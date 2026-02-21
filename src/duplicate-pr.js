'use strict';

const { createHash } = require('node:crypto');

const DUPLICATE_COMMENT_MARKER = '<!-- heimdall-duplicate-bot -->';

const DEFAULT_DUPLICATE_CONFIG = Object.freeze({
  enabled: true,
  onlyOnOpened: true,
  maxOpenCandidates: 80,
  maxMergedCandidates: 140,
  maxCandidateComparisons: 60,
  mergedLookbackDays: 180,
  fileCountDeltaThreshold: 8,
  topLevelDirOverlapThreshold: 0.5,
  fileOverlapThreshold: 0.7,
  structuralSimilarityThreshold: 0.85,
  semanticSimilarityThreshold: 0.9,
  candidateFetchConcurrency: 4,
  maxPatchCharactersPerFile: 12000,
  semanticVectorSize: 256,
  maxReportedMatches: 3,
});

const REPRESENTATION_CACHE_MAX_ENTRIES = 2000;
const representationCache = new Map();

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'if',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'with',
]);

const FUNCTION_SIGNATURE_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
  /^\s*def\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:public|private|protected|internal|static|final|abstract|synchronized|\s)+[A-Za-z0-9_<>,\[\]?]+\s+([A-Za-z_][\w]*)\s*\(/,
];

const CLASS_SIGNATURE_PATTERNS = [
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*struct\s+([A-Za-z_$][\w$]*)\b/,
];

const IMPORT_PATTERNS = [
  /^\s*import\s+.+?\s+from\s+['"]([^'"]+)['"]\s*;?$/,
  /^\s*import\s+['"]([^'"]+)['"]\s*;?$/,
  /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\(['"]([^'"]+)['"]\)\s*;?$/,
  /^\s*from\s+([A-Za-z0-9_./-]+)\s+import\s+/,
  /^\s*import\s+([A-Za-z0-9_.,\s]+)\s*$/,
  /^\s*#include\s+[<"]([^>"]+)[>"]\s*$/,
  /^\s*using\s+([A-Za-z0-9_.]+)\s*;?$/,
];

function parseCsv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

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
      parseNumber(config.structuralSimilarityThreshold, 0.85),
      0,
      1,
    ),
    semanticSimilarityThreshold: clamp(
      parseNumber(config.semanticSimilarityThreshold, 0.9),
      0,
      1,
    ),
    candidateFetchConcurrency: clamp(parseInteger(config.candidateFetchConcurrency, 4), 1, 12),
    maxPatchCharactersPerFile: clamp(parseInteger(config.maxPatchCharactersPerFile, 12000), 200, 100000),
    semanticVectorSize: clamp(parseInteger(config.semanticVectorSize, 256), 32, 2048),
    maxReportedMatches: clamp(parseInteger(config.maxReportedMatches, 3), 1, 10),
  };
}

function buildDuplicateConfigFromEnv(env) {
  const overrides = {};

  if (env.DUPLICATE_DETECTION_ENABLED !== undefined) {
    overrides.enabled = parseBoolean(env.DUPLICATE_DETECTION_ENABLED, DEFAULT_DUPLICATE_CONFIG.enabled);
  }

  if (env.DUPLICATE_DETECTION_ONLY_ON_OPENED !== undefined) {
    overrides.onlyOnOpened = parseBoolean(
      env.DUPLICATE_DETECTION_ONLY_ON_OPENED,
      DEFAULT_DUPLICATE_CONFIG.onlyOnOpened,
    );
  }

  if (env.DUPLICATE_MAX_OPEN_CANDIDATES) {
    overrides.maxOpenCandidates = env.DUPLICATE_MAX_OPEN_CANDIDATES;
  }

  if (env.DUPLICATE_MAX_MERGED_CANDIDATES) {
    overrides.maxMergedCandidates = env.DUPLICATE_MAX_MERGED_CANDIDATES;
  }

  if (env.DUPLICATE_MAX_CANDIDATE_COMPARISONS) {
    overrides.maxCandidateComparisons = env.DUPLICATE_MAX_CANDIDATE_COMPARISONS;
  }

  if (env.DUPLICATE_MERGED_LOOKBACK_DAYS) {
    overrides.mergedLookbackDays = env.DUPLICATE_MERGED_LOOKBACK_DAYS;
  }

  if (env.DUPLICATE_FILE_COUNT_DELTA_THRESHOLD) {
    overrides.fileCountDeltaThreshold = env.DUPLICATE_FILE_COUNT_DELTA_THRESHOLD;
  }

  if (env.DUPLICATE_TOP_LEVEL_DIR_OVERLAP_THRESHOLD) {
    overrides.topLevelDirOverlapThreshold = env.DUPLICATE_TOP_LEVEL_DIR_OVERLAP_THRESHOLD;
  }

  if (env.DUPLICATE_FILE_OVERLAP_THRESHOLD) {
    overrides.fileOverlapThreshold = env.DUPLICATE_FILE_OVERLAP_THRESHOLD;
  }

  if (env.DUPLICATE_STRUCTURAL_SIMILARITY_THRESHOLD) {
    overrides.structuralSimilarityThreshold = env.DUPLICATE_STRUCTURAL_SIMILARITY_THRESHOLD;
  }

  if (env.DUPLICATE_SEMANTIC_SIMILARITY_THRESHOLD) {
    overrides.semanticSimilarityThreshold = env.DUPLICATE_SEMANTIC_SIMILARITY_THRESHOLD;
  }

  if (env.DUPLICATE_CANDIDATE_FETCH_CONCURRENCY) {
    overrides.candidateFetchConcurrency = env.DUPLICATE_CANDIDATE_FETCH_CONCURRENCY;
  }

  if (env.DUPLICATE_MAX_PATCH_CHARS_PER_FILE) {
    overrides.maxPatchCharactersPerFile = env.DUPLICATE_MAX_PATCH_CHARS_PER_FILE;
  }

  if (env.DUPLICATE_SEMANTIC_VECTOR_SIZE) {
    overrides.semanticVectorSize = env.DUPLICATE_SEMANTIC_VECTOR_SIZE;
  }

  if (env.DUPLICATE_MAX_REPORTED_MATCHES) {
    overrides.maxReportedMatches = env.DUPLICATE_MAX_REPORTED_MATCHES;
  }

  return normalizeDuplicateConfig(overrides);
}

function toSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(filename) {
  return String(filename || '').replace(/\\/g, '/').trim();
}

function getTopLevelDirectory(filename) {
  const normalized = normalizePath(filename);
  if (!normalized) {
    return '.';
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex === -1) {
    return '.';
  }

  return normalized.slice(0, slashIndex) || '.';
}

function normalizeCodeLine(value) {
  let line = String(value || '').trim();
  if (!line) {
    return '';
  }

  line = line.replace(/\/\*.*?\*\//g, ' ');
  line = line.replace(/\/\/.*$/g, ' ');
  line = line.replace(/#.*$/g, ' ');
  line = line.replace(/--.*$/g, ' ');
  line = line.replace(/\s+/g, ' ').trim().toLowerCase();

  return line;
}

function tokenizeLine(value) {
  const normalized = normalizeCodeLine(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function matchFirstGroup(value, patterns) {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match && match[1]) {
      return match[1].trim().toLowerCase();
    }
  }

  return null;
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

function mergeSets(target, source) {
  for (const item of source) {
    target.add(item);
  }
}

function toFrequencyMap(tokens) {
  const map = new Map();
  for (const token of tokens) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}

function fnv1aHash32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function buildHashedEmbedding(text, vectorSize) {
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

  const semanticText = [
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
    semanticVector: buildHashedEmbedding(semanticText, config.semanticVectorSize),
    filePathHash,
    normalizedDiffHash,
    patchFingerprint,
    inversePatchFingerprint,
  };
}

function jaccardSimilarity(setA, setB, emptySimilarity = 1) {
  if (setA.size === 0 && setB.size === 0) {
    return emptySimilarity;
  }

  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

function cosineSimilarityFromMaps(mapA, mapB) {
  if (mapA.size === 0 || mapB.size === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of mapA.values()) {
    normA += value * value;
  }

  for (const value of mapB.values()) {
    normB += value * value;
  }

  const [smaller, larger] = mapA.size <= mapB.size ? [mapA, mapB] : [mapB, mapA];
  for (const [token, value] of smaller.entries()) {
    if (larger.has(token)) {
      dot += value * larger.get(token);
    }
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cosineSimilarityFromVectors(vectorA, vectorB) {
  if (vectorA.length === 0 || vectorB.length === 0 || vectorA.length !== vectorB.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < vectorA.length; index += 1) {
    const a = vectorA[index];
    const b = vectorB[index];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
  const semanticSimilarity = cosineSimilarityFromVectors(
    currentRepresentation.semanticVector,
    candidateRepresentation.semanticVector,
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
  const passesSemantic = semanticSimilarity >= config.semanticSimilarityThreshold;

  const exactDuplicate = patchIdMatch || (normalizedDiffHashMatch && filePathHashMatch && passesHardFilter);
  const semanticDuplicate = passesHardFilter && passesStructural && passesSemantic;
  const isDuplicate = exactDuplicate || semanticDuplicate;

  let confidence = 0;
  if (exactDuplicate) {
    confidence = 1;
  } else if (inversePatchMatch) {
    confidence = 0.96;
  } else {
    confidence = clamp(
      fileOverlap * 0.34 +
        structuralSimilarity * 0.32 +
        semanticSimilarity * 0.22 +
        Math.max(functionOverlap, classOverlap, importOverlap) * 0.12,
      0,
      0.999,
    );
  }

  let reason = 'none';
  if (exactDuplicate) {
    reason = patchIdMatch ? 'patch-id-match' : 'normalized-diff-hash-match';
  } else if (semanticDuplicate) {
    reason = 'structural-and-semantic-match';
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
      semanticSimilarity,
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

function formatPercent(score) {
  return `${Math.round(clamp(score, 0, 1) * 100)}%`;
}

function toHumanReason(reason) {
  if (reason === 'patch-id-match') {
    return 'Exact semantic patch match';
  }

  if (reason === 'normalized-diff-hash-match') {
    return 'Normalized diff hash match';
  }

  if (reason === 'structural-and-semantic-match') {
    return 'Structural and semantic similarity match';
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
    `PR #${currentPullRequest.number} appears semantically equivalent to one or more existing pull requests.`,
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
      `  - File overlap: ${formatPercent(metrics.fileOverlap)}, structural: ${formatPercent(metrics.structuralSimilarity)}, semantic: ${formatPercent(metrics.semanticSimilarity)}`,
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
      `semantic >= ${formatPercent(detectionResult.thresholds.semanticSimilarity)}.`,
    '',
    'If this is intentional, keep this PR open and ignore this notice.',
  );

  return lines.join('\n');
}

function getRepresentationCacheKey({ owner, repo, pullRequest, config }) {
  const updatedAt = pullRequest.updated_at || '';
  const headSha = pullRequest.head && pullRequest.head.sha ? pullRequest.head.sha : '';
  return [
    owner,
    repo,
    pullRequest.number,
    updatedAt,
    headSha,
    config.maxPatchCharactersPerFile,
    config.semanticVectorSize,
  ].join('|');
}

function getCachedRepresentation(cacheKey) {
  if (!representationCache.has(cacheKey)) {
    return null;
  }

  const cachedValue = representationCache.get(cacheKey);
  representationCache.delete(cacheKey);
  representationCache.set(cacheKey, cachedValue);
  return cachedValue;
}

function setCachedRepresentation(cacheKey, representation) {
  if (representationCache.has(cacheKey)) {
    representationCache.delete(cacheKey);
  }

  representationCache.set(cacheKey, representation);
  while (representationCache.size > REPRESENTATION_CACHE_MAX_ENTRIES) {
    const oldestKey = representationCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    representationCache.delete(oldestKey);
  }
}

async function mapWithConcurrency(items, concurrency, task) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;

  const workers = [];
  for (let workerIndex = 0; workerIndex < limit; workerIndex += 1) {
    workers.push(
      (async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) {
            return;
          }

          results[index] = await task(items[index], index);
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}

async function collectPullRequests({ github, owner, repo, state, limit, mergedLookbackDays }) {
  const results = [];
  const perPage = 100;
  const maxPages = Math.max(1, Math.ceil(limit / perPage) + 2);
  const nowMs = Date.now();
  const lookbackMs = mergedLookbackDays * 24 * 60 * 60 * 1000;

  for (let page = 1; page <= maxPages && results.length < limit; page += 1) {
    const response = await github.rest.pulls.list({
      owner,
      repo,
      state,
      sort: 'updated',
      direction: 'desc',
      per_page: perPage,
      page,
    });
    const pullRequests = Array.isArray(response.data) ? response.data : [];
    if (pullRequests.length === 0) {
      break;
    }

    for (const pullRequest of pullRequests) {
      if (state === 'closed') {
        if (!pullRequest.merged_at) {
          continue;
        }

        const mergedAtMs = Date.parse(pullRequest.merged_at);
        if (Number.isNaN(mergedAtMs) || nowMs - mergedAtMs > lookbackMs) {
          continue;
        }
      }

      results.push(pullRequest);
      if (results.length >= limit) {
        break;
      }
    }

    if (pullRequests.length < perPage) {
      break;
    }
  }

  return results;
}

async function listPullRequestFiles({ github, owner, repo, pullNumber }) {
  return github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
}

async function detectDuplicatePullRequest({
  github,
  owner,
  repo,
  currentPullRequest,
  currentFiles,
  config,
  logger,
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
      semanticSimilarity: effectiveConfig.semanticSimilarityThreshold,
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
  parseCsv,
};
