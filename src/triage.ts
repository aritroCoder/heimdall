'use strict';

const {
  DUPLICATE_COMMENT_MARKER,
  buildDuplicateCommentBody,
  detectDuplicatePullRequest,
  normalizeDuplicateConfig,
} = require('./duplicate-pr');

const BOT_COMMENT_MARKER = '<!-- heimdall-bot -->';

const DEFAULT_CONFIG = Object.freeze({
  aiSlopThreshold: 45,
  lowEffortThreshold: 40,
  aiSlopLabel: 'triage:ai-slop',
  lowEffortLabel: 'triage:low-effort',
  humanReviewedLabel: 'reviewed-by-human',
  trustedAuthors: ['dependabot[bot]', 'renovate[bot]'],
  trustedTitlePatterns: ['^docs:', '^chore\\\\(deps\\\\):', '^build\\\\(deps\\\\):'],
  minFindingsForLabel: 2,
  sizeLabels: ['size/XS', 'size/S', 'size/M', 'size/L', 'size/XL'],
  sizeThresholds: [10, 100, 500, 1000],
});

const SIZE_LABEL_COLORS = ['3cbf00', '5d9801', 'fbca04', 'ff9500', 'e11d48'];

const GENERIC_TITLE_RE = /^(update[ds]?|fix(e[ds])?|changes?|misc|improvements?|refactor(ed)?|cleanup|wip|add(ed)?|remove[ds]?|delete[ds]?|modify|modifie[ds]|tweak(ed)?|adjust(ed)?|bump(ed)?)\b/i;
const GENERIC_COMMIT_RE = /^(fix|update|changes?|misc|refactor|cleanup|wip|address review comments|apply suggestions?)($|[:\s])/i;
const AI_DISCLOSURE_RE = /(generated|written)\s+(?:primarily\s+)?(?:by|with)\s+(?:ai|chatgpt|claude|copilot)/i;
const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^./]+$/i;

const DOCS_OR_CONFIG_EXTENSIONS = new Set([
  'md',
  'mdx',
  'txt',
  'rst',
  'adoc',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'lock',
]);

const SOURCE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'java',
  'kt',
  'rs',
  'rb',
  'php',
  'cs',
  'swift',
  'scala',
  'lua',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
]);

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

function normalizeConfig(inputConfig) {
  const config = { ...DEFAULT_CONFIG, ...inputConfig };

  return {
    ...config,
    aiSlopThreshold: parseInteger(config.aiSlopThreshold, DEFAULT_CONFIG.aiSlopThreshold),
    lowEffortThreshold: parseInteger(config.lowEffortThreshold, DEFAULT_CONFIG.lowEffortThreshold),
    minFindingsForLabel: parseInteger(config.minFindingsForLabel, DEFAULT_CONFIG.minFindingsForLabel),
    trustedAuthors: Array.isArray(config.trustedAuthors) ? config.trustedAuthors : [],
    trustedTitlePatterns: Array.isArray(config.trustedTitlePatterns) ? config.trustedTitlePatterns : [],
    sizeLabels: Array.isArray(config.sizeLabels) ? config.sizeLabels : DEFAULT_CONFIG.sizeLabels,
    sizeThresholds: Array.isArray(config.sizeThresholds)
      ? config.sizeThresholds.map(Number).filter((n) => !Number.isNaN(n))
      : DEFAULT_CONFIG.sizeThresholds,
  };
}

