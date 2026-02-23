'use strict';

import type { DuplicateConfig, GithubPullRequest, PullRequestRepresentation } from '../types';

const REPRESENTATION_CACHE_MAX_ENTRIES = 2000;
const representationCache = new Map<string, PullRequestRepresentation>();

export function getRepresentationCacheKey({
  owner,
  repo,
  pullRequest,
  config,
}: {
  owner: string;
  repo: string;
  pullRequest: GithubPullRequest;
  config: Pick<DuplicateConfig, 'maxPatchCharactersPerFile' | 'metadataVectorSize'>;
}): string {
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

export function getCachedRepresentation(cacheKey: string): PullRequestRepresentation | null {
  if (!representationCache.has(cacheKey)) {
    return null;
  }

  const cachedValue = representationCache.get(cacheKey);
  if (!cachedValue) {
    return null;
  }
  representationCache.delete(cacheKey);
  representationCache.set(cacheKey, cachedValue);
  return cachedValue;
}

export function setCachedRepresentation(cacheKey: string, representation: PullRequestRepresentation): void {
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
