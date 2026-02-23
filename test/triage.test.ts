'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzePullRequest,
  BOT_COMMENT_MARKER,
  buildConfigFromEnv,
  determineSizeLabel,
  getDesiredLabels,
  PROCESSING_COMMENT_MARKER,
  DEFAULT_CONFIG,
  runTriageForPullRequest,
} from '../src/triage';
import type {
  GithubClient,
  GithubIssueComment,
  GithubPullRequest,
  GithubPullRequestCommit,
  GithubPullRequestFile,
} from '../src/types';

test('scores docs-only pull requests without bypassing', () => {
  const analysis = analyzePullRequest({
    pr: {
      number: 1,
      title: 'docs: improve setup guide',
      body: 'Updated setup instructions for better clarity.',
      additions: 40,
      deletions: 5,
      changed_files: 1,
    },
    files: [{ filename: 'README.md' }],
    commits: [{ commit: { message: 'docs: update readme' } }],
    config: {},
  });

  assert.equal(analysis.bypassed, false);
  assert.equal(analysis.lowEffort.flagged, false, 'well-described docs PR should not be flagged');
  assert.equal(analysis.aiSlop.flagged, false);
});

test('flags both low-effort and AI-slop when multiple strong signals exist', () => {
  const files = [];
  for (let index = 0; index < 18; index += 1) {
    files.push({ filename: `src/module-${index}.ts` });
  }

  const analysis = analyzePullRequest({
    pr: {
      number: 2,
      title: 'update changes',
      body: 'quick update',
      additions: 1400,
      deletions: 300,
      changed_files: files.length,
    },
    files,
    commits: [
      { commit: { message: 'update' } },
      { commit: { message: 'fix' } },
      { commit: { message: 'cleanup' } },
      { commit: { message: 'update' } },
    ],
    config: {},
  });

  const labels = getDesiredLabels(analysis, {
    lowEffortLabel: 'triage:low-effort',
    aiSlopLabel: 'triage:ai-slop',
  });

  assert.equal(analysis.lowEffort.flagged, true);
  assert.equal(analysis.aiSlop.flagged, true);
  assert.deepEqual(new Set(labels), new Set(['size/XL', 'triage:low-effort', 'triage:ai-slop']));
});

test('does not flag high-context pull requests with tests', () => {
  const analysis = analyzePullRequest({
    pr: {
      number: 3,
      title: 'feat(parser): support escaped commas in CSV input',
      body: [
        '## Summary',
        '',
        '- add parser support for escaped commas',
        '- add regression tests for comma escaping and quote edge-cases',
        '- include migration notes for the parser option rename',
      ].join('\n'),
      additions: 180,
      deletions: 60,
      changed_files: 4,
    },
    files: [
      { filename: 'src/parser/csv.ts' },
      { filename: 'src/parser/tokenizer.ts' },
      { filename: 'test/parser/csv.test.ts' },
      { filename: 'docs/parser.md' },
    ],
    commits: [
      { commit: { message: 'feat(parser): support escaped commas' } },
      { commit: { message: 'test(parser): add escaped comma regressions' } },
    ],
    config: {},
  });

  assert.equal(analysis.bypassed, false);
  assert.equal(analysis.lowEffort.flagged, false);
  assert.equal(analysis.aiSlop.flagged, false);
});

test('buildConfigFromEnv parses numeric and csv settings', () => {
  const config = buildConfigFromEnv({
    TRIAGE_AI_SLOP_THRESHOLD: '60',
    TRIAGE_LOW_EFFORT_THRESHOLD: '55',
    TRIAGE_AI_SLOP_LABEL: 'quality:ai-slop',
    TRIAGE_LOW_EFFORT_LABEL: 'quality:low-effort',
    TRIAGE_TRUSTED_AUTHORS: 'alice,bob',
    TRIAGE_TRUSTED_TITLE_REGEX: '^docs:,^chore:',
    TRIAGE_MIN_FINDINGS: '3',
  });

  assert.equal(config.aiSlopThreshold, 60);
  assert.equal(config.lowEffortThreshold, 55);
  assert.equal(config.aiSlopLabel, 'quality:ai-slop');
  assert.equal(config.lowEffortLabel, 'quality:low-effort');
  assert.deepEqual(config.trustedAuthors, ['alice', 'bob']);
  assert.deepEqual(config.trustedTitlePatterns, ['^docs:', '^chore:']);
  assert.equal(config.minFindingsForLabel, 3);
});