function buildConfigFromEnv(env) {
  const overrides = {};

  if (env.TRIAGE_AI_SLOP_THRESHOLD) overrides['aiSlopThreshold'] = env.TRIAGE_AI_SLOP_THRESHOLD;
  if (env.TRIAGE_LOW_EFFORT_THRESHOLD) overrides['lowEffortThreshold'] = env.TRIAGE_LOW_EFFORT_THRESHOLD;
  if (env.TRIAGE_AI_SLOP_LABEL) overrides['aiSlopLabel'] = env.TRIAGE_AI_SLOP_LABEL;
  if (env.TRIAGE_LOW_EFFORT_LABEL) overrides['lowEffortLabel'] = env.TRIAGE_LOW_EFFORT_LABEL;
  if (env.TRIAGE_HUMAN_REVIEWED_LABEL) overrides['humanReviewedLabel'] = env.TRIAGE_HUMAN_REVIEWED_LABEL;
  if (env.TRIAGE_TRUSTED_AUTHORS) overrides['trustedAuthors'] = parseCsv(env.TRIAGE_TRUSTED_AUTHORS);
  if (env.TRIAGE_TRUSTED_TITLE_REGEX)
    overrides['trustedTitlePatterns'] = parseCsv(env.TRIAGE_TRUSTED_TITLE_REGEX);
  if (env.TRIAGE_MIN_FINDINGS) overrides['minFindingsForLabel'] = env.TRIAGE_MIN_FINDINGS;
  if (env.TRIAGE_SIZE_THRESHOLDS)
    overrides['sizeThresholds'] = parseCsv(env.TRIAGE_SIZE_THRESHOLDS).map(Number);
  if (env.TRIAGE_SIZE_LABELS) overrides['sizeLabels'] = parseCsv(env.TRIAGE_SIZE_LABELS);

  return normalizeConfig(overrides);
}

function getLowerExtension(filename) {
  const segments = filename.toLowerCase().split('.');
  if (segments.length < 2) {
    return '';
  }

  return segments[segments.length - 1];
}

function isTestFile(filename) {
  return TEST_FILE_RE.test(filename);
}

function isDocsOrConfigFile(filename) {
  const normalized = filename.toLowerCase();
  if (normalized.startsWith('docs/') || normalized.startsWith('.github/')) {
    return true;
  }

  if (normalized === 'readme' || normalized.startsWith('readme.')) {
    return true;
  }

  const extension = getLowerExtension(filename);
  return DOCS_OR_CONFIG_EXTENSIONS.has(extension);
}

function isSourceFile(filename) {
  if (isTestFile(filename)) {
    return true;
  }

  const extension = getLowerExtension(filename);
  return SOURCE_EXTENSIONS.has(extension);
}

function buildFinding(id, category, points, detail) {
  return { id, category, points, detail };
}

function scoreCategory(findings, threshold, minFindings) {
  const score = Math.min(
    100,
    findings.reduce((total, finding) => total + finding.points, 0),
  );

  return {
    score,
    threshold,
    findings,
    flagged: score >= threshold && findings.length >= minFindings,
  };
}

function determineSizeLabel(totalLinesChanged, config) {
  const thresholds = config.sizeThresholds;
  const labels = config.sizeLabels;

  for (let i = 0; i < thresholds.length; i++) {
    if (totalLinesChanged < thresholds[i]) {
      return labels[i];
    }
  }

  return labels[labels.length - 1];
}

