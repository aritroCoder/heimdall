'use strict';

const {
  clamp,
  formatPercent,
  getTopLevelDirectory,
  mapWithConcurrency,
  normalizeCodeLine,
  parseBoolean,
  parseInteger,
  parseNumber,
  toSha256,
  normalizePath,
  toFrequencyMap,
  mergeSets,
} = require('./core/utils');
const {
  IMPORT_PATTERNS,
  FUNCTION_SIGNATURE_PATTERNS,
  CLASS_SIGNATURE_PATTERNS,
} = require('./core/patterns');
const {
  jaccardSimilarity,
  cosineSimilarityFromMaps,
  cosineSimilarityFromVectors,
} = require('./core/similarity');
const { collectPullRequests, listPullRequestFiles } = require('./core/github');
const {
  getRepresentationCacheKey,
  getCachedRepresentation,
  setCachedRepresentation,
} = require('./core/pr-cache');
const { matchFirstGroup, tokenizeLine } = require('./core/pr-features');

const DUPLICATE_COMMENT_MARKER = '<!-- heimdall-duplicate-bot -->';

const DEFAULT_DUPLICATE_CONFIG = Object.freeze({
  enabled: true,
  onlyOnOpened: false,
  maxOpenCandidates: 80,
  maxMergedCandidates: 140,
  maxCandidateComparisons: 60,
  mergedLookbackDays: 180,
  fileCountDeltaThreshold: 8,
  topLevelDirOverlapThreshold: 0.5,
  fileOverlapThreshold: 0.7,
  structuralSimilarityThreshold: 0.72,
  metadataSimilarityThreshold: 0.84,
  candidateFetchConcurrency: 4,
  maxPatchCharactersPerFile: 12000,
  metadataVectorSize: 256,
  maxReportedMatches: 3,
});

function normalizeDuplicateConfig(inputConfig) {
  const config = { ...DEFAULT_DUPLICATE_CONFIG, ...inputConfig };

  return {
    enabled: parseBoolean(config.enabled, DEFAULT_DUPLICATE_CONFIG.enabled),
    onlyOnOpened: parseBoolean(config.onlyOnOpened, DEFAULT_DUPLICATE_CONFIG.onlyOnOpened),
    maxOpenCandidates: clamp(parseInteger(config.maxOpenCandidates, 80), 1, 400),
    maxMergedCandidates: clamp(parseInteger(config.maxMergedCandidates, 140), 1, 600),
    maxCandidateComparisons: clamp(parseInteger(config.maxCandidateComparisons, 60), 1, 200),
    mergedLookbackDays: clamp(parseInteger(config.mergedLookbackDays, 180), 1, 1000),
    fileCountDeltaThreshold: clamp(parseInteger(config.fileCountDeltaThreshold, 8), 0, 100),
    topLevelDirOverlapThreshold: clamp(
      parseNumber(config.topLevelDirOverlapThreshold, 0.5),
      0,
      1,
    ),
    fileOverlapThreshold: clamp(parseNumber(config.fileOverlapThreshold, 0.7), 0, 1),
    structuralSimilarityThreshold: clamp(
      parseNumber(config.structuralSimilarityThreshold, DEFAULT_DUPLICATE_CONFIG.structuralSimilarityThreshold),
      0,
      1,
    ),
    metadataSimilarityThreshold: clamp(
      parseNumber(config.metadataSimilarityThreshold, DEFAULT_DUPLICATE_CONFIG.metadataSimilarityThreshold),
      0,
      1,
    ),
    candidateFetchConcurrency: clamp(parseInteger(config.candidateFetchConcurrency, 4), 1, 12),
    maxPatchCharactersPerFile: clamp(
      parseInteger(config.maxPatchCharactersPerFile, 12000),
      200,
      100000,
    ),
    metadataVectorSize: clamp(parseInteger(config.metadataVectorSize, 256), 32, 2048),
    maxReportedMatches: clamp(parseInteger(config.maxReportedMatches, 3), 1, 10),
  };
}

