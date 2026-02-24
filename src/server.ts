'use strict';

import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

import { buildConfigFromEnv, runTriageForPullRequest } from './triage';
import { buildDuplicateConfigFromEnv } from './duplicate-pr';
import type {
    EnvMap,
    GithubClient,
    GithubIssueComment,
    GithubPullRequest,
    LoggerLike,
    PullRequestEventPayload,
    TriageFinding,
} from './types';

interface ServerLogger extends LoggerLike {
    info: (...args: readonly unknown[]) => void;
    error: (...args: readonly unknown[]) => void;
}

type FallbackRequestParams = { per_page?: number; page?: number } & Record<
    string,
    unknown
>;
type RequestMethod = (
    routeOrMethod: string,
    params: FallbackRequestParams
) => Promise<{ data: unknown }>;

export const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
    'opened',
    'reopened',
    'synchronize',
    'edited',
    'ready_for_review',
    'labeled',
    'unlabeled',
]);

export function normalizePrivateKey(
    privateKey: string | null | undefined
): string {
    if (!privateKey) {
        return '';
    }

    return privateKey.replace(/\\n/g, '\n');
}

function requireEnv(name: string, env: EnvMap): string {
    const value = env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

export function getPort(env: EnvMap): number {
    const parsed = Number.parseInt(env.PORT || '3000', 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return 3000;
    }

    return parsed;
}

export function createFallbackPaginate(
    request: RequestMethod
): GithubClient['paginate'] {
    return async function fallbackPaginate<
        TParams extends Record<string, unknown>,
        TItem,
    >(
        routeOrMethod:
            | ((params: TParams) => Promise<{ data: TItem[] }>)
            | string,
        params = {} as TParams
    ): Promise<TItem[]> {
        const typedParams = params as TParams & {
            per_page?: number;
            page?: number;
        };
        const results: TItem[] = [];
        const perPage = typedParams.per_page || 100;
        let page = typedParams.page || 1;

        while (true) {
            const pageParams = { ...typedParams, per_page: perPage, page };
            const response =
                typeof routeOrMethod === 'function'
                    ? await routeOrMethod(pageParams as TParams)
                    : await request(routeOrMethod, pageParams);

            if (!response || !Array.isArray(response.data)) {
                return (response?.data || []) as TItem[];
            }

            const pageData = response.data as TItem[];
            results.push(...pageData);

            if (pageData.length < perPage) {
                return results;
            }

            page += 1;

            if (page > 100) {
                return results;
            }
        }
    };
}

export function createRestCompatClient(octokit: unknown): GithubClient {
    const candidate = octokit as {
        rest?: GithubClient['rest'];
        paginate?: GithubClient['paginate'];
        request?: (
            routeOrMethod: string,
            params: FallbackRequestParams
        ) => Promise<{ data: unknown }>;
    };

    if (candidate.rest && typeof candidate.paginate === 'function') {
        return {
            rest: candidate.rest,
            paginate: candidate.paginate.bind(octokit),
        };
    }

    if (!candidate || typeof candidate.request !== 'function') {
        throw new Error(
            'Octokit request client is unavailable for webhook event.'
        );
    }

    const request = candidate.request.bind(octokit) as RequestMethod;
    const paginate =
        typeof candidate.paginate === 'function'
            ? candidate.paginate.bind(octokit)
            : createFallbackPaginate(request);

    const requestRoute = <TData>(
        routeOrMethod: string,
        params: unknown
    ): Promise<{ data: TData }> => {
        return request(
            routeOrMethod,
            params as FallbackRequestParams
        ) as Promise<{ data: TData }>;
    };

    const rest: GithubClient['rest'] = {
        pulls: {
            get: (params) =>
                requestRoute<GithubPullRequest>(
                    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
                    params
                ),
            list: (params) =>
                requestRoute<GithubPullRequest[]>(
                    'GET /repos/{owner}/{repo}/pulls',
                    params
                ),
            listFiles: (params) =>
                requestRoute<{ filename: string; patch?: string }[]>(
                    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
                    params
                ),
            listCommits: (params) =>
                requestRoute<{ commit?: { message?: string | null } | null }[]>(
                    'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
                    params
                ),
        },
        issues: {
            createLabel: (params) =>
                requestRoute<unknown>(
                    'POST /repos/{owner}/{repo}/labels',
                    params
                ),
            addLabels: (params) =>
                requestRoute<unknown>(
                    'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
                    params
                ),
            removeLabel: (params) =>
                requestRoute<unknown>(
                    'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
                    params
                ),
            listComments: (params) =>
                requestRoute<GithubIssueComment[]>(
                    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
                    params
                ),
            updateComment: (params) =>
                requestRoute<unknown>(
                    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
                    params
                ),
            createComment: (params) =>
                requestRoute<unknown>(
                    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
                    params
                ),
            deleteComment: (params) =>
                requestRoute<unknown>(
                    'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}',
                    params
                ),
        },
    };

    return {
        rest,
        paginate,
    };
}

export async function createGithubApp({
    env = process.env,
    logger = console,
}: {
    env?: EnvMap;
    logger?: ServerLogger;
} = {}): Promise<{
    app: import('@octokit/app').App;
    createNodeMiddleware: typeof import('@octokit/webhooks').createNodeMiddleware;
}> {
    const [{ App }, { createNodeMiddleware }] = await Promise.all([
        import('@octokit/app'),
        import('@octokit/webhooks'),
    ]);

    const appId = requireEnv('GITHUB_APP_ID', env);
    const privateKey = normalizePrivateKey(
        requireEnv('GITHUB_APP_PRIVATE_KEY', env)
    );
    const webhookSecret = requireEnv('GITHUB_WEBHOOK_SECRET', env);
    const triageConfig = buildConfigFromEnv(env);
    const duplicateConfig = buildDuplicateConfigFromEnv(env);

    const app = new App({
        appId,
        privateKey,
        webhooks: {
            secret: webhookSecret,
        },
    });

    app.webhooks.on(
        'pull_request',
        async ({ payload }: { payload: PullRequestEventPayload }) => {
            if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(payload.action)) {
                return;
            }
            logger.info(
                `Received pull_request number ${payload.pull_request?.number} action ${payload.action} event for ${payload.repository.name}.`
            );

            if (
                !payload.pull_request ||
                payload.pull_request.state !== 'open'
            ) {
                return;
            }

            const owner = payload.repository.owner.login;
            const repo = payload.repository.name;
            const pullNumber = payload.pull_request.number;
            const installationId =
                payload.installation && payload.installation.id;

            if (!installationId) {
                logger.error(
                    `Missing installation id for ${owner}/${repo}#${pullNumber}; skipping triage.`
                );
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
                duplicateConfig,
                eventAction: payload.action,
                logger,
            });

            if (result.skipped) {
                logger.info(
                    `Triage skipped for ${owner}/${repo}#${pullNumber}: ${result.skipReason || 'unspecified reason'}`
                );
                return;
            }

            if (!result.analysis) {
                return;
            }

            const { lowEffort, aiSlop } = result.analysis;
            const duplicateDetection = result.duplicateDetection;
            const formatFindings = (findings: TriageFinding[]): string =>
                findings.length === 0
                    ? 'none'
                    : findings.map((f) => `${f.id} (+${f.points})`).join(', ');
            const duplicateSummary = duplicateDetection.checked
                ? `checked (flagged=${duplicateDetection.flagged}, matches=${duplicateDetection.matches.length})`
                : `skipped (${duplicateDetection.skipReason || 'unknown'})`;

            logger.info(
                `Triage completed for ${owner}/${repo}#${pullNumber}\n` +
                    `  low-effort: ${lowEffort.score}/100 (threshold ${lowEffort.threshold}, flagged=${lowEffort.flagged})\n` +
                    `    findings: ${formatFindings(lowEffort.findings)}\n` +
                    `  ai-slop:    ${aiSlop.score}/100 (threshold ${aiSlop.threshold}, flagged=${aiSlop.flagged})\n` +
                    `    findings: ${formatFindings(aiSlop.findings)}\n` +
                    `  duplicate:  ${duplicateSummary}\n` +
                    `  size: ${result.analysis.sizeLabel}\n` +
                    `  labels: ${result.desiredLabels.join(', ') || 'none'}`
            );
        }
    );

    app.webhooks.onError((error: unknown) => {
        logger.error('Webhook processing failed.', error);
    });

    return { app, createNodeMiddleware };
}

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const SITE_DIR = join(__dirname, '..', 'site');

async function serveSiteFile(
    req: IncomingMessage,
    res: ServerResponse
): Promise<void> {
    const urlPath = (req.url || '/').split('?')[0];
    const filePath = urlPath === '/' ? '/index.html' : urlPath;

    const resolved = join(SITE_DIR, filePath);
    if (!resolved.startsWith(SITE_DIR)) {
        res.writeHead(403);
        res.end();
        return;
    }

    try {
        const data = await readFile(resolved);
        const ext = extname(resolved).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
}

export async function startServer({
    env = process.env,
    logger = console,
}: {
    env?: EnvMap;
    logger?: ServerLogger;
} = {}): Promise<Server> {
    const { app, createNodeMiddleware } = await createGithubApp({
        env,
        logger,
    });
    const webhookMiddleware = createNodeMiddleware(app.webhooks, {
        path: '/api/github/webhooks',
    });

    const port = getPort(env);
    const server = createServer((req, res) => {
        webhookMiddleware(req, res, () => {
            void serveSiteFile(req, res);
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(port, () => {
            logger.info(`GitHub App webhook server listening on port ${port}.`);
            resolve();
        });
        server.on('error', reject);
    });

    return server;
}

if (require.main === module) {
    startServer().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