function normalizeCommitMessage(message) {
  return message.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function analyzePullRequest({ pr, files, commits, config }) {
  const effectiveConfig = normalizeConfig(config);

  const title = (pr.title || '').trim();
  const body = (pr.body || '').trim();
  const bodyLength = body.length;
  const totalLinesChanged = (pr.additions || 0) + (pr.deletions || 0);
  const fileCount = files.length || pr.changed_files || 0;
  const fileNames = files.map((file) => file.filename);

  const hasTests = fileNames.some((filename) => isTestFile(filename));
  const hasSource = fileNames.some((filename) => isSourceFile(filename) && !isDocsOrConfigFile(filename));
  const docsOrConfigOnly = fileNames.length > 0 && fileNames.every((filename) => isDocsOrConfigFile(filename));

  const commitHeadlines = commits.map((commit) => {
    const message = (commit.commit && commit.commit.message) || '';
    return message.split('\n')[0].trim();
  });

  const genericCommitCount = commitHeadlines.filter((headline) => GENERIC_COMMIT_RE.test(headline)).length;
  const genericCommitRatio = commitHeadlines.length > 0 ? genericCommitCount / commitHeadlines.length : 0;
  const normalizedCommits = commitHeadlines.map((headline) => normalizeCommitMessage(headline));
  const uniqueCommitCount = new Set(normalizedCommits).size;
  const uniqueCommitRatio = commitHeadlines.length > 0 ? uniqueCommitCount / commitHeadlines.length : 1;
  const churnPerFile = fileCount > 0 ? totalLinesChanged / fileCount : 0;

  const lowEffortFindings = [];
  const aiSlopFindings = [];

  if (bodyLength < 40) {
    lowEffortFindings.push(
      buildFinding('minimal-description', 'low-effort', 28, 'PR description is under 40 characters.'),
    );
  } else if (bodyLength < 120) {
    lowEffortFindings.push(
      buildFinding('short-description', 'low-effort', 15, 'PR description is under 120 characters.'),
    );
  }

  if (title.length < 12 || GENERIC_TITLE_RE.test(title)) {
    lowEffortFindings.push(
      buildFinding('generic-title', 'low-effort', 10, 'PR title is very generic or too short.'),
    );
    aiSlopFindings.push(
      buildFinding('generic-title-ai-signal', 'ai-slop', 8, 'Generic PR title is a weak AI-slop signal.'),
    );
  }

  if (hasSource && !hasTests && totalLinesChanged >= 300) {
    lowEffortFindings.push(
      buildFinding('no-tests-large-change', 'low-effort', 24, 'Large source-code change without tests.'),
    );
    aiSlopFindings.push(
      buildFinding('no-tests-large-change-ai-signal', 'ai-slop', 16, 'Large source-code change without tests.'),
    );
  } else if (hasSource && !hasTests && fileCount >= 6) {
    lowEffortFindings.push(
      buildFinding('no-tests-medium-change', 'low-effort', 12, 'Multi-file source change without tests.'),
    );
  }

  if (fileCount >= 25) {
    lowEffortFindings.push(buildFinding('very-wide-pr', 'low-effort', 12, 'PR spans at least 25 files.'));
  } else if (fileCount >= 15) {
    lowEffortFindings.push(buildFinding('wide-pr', 'low-effort', 7, 'PR spans at least 15 files.'));
  }

  if (totalLinesChanged >= 1200) {
    lowEffortFindings.push(
      buildFinding('very-large-pr', 'low-effort', 12, 'PR changes at least 1,200 lines.'),
    );
  } else if (totalLinesChanged >= 500) {
    lowEffortFindings.push(buildFinding('large-pr', 'low-effort', 7, 'PR changes at least 500 lines.'));
  }

  if (totalLinesChanged <= 10 && fileCount <= 2 && bodyLength < 120) {
    lowEffortFindings.push(
      buildFinding('trivial-change', 'low-effort', 15, 'Trivially small change with minimal context.'),
    );
  }

  if (commitHeadlines.length >= 2 && genericCommitRatio === 1) {
    aiSlopFindings.push(
      buildFinding('all-generic-commits', 'ai-slop', 30, 'All commit messages are generic.'),
    );
  } else if (commitHeadlines.length >= 2 && genericCommitRatio >= 0.6) {
    aiSlopFindings.push(
      buildFinding('mostly-generic-commits', 'ai-slop', 16, 'Most commit messages are generic.'),
    );
  }

  if (commitHeadlines.length >= 4 && uniqueCommitRatio < 0.6) {
    aiSlopFindings.push(
      buildFinding('repetitive-commit-patterns', 'ai-slop', 10, 'Commit messages are repetitive.'),
    );
  }

  if (fileCount >= 8 && churnPerFile >= 200) {
    aiSlopFindings.push(
      buildFinding('high-churn-per-file', 'ai-slop', 18, 'High average churn per changed file.'),
    );
  } else if (fileCount >= 5 && churnPerFile >= 120) {
    aiSlopFindings.push(
      buildFinding('moderate-churn-per-file', 'ai-slop', 10, 'Moderately high churn per changed file.'),
    );
  }

  if (AI_DISCLOSURE_RE.test(body)) {
    aiSlopFindings.push(
      buildFinding(
        'explicit-ai-disclosure',
        'ai-slop',
        20,
        'PR description explicitly says the change was generated by AI.',
      ),
    );
  }

  if (genericCommitRatio >= 0.6 && bodyLength < 120) {
    aiSlopFindings.push(
      buildFinding(
        'generic-metadata-combination',
        'ai-slop',
        10,
        'Generic commit messages combined with low-context PR description.',
      ),
    );
  }

  const sizeLabel = determineSizeLabel(totalLinesChanged, effectiveConfig);

  return {
    bypassed: false,
    bypassReason: null,
    sizeLabel,
    summary: {
      bodyLength,
      totalLinesChanged,
      fileCount,
      hasSource,
      hasTests,
      commitCount: commits.length,
      genericCommitRatio,
      churnPerFile,
    },
    lowEffort: scoreCategory(
      lowEffortFindings,
      effectiveConfig.lowEffortThreshold,
      effectiveConfig.minFindingsForLabel,
    ),
    aiSlop: scoreCategory(
      aiSlopFindings,
      effectiveConfig.aiSlopThreshold,
      effectiveConfig.minFindingsForLabel,
    ),
  };
}

function getDesiredLabels(analysis, config) {
  const labels = [];

  if (analysis.sizeLabel) {
    labels.push(analysis.sizeLabel);
  }

  if (analysis.lowEffort.flagged) {
    labels.push(config.lowEffortLabel);
  }

  if (analysis.aiSlop.flagged) {
    labels.push(config.aiSlopLabel);
  }

  return labels;
}

function renderCategory(name, categoryResult) {
  const lines = [`### ${name}`, '', `- Score: **${categoryResult.score}/100** (threshold: ${categoryResult.threshold})`];

  if (categoryResult.findings.length === 0) {
    lines.push('- No strong signals found.');
    return lines.join('\n');
  }

  for (const finding of categoryResult.findings) {
    lines.push(`- ${finding.detail} (+${finding.points})`);
  }

  return lines.join('\n');
}

function buildCommentBody(analysis, config) {
  const sections = [
    BOT_COMMENT_MARKER,
    '## PR Triage Result',
    '',
    'This automated triage checks for low-effort and AI-slop signals to help maintainers filter PRs quickly.',
    '',
    renderCategory('Low-effort signals', analysis.lowEffort),
    '',
    renderCategory('AI-slop signals', analysis.aiSlop),
    '',
    `If this is a false positive, add the \`${config.humanReviewedLabel}\` label to skip future automatic triage on this PR.`,
  ];

  return sections.join('\n');
}

function isTrustedAuthor(author, config) {
  return config.trustedAuthors.map((item) => item.toLowerCase()).includes((author || '').toLowerCase());
}

function matchesTrustedTitlePattern(title, config) {
  for (const pattern of config.trustedTitlePatterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(title || '')) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function ensureManagedLabelsExist({ github, owner, repo, config }) {
  const labelDefinitions = [
    {
      name: config.lowEffortLabel,
      color: 'd93f0b',
      description: 'Automated triage: low-effort pull request signals detected.',
    },
    {
      name: config.aiSlopLabel,
      color: 'b60205',
      description: 'Automated triage: AI-slop pull request signals detected.',
    },
  ];

  for (let i = 0; i < config.sizeLabels.length; i++) {
    labelDefinitions.push({
      name: config.sizeLabels[i],
      color: SIZE_LABEL_COLORS[i] || SIZE_LABEL_COLORS[SIZE_LABEL_COLORS.length - 1],
      description: `PR size classification: ${config.sizeLabels[i]}.`,
    });
  }

  for (const label of labelDefinitions) {
    try {
      await github.rest.issues.createLabel({
        owner,
        repo,
        name: label.name,
        color: label.color,
        description: label.description,
      });
    } catch (error) {
      if (!error || error.status !== 422) {
        throw error;
      }
    }
  }
}

async function syncManagedLabels({
  github,
  owner,
  repo,
  issueNumber,
  existingLabels,
  desiredLabels,
  config,
}) {
  const managedLabelSet = new Set([config.lowEffortLabel, config.aiSlopLabel, ...config.sizeLabels]);
  const existingSet = new Set(existingLabels);

  const labelsToAdd = desiredLabels.filter((label) => !existingSet.has(label));
  const labelsToRemove = existingLabels.filter(
    (label) => managedLabelSet.has(label) && !desiredLabels.includes(label),
  );

  if (labelsToAdd.length > 0) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: labelsToAdd,
    });
  }

  for (const label of labelsToRemove) {
    try {
      await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      if (!error || error.status !== 404) {
        throw error;
      }
    }
  }
}

