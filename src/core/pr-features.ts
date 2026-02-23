'use strict';

import { normalizeCodeLine } from './utils';

const STOP_WORDS: ReadonlySet<string> = new Set([
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

export function tokenizeLine(value: string | null | undefined): string[] {
  const normalized = normalizeCodeLine(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function matchFirstGroup(value: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match && match[1]) {
      return match[1].trim().toLowerCase();
    }
  }

  return null;
}
