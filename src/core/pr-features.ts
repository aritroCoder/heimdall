"use strict";

const { normalizeCodeLine } = require('./utils');

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

module.exports = {
  matchFirstGroup,
  tokenizeLine,
};
