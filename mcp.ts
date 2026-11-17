// The MCP endpoint: JSON-RPC 2.0 Streamable HTTP at POST /mcp, plain JSON
// answers (no SSE). Six tools, all acting on the same store as REST and
// GraphQL, so a repo made here reads back identically over the other surfaces.

import { Store, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

export interface McpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description?: string }>;
    readonly required: string[];
  };
}

// One constant list, returned byte-for-byte on every tools/list call.
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Repository name.' }),
        description: Object.freeze({ type: 'string', description: 'Short description.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Issue title.' }),
        body: Object.freeze({ type: 'string', description: 'Issue body.' }),
        state: Object.freeze({ type: 'string', description: 'Initial state, open or closed.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Filter by state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'Pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

function toolResult(data: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function missingArg(name: string): Record<string, unknown> {
  return toolError(`Missing required argument: ${name}`);
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw { code: -32602, message: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') return missingArg(required);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const repo = store.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if (!repo) return toolError(`Repository ${VIEWER.login}/${repoName} already exists`);
      return toolResult(repoShape(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoShape(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const created = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolError(`Label ${created.error} does not exist`);
      const issue = created.issue;
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = store.listIssues(repo, { state: state === 'all' ? undefined : state });
      const issues = list.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
      }));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const created = store.createPull(repo, {
        head: String(args.head),
        base: String(args.base),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolError(created.error);
      const pull = created.pull;
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head, sha: store.headSha(repo, pull) },
        base: { ref: pull.base, sha: store.baseSha(repo, pull) },
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = Number(args.pull_number);
      const merged = store.mergePull(repo, number);
      if ('error' in merged) return toolError(`Cannot merge pull request #${number}: ${merged.error}`);
      return toolResult({ number, merged: true, sha: merged.sha });
    }
    default:
      throw { code: -32602, message: `Unknown tool: ${name}` };
  }
}

export function handleMcp(store: Store, rawBody: string): McpResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody === '' ? '{}' : rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = payload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  // Notifications carry no id and get no result; a bare 200 keeps the client moving.
  if (id === null || id === undefined) {
    return { status: 200, body: {} };
  }
  const ok = (result: unknown, headers?: Readonly<Record<string, string>>): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result }, headers });
  const err = (code: number, message: string): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return ok({
      supportedVersions: ['2026-07-28', '2026-06-18'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    return ok(
      { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      { 'Mcp-Session-Id': 'forge-session-1' },
    );
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    const params = (request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {});
    try {
      return ok(callTool(store, toolName, args));
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error) {
        const typed = error as { code: number; message: string };
        return err(typed.code, typed.message);
      }
      return err(-32603, (error as Error).message);
    }
  }
  return err(-32601, `Method not found: ${method}`);
}
