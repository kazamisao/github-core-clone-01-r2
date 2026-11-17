// The HTTP server: one process, stdlib only. It routes git smart-HTTP,
// REST v3, GraphQL and MCP onto one shared store, enforces the bearer-token
// gate on the API surfaces, and stamps every reply with X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { GitProto } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

let requestCounter = 0;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body exceeds the 64 MiB limit'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, requestId: string, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}, rawPayload?: string): void {
  const payload = rawPayload ?? (body === null || body === undefined ? '' : JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  response.end(payload);
}

let expectedAuthHeader: string | null = null;

/** True when the request carries the trial token this process was given. */
function authorized(request: IncomingMessage): boolean {
  if (expectedAuthHeader === null) {
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    expectedAuthHeader = expected === '' ? '' : `Bearer ${expected}`;
  }
  const header = request.headers.authorization ?? '';
  if (expectedAuthHeader === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === expectedAuthHeader;
}

export function createApp(): Server {
  const store = new Store();
  const git = new GitProto(store);

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const requestId = `req-${++requestCounter}`;
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
        const pathname = url.pathname;
        const method = request.method ?? 'GET';

        // Boot probe — no token, plain 200.
        if (pathname === '/healthz' && method === 'GET') {
          return sendJson(response, requestId, 200, { status: 'ok' });
        }

        // GraphQL — POST /api/graphql
        if (pathname === '/api/graphql') {
          if (!authorized(request)) return sendJson(response, requestId, 401, { message: 'Requires authentication' });
          if (method !== 'POST') return sendJson(response, requestId, 405, { message: 'Method Not Allowed' });
          const body = await readBody(request);
          const result = handleGraphql(store, body.toString('utf8'));
          return sendJson(response, requestId, result.status, result.body);
        }

        // MCP — POST /mcp
        if (pathname === '/mcp') {
          if (!authorized(request)) return sendJson(response, requestId, 401, { message: 'Requires authentication' });
          if (method !== 'POST') return sendJson(response, requestId, 405, { message: 'Method Not Allowed' });
          const body = await readBody(request);
          const result = handleMcp(store, body.toString('utf8'));
          return sendJson(response, requestId, result.status, result.body, result.headers);
        }

        // REST v3 — /api/v3/...
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authorized(request)) return sendJson(response, requestId, 401, { message: 'Requires authentication' });
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
          const result = handleRest(store, {
            method,
            pathname,
            query: url.searchParams,
            origin: `http://${request.headers.host ?? '127.0.0.1'}`,
            rawBody: body.toString('utf8'),
          });
          if (result.status === 204) {
            response.writeHead(204, { 'x-github-request-id': requestId });
            return response.end();
          }
          return sendJson(response, requestId, result.status, result.body, result.headers, result.rawBody);
        }

        // Git smart HTTP — /{owner}/{repo}.git/...
        const gitMatch = GIT_PATH.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          const repo = store.getRepo(owner, repoName);
          if (!repo) return sendJson(response, requestId, 404, { message: 'Not Found' });
          if (endpoint === 'info/refs') {
            if (method !== 'GET') return sendJson(response, requestId, 405, { message: 'Method Not Allowed' });
            const service = url.searchParams.get('service') ?? '';
            const result = git.infoRefs(repo, service, request.headers['git-protocol']);
            response.writeHead(result.status, {
              'content-type': result.contentType,
              'x-github-request-id': requestId,
            });
            return response.end(result.body);
          }
          if (method !== 'POST') return sendJson(response, requestId, 405, { message: 'Method Not Allowed' });
          const body = await readBody(request);
          const result =
            endpoint === 'git-upload-pack'
              ? git.uploadPack(repo, body, request.headers['git-protocol'])
              : git.receivePack(repo, body);
          response.writeHead(result.status, {
            'content-type': result.contentType,
            'x-github-request-id': requestId,
          });
          return response.end(result.body);
        }

        return sendJson(response, requestId, 404, { message: 'Not Found' });
      } catch (error) {
        process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
        if (!response.headersSent) sendJson(response, requestId, 500, { message: 'Internal Server Error' });
        else response.end();
      }
    })();
  });
}
