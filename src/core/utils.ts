'use strict';

import { createHash } from 'node:crypto';

export function parseCsv(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseInteger(value: string | number | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

export function parseNumber(value: string | number | null | undefined, fallback: number): number {
  const parsed = Number.parseFloat(String(value));
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

export function parseBoolean(
  value: string | number | boolean | null | undefined,
  fallback: boolean,
): boolean {
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

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

export function toSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizePath(filename: string | null | undefined): string {
  return String(filename || '').replace(/\\/g, '/').trim();
}

export function getTopLevelDirectory(filename: string | null | undefined): string {
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

export function normalizeCodeLine(value: string | null | undefined): string {
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

export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  task: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<TResult>(items.length);
  let cursor = 0;

  const workers: Promise<void>[] = [];
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

export function formatPercent(score: number): string {
  return `${Math.round(clamp(score, 0, 1) * 100)}%`;
}

export function mergeSets<TValue>(target: Set<TValue>, source: Iterable<TValue>): void {
  for (const item of source) {
    target.add(item);
  }
}

export function toFrequencyMap(tokens: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}
