'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DUPLICATE_COMMENT_MARKER,
  buildDuplicateCommentBody,
  buildDuplicateConfigFromEnv,
  buildPullRequestRepresentation,
  detectDuplicatePullRequest,
  evaluateCandidateSimilarity,
  normalizeDuplicateConfig,
} = require('../src/duplicate-pr.js');

function createPullRequest(number, overrides = {}) {
  return {
    id: number * 10,
    number,
    title: `PR ${number}`,
    body: 'Implements a focused change.',
    html_url: `https://github.com/acme/repo/pull/${number}`,
    state: 'open',
    merged_at: null,
    updated_at: '2026-02-20T00:00:00.000Z',
    created_at: '2026-02-20T00:00:00.000Z',
    changed_files: 1,
    base: { ref: 'main' },
    ...overrides,
  };
}

function createMockGithub({ pullsByState, filesByPull }) {
  const listFilesRoute = () => {};

  return {
    rest: {
      pulls: {
        list: async ({ state, page }) => {
          if (page > 1) {
            return { data: [] };
          }

          return { data: pullsByState[state] || [] };
        },
        listFiles: listFilesRoute,
      },
    },
    paginate: async (route, params) => {
      if (route === listFilesRoute) {
        return filesByPull[params.pull_number] || [];
      }

      throw new Error('Unexpected pagination route in duplicate-pr tests.');
    },
  };
}