async function findExistingManagedComment({ github, owner, repo, issueNumber, marker }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  return comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(marker));
}

async function upsertTriageComment({ github, owner, repo, issueNumber, body }) {
  await upsertManagedComment({
    github,
    owner,
    repo,
    issueNumber,
    body,
    marker: BOT_COMMENT_MARKER,
  });
}

async function upsertDuplicateComment({ github, owner, repo, issueNumber, body }) {
  await upsertManagedComment({
    github,
    owner,
    repo,
    issueNumber,
    body,
    marker: DUPLICATE_COMMENT_MARKER,
  });
}

async function upsertManagedComment({ github, owner, repo, issueNumber, body, marker }) {
  // if already comment posted for duplicate PR, update instead of creating new comment
  const existingComment = await findExistingManagedComment({
    github,
    owner,
    repo,
    issueNumber,
    marker,
  });

  if (existingComment) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });
    return;
  }

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

async function deleteTriageComment({ github, owner, repo, issueNumber }) {
  await deleteManagedComment({
    github,
    owner,
    repo,
    issueNumber,
    marker: BOT_COMMENT_MARKER,
  });
}

async function deleteDuplicateComment({ github, owner, repo, issueNumber }) {
  await deleteManagedComment({
    github,
    owner,
    repo,
    issueNumber,
    marker: DUPLICATE_COMMENT_MARKER,
  });
}

