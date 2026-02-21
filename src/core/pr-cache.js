
"use strict";

const REPRESENTATION_CACHE_MAX_ENTRIES = 2000;
const representationCache = new Map();

function getRepresentationCacheKey({ owner, repo, pullRequest, config }) {
  const updatedAt = pullRequest.updated_at || '';
  const headSha = pullRequest.head && pullRequest.head.sha ? pullRequest.head.sha : '';
  return [
    owner,
    repo,
    pullRequest.number,
    updatedAt,
    headSha,
    config.maxPatchCharactersPerFile,
    config.metadataVectorSize,
  ].join('|');
}

function getCachedRepresentation(cacheKey) {
  if (!representationCache.has(cacheKey)) {
    return null;
  }

  const cachedValue = representationCache.get(cacheKey);
  representationCache.delete(cacheKey);
  representationCache.set(cacheKey, cachedValue);
  return cachedValue;
}

function setCachedRepresentation(cacheKey, representation) {
  if (representationCache.has(cacheKey)) {
    representationCache.delete(cacheKey);
  }

  representationCache.set(cacheKey, representation);
  while (representationCache.size > REPRESENTATION_CACHE_MAX_ENTRIES) {
    const oldestKey = representationCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    representationCache.delete(oldestKey);
  }
}

module.exports = {
  getCachedRepresentation,
  getRepresentationCacheKey,
  setCachedRepresentation,
};