test('determineSizeLabel returns XS for fewer than 10 lines', () => {
  const label = determineSizeLabel(5, DEFAULT_CONFIG);
  assert.equal(label, 'size/XS');
});

test('determineSizeLabel returns S for 10-99 lines', () => {
  assert.equal(determineSizeLabel(10, DEFAULT_CONFIG), 'size/S');
  assert.equal(determineSizeLabel(99, DEFAULT_CONFIG), 'size/S');
});

test('determineSizeLabel returns M for 100-499 lines', () => {
  assert.equal(determineSizeLabel(100, DEFAULT_CONFIG), 'size/M');
  assert.equal(determineSizeLabel(499, DEFAULT_CONFIG), 'size/M');
});

test('determineSizeLabel returns L for 500-999 lines', () => {
  assert.equal(determineSizeLabel(500, DEFAULT_CONFIG), 'size/L');
  assert.equal(determineSizeLabel(999, DEFAULT_CONFIG), 'size/L');
});

test('determineSizeLabel returns XL for 1000+ lines', () => {
  assert.equal(determineSizeLabel(1000, DEFAULT_CONFIG), 'size/XL');
  assert.equal(determineSizeLabel(5000, DEFAULT_CONFIG), 'size/XL');
});

test('determineSizeLabel returns XS for zero lines', () => {
  assert.equal(determineSizeLabel(0, DEFAULT_CONFIG), 'size/XS');
});

test('analyzePullRequest includes sizeLabel in result', () => {
  const analysis = analyzePullRequest({
    pr: {
      number: 4,
      title: 'feat: add new feature',
      body: 'A detailed description of the changes being made here.',
      additions: 80,
      deletions: 15,
      changed_files: 3,
    },
    files: [
      { filename: 'src/feature.ts' },
      { filename: 'src/helper.ts' },
      { filename: 'test/feature.test.ts' },
    ],
    commits: [{ commit: { message: 'feat: add new feature' } }],
    config: {},
  });

  assert.equal(analysis.sizeLabel, 'size/S');
});

test('getDesiredLabels includes size label alongside triage labels', () => {
  const analysis = {
    sizeLabel: 'size/M',
    lowEffort: { flagged: true },
    aiSlop: { flagged: false },
  };

  const labels = getDesiredLabels(analysis, {
    lowEffortLabel: 'triage:low-effort',
    aiSlopLabel: 'triage:ai-slop',
  });

  assert.ok(labels.includes('size/M'), 'should include size label');
  assert.ok(labels.includes('triage:low-effort'), 'should include low-effort label');
  assert.equal(labels.length, 2);
});

test('getDesiredLabels includes only size label when no triage flags', () => {
  const analysis = {
    sizeLabel: 'size/XS',
    lowEffort: { flagged: false },
    aiSlop: { flagged: false },
  };

  const labels = getDesiredLabels(analysis, {
    lowEffortLabel: 'triage:low-effort',
    aiSlopLabel: 'triage:ai-slop',
  });

  assert.deepEqual(labels, ['size/XS']);
});

test('buildConfigFromEnv parses size thresholds and labels', () => {
  const config = buildConfigFromEnv({
    TRIAGE_SIZE_THRESHOLDS: '5,50,200,800',
    TRIAGE_SIZE_LABELS: 'sz/tiny,sz/small,sz/medium,sz/large,sz/huge',
  });

  assert.deepEqual(config.sizeThresholds, [5, 50, 200, 800]);
  assert.deepEqual(config.sizeLabels, ['sz/tiny', 'sz/small', 'sz/medium', 'sz/large', 'sz/huge']);
});