function buildDuplicateConfigFromEnv(env) {
  const overrides = {};

  if (env.DUPLICATE_DETECTION_ENABLED !== undefined) {
    overrides['enabled'] = parseBoolean(
      env.DUPLICATE_DETECTION_ENABLED,
      DEFAULT_DUPLICATE_CONFIG.enabled,
    );
  }

  if (env.DUPLICATE_DETECTION_ONLY_ON_OPENED !== undefined) {
    overrides['onlyOnOpened'] = parseBoolean(
      env.DUPLICATE_DETECTION_ONLY_ON_OPENED,
      DEFAULT_DUPLICATE_CONFIG.onlyOnOpened,
    );
  }

  if (env.DUPLICATE_MAX_OPEN_CANDIDATES) {
    overrides['maxOpenCandidates'] = env.DUPLICATE_MAX_OPEN_CANDIDATES;
  }
  if (env.DUPLICATE_MAX_MERGED_CANDIDATES) {
    overrides['maxMergedCandidates'] = env.DUPLICATE_MAX_MERGED_CANDIDATES;
  }
  if (env.DUPLICATE_MAX_CANDIDATE_COMPARISONS) {
    overrides['maxCandidateComparisons'] = env.DUPLICATE_MAX_CANDIDATE_COMPARISONS;
  }
  if (env.DUPLICATE_MERGED_LOOKBACK_DAYS) {
    overrides['mergedLookbackDays'] = env.DUPLICATE_MERGED_LOOKBACK_DAYS;
  }
  if (env.DUPLICATE_FILE_COUNT_DELTA_THRESHOLD) {
    overrides['fileCountDeltaThreshold'] = env.DUPLICATE_FILE_COUNT_DELTA_THRESHOLD;
  }
  if (env.DUPLICATE_TOP_LEVEL_DIR_OVERLAP_THRESHOLD) {
    overrides['topLevelDirOverlapThreshold'] = env.DUPLICATE_TOP_LEVEL_DIR_OVERLAP_THRESHOLD;
  }
  if (env.DUPLICATE_FILE_OVERLAP_THRESHOLD) {
    overrides['fileOverlapThreshold'] = env.DUPLICATE_FILE_OVERLAP_THRESHOLD;
  }
  if (env.DUPLICATE_STRUCTURAL_SIMILARITY_THRESHOLD) {
    overrides['structuralSimilarityThreshold'] = env.DUPLICATE_STRUCTURAL_SIMILARITY_THRESHOLD;
  }
  if (env.DUPLICATE_METADATA_SIMILARITY_THRESHOLD) {
    overrides['metadataSimilarityThreshold'] = env.DUPLICATE_METADATA_SIMILARITY_THRESHOLD;
  }
  if (env.DUPLICATE_CANDIDATE_FETCH_CONCURRENCY) {
    overrides['candidateFetchConcurrency'] = env.DUPLICATE_CANDIDATE_FETCH_CONCURRENCY;
  }
  if (env.DUPLICATE_MAX_PATCH_CHARS_PER_FILE) {
    overrides['maxPatchCharactersPerFile'] = env.DUPLICATE_MAX_PATCH_CHARS_PER_FILE;
  }
  if (env.DUPLICATE_METADATA_VECTOR_SIZE) {
    overrides['metadataVectorSize'] = env.DUPLICATE_METADATA_VECTOR_SIZE;
  }
  if (env.DUPLICATE_MAX_REPORTED_MATCHES) {
    overrides['maxReportedMatches'] = env.DUPLICATE_MAX_REPORTED_MATCHES;
  }

  return normalizeDuplicateConfig(overrides);
}

