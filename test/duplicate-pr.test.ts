'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DUPLICATE_COMMENT_MARKER,
  buildDuplicateCommentBody,
  buildDuplicateConfigFromEnv,
  buildPullRequestRepresentation,
  detectDuplicatePullRequest,
  evaluateCandidateSimilarity,
  normalizeDuplicateConfig,
} from '../src/duplicate-pr';
import type {
  GithubClient,
  GithubIssueComment,
  GithubPullRequest,
  GithubPullRequestCommit,
  GithubPullRequestFile,
} from '../src/types';

function createPullRequest(number: number, overrides: Partial<GithubPullRequest> = {}): GithubPullRequest {
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

function createMockGithub({
  pullsByState,
  filesByPull,
}: {
  pullsByState: Record<string, GithubPullRequest[]>;
  filesByPull: Record<number, GithubPullRequestFile[]>;
}): GithubClient {
  const listFilesRoute = async (): Promise<{ data: GithubPullRequestFile[] }> => ({ data: [] });
  const notImplemented = async (): Promise<never> => {
    throw new Error('Unexpected route in duplicate-pr tests.');
  };

  return {
    rest: {
      pulls: {
        get: notImplemented,
        list: async ({ state, page = 1 }) => {
          if (page > 1) {
            return { data: [] };
          }

          return { data: pullsByState[state] || [] };
        },
        listFiles: listFilesRoute,
        listCommits: async (): Promise<{ data: GithubPullRequestCommit[] }> => ({ data: [] }),
      },
      issues: {
        createLabel: notImplemented,
        addLabels: notImplemented,
        removeLabel: notImplemented,
        listComments: async (): Promise<{ data: GithubIssueComment[] }> => ({ data: [] }),
        updateComment: notImplemented,
        createComment: notImplemented,
        deleteComment: notImplemented,
      },
    },
    paginate: async <TParams extends Record<string, unknown>, TItem>(
      _route: (params: TParams) => Promise<{ data: TItem[] }>,
      params: TParams,
    ): Promise<TItem[]> => {
      const pullNumber = Number((params as { pull_number?: unknown }).pull_number);
      return ((Number.isNaN(pullNumber) ? [] : filesByPull[pullNumber] || []) as unknown) as TItem[];
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
    DUPLICATE_METADATA_SIMILARITY_THRESHOLD: '0.95',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.onlyOnOpened, false);
  assert.equal(config.maxOpenCandidates, 30);
  assert.equal(config.fileOverlapThreshold, 0.8);
  assert.equal(config.structuralSimilarityThreshold, 0.9);
  assert.equal(config.metadataSimilarityThreshold, 0.95);
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
      metadataSimilarityThreshold: 0.8,
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.flagged, true);
  assert.ok(result.bestMatch);
  assert.equal(result.bestMatch.number, 101);
  assert.ok(result.bestMatch.similarity.metrics.fileOverlap >= 0.7);
});

test('buildDuplicateCommentBody renders marker and top-match breakdown', () => {
  const body = buildDuplicateCommentBody({
    currentPullRequest: createPullRequest(200, { title: 'feat: add endpoint' }),
    detectionResult: {
      checked: true,
      skipReason: null,
      flagged: true,
      candidateCount: 1,
      comparedCount: 1,
      matches: [
        {
          number: 42,
          htmlUrl: 'https://github.com/acme/repo/pull/42',
          state: 'open',
          title: 'feat: add endpoint',
          mergedAt: null,
          similarity: {
            confidence: 0.97,
            reason: 'patch-id-match',
            isDuplicate: true,
            isRevert: false,
            passesCandidateFilter: true,
            metrics: {
              fileOverlap: 1,
              topLevelDirOverlap: 1,
              fileCountDelta: 0,
              structuralSimilarity: 1,
              metadataSimilarity: 0.95,
              functionOverlap: 1,
              classOverlap: 0,
              importOverlap: 1,
              patchIdMatch: true,
              inversePatchMatch: false,
              normalizedDiffHashMatch: true,
              filePathHashMatch: true,
            },
          },
        },
      ],
      bestMatch: {
        number: 42,
        htmlUrl: 'https://github.com/acme/repo/pull/42',
        state: 'open',
        title: 'feat: add endpoint',
        mergedAt: null,
        similarity: {
          confidence: 0.97,
          reason: 'patch-id-match',
          isDuplicate: true,
          isRevert: false,
          passesCandidateFilter: true,
          metrics: {
            fileOverlap: 1,
            topLevelDirOverlap: 1,
            fileCountDelta: 0,
            structuralSimilarity: 1,
            metadataSimilarity: 0.95,
            functionOverlap: 1,
            classOverlap: 0,
            importOverlap: 1,
            patchIdMatch: true,
            inversePatchMatch: false,
            normalizedDiffHashMatch: true,
            filePathHashMatch: true,
          },
        },
      },
      reverts: [],
      thresholds: {
        fileOverlap: 0.7,
        structuralSimilarity: 0.85,
        metadataSimilarity: 0.9,
      },
    },
  });

  assert.ok(body.includes(DUPLICATE_COMMENT_MARKER));
  assert.ok(body.includes('#42'));
  assert.ok(body.includes('Confidence: **97%**'));
  assert.ok(body.includes('Thresholds used:'));
});