test('opened event adds author label and removes processing comment after triage', async () => {
  const files: GithubPullRequestFile[] = [];
  for (let index = 0; index < 18; index += 1) {
    files.push({ filename: `src/module-${index}.ts` });
  }

  const commits: GithubPullRequestCommit[] = [
    { commit: { message: 'update' } },
    { commit: { message: 'fix' } },
    { commit: { message: 'cleanup' } },
    { commit: { message: 'update' } },
  ];

  const fullPullRequest: GithubPullRequest = {
    id: 100,
    number: 100,
    author_association: 'MEMBER',
    title: 'update changes',
    body: 'quick update',
    state: 'open',
    additions: 1400,
    deletions: 300,
    changed_files: files.length,
    labels: [],
    user: { login: 'alice' },
  };

  const addedLabelCalls: string[][] = [];
  const comments: GithubIssueComment[] = [];
  const createdCommentBodies: string[] = [];
  let nextCommentId = 1;

  const pullList = async (): Promise<{ data: GithubPullRequest[] }> => ({ data: [] });
  const pullGet = async (): Promise<{ data: GithubPullRequest }> => ({ data: fullPullRequest });
  const pullListFiles = async (): Promise<{ data: GithubPullRequestFile[] }> => ({ data: files });
  const pullListCommits = async (): Promise<{ data: GithubPullRequestCommit[] }> => ({ data: commits });
  const issueListComments = async (): Promise<{ data: GithubIssueComment[] }> => ({ data: comments });

  const github: GithubClient = {
    rest: {
      pulls: {
        get: pullGet,
        list: pullList,
        listFiles: pullListFiles,
        listCommits: pullListCommits,
      },
      issues: {
        createLabel: async () => ({}),
        addLabels: async ({ labels }) => {
          addedLabelCalls.push([...labels]);
          return {};
        },
        removeLabel: async () => ({}),
        listComments: issueListComments,
        updateComment: async ({ comment_id, body }) => {
          const existing = comments.find((comment) => comment.id === comment_id);
          if (existing) {
            existing.body = body;
          }
          return {};
        },
        createComment: async ({ body }) => {
          createdCommentBodies.push(body);
          comments.push({ id: nextCommentId, body });
          nextCommentId += 1;
          return {};
        },
        deleteComment: async ({ comment_id }) => {
          const index = comments.findIndex((comment) => comment.id === comment_id);
          if (index !== -1) {
            comments.splice(index, 1);
          }
          return {};
        },
      },
    },
    paginate: async <TParams extends Record<string, unknown>, TItem>(
      route: (params: TParams) => Promise<{ data: TItem[] }>,
      _params: TParams,
    ): Promise<TItem[]> => {
      if (route === (pullListFiles as unknown as typeof route)) {
        return files as unknown as TItem[];
      }

      if (route === (pullListCommits as unknown as typeof route)) {
        return commits as unknown as TItem[];
      }

      if (route === (issueListComments as unknown as typeof route)) {
        return comments as unknown as TItem[];
      }

      throw new Error('Unexpected pagination route in triage test.');
    },
  };

  const result = await runTriageForPullRequest({
    github,
    owner: 'acme',
    repo: 'repo',
    pullNumber: 100,
    config: {},
    duplicateConfig: { enabled: false },
    eventAction: 'opened',
    logger: { info: () => {}, warning: () => {}, error: () => {} },
  });

  assert.equal(result.skipped, false);
  assert.ok(addedLabelCalls.some((labels) => labels.includes('author/member')));
  assert.ok(createdCommentBodies.some((body) => body.includes(PROCESSING_COMMENT_MARKER)));
  assert.equal(
    comments.some((comment) => typeof comment.body === 'string' && comment.body.includes(PROCESSING_COMMENT_MARKER)),
    false,
  );
  assert.equal(
    comments.some((comment) => typeof comment.body === 'string' && comment.body.includes(BOT_COMMENT_MARKER)),
    true,
  );
});
