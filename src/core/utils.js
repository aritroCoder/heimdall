"use strict";

const { createHash } = require('node:crypto');

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


function formatPercent(score) {
  return `${Math.round(clamp(score, 0, 1) * 100)}%`;
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

module.exports = {
  clamp,
  formatPercent,
  getTopLevelDirectory,
  mapWithConcurrency,
  normalizeCodeLine,
  normalizePath,
  parseBoolean,
  parseCsv,
  parseInteger,
  parseNumber,
  toSha256,
  toFrequencyMap,
  mergeSets
};