async function deleteManagedComment({ github, owner, repo, issueNumber, marker }) {
  const existingComment = await findExistingManagedComment({
    github,
    owner,
    repo,
    issueNumber,
    marker,
  });

  if (!existingComment) {
    return;
  }

  await github.rest.issues.deleteComment({
    owner,
    repo,
    comment_id: existingComment.id,
  });
}

function buildSkippedDuplicateDetection(skipReason) {
  return {
    checked: false,
    skipReason,
    flagged: false,
    candidateCount: 0,
    comparedCount: 0,
    matches: [],
    bestMatch: null,
    reverts: [],
    thresholds: null,
  };
}

async function runDuplicateCheckForPullRequest({
  github,
  owner,
  repo,
  pullNumber,
  fullPullRequest,
  files,
  duplicateConfig,
  eventAction,
  logger,
}) {
  const log = toLogger(logger);
  const effectiveDuplicateConfig = normalizeDuplicateConfig(duplicateConfig);

  if (!effectiveDuplicateConfig.enabled) {
    return buildSkippedDuplicateDetection('disabled');
  }

  if (effectiveDuplicateConfig.onlyOnOpened && eventAction && eventAction !== 'opened' && eventAction !== 'reopened') {
    return buildSkippedDuplicateDetection('non-opened-action');
  }

  if (!github || !github.rest || !github.rest.pulls || typeof github.rest.pulls.list !== 'function') {
    log.warning('Duplicate detection skipped: github.rest.pulls.list is unavailable in this client.');
    return buildSkippedDuplicateDetection('unsupported-client');
  }

  const duplicateResult = await detectDuplicatePullRequest({
    github,
    owner,
    repo,
    currentPullRequest: fullPullRequest,
    currentFiles: files,
    config: effectiveDuplicateConfig,
    logger: log,
  });

  if (duplicateResult.flagged) {
    const commentBody = buildDuplicateCommentBody({
      detectionResult: duplicateResult,
      currentPullRequest: fullPullRequest,
    });
    if (commentBody) {
      log.info(`Posting duplicate comment on ${owner}/${repo}#${pullNumber} (matches=${duplicateResult.matches.length}).`);
      await upsertDuplicateComment({
        github,
        owner,
        repo,
        issueNumber: pullNumber,
        body: commentBody,
      });
    } else {
      log.warning(`Duplicate flagged for ${owner}/${repo}#${pullNumber} but comment body was empty; skipping upsert.`);
    }
  } else if (duplicateResult.checked) {
    await deleteDuplicateComment({ github, owner, repo, issueNumber: pullNumber });
  }

  return duplicateResult;
}

