// The REST v3 surface: /api/v3 (root, meta, user), repos, refs, branches,
// commits, contents, labels, issues, comments and pull requests. Shapes follow
// the wire contract in RULES.txt: JSON everywhere, X-GitHub-Request-Id on every
// reply (set by app.ts), 401 without a token (enforced by app.ts), 404 JSON for
// anything unknown, 422 with "already exists" for a duplicate repo name.

import { Store, globalId, type Comment, type Issue, type Pull, type Repo } from './store.ts';
import { isObjectId, parseCommit } from './gitstore.ts';
import { VIEWER } from './scenario.ts';

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Pre-serialized JSON body; app.ts sends it verbatim when present. */
  readonly rawBody?: string;
}

export interface RestRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  /** Absolute origin of this request, e.g. http://127.0.0.1:1234 (for Link headers). */
  readonly origin: string;
  /** Raw request body text ('' when none). */
  readonly rawBody: string;
}

const EPOCH_SEC = 1_700_000_000;

const isoSeqCache = new Map<number, string>();

function isoSeq(seq: number): string {
  const cached = isoSeqCache.get(seq);
  if (cached !== undefined) return cached;
  const rendered = new Date((EPOCH_SEC + seq) * 1000).toISOString();
  if (isoSeqCache.size > 4096) isoSeqCache.clear();
  isoSeqCache.set(seq, rendered);
  return rendered;
}

function json(status: number, body: unknown, headers?: Readonly<Record<string, string>>): ApiResult {
  return { status, body, headers };
}

function notFound(message = 'Not Found'): ApiResult {
  return json(404, { message });
}

