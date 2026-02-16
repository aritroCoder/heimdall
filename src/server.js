'use strict';

const { createServer } = require('node:http');

const { buildConfigFromEnv, runTriageForPullRequest } = require('./triage.js');

const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'edited',
  'ready_for_review',
  'labeled',
  'unlabeled',
]);

function normalizePrivateKey(privateKey) {
  if (!privateKey) {
    return '';
  }

  return privateKey.replace(/\\n/g, '\n');
}

function requireEnv(name, env) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getPort(env) {
  const parsed = Number.parseInt(env.PORT || '3000', 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 3000;
  }

  return parsed;
}

function createFallbackPaginate(request) {
  return async (routeOrMethod, params = {}) => {
    const results = [];
    const perPage = params.per_page || 100;
    let page = params.page || 1;

    while (true) {
      const pageParams = { ...params, per_page: perPage, page };
      const response =
        typeof routeOrMethod === 'function'
          ? await routeOrMethod(pageParams)
          : await request(routeOrMethod, pageParams);

      if (!response || !Array.isArray(response.data)) {
        return response && response.data;
      }

      results.push(...response.data);

      if (response.data.length < perPage) {
        return results;
      }

      page += 1;

      if (page > 100) {
        return results;
      }
    }
  };
}

function createRestCompatClient(octokit) {
  if (octokit && octokit.rest && octokit.paginate) {
    return octokit;
  }

  if (!octokit || typeof octokit.request !== 'function') {
    throw new Error('Octokit request client is unavailable for webhook event.');
  }

  const request = octokit.request.bind(octokit);
  const paginate =
    typeof octokit.paginate === 'function'
      ? octokit.paginate.bind(octokit)
      : createFallbackPaginate(request);

  return {
    rest: {
      pulls: {
        get: (params) => request('GET /repos/{owner}/{repo}/pulls/{pull_number}', params),
        listFiles: (params) => request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', params),
        listCommits: (params) =>
          request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', params),
      },
      issues: {
        createLabel: (params) => request('POST /repos/{owner}/{repo}/labels', params),
        addLabels: (params) =>
          request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', params),
        removeLabel: (params) =>
          request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', params),
        listComments: (params) =>
          request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', params),
        updateComment: (params) =>
          request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', params),
        createComment: (params) =>
          request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', params),
        deleteComment: (params) =>
          request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', params),
      },
    },
    paginate,
  };
}

async function createGithubApp({ env = process.env, logger = console } = {}) {
  const [{ App }, { createNodeMiddleware }] = await Promise.all([
    import('@octokit/app'),
    import('@octokit/webhooks'),
  ]);

  const appId = requireEnv('GITHUB_APP_ID', env);
  const privateKey = normalizePrivateKey(requireEnv('GITHUB_APP_PRIVATE_KEY', env));
  const webhookSecret = requireEnv('GITHUB_WEBHOOK_SECRET', env);
  const triageConfig = buildConfigFromEnv(env);

  const app = new App({
    appId,
    privateKey,
    webhooks: {
      secret: webhookSecret,
    },
  });

  app.webhooks.on('pull_request', async ({ payload }) => {
    if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(payload.action)) {
      return;
    }

    if (!payload.pull_request || payload.pull_request.state !== 'open') {
      return;
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pullNumber = payload.pull_request.number;
    const installationId = payload.installation && payload.installation.id;

    if (!installationId) {
      logger.error(`Missing installation id for ${owner}/${repo}#${pullNumber}; skipping triage.`);
      return;
    }

    const octokit = await app.getInstallationOctokit(installationId);
    const github = createRestCompatClient(octokit);

    const result = await runTriageForPullRequest({
      github,
      owner,
      repo,
      pullNumber,
      config: triageConfig,
      logger,
    });

    if (result.skipped) {
      logger.info(
        `Triage skipped for ${owner}/${repo}#${pullNumber}: ${result.skipReason || 'unspecified reason'}`,
      );
      return;
    }

    const { lowEffort, aiSlop } = result.analysis;
    const formatFindings = (findings) =>
      findings.length === 0
        ? 'none'
        : findings.map((f) => `${f.id} (+${f.points})`).join(', ');

    logger.info(
      `Triage completed for ${owner}/${repo}#${pullNumber}\n` +
        `  low-effort: ${lowEffort.score}/100 (threshold ${lowEffort.threshold}, flagged=${lowEffort.flagged})\n` +
        `    findings: ${formatFindings(lowEffort.findings)}\n` +
        `  ai-slop:    ${aiSlop.score}/100 (threshold ${aiSlop.threshold}, flagged=${aiSlop.flagged})\n` +
        `    findings: ${formatFindings(aiSlop.findings)}\n` +
        `  labels: ${result.desiredLabels.join(', ') || 'none'}`,
    );
  });

  app.webhooks.onError((error) => {
    logger.error('Webhook processing failed.', error);
  });

  return { app, createNodeMiddleware };
}

async function startServer({ env = process.env, logger = console } = {}) {
  const { app, createNodeMiddleware } = await createGithubApp({ env, logger });
  const middleware = createNodeMiddleware(app.webhooks, {
    path: '/api/github/webhooks',
  });

  const port = getPort(env);
  const server = createServer(middleware);

  await new Promise((resolve, reject) => {
    server.listen(port, () => {
      logger.info(`GitHub App webhook server listening on port ${port}.`);
      resolve();
    });
    server.on('error', reject);
  });

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  SUPPORTED_PULL_REQUEST_ACTIONS,
  createFallbackPaginate,
  createGithubApp,
  createRestCompatClient,
  getPort,
  normalizePrivateKey,
  startServer,
};
