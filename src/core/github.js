"use strict";

async function collectPullRequests({ github, owner, repo, state, limit, mergedLookbackDays }) {
  const results = [];
  const perPage = 100;
  const maxPages = Math.max(1, Math.ceil(limit / perPage) + 2);
  const nowMs = Date.now();
  const lookbackMs = mergedLookbackDays * 24 * 60 * 60 * 1000;

  for (let page = 1; page <= maxPages && results.length < limit; page += 1) {
    const response = await github.rest.pulls.list({
      owner,
      repo,
      state,
      sort: 'updated',
      direction: 'desc',
      per_page: perPage,
      page,
    });
    const pullRequests = Array.isArray(response.data) ? response.data : [];
    if (pullRequests.length === 0) {
      break;
    }

    for (const pullRequest of pullRequests) {
      if (state === 'closed') {
        if (!pullRequest.merged_at) {
          continue;
        }

        const mergedAtMs = Date.parse(pullRequest.merged_at);
        if (Number.isNaN(mergedAtMs) || nowMs - mergedAtMs > lookbackMs) {
          continue;
        }
      }

      results.push(pullRequest);
      if (results.length >= limit) {
        break;
      }
    }

    if (pullRequests.length < perPage) {
      break;
    }
  }

  return results;
}

async function listPullRequestFiles({ github, owner, repo, pullNumber }) {
  return github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
}

module.exports = {
  collectPullRequests,
  listPullRequestFiles,
};