function parseBody(request: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (request.rawBody === '') return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(request.rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
      out.push((entry as Record<string, unknown>).name as string);
    } else return undefined;
  }
  return out;
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoSeq(repo.createdSeq),
    updated_at: isoSeq(repo.createdSeq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoSeq(issue.createdSeq),
    updated_at: isoSeq(issue.updatedSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', repo.id, issueNumber, comment.id),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoSeq(comment.createdSeq),
    updated_at: isoSeq(comment.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PR', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: store.headSha(repo, pull), label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: store.baseSha(repo, pull), label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoSeq(pull.createdSeq),
    updated_at: isoSeq(pull.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const message = commit.message.replace(/\n$/, '');
  const authorLine = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) \+0000$/.exec(line);
    if (!match) return { name: VIEWER.name, email: VIEWER.email, date: isoSeq(0) };
    return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha,
    node_id: globalId('C', repo.id, 0, 0),
    commit: { message, author: authorLine(commit.author), committer: authorLine(commit.committer) },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: readonly T[], request: RestRequest): { page: T[]; link: string | null } {
  const page = Math.max(1, Number(request.query.get('page') ?? '1') || 1);
  const perPage = Math.max(1, Math.min(100, Number(request.query.get('per_page') ?? '30') || 30));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const build = (p: number): string => {
    const query = new URLSearchParams(request.query);
    query.set('page', String(p));
    query.set('per_page', String(perPage));
    return `${request.origin}${request.pathname}?${query.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  links.push(`<${build(1)}>; rel="first"`);
  links.push(`<${build(totalPages)}>; rel="last"`);
  return { page: [...slice], link: links.length ? links.join(', ') : null };
}

function withLink(result: ApiResult, link: string | null): ApiResult {
  if (link === null) return result;
  return { ...result, headers: { ...(result.headers ?? {}), Link: link } };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export function handleRest(store: Store, request: RestRequest): ApiResult {
  const { method, pathname } = request;
  const segments = pathname.split('/').filter((s) => s !== '');

  // GET /api/v3/ — root
  if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0'.repeat(40) });
  }
  // GET /api/v3/user
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
    return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }
  // POST /api/v3/user/repos
  if (method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    const parsed = parseBody(request);
    if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
    const name = asString(parsed.value.name);
    if (!name) return json(422, { message: 'name is required' });
    const repo = store.createRepo(VIEWER.login, name, {
      description: asString(parsed.value.description),
      private: asBool(parsed.value.private),
    });
    if (!repo) return json(422, { message: `Repository ${VIEWER.login}/${name} already exists` });
    return json(201, repoJson(repo));
  }
  // GET /api/v3/user/repos
  if (method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    const repos = store.listRepos(VIEWER.login);
    const { page, link } = paginate(repos.map(repoJson), request);
    return withLink(json(200, page), link);
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 5 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3] as string;
    const repoName = segments[4] as string;
    const repo = store.getRepo(owner, repoName);
    const rest = segments.slice(5);
    // Repo itself
    if (rest.length === 0) {
      if (!repo) return notFound('Not Found');
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseBody(request);
        if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
        const description = asString(parsed.value.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBool(parsed.value.private);
        if (isPrivate !== undefined) repo.private = isPrivate;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return json(204, null);
      }
      return notFound();
    }
    if (!repo) return notFound('Not Found');

    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseBody(request);
        if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
        const ref = asString(parsed.value.ref);
        const sha = asString(parsed.value.sha);
        if (!ref || !sha || !isObjectId(sha)) return json(422, { message: 'ref and sha are required' });
        if (!repo.objects.has(sha)) return json(422, { message: 'object does not exist' });
        if (repo.refs.has(ref)) return json(422, { message: 'Reference already exists' });
        repo.refs.set(ref, sha);
        return json(201, { ref, node_id: globalId('R', repo.id), object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const branch = rest[3] as string;
        const sha = store.branchTip(repo, branch);
        if (sha === undefined) return notFound('Not Found');
        return json(200, { ref: `refs/heads/${branch}`, node_id: globalId('R', repo.id), object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
      }
      return notFound();
    }
    // /branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches = store.listBranches(repo).map((b) => ({
          name: b.name,
          commit: { sha: b.sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${b.sha}` },
          protected: false,
        }));
        const { page, link } = paginate(branches, request);
        return withLink(json(200, page), link);
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = rest[1] as string;
        const sha = store.branchTip(repo, branch);
        if (sha === undefined) return notFound('Not Found');
        return json(200, { name: branch, commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, protected: false });
      }
      return notFound();
    }
    // /commits
    if (rest[0] === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const ref = request.query.get('sha') ?? repo.defaultBranch;
        const shas = store.listCommits(repo, ref);
        const { page, link } = paginate(shas.map((sha) => commitJson(store, repo, sha)).filter((c) => c !== null), request);
        return withLink(json(200, page), link);
      }
      if (method === 'GET' && rest.length === 2) {
        const sha = rest[1] as string;
        const entry = commitJson(store, repo, sha);
        if (!entry) return notFound('Not Found');
        return json(200, entry);
      }
      return notFound();
    }
    // /contents/*
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      const branch = request.query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const read = store.readPath(repo, branch, path);
        if (!read) return notFound('Not Found');
        if (read.kind === 'file') {
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: read.data.length,
            name: path.split('/').pop() ?? path,
            path,
            sha: read.oid,
            content: read.data.toString('base64'),
            url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
            html_url: `https://example.invalid/${owner}/${repoName}/blob/${branch}/${path}`,
            download_url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          });
        }
        return json(200, read.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${entry.path}`,
          html_url: `https://example.invalid/${owner}/${repoName}/tree/${branch}/${entry.path}`,
        })));
      }
      if (method === 'PUT') {
        const parsed = parseBody(request);
        if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
        const contentB64 = asString(parsed.value.content);
        const message = asString(parsed.value.message) ?? 'Update file';
        const putBranch = asString(parsed.value.branch) ?? branch;
        const expectedSha = asString(parsed.value.sha);
        if (contentB64 === undefined) return json(422, { message: 'content is required' });
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return json(422, { message: 'content is not valid base64' });
        }
        const existing = store.readPath(repo, putBranch, path);
        const isUpdate = existing?.kind === 'file';
        if (expectedSha !== undefined && isUpdate && existing.kind === 'file' && existing.oid !== expectedSha) {
          return json(409, { message: 'sha does not match the current file' });
        }
        const { commitSha, blobSha } = store.commitFile(repo, putBranch, path, content, message);
        return json(isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const parsed = parseBody(request);
        if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
        const message = asString(parsed.value.message) ?? 'Delete file';
        const delBranch = asString(parsed.value.branch) ?? branch;
        const result = store.deleteFile(repo, delBranch, path, message);
        if (!result) return notFound('Not Found');
        return json(200, { commit: { sha: result.commitSha, message } });
      }
      return notFound();
    }
    // /labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
      }
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseBody(request);
        if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
        const name = asString(parsed.value.name);
        const color = asString(parsed.value.color) ?? 'ededed';
        if (!name) return json(422, { message: 'name is required' });
        const label = store.createLabel(repo, name, color);
        return json(201, { name: label.name, color: label.color, description: '' });
      }
      return notFound();
    }
    // /issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const list = store.listIssues(repo, {
            state: request.query.get('state') ?? undefined,
            sort: request.query.get('sort') ?? undefined,
            direction: request.query.get('direction') ?? undefined,
          });
          const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), request);
          return withLink(json(200, page), link);
        }
        if (method === 'POST') {
          const parsed = parseBody(request);
          if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
          const title = asString(parsed.value.title);
          const body = asString(parsed.value.body) ?? '';
          const labels = asStringArray(parsed.value.labels) ?? [];
          if (!title) return json(422, { message: 'title is required' });
          const created = store.createIssue(repo, title, body, labels);
          if ('error' in created) return json(422, { message: `Label ${created.error} does not exist` });
          return json(201, issueJson(repo, created.issue));
        }
        return notFound();
      }
      const issueNumber = Number(rest[1]);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = store.getIssue(repo, issueNumber);
          if (!issue) return notFound('Not Found');
          // The read hot path: an unpatched issue serializes once, then the
          // cached bytes are served verbatim (patchIssue clears the cache).
          if (issue.jsonCache !== undefined) return { status: 200, body: null, rawBody: issue.jsonCache };
          const rawBody = JSON.stringify(issueJson(repo, issue));
          issue.jsonCache = rawBody;
          return { status: 200, body: null, rawBody };
        }
        if (method === 'PATCH') {
          const parsed = parseBody(request);
          if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
          const state = asString(parsed.value.state);
          const issue = store.patchIssue(repo, issueNumber, {
            state: state === 'open' || state === 'closed' ? state : undefined,
            title: asString(parsed.value.title),
            body: asString(parsed.value.body),
          });
          if (!issue) return notFound('Not Found');
          return json(200, issueJson(repo, issue));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          if (!store.getIssue(repo, issueNumber)) return notFound('Not Found');
          const comments = store.listComments(repo, issueNumber);
          const { page, link } = paginate(comments.map((c) => commentJson(repo, issueNumber, c)), request);
          return withLink(json(200, page), link);
        }
        if (method === 'POST') {
          const parsed = parseBody(request);
          if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
          const bodyText = asString(parsed.value.body);
          if (bodyText === undefined) return json(422, { message: 'body is required' });
          const comment = store.addComment(repo, issueNumber, bodyText);
          if (!comment) return notFound('Not Found');
          return json(201, commentJson(repo, issueNumber, comment));
        }
        return notFound();
      }
      return notFound();
    }
    // /pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = request.query.get('state');
          const list = store.listPulls(repo, state === 'all' ? undefined : (state ?? 'open'));
          const { page, link } = paginate(list.map((pull) => pullJson(store, repo, pull)), request);
          return withLink(json(200, page), link);
        }
        if (method === 'POST') {
          const parsed = parseBody(request);
          if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
          const head = asString(parsed.value.head);
          const base = asString(parsed.value.base);
          const title = asString(parsed.value.title);
          const body = asString(parsed.value.body) ?? '';
          if (!head || !base || !title) return json(422, { message: 'head, base and title are required' });
          const created = store.createPull(repo, { head, base, title, body });
          if ('error' in created) return json(422, { message: created.error });
          return json(201, pullJson(store, repo, created.pull));
        }
        return notFound();
      }
      const pullNumber = Number(rest[1]);
      if (!Number.isInteger(pullNumber) || pullNumber < 1) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') {
          const pull = store.getPull(repo, pullNumber);
          if (!pull) return notFound('Not Found');
          return json(200, pullJson(store, repo, pull));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pull = store.getPull(repo, pullNumber);
        if (!pull) return notFound('Not Found');
        return json(200, store.pullFiles(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
        const pull = store.getPull(repo, pullNumber);
        if (!pull) return notFound('Not Found');
        const headTip = store.headSha(repo, pull);
        const baseTip = store.baseSha(repo, pull);
        const headCommits = new Set(store.listCommits(repo, pull.head));
        const baseCommits = new Set(store.listCommits(repo, pull.base));
        const onlyHead = [...headCommits].filter((sha) => !baseCommits.has(sha));
        void headTip;
        void baseTip;
        return json(200, onlyHead.map((sha) => commitJson(store, repo, sha)).filter((c) => c !== null));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const parsed = parseBody(request);
        if (!parsed.ok) return json(400, { message: 'Problems parsing JSON' });
        const merged = store.mergePull(repo, pullNumber);
        if ('error' in merged) {
          if (merged.error === 'not-found') return notFound('Not Found');
          if (merged.error === 'already-closed') return json(405, { message: 'Pull request is already merged' });
          return json(405, { message: 'Merge conflict' });
        }
        return json(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
      }
      return notFound();
    }
    return notFound();
  }

  return notFound();
}