test('buildDuplicateConfigFromEnv parses booleans and thresholds', () => {
  const config = buildDuplicateConfigFromEnv({
    DUPLICATE_DETECTION_ENABLED: 'true',
    DUPLICATE_DETECTION_ONLY_ON_OPENED: 'false',
    DUPLICATE_MAX_OPEN_CANDIDATES: '30',
    DUPLICATE_FILE_OVERLAP_THRESHOLD: '0.8',
    DUPLICATE_STRUCTURAL_SIMILARITY_THRESHOLD: '0.9',
    DUPLICATE_SEMANTIC_SIMILARITY_THRESHOLD: '0.95',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.onlyOnOpened, false);
  assert.equal(config.maxOpenCandidates, 30);
  assert.equal(config.fileOverlapThreshold, 0.8);
  assert.equal(config.structuralSimilarityThreshold, 0.9);
  assert.equal(config.semanticSimilarityThreshold, 0.95);
});

test('buildPullRequestRepresentation extracts files, imports, and changed symbols', () => {
  const config = normalizeDuplicateConfig({});
  const representation = buildPullRequestRepresentation({
    pr: createPullRequest(1),
    files: [
      {
        filename: 'src/math.ts',
        patch: [
          '@@ -0,0 +1,5 @@',
          "+import { sum } from './sum';",
          '+export function add(a, b) {',
          '+  return sum(a, b);',
          '+}',
          '+class Calculator {}',
        ].join('\n'),
      },
    ],
    config,
  });

  assert.equal(representation.fileSet.has('src/math.ts'), true);
  assert.equal(representation.topLevelDirectories.has('src'), true);
  assert.equal(representation.importsAdded.has('./sum'), true);
  assert.equal(representation.changedFunctions.has('add'), true);
  assert.equal(representation.changedClasses.has('calculator'), true);
  assert.ok(representation.patchFingerprint.length > 20);
});

test('evaluateCandidateSimilarity marks exact patch-id match as duplicate', () => {
  const config = normalizeDuplicateConfig({});

  const currentRepresentation = buildPullRequestRepresentation({
    pr: createPullRequest(11),
    files: [
      {
        filename: 'src/value.ts',
        patch: '@@ -0,0 +1,2 @@\n+export const value = 1;\n+export const active = true;',
      },
    ],
    config,
  });

  const candidateRepresentation = buildPullRequestRepresentation({
    pr: createPullRequest(12),
    files: [
      {
        filename: 'src/value.ts',
        patch: '@@ -0,0 +1,2 @@\n+export const value = 1;\n+export const active = true;',
      },
    ],
    config,
  });

  const similarity = evaluateCandidateSimilarity(currentRepresentation, candidateRepresentation, config);

  assert.equal(similarity.isDuplicate, true);
  assert.equal(similarity.reason, 'patch-id-match');
  assert.equal(similarity.metrics.patchIdMatch, true);
  assert.equal(similarity.confidence, 1);
});

test('detectDuplicatePullRequest finds duplicate among filtered candidates', async () => {
  const nowIso = new Date().toISOString();
  const currentPull = createPullRequest(100, {
    title: 'feat: add metrics collection endpoint',
    body: 'Adds a metrics endpoint and request counter.',
    changed_files: 2,
  });

  const duplicatePull = createPullRequest(101, {
    title: 'feat(metrics): add endpoint for request counters',
    changed_files: 2,
    base: { ref: 'main' },
  });

  const differentBasePull = createPullRequest(102, {
    title: 'feat: unrelated',
    changed_files: 2,
    base: { ref: 'release' },
  });

  const mergedNonDuplicate = createPullRequest(103, {
    title: 'fix: cleanup parser',
    state: 'closed',
    merged_at: nowIso,
    changed_files: 2,
    base: { ref: 'main' },
  });

  const filesByPull = {
    100: [
      {
        filename: 'src/metrics.ts',
        patch: [
          '@@ -0,0 +1,5 @@',
          "+import { counter } from './counter';",
          '+export function createMetricsEndpoint(app) {',
          "+  app.get('/metrics', () => counter());",
          '+}',
        ].join('\n'),
      },
      {
        filename: 'src/counter.ts',
        patch: '@@ -0,0 +1,2 @@\n+export function counter() {\n+  return 1;\n+}',
      },
    ],
    101: [
      {
        filename: 'src/metrics.ts',
        patch: [
          '@@ -0,0 +1,5 @@',
          "+import { counter } from './counter';",
          '+export function createMetricsEndpoint(app) {',
          "+  app.get('/metrics', () => counter());",
          '+}',
        ].join('\n'),
      },
      {
        filename: 'src/counter.ts',
        patch: '@@ -0,0 +1,2 @@\n+export function counter() {\n+  return 1;\n+}',
      },
    ],
    103: [
      {
        filename: 'src/parser.ts',
        patch: '@@ -1,2 +1,2 @@\n-export const mode = "legacy";\n+export const mode = "strict";',
      },
      {
        filename: 'src/tokenizer.ts',
        patch: '@@ -1 +1 @@\n-export function token() { return "a"; }\n+export function token() { return "b"; }',
      },
    ],
  };

  const github = createMockGithub({
    pullsByState: {
      open: [currentPull, duplicatePull, differentBasePull],
      closed: [mergedNonDuplicate],
    },
    filesByPull,
  });

  const result = await detectDuplicatePullRequest({
    github,
    owner: 'acme',
    repo: 'repo',
    currentPullRequest: currentPull,
    currentFiles: filesByPull[100],
    config: {
      maxOpenCandidates: 20,
      maxMergedCandidates: 20,
      maxCandidateComparisons: 10,
      fileOverlapThreshold: 0.7,
      structuralSimilarityThreshold: 0.8,
      semanticSimilarityThreshold: 0.8,
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.flagged, true);
  assert.equal(result.bestMatch.number, 101);
  assert.ok(result.bestMatch.similarity.metrics.fileOverlap >= 0.7);
});

test('buildDuplicateCommentBody renders marker and top-match breakdown', () => {
  const body = buildDuplicateCommentBody({
    currentPullRequest: createPullRequest(200, { title: 'feat: add endpoint' }),
    detectionResult: {
      flagged: true,
      matches: [
        {
          number: 42,
          state: 'open',
          title: 'feat: add endpoint',
          similarity: {
            confidence: 0.97,
            reason: 'patch-id-match',
            metrics: {
              fileOverlap: 1,
              structuralSimilarity: 1,
              semanticSimilarity: 0.95,
            },
          },
        },
      ],
      reverts: [],
      thresholds: {
        fileOverlap: 0.7,
        structuralSimilarity: 0.85,
        semanticSimilarity: 0.9,
      },
    },
  });

  assert.ok(body.includes(DUPLICATE_COMMENT_MARKER));
  assert.ok(body.includes('#42'));
  assert.ok(body.includes('Confidence: **97%**'));
  assert.ok(body.includes('Thresholds used:'));
});
