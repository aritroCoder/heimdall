'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzePullRequest,
  buildConfigFromEnv,
  getDesiredLabels,
} = require('../src/triage.js');

test('scores docs-only pull requests without bypassing', () => {
  const analysis = analyzePullRequest({
    pr: {
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
  assert.deepEqual(new Set(labels), new Set(['triage:low-effort', 'triage:ai-slop']));
});

test('does not flag high-context pull requests with tests', () => {
  const analysis = analyzePullRequest({
    pr: {
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