function buildFileFeatures(file, config) {
  const filename = normalizePath(file.filename);
  const patchSource = typeof file.patch === 'string' ? file.patch : '';
  const patch = patchSource.slice(0, config.maxPatchCharactersPerFile);
  const lines = patch.split('\n');

  const addedLines = [];
  const removedLines = [];
  const addedTokens = [];
  const removedTokens = [];

  const importsAdded = new Set();
  const importsRemoved = new Set();
  const changedFunctions = new Set();
  const changedClasses = new Set();

  for (const line of lines) {
    if (!line || line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    const isAdded = line.startsWith('+');
    const isRemoved = line.startsWith('-');
    if (!isAdded && !isRemoved) {
      continue;
    }

    const raw = line.slice(1);
    const normalized = normalizeCodeLine(raw);
    if (!normalized) {
      continue;
    }

    const importMatch = matchFirstGroup(raw, IMPORT_PATTERNS);
    const functionMatch = matchFirstGroup(raw, FUNCTION_SIGNATURE_PATTERNS);
    const classMatch = matchFirstGroup(raw, CLASS_SIGNATURE_PATTERNS);

    if (isAdded) {
      addedLines.push(normalized);
      addedTokens.push(...tokenizeLine(raw));
      if (importMatch) {
        importsAdded.add(importMatch);
      }
    }

    if (isRemoved) {
      removedLines.push(normalized);
      removedTokens.push(...tokenizeLine(raw));
      if (importMatch) {
        importsRemoved.add(importMatch);
      }
    }

    if (functionMatch) {
      changedFunctions.add(functionMatch);
    }

    if (classMatch) {
      changedClasses.add(classMatch);
    }
  }

  return {
    filename,
    topLevelDirectory: getTopLevelDirectory(filename),
    addedLines,
    removedLines,
    addedTokens,
    removedTokens,
    importsAdded,
    importsRemoved,
    changedFunctions,
    changedClasses,
  };
}

function fnv1aHash32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function buildFeatureHashVector(text, vectorSize) {
  const vector = new Array(vectorSize).fill(0);
  const tokens = tokenizeLine(String(text || ''));

  for (const token of tokens) {
    const hash = fnv1aHash32(token);
    const index = hash % vectorSize;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function buildPullRequestRepresentation({ pr, files, config }) {
  const fileFeatures = files.map((file) => buildFileFeatures(file, config));

  const fileSet = new Set();
  const topLevelDirectories = new Set();
  const changedFunctions = new Set();
  const changedClasses = new Set();
  const importsAdded = new Set();
  const importsRemoved = new Set();

  const allAddedLines = [];
  const allRemovedLines = [];
  const allAddedTokens = [];
  const allRemovedTokens = [];

  for (const feature of fileFeatures) {
    fileSet.add(feature.filename);
    topLevelDirectories.add(feature.topLevelDirectory);
    mergeSets(changedFunctions, feature.changedFunctions);
    mergeSets(changedClasses, feature.changedClasses);
    mergeSets(importsAdded, feature.importsAdded);
    mergeSets(importsRemoved, feature.importsRemoved);
    allAddedLines.push(...feature.addedLines);
    allRemovedLines.push(...feature.removedLines);
    allAddedTokens.push(...feature.addedTokens);
    allRemovedTokens.push(...feature.removedTokens);
  }

  const sortedFiles = [...fileSet].sort();
  const sortedAddedLines = [...allAddedLines].sort();
  const sortedRemovedLines = [...allRemovedLines].sort();
  const sortedFunctions = [...changedFunctions].sort();
  const sortedClasses = [...changedClasses].sort();
  const sortedImportsAdded = [...importsAdded].sort();
  const sortedImportsRemoved = [...importsRemoved].sort();

  const filePathHash = toSha256(sortedFiles.join('\n'));
  const normalizedDiffHash = toSha256(
    ['A', ...sortedAddedLines.map((line) => `+${line}`), 'R', ...sortedRemovedLines.map((line) => `-${line}`)].join(
      '\n',
    ),
  );
  const patchFingerprint = toSha256(['A', ...sortedAddedLines, 'R', ...sortedRemovedLines].join('\n'));
  const inversePatchFingerprint = toSha256(
    ['A', ...sortedRemovedLines, 'R', ...sortedAddedLines].join('\n'),
  );

  const metadataText = [
    (pr.title || '').trim(),
    (pr.body || '').trim(),
    `files ${sortedFiles.join(' ')}`,
    `functions ${sortedFunctions.join(' ')}`,
    `classes ${sortedClasses.join(' ')}`,
    `imports added ${sortedImportsAdded.join(' ')}`,
    `imports removed ${sortedImportsRemoved.join(' ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    prNumber: pr.number,
    prId: pr.id,
    title: pr.title || '',
    body: pr.body || '',
    htmlUrl: pr.html_url || '',
    baseRef: pr.base && pr.base.ref ? pr.base.ref : '',
    state: pr.state || 'open',
    mergedAt: pr.merged_at || null,
    fileSet,
    topLevelDirectories,
    fileCount: sortedFiles.length,
    changedFunctions,
    changedClasses,
    importsAdded,
    importsRemoved,
    addedTokenFrequency: toFrequencyMap(allAddedTokens),
    removedTokenFrequency: toFrequencyMap(allRemovedTokens),
    metadataTokenVector: buildFeatureHashVector(metadataText, config.metadataVectorSize),
    filePathHash,
    normalizedDiffHash,
    patchFingerprint,
    inversePatchFingerprint,
  };
}

function evaluateCandidateSimilarity(currentRepresentation, candidateRepresentation, config) {
  const fileOverlap = jaccardSimilarity(currentRepresentation.fileSet, candidateRepresentation.fileSet);
  const topLevelDirOverlap = jaccardSimilarity(
    currentRepresentation.topLevelDirectories,
    candidateRepresentation.topLevelDirectories,
  );
  const fileCountDelta = Math.abs(currentRepresentation.fileCount - candidateRepresentation.fileCount);
  const structuralSimilarity = cosineSimilarityFromMaps(
    currentRepresentation.addedTokenFrequency,
    candidateRepresentation.addedTokenFrequency,
  );
  const metadataSimilarity = cosineSimilarityFromVectors(
    currentRepresentation.metadataTokenVector,
    candidateRepresentation.metadataTokenVector,
  );
  const functionOverlap = jaccardSimilarity(
    currentRepresentation.changedFunctions,
    candidateRepresentation.changedFunctions,
    0,
  );
  const classOverlap = jaccardSimilarity(
    currentRepresentation.changedClasses,
    candidateRepresentation.changedClasses,
    0,
  );
  const importOverlap = jaccardSimilarity(
    currentRepresentation.importsAdded,
    candidateRepresentation.importsAdded,
    0,
  );

  const patchIdMatch =
    currentRepresentation.patchFingerprint.length > 0 &&
    currentRepresentation.patchFingerprint === candidateRepresentation.patchFingerprint;
  const inversePatchMatch =
    currentRepresentation.patchFingerprint.length > 0 &&
    currentRepresentation.patchFingerprint === candidateRepresentation.inversePatchFingerprint;
  const normalizedDiffHashMatch =
    currentRepresentation.normalizedDiffHash.length > 0 &&
    currentRepresentation.normalizedDiffHash === candidateRepresentation.normalizedDiffHash;
  const filePathHashMatch =
    currentRepresentation.filePathHash.length > 0 &&
    currentRepresentation.filePathHash === candidateRepresentation.filePathHash;

  const passesCandidateFilter =
    fileCountDelta <= config.fileCountDeltaThreshold &&
    topLevelDirOverlap >= config.topLevelDirOverlapThreshold;

  const passesHardFilter = fileOverlap >= config.fileOverlapThreshold;
  const passesStructural = structuralSimilarity >= config.structuralSimilarityThreshold;
  const passesMetadata = metadataSimilarity >= config.metadataSimilarityThreshold;

  const exactDuplicate = patchIdMatch || (normalizedDiffHashMatch && filePathHashMatch && passesHardFilter);
  const metadataDuplicate = passesHardFilter && passesStructural && passesMetadata;
  const isDuplicate = exactDuplicate || metadataDuplicate;

  let confidence = 0;
  if (exactDuplicate) {
    confidence = 1;
  } else if (inversePatchMatch) {
    confidence = 0.96;
  } else {
    confidence = clamp(
      fileOverlap * 0.34 +
        structuralSimilarity * 0.32 +
        metadataSimilarity * 0.22 +
        Math.max(functionOverlap, classOverlap, importOverlap) * 0.12,
      0,
      0.999,
    );
  }

  let reason = 'none';
  if (exactDuplicate) {
    reason = patchIdMatch ? 'patch-id-match' : 'normalized-diff-hash-match';
  } else if (metadataDuplicate) {
    reason = 'structural-and-metadata-match';
  } else if (inversePatchMatch) {
    reason = 'inverse-patch-match';
  }

  return {
    reason,
    confidence,
    isDuplicate,
    isRevert: inversePatchMatch,
    passesCandidateFilter,
    metrics: {
      fileOverlap,
      topLevelDirOverlap,
      fileCountDelta,
      structuralSimilarity,
      metadataSimilarity,
      functionOverlap,
      classOverlap,
      importOverlap,
      patchIdMatch,
      inversePatchMatch,
      normalizedDiffHashMatch,
      filePathHashMatch,
    },
  };
}

function toHumanReason(reason) {
  if (reason === 'patch-id-match') {
    return 'Exact patch fingerprint match';
  }

  if (reason === 'normalized-diff-hash-match') {
    return 'Normalized diff hash match';
  }

  if (reason === 'structural-and-metadata-match') {
    return 'Structural and metadata similarity match';
  }

  if (reason === 'inverse-patch-match') {
    return 'Inverse patch match (possible revert)';
  }

  return 'Similarity match';
}

function buildDuplicateCommentBody({ detectionResult, currentPullRequest }) {
  if (!detectionResult || !detectionResult.flagged || !Array.isArray(detectionResult.matches)) {
    return '';
  }

  const lines = [
    DUPLICATE_COMMENT_MARKER,
    '## Potential Duplicate Pull Request',
    '',
    `PR #${currentPullRequest.number} appears highly similar to one or more existing pull requests.`,
    '',
    '### Top matches',
    '',
  ];

  for (const match of detectionResult.matches) {
    const metrics = match.similarity.metrics;
    lines.push(
      `- #${match.number} (${match.state}) ${match.title || '(no title)'}`,
      `  - Confidence: **${formatPercent(match.similarity.confidence)}**`,
      `  - Reason: ${toHumanReason(match.similarity.reason)}`,
      `  - File overlap: ${formatPercent(metrics.fileOverlap)}, structural: ${formatPercent(metrics.structuralSimilarity)}, metadata: ${formatPercent(metrics.metadataSimilarity)}`,
    );
  }

  if (detectionResult.reverts && detectionResult.reverts.length > 0) {
    const revertNumbers = detectionResult.reverts.map((match) => `#${match.number}`).join(', ');
    lines.push('', `Potential reverts detected relative to: ${revertNumbers}.`);
  }

  lines.push(
    '',
    `Thresholds used: file overlap >= ${formatPercent(detectionResult.thresholds.fileOverlap)}, ` +
      `structural >= ${formatPercent(detectionResult.thresholds.structuralSimilarity)}, ` +
    `metadata >= ${formatPercent(detectionResult.thresholds.metadataSimilarity)}.`,
    '',
    'If this is intentional, keep this PR open and ignore this notice.',
  );

  return lines.join('\n');
}

async function detectDuplicatePullRequest({
  github,
  owner,
  repo,
  currentPullRequest,
  currentFiles,
  config,
  logger = null,
}) {
  const effectiveConfig = normalizeDuplicateConfig(config);

  if (!effectiveConfig.enabled) {
    return {
      checked: false,
      skipReason: 'disabled',
      flagged: false,
      candidateCount: 0,
      comparedCount: 0,
      matches: [],
      bestMatch: null,
      reverts: [],
    };
  }

  const currentRepresentation = buildPullRequestRepresentation({
    pr: currentPullRequest,
    files: currentFiles,
    config: effectiveConfig,
  });

  const [openCandidates, mergedCandidates] = await Promise.all([
    collectPullRequests({
      github,
      owner,
      repo,
      state: 'open',
      limit: effectiveConfig.maxOpenCandidates,
      mergedLookbackDays: effectiveConfig.mergedLookbackDays,
    }),
    collectPullRequests({
      github,
      owner,
      repo,
      state: 'closed',
      limit: effectiveConfig.maxMergedCandidates,
      mergedLookbackDays: effectiveConfig.mergedLookbackDays,
    }),
  ]);

  const candidateByNumber = new Map();
  for (const candidate of [...openCandidates, ...mergedCandidates]) {
    if (!candidate || candidate.number === currentPullRequest.number) {
      continue;
    }

    if (!candidate.base || candidate.base.ref !== currentRepresentation.baseRef) {
      continue;
    }

    if (!candidateByNumber.has(candidate.number)) {
      candidateByNumber.set(candidate.number, candidate);
    }
  }

  const candidatePool = [...candidateByNumber.values()]
    .sort((left, right) => {
      // Prefer open PRs over closed/merged so that an active duplicate is always
      // evaluated before an older merged one when the pool is capped.
      const leftIsOpen = !left.merged_at && left.state === 'open' ? 0 : 1;
      const rightIsOpen = !right.merged_at && right.state === 'open' ? 0 : 1;
      if (leftIsOpen !== rightIsOpen) {
        return leftIsOpen - rightIsOpen;
      }
      const leftTs = Date.parse(left.updated_at || left.created_at || 0);
      const rightTs = Date.parse(right.updated_at || right.created_at || 0);
      return rightTs - leftTs;
    })
    .slice(0, effectiveConfig.maxCandidateComparisons);

  const evaluations = await mapWithConcurrency(
    candidatePool,
    effectiveConfig.candidateFetchConcurrency,
    async (candidate) => {
      if (typeof candidate.changed_files === 'number') {
        const delta = Math.abs(candidate.changed_files - currentRepresentation.fileCount);
        if (delta > effectiveConfig.fileCountDeltaThreshold) {
          return null;
        }
      }

      const candidateCacheKey = getRepresentationCacheKey({
        owner,
        repo,
        pullRequest: candidate,
        config: effectiveConfig,
      });

      let candidateRepresentation = getCachedRepresentation(candidateCacheKey);
      if (!candidateRepresentation) {
        const candidateFiles = await listPullRequestFiles({
          github,
          owner,
          repo,
          pullNumber: candidate.number,
        });

        candidateRepresentation = buildPullRequestRepresentation({
          pr: candidate,
          files: candidateFiles,
          config: effectiveConfig,
        });
        setCachedRepresentation(candidateCacheKey, candidateRepresentation);
      }

      const similarity = evaluateCandidateSimilarity(
        currentRepresentation,
        candidateRepresentation,
        effectiveConfig,
      );

      if (!similarity.passesCandidateFilter) {
        return null;
      }

      return {
        number: candidate.number,
        htmlUrl: candidate.html_url || '',
        state: candidate.merged_at ? 'merged' : candidate.state || 'open',
        title: candidate.title || '',
        mergedAt: candidate.merged_at || null,
        similarity,
      };
    },
  );

  const compared = evaluations.filter(Boolean);
  const duplicateMatches = compared
    .filter((entry) => entry.similarity.isDuplicate)
    .sort((left, right) => right.similarity.confidence - left.similarity.confidence);
  const revertMatches = compared
    .filter((entry) => entry.similarity.isRevert)
    .sort((left, right) => right.similarity.confidence - left.similarity.confidence);

  const topMatches = duplicateMatches.slice(0, effectiveConfig.maxReportedMatches);
  const bestMatch = topMatches.length > 0 ? topMatches[0] : null;

  if (logger && typeof logger.info === 'function') {
    logger.info(
      `Duplicate scan for ${owner}/${repo}#${currentPullRequest.number}: ` +
      `pool=${candidatePool.length}, compared=${compared.length}, matches=${topMatches.length}, reverts=${revertMatches.length}`,
    );
    logger.info(
      `best match #${bestMatch ? bestMatch.number : 'N/A'} with confidence ${bestMatch ? formatPercent(bestMatch.similarity.confidence) : 'N/A'}`,
    );

    const nearMisses = compared
      .filter((entry) => !entry.similarity.isDuplicate)
      .sort((left, right) => right.similarity.confidence - left.similarity.confidence)
      .slice(0, 5);

    if (nearMisses.length > 0) {
      logger.info(`  Top ${nearMisses.length} non-duplicate candidate(s) by confidence:`);
      for (const entry of nearMisses) {
        const m = entry.similarity.metrics;
        const t = effectiveConfig;
        const failReasons = [];
        if (!m.patchIdMatch && !m.normalizedDiffHashMatch) {
          if (m.fileOverlap < t.fileOverlapThreshold)
            failReasons.push(`file-overlap ${formatPercent(m.fileOverlap)} < ${formatPercent(t.fileOverlapThreshold)}`);
          if (m.fileOverlap >= t.fileOverlapThreshold && m.structuralSimilarity < t.structuralSimilarityThreshold)
            failReasons.push(`structural ${formatPercent(m.structuralSimilarity)} < ${formatPercent(t.structuralSimilarityThreshold)}`);
          if (m.fileOverlap >= t.fileOverlapThreshold && m.metadataSimilarity < t.metadataSimilarityThreshold)
            failReasons.push(`metadata ${formatPercent(m.metadataSimilarity)} < ${formatPercent(t.metadataSimilarityThreshold)}`);
        }
        logger.info(
          `  #${entry.number} (${entry.state}) confidence=${formatPercent(entry.similarity.confidence)} | ` +
            `file-overlap=${formatPercent(m.fileOverlap)} structural=${formatPercent(m.structuralSimilarity)} metadata=${formatPercent(m.metadataSimilarity)} | ` +
            `not-duplicate: ${failReasons.length > 0 ? failReasons.join(', ') : 'below all thresholds'}`,
        );
      }
    }
  }

  return {
    checked: true,
    skipReason: null,
    flagged: topMatches.length > 0,
    candidateCount: candidatePool.length,
    comparedCount: compared.length,
    matches: topMatches,
    bestMatch,
    reverts: revertMatches.slice(0, effectiveConfig.maxReportedMatches),
    thresholds: {
      fileOverlap: effectiveConfig.fileOverlapThreshold,
      structuralSimilarity: effectiveConfig.structuralSimilarityThreshold,
      metadataSimilarity: effectiveConfig.metadataSimilarityThreshold,
    },
  };
}

module.exports = {
  DEFAULT_DUPLICATE_CONFIG,
  DUPLICATE_COMMENT_MARKER,
  buildDuplicateCommentBody,
  buildDuplicateConfigFromEnv,
  buildPullRequestRepresentation,
  cosineSimilarityFromMaps,
  cosineSimilarityFromVectors,
  detectDuplicatePullRequest,
  evaluateCandidateSimilarity,
  getTopLevelDirectory,
  jaccardSimilarity,
  normalizeCodeLine,
  normalizeDuplicateConfig,
};
