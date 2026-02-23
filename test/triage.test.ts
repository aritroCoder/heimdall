'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzePullRequest,
  buildConfigFromEnv,
  determineSizeLabel,
  getDesiredLabels,
  DEFAULT_CONFIG,
} from '../src/triage';

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