function toLogger(logger) {
  if (!logger) {
    return {
      info: () => {},
      warning: () => {},
      error: () => {},
    };
  }

  const info = typeof logger.info === 'function' ? logger.info.bind(logger) : () => {};
  const warningCandidate =
    typeof logger.warning === 'function'
      ? logger.warning.bind(logger)
      : typeof logger.warn === 'function'
        ? logger.warn.bind(logger)
        : () => {};
  const error = typeof logger.error === 'function' ? logger.error.bind(logger) : () => {};

  return {
    info,
    warning: warningCandidate,
    error,
  };
}

async function runTriageForPullRequest({
  github,
  owner,
  repo,
  pullNumber,
  config,
  duplicateConfig = null,
  eventAction,
  logger,
}) {
  const log = toLogger(logger);
  const effectiveConfig = normalizeConfig(config);

  if (!github) {
    throw new Error('GitHub client is required.');
  }

  if (!owner || !repo || !pullNumber) {
    throw new Error('owner, repo, and pullNumber are required.');
  }

  const { data: fullPullRequest } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const currentLabelNames = (fullPullRequest.labels || []).map((label) => label.name);
  const author = fullPullRequest.user ? fullPullRequest.user.login : '';

  if (currentLabelNames.includes(effectiveConfig.humanReviewedLabel)) {
    await syncManagedLabels({
      github,
      owner,
      repo,
      issueNumber: pullNumber,
      existingLabels: currentLabelNames,
      desiredLabels: [],
      config: effectiveConfig,
    });
    await deleteTriageComment({ github, owner, repo, issueNumber: pullNumber });
    await deleteDuplicateComment({ github, owner, repo, issueNumber: pullNumber });
    log.info('Skipping triage because PR has the human-reviewed override label.');
    return {
      skipped: true,
      skipReason: 'human-reviewed',
      analysis: null,
      desiredLabels: [],
      duplicateDetection: buildSkippedDuplicateDetection('triage-bypassed-human-reviewed'),
    };
  }

  if (isTrustedAuthor(author, effectiveConfig)) {
    await syncManagedLabels({
      github,
      owner,
      repo,
      issueNumber: pullNumber,
      existingLabels: currentLabelNames,
      desiredLabels: [],
      config: effectiveConfig,
    });
    await deleteTriageComment({ github, owner, repo, issueNumber: pullNumber });
    await deleteDuplicateComment({ github, owner, repo, issueNumber: pullNumber });
    log.info(`Skipping triage for trusted author: ${author}.`);
    return {
      skipped: true,
      skipReason: 'trusted-author',
      analysis: null,
      desiredLabels: [],
      duplicateDetection: buildSkippedDuplicateDetection('triage-bypassed-trusted-author'),
    };
  }

  if (matchesTrustedTitlePattern(fullPullRequest.title || '', effectiveConfig)) {
    await syncManagedLabels({
      github,
      owner,
      repo,
      issueNumber: pullNumber,
      existingLabels: currentLabelNames,
      desiredLabels: [],
      config: effectiveConfig,
    });
    await deleteTriageComment({ github, owner, repo, issueNumber: pullNumber });
    await deleteDuplicateComment({ github, owner, repo, issueNumber: pullNumber });
    log.info('Skipping triage because title matches an allowlisted pattern.');
    return {
      skipped: true,
      skipReason: 'trusted-title',
      analysis: null,
      desiredLabels: [],
      duplicateDetection: buildSkippedDuplicateDetection('triage-bypassed-trusted-title'),
    };
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  let duplicateDetection: any = buildSkippedDuplicateDetection('not-run');
  try {
    duplicateDetection = await runDuplicateCheckForPullRequest({
      github,
      owner,
      repo,
      pullNumber,
      fullPullRequest,
      files,
      duplicateConfig,
      eventAction,
      logger: log,
    });
  } catch (error) {
    duplicateDetection = buildSkippedDuplicateDetection('error');
    log.warning(`Duplicate detection failed for ${owner}/${repo}#${pullNumber}. Continuing triage.`);
    log.error(error);
  }

  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const analysis = analyzePullRequest({
    pr: fullPullRequest,
    files,
    commits,
    config: effectiveConfig,
  });

  const desiredLabels = analysis.bypassed ? [] : getDesiredLabels(analysis, effectiveConfig);
  const hasTriageLabels = analysis.lowEffort.flagged || analysis.aiSlop.flagged;

  if (desiredLabels.length > 0) {
    await ensureManagedLabelsExist({ github, owner, repo, config: effectiveConfig });
  }

  await syncManagedLabels({
    github,
    owner,
    repo,
    issueNumber: pullNumber,
    existingLabels: currentLabelNames,
    desiredLabels,
    config: effectiveConfig,
  });

  if (!hasTriageLabels) {
    await deleteTriageComment({ github, owner, repo, issueNumber: pullNumber });
  } else {
    const commentBody = buildCommentBody(analysis, effectiveConfig);
    await upsertTriageComment({
      github,
      owner,
      repo,
      issueNumber: pullNumber,
      body: commentBody,
    });
  }

  return {
    skipped: false,
    skipReason: null,
    analysis,
    desiredLabels,
    duplicateDetection,
  };
}

async function runTriage({ github, context, core, config }) {
  const pullRequest = context.payload.pull_request;

  if (!pullRequest) {
    core.info('No pull request in event payload. Skipping triage.');
    return;
  }

  const result = await runTriageForPullRequest({
    github,
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullNumber: pullRequest.number,
    config,
    eventAction: context.payload.action,
    logger: {
      info: core.info.bind(core),
      warning: core.warning.bind(core),
      error: core.error.bind(core),
    },
  });

  if (!result || result.skipped || !result.analysis) {
    core.setOutput('ai_slop_score', '0');
    core.setOutput('low_effort_score', '0');
    core.setOutput('labels_applied', '');
    return;
  }

  core.setOutput('ai_slop_score', String(result.analysis.aiSlop.score));
  core.setOutput('low_effort_score', String(result.analysis.lowEffort.score));
  core.setOutput('labels_applied', result.desiredLabels.join(','));
}

module.exports = {
  BOT_COMMENT_MARKER,
  DEFAULT_CONFIG,
  SIZE_LABEL_COLORS,
  analyzePullRequest,
  buildCommentBody,
  buildConfigFromEnv,
  determineSizeLabel,
  getDesiredLabels,
  isDocsOrConfigFile,
  isSourceFile,
  isTestFile,
  parseCsv,
  runTriage,
  runTriageForPullRequest,
};
