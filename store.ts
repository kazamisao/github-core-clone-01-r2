// The forge's store: repositories, their git objects and refs, issues, pull
// requests, labels and comments. Everything lives in memory for the trial;
// nothing here reads a clock or Math.random — ordering and timestamps come
// from one monotonic sequence, so two runs on the same requests agree.

import {
  buildCommit,
  buildTree,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  treeLookup,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeChange,
} from './gitstore.ts';
import { VIEWER, viewerIdentity } from './scenario.ts';

const EPOCH_SEC = 1_700_000_000;

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  /** Serialized REST shape of this issue, cached by rest.ts; cleared on patch. */
  jsonCache?: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Issue[];
  /** Number → issue index so a single-issue read is O(1), not a scan. */
  readonly issuesByNumber: Map<number, Issue>;
  /** gitproto response cache (advertisements, ls-refs, fetch bodies). */
  readonly protoCache: Map<string, Buffer>;
  readonly pulls: Pull[];
  readonly labels: Map<string, Label>;
  readonly comments: Map<number, Comment[]>;
  nextNumber: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

const isoOfCache = new Map<number, string>();

function isoOf(seq: number): string {
  const cached = isoOfCache.get(seq);
  if (cached !== undefined) return cached;
  const rendered = new Date((EPOCH_SEC + seq) * 1000).toISOString();
  if (isoOfCache.size > 4096) isoOfCache.clear();
  isoOfCache.set(seq, rendered);
  return rendered;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private seq = 0;

  private tick(): number {
    this.seq += 1;
    return this.seq;
  }

  timestamp(): string {
    return isoOf(this.tick());
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.tick(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      protoCache: new Map(),
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Commits reachable from `ref` (branch name or oid), newest first. */
  listCommits(repo: Repo, ref: string): string[] {
    let tip = this.branchTip(repo, ref) ?? (isObjectId(ref) ? ref : undefined);
    if (tip === undefined) {
      const full = repo.refs.get(ref);
      if (full !== undefined) tip = full;
    }
    if (tip === undefined) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      queue.push(...parseCommit(object.data).parents);
    }
    return out;
  }

  createBranch(repo: Repo, branch: string, sha: string): boolean {
    const ref = `refs/heads/${branch}`;
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }

  // ---------------------------------------------------------------- contents commits

  private setPathInTree(repo: Repo, rootTreeOid: string | null, segments: readonly string[], blobOid: string | null): string {
    const apply = (treeOid: string | null, depth: number): string | null => {
      const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = segments[depth] as string;
      const isLast = depth === segments.length - 1;
      const idx = entries.findIndex((e) => e.name === name);
      if (isLast) {
        if (blobOid === null) {
          if (idx === -1) return entries.length ? this.putObject(repo, 'tree', buildTree(entries)) : null;
          const next = entries.filter((_, i) => i !== idx);
          return next.length ? this.putObject(repo, 'tree', buildTree(next)) : null;
        }
        const next = [...entries];
        const entry = { mode: '100644', name, oid: blobOid };
        if (idx === -1) next.push(entry);
        else next[idx] = entry;
        return this.putObject(repo, 'tree', buildTree(next));
      }
      const child = idx === -1 ? null : entries[idx];
      const childTree = child && child.mode === '40000' ? child.oid : null;
      const newChild = apply(childTree, depth + 1);
      const next = [...entries];
      if (newChild === null) {
        if (idx !== -1) next.splice(idx, 1);
      } else if (idx === -1) {
        next.push({ mode: '40000', name, oid: newChild });
      } else {
        next[idx] = { mode: '40000', name, oid: newChild };
      }
      if (next.length === 0) return null;
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return apply(rootTreeOid, 0) ?? this.putObject(repo, 'tree', buildTree([]));
  }

  /**
   * Commit `content` at `path` on `branch` (creating the branch from the default
   * tip when it does not exist yet). Returns the commit and blob shas.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    let tip = this.branchTip(repo, branch);
    if (tip === undefined) {
      const baseTip = this.branchTip(repo, repo.defaultBranch);
      if (baseTip !== undefined) {
        repo.refs.set(`refs/heads/${branch}`, baseTip);
        tip = baseTip;
      }
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    const segments = path.split('/').filter((s) => s !== '');
    const newTree = this.setPathInTree(repo, parentTree, segments, blobSha);
    const stamp = EPOCH_SEC + this.tick();
    const who = viewerIdentity(stamp);
    const commitData = buildCommit({
      tree: newTree,
      parents: tip === undefined ? [] : [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha: blobSha };
  }

  /** Remove `path` from `branch`'s tree in a new commit; null when the file is absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
    const found = treeLookup(this.lookup(repo), commit.tree, path);
    if (!found) return null;
    const segments = path.split('/').filter((s) => s !== '');
    const newTree = this.setPathInTree(repo, commit.tree, segments, null);
    const stamp = EPOCH_SEC + this.tick();
    const who = viewerIdentity(stamp);
    const commitData = buildCommit({
      tree: newTree,
      parents: [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** Read a path at a branch tip: a blob, a directory listing, or null. */
  readPath(
    repo: Repo,
    branch: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
    const clean = path.split('/').filter((s) => s !== '').join('/');
    if (clean === '') {
      const entries = parseTree(repo.objects.get(commit.tree)?.data ?? Buffer.alloc(0)).map((e) => ({
        name: e.name,
        path: e.name,
        oid: e.oid,
        mode: e.mode,
      }));
      return { kind: 'dir', entries };
    }
    const found = treeLookup(this.lookup(repo), commit.tree, clean);
    if (!found) {
      // Maybe a directory: walk to the subtree.
      const segments = clean.split('/');
      let current = commit.tree;
      let ok = true;
      for (const segment of segments) {
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tree') { ok = false; break; }
        const entry = parseTree(object.data).find((e) => e.name === segment);
        if (!entry || entry.mode !== '40000') { ok = false; break; }
        current = entry.oid;
      }
      if (!ok) return null;
      const entries = parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0)).map((e) => ({
        name: e.name,
        path: `${clean}/${e.name}`,
        oid: e.oid,
        mode: e.mode,
      }));
      return { kind: 'dir', entries };
    }
    if (found.mode === '40000') {
      const entries = parseTree(repo.objects.get(found.oid)?.data ?? Buffer.alloc(0)).map((e) => ({
        name: e.name,
        path: `${clean}/${e.name}`,
        oid: e.oid,
        mode: e.mode,
      }));
      return { kind: 'dir', entries };
    }
    const blob = repo.objects.get(found.oid);
    if (!blob) return null;
    return { kind: 'file', oid: found.oid, data: blob.data };
  }

  // ---------------------------------------------------------------- issues / labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): { issue: Issue } | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: label };
    }
    const seq = this.tick();
    const issue: Issue = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issuesByNumber.get(number);
  }

  patchIssue(repo: Repo, number: number, patch: { state?: 'open' | 'closed'; title?: string; body?: string }): Issue | undefined {
    const issue = this.getIssue(repo, number);
    if (!issue) return undefined;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedSeq = this.tick();
    issue.jsonCache = undefined;
    return issue;
  }

  listIssues(
    repo: Repo,
    opts: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    let list = [...repo.issues];
    if (opts.state === 'open') list = list.filter((i) => i.state === 'open');
    else if (opts.state === 'closed') list = list.filter((i) => i.state === 'closed');
    const asc = (opts.direction ?? 'desc') === 'asc';
    list.sort((a, b) => (asc ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  addComment(repo: Repo, number: number, body: string): Comment | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    const comment: Comment = { id: this.nextId++, body, createdSeq: this.tick() };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }

  listComments(repo: Repo, number: number): Comment[] {
    return [...(repo.comments.get(number) ?? [])];
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, input: { head: string; base: string; title: string; body: string }): { pull: Pull } | { error: string } {
    const headTip = this.branchTip(repo, input.head);
    const baseTip = this.branchTip(repo, input.base);
    if (headTip === undefined || baseTip === undefined) return { error: 'head or base branch does not exist' };
    const open = repo.pulls.find((p) => p.head === input.head && p.base === input.base && p.state === 'open');
    if (open) return { error: 'a pull request is already open for this head and base' };
    const pull: Pull = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      head: input.head,
      base: input.base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.tick(),
    };
    repo.pulls.push(pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  listPulls(repo: Repo, state: string | undefined): Pull[] {
    let list = [...repo.pulls];
    if (state === 'open') list = list.filter((p) => p.state === 'open');
    else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list;
  }

  headSha(repo: Repo, pull: Pull): string {
    return this.branchTip(repo, pull.head) ?? '';
  }

  baseSha(repo: Repo, pull: Pull): string {
    return this.branchTip(repo, pull.base) ?? '';
  }

  /** The files a pull request changes (head tip vs merge-base with the base tip). */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const baseTree = base === null ? this.putObject(repo, 'tree', buildTree([])) : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const changes: TreeChange[] = diffTrees(this.lookup(repo), baseTree, headTree);
    return changes.map((change) => {
      const countLines = (oid: string | null): number => {
        if (oid === null) return 0;
        const data = repo.objects.get(oid)?.data;
        if (!data) return 0;
        const text = data.toString('utf8');
        if (text === '') return 0;
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      };
      const additions = change.status === 'removed' ? 0 : countLines(change.newOid);
      const deletions = change.status === 'added' ? 0 : countLines(change.oldOid);
      return {
        filename: change.path,
        status: change.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  /**
   * Whether merging this pull request would conflict: some path changed on
   * both sides of the merge-base with different resulting content.
   */
  pullWouldConflict(repo: Repo, pull: Pull): boolean {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return true;
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const emptyTree = this.putObject(repo, 'tree', buildTree([]));
    const baseTree = base === null ? emptyTree : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const targetTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const headChanges = diffTrees(this.lookup(repo), baseTree, headTree);
    const baseChanges = new Map(diffTrees(this.lookup(repo), baseTree, targetTree).map((c) => [c.path, c]));
    for (const change of headChanges) {
      const other = baseChanges.get(change.path);
      if (other && other.newOid !== change.newOid) return true;
    }
    return false;
  }

  /** The GraphQL mergeable enum for a pull request. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.pullWouldConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * sha, 'not-found', 'conflict' or 'already-closed'.
   */
  mergePull(repo: Repo, number: number): { sha: string } | { error: 'not-found' | 'conflict' | 'already-closed' } {
    const pull = this.getPull(repo, number);
    if (!pull) return { error: 'not-found' };
    if (pull.state === 'closed') return { error: 'already-closed' };
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return { error: 'not-found' };
    if (this.pullWouldConflict(repo, pull)) return { error: 'conflict' };
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const emptyTree = this.putObject(repo, 'tree', buildTree([]));
    const baseTree = base === null ? emptyTree : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const targetTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const headChanges = diffTrees(this.lookup(repo), baseTree, headTree);
    // Apply the head's changes onto the target tree.
    let tree = targetTree;
    for (const change of headChanges) {
      const segments = change.path.split('/').filter((s) => s !== '');
      tree = this.setPathInTree(repo, tree, segments, change.newOid);
    }
    const stamp = EPOCH_SEC + this.tick();
    const who = viewerIdentity(stamp);
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
    const commitData = buildCommit({ tree, parents: [baseTip], message, author: who, committer: who });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(stamp);
    pull.mergeCommitSha = sha;
    return { sha };
  }

  /** Whether `ancestor` is an ancestor of `oid` in this repo. */
  isAncestorOf(repo: Repo, ancestor: string, oid: string): boolean {
    return isAncestor(ancestor, oid, this.lookup(repo));
  }

  reachableFrom(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo));
  }

  flattenTreeOf(repo: Repo, treeOid: string): Array<{ path: string; oid: string }> {
    return flattenTree(this.lookup(repo), treeOid);
  }
}

// ---------------------------------------------------------------------------
// Relay global ids (opaque, stable): base64url of a typed key.
// ---------------------------------------------------------------------------

export function globalId(kind: 'R' | 'I' | 'PR' | 'C', repoId: number, a?: number, b?: number): string {
  const raw = b === undefined ? `${kind}:${repoId}:${a ?? 0}` : `${kind}:${repoId}:${a}:${b}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; a: number; b: number } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 3) return null;
    return { kind: parts[0] as string, repoId: Number(parts[1]), a: Number(parts[2]), b: Number(parts[3] ?? 0) };
  } catch {
    return null;
  }
}

export { VIEWER };
