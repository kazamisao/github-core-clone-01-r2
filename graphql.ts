// A small hand-rolled GraphQL layer: tokenizer + recursive-descent parser for
// the query documents the suite sends, and an executor over a fixed schema
// whitelist. No external GraphQL library is used (stdlib only).

import { Store, decodeGlobalId, globalId, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}():$![]=@'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type Selection =
  | { kind: 'field'; alias?: string; name: string; args: Record<string, ValueNode>; selections: Selection[] }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selections: Selection[] };

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name?: string;
  readonly selections: Selection[];
}

interface Fragment {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${token.value}`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek()) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next();
        const on = this.next();
        if (on.value !== 'on') throw new Error('fragment must name a type with "on"');
        const typeName = this.next();
        const selections = this.parseSelectionSet();
        fragments.set(name.value, { name: name.value, typeCondition: typeName.value, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '{') {
      return { kind, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') { name = maybeName.value; this.next(); }
      // Variable definitions: ($x: Type = default, ...) — consumed, not interpreted.
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
      return { kind, name, selections: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${token.value} at the start of a GraphQL operation`);
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.next();
        return { kind: 'inline', typeCondition: typeName.value, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        this.next();
        return { kind: 'spread', name: next.value };
      }
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const name = this.next();
    if (name.kind !== 'name') throw new Error(`expected a field name, got ${name.value}`);
    let alias: string | undefined;
    let fieldName = name.value;
    if (this.acceptPunct(':')) {
      alias = name.value;
      fieldName = this.next().value;
    }
    let args: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) args = this.parseArguments();
    let selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name: fieldName, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.next();
      this.expectPunct(':');
      args[name.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.next();
        this.expectPunct(':');
        fields.push({ name: name.value, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value} in GraphQL document`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// views (what resolvers hand the executor)
// ---------------------------------------------------------------------------

interface Ctx {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly fragments: Map<string, Fragment>;
  readonly errors: Array<{ message: string }>;
}

type AnyView = Record<string, unknown> & { __typename?: string };

function repoView(repo: Repo): AnyView {
  return { __typename: 'Repository', __repo: repo };
}

function issueView(repo: Repo, issue: Issue): AnyView {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullView(repo: Repo, pull: Pull): AnyView {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userView(): AnyView {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function pageInfoView(hasNextPage: boolean, endCursor: string | null, hasPreviousPage: boolean, startCursor: string | null): AnyView {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage, startCursor };
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

interface FieldDef {
  readonly type: string;
  readonly resolve: (parent: AnyView, args: Record<string, unknown>, ctx: Ctx) => unknown;
}

interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM';
  readonly fields?: Record<string, FieldDef>;
  readonly values?: string[];
}

const FIELD = (type: string, resolve: FieldDef['resolve']): FieldDef => ({ type, resolve });
const SCALAR = (resolve: FieldDef['resolve']): FieldDef => FIELD('String', resolve);

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: FIELD('User', () => userView()),
      repository: FIELD('Repository', (_parent, args, ctx) => {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoView(repo) : null;
      }),
      node: FIELD('Node', (_parent, args, ctx) => {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        for (const repo of ctx.store.repos.values()) {
          if (decoded.kind === 'R' && repo.id === decoded.repoId) return repoView(repo);
          if (decoded.kind === 'I' && repo.id === decoded.repoId) {
            const issue = ctx.store.getIssue(repo, decoded.a);
            return issue ? issueView(repo, issue) : null;
          }
          if (decoded.kind === 'PR' && repo.id === decoded.repoId) {
            const pull = ctx.store.getPull(repo, decoded.a);
            return pull ? pullView(repo, pull) : null;
          }
        }
        return null;
      }),
      __type: FIELD('__Type', (_parent, args) => typeView(String(args.name ?? ''))),
      __schema: FIELD('__Schema', () => ({ __typename: '__Schema' })),
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: FIELD('CreateIssuePayload', (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'R') throw new Error('createIssue: repositoryId does not name a repository');
        const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
        if (!repo) throw new Error('createIssue: repository not found');
        const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) throw new Error(`createIssue: ${created.error}`);
        return { __typename: 'CreateIssuePayload', __repo: repo, __issue: created.issue };
      }),
      closeIssue: FIELD('CloseIssuePayload', (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'I') throw new Error('closeIssue: issueId does not name an issue');
        const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
        const issue = repo ? ctx.store.patchIssue(repo, decoded.a, { state: 'closed' }) : undefined;
        if (!issue || !repo) throw new Error('closeIssue: issue not found');
        return { __typename: 'CloseIssuePayload', __repo: repo, __issue: issue };
      }),
      createPullRequest: FIELD('CreatePullRequestPayload', (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'R') throw new Error('createPullRequest: repositoryId does not name a repository');
        const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
        if (!repo) throw new Error('createPullRequest: repository not found');
        const created = ctx.store.createPull(repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
        });
        if ('error' in created) throw new Error(`createPullRequest: ${created.error}`);
        return { __typename: 'CreatePullRequestPayload', __repo: repo, __pull: created.pull };
      }),
      mergePullRequest: FIELD('MergePullRequestPayload', (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'PR') throw new Error('mergePullRequest: pullRequestId does not name a pull request');
        const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
        if (!repo) throw new Error('mergePullRequest: repository not found');
        const merged = ctx.store.mergePull(repo, decoded.a);
        if ('error' in merged) throw new Error(`mergePullRequest: ${merged.error}`);
        const pull = ctx.store.getPull(repo, decoded.a);
        if (!pull) throw new Error('mergePullRequest: pull request not found');
        return { __typename: 'MergePullRequestPayload', __repo: repo, __pull: pull };
      }),
      addComment: FIELD('AddCommentPayload', (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (!decoded || decoded.kind !== 'I') throw new Error('addComment: subjectId does not name an issue');
        const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
        if (!repo) throw new Error('addComment: repository not found');
        const comment = ctx.store.addComment(repo, decoded.a, String(input.body ?? ''));
        if (!comment) throw new Error('addComment: issue not found');
        return { __typename: 'AddCommentPayload', __repo: repo, __issueNumber: decoded.a, __comment: comment };
      }),
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: SCALAR((parent) => parent.login ?? VIEWER.login),
      id: SCALAR((parent) => globalId('R', Number(parent.id ?? VIEWER.id))),
      name: SCALAR((parent) => parent.name ?? VIEWER.name),
      email: SCALAR((parent) => parent.email ?? VIEWER.email),
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: SCALAR((parent) => globalId('R', (parent.__repo as Repo).id)),
      databaseId: SCALAR((parent) => (parent.__repo as Repo).id),
      name: SCALAR((parent) => (parent.__repo as Repo).name),
      nameWithOwner: SCALAR((parent) => { const r = parent.__repo as Repo; return `${r.owner}/${r.name}`; }),
      owner: FIELD('User', (parent) => ({ __typename: 'User', login: (parent.__repo as Repo).owner, id: VIEWER.id, name: (parent.__repo as Repo).owner, email: '' })),
      defaultBranchRef: FIELD('BranchRef', (parent) => ({ __typename: 'BranchRef', name: (parent.__repo as Repo).defaultBranch })),
      viewerPermission: SCALAR(() => 'ADMIN'),
      hasIssuesEnabled: SCALAR(() => true),
      issue: FIELD('Issue', (parent, args, ctx) => {
        const repo = parent.__repo as Repo;
        const issue = ctx.store.getIssue(repo, Number(args.number ?? 0));
        return issue ? issueView(repo, issue) : null;
      }),
      issues: FIELD('IssueConnection', (parent, args, ctx) => {
        const repo = parent.__repo as Repo;
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (states && states.length) list = list.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT') {
          const desc = orderBy.direction === 'DESC';
          list.sort((a, b) => (desc ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        } else {
          list.sort((a, b) => a.createdSeq - b.createdSeq);
        }
        let startIndex = 0;
        if (typeof args.after === 'string') {
          const cursorNumber = decodeCursor(args.after);
          if (cursorNumber !== null) {
            const idx = list.findIndex((i) => i.number === cursorNumber);
            if (idx >= 0) startIndex = idx + 1;
          }
        }
        const first = typeof args.first === 'number' ? args.first : list.length;
        const nodes = list.slice(startIndex, startIndex + first);
        const hasNextPage = startIndex + first < list.length;
        return {
          __typename: 'IssueConnection',
          __nodes: nodes.map((issue) => issueView(repo, issue)),
          __totalCount: list.length,
          __pageInfo: pageInfoView(
            hasNextPage,
            nodes.length ? encodeCursor(nodes[nodes.length - 1]?.number ?? 0) : null,
            startIndex > 0,
            nodes.length ? encodeCursor(nodes[0]?.number ?? 0) : null,
          ),
        };
      }),
      pullRequests: FIELD('PullRequestConnection', (parent, args) => {
        const repo = parent.__repo as Repo;
        const list = [...repo.pulls].sort((a, b) => a.createdSeq - b.createdSeq);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const nodes = list.slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          __nodes: nodes.map((pull) => pullView(repo, pull)),
          __totalCount: list.length,
          __pageInfo: pageInfoView(first < list.length, nodes.length ? encodeCursor(nodes[nodes.length - 1]?.number ?? 0) : null, false, null),
        };
      }),
      pullRequest: FIELD('PullRequest', (parent, args, ctx) => {
        const repo = parent.__repo as Repo;
        const pull = ctx.store.getPull(repo, Number(args.number ?? 0));
        return pull ? pullView(repo, pull) : null;
      }),
    },
  },
  BranchRef: { kind: 'OBJECT', fields: { name: SCALAR((parent) => parent.name) } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: SCALAR((parent) => globalId('I', (parent.__repo as Repo).id, (parent.__issue as Issue).number)),
      number: SCALAR((parent) => (parent.__issue as Issue).number),
      title: SCALAR((parent) => (parent.__issue as Issue).title),
      state: SCALAR((parent) => (parent.__issue as Issue).state.toUpperCase()),
      body: SCALAR((parent) => (parent.__issue as Issue).body),
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: FIELD('[Issue]', (parent) => parent.__nodes ?? []),
      pageInfo: FIELD('PageInfo', (parent) => parent.__pageInfo),
      totalCount: SCALAR((parent) => parent.__totalCount ?? 0),
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: SCALAR((parent) => parent.hasNextPage ?? false),
      endCursor: SCALAR((parent) => parent.endCursor ?? null),
      hasPreviousPage: SCALAR((parent) => parent.hasPreviousPage ?? false),
      startCursor: SCALAR((parent) => parent.startCursor ?? null),
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: SCALAR((parent) => globalId('PR', (parent.__repo as Repo).id, (parent.__pull as Pull).number)),
      number: SCALAR((parent) => (parent.__pull as Pull).number),
      title: SCALAR((parent) => (parent.__pull as Pull).title),
      state: SCALAR((parent) => {
        const pull = parent.__pull as Pull;
        if (pull.merged) return 'MERGED';
        return pull.state.toUpperCase();
      }),
      merged: SCALAR((parent) => (parent.__pull as Pull).merged),
      headRefName: SCALAR((parent) => (parent.__pull as Pull).head),
      baseRefName: SCALAR((parent) => (parent.__pull as Pull).base),
      mergeable: SCALAR((parent, _args, ctx) => ctx.store.pullMergeable(parent.__repo as Repo, parent.__pull as Pull)),
      files: FIELD('FileConnection', (parent, args, ctx) => {
        const repo = parent.__repo as Repo;
        const pull = parent.__pull as Pull;
        const files = ctx.store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return {
          __typename: 'FileConnection',
          __nodes: files.slice(0, first).map((f) => ({ __typename: 'PullRequestFile', path: f.filename })),
          __pageInfo: pageInfoView(first < files.length, null, false, null),
        };
      }),
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: FIELD('[PullRequest]', (parent) => parent.__nodes ?? []),
      pageInfo: FIELD('PageInfo', (parent) => parent.__pageInfo),
      totalCount: SCALAR((parent) => parent.__totalCount ?? 0),
    },
  },
  FileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: FIELD('[PullRequestFile]', (parent) => parent.__nodes ?? []),
      pageInfo: FIELD('PageInfo', (parent) => parent.__pageInfo),
    },
  },
  PullRequestFile: { kind: 'OBJECT', fields: { path: SCALAR((parent) => parent.path) } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: FIELD('Issue', (parent) => issueView(parent.__repo as Repo, parent.__issue as Issue)) } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: FIELD('Issue', (parent) => issueView(parent.__repo as Repo, parent.__issue as Issue)) } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: FIELD('PullRequest', (parent) => pullView(parent.__repo as Repo, parent.__pull as Pull)) } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: FIELD('PullRequest', (parent) => pullView(parent.__repo as Repo, parent.__pull as Pull)) } },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: FIELD('IssueCommentEdge', (parent) => ({
        __typename: 'IssueCommentEdge',
        __node: { __typename: 'IssueComment', __repo: parent.__repo, __issueNumber: parent.__issueNumber, __comment: parent.__comment },
      })),
    },
  },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: FIELD('IssueComment', (parent) => parent.__node) } },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: SCALAR((parent) => globalId('C', (parent.__repo as Repo).id, Number(parent.__issueNumber ?? 0), Number((parent.__comment as { id: number }).id ?? 0))),
      body: SCALAR((parent) => (parent.__comment as { body: string }).body),
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: SCALAR((parent) => parent.name ?? null),
      kind: SCALAR((parent) => parent.kind ?? null),
      fields: FIELD('[__Field]', (parent) => (parent as { __fields?: AnyView[] }).__fields ?? null),
      enumValues: FIELD('[__EnumValue]', (parent) => (parent as { __enumValues?: AnyView[] }).__enumValues ?? null),
    },
  },
  __Field: { kind: 'OBJECT', fields: { name: SCALAR((parent) => parent.name) } },
  __EnumValue: { kind: 'OBJECT', fields: { name: SCALAR((parent) => parent.name) } },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: FIELD('__Type', () => typeView('Query')),
      mutationType: FIELD('__Type', () => typeView('Mutation')),
      types: FIELD('[__Type]', () => Object.keys(SCHEMA).map((name) => typeView(name))),
    },
  },
  Node: { kind: 'OBJECT', fields: { id: SCALAR((parent) => parent.id ?? null) } },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
};

function typeView(name: string): AnyView | null {
  const def = SCHEMA[name];
  if (!def) return null;
  const fields = def.fields ? Object.keys(def.fields).map((fieldName) => ({ __typename: '__Field', name: fieldName })) : null;
  const enumValues = def.values ? def.values.map((value) => ({ __typename: '__EnumValue', name: value })) : null;
  return { __typename: '__Type', name, kind: def.kind, __fields: fields, __enumValues: enumValues };
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function baseTypeName(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

function executeSelections(typeName: string, parent: AnyView | null, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}"` });
        continue;
      }
      if (fragment.typeCondition && parent?.__typename && fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(fragment.typeCondition, parent, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && parent?.__typename && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(selection.typeCondition ?? typeName, parent, selection.selections, ctx));
      continue;
    }
    const fieldDef = SCHEMA[typeName]?.fields?.[selection.name];
    const key = selection.alias ?? selection.name;
    if (!fieldDef) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}"` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(selection.args)) args[name] = resolveValue(node, ctx.variables);
    let value: unknown;
    try {
      value = fieldDef.resolve(parent ?? {}, args, ctx);
    } catch (error) {
      ctx.errors.push({ message: (error as Error).message });
      out[key] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[key] = value;
      continue;
    }
    const nextType = baseTypeName(fieldDef.type);
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        const itemType = (item as AnyView)?.__typename ?? nextType;
        return executeSelections(itemType, item as AnyView, selection.selections, ctx);
      });
    } else {
      const itemType = (value as AnyView)?.__typename ?? nextType;
      out[key] = executeSelections(itemType, value as AnyView, selection.selections, ctx);
    }
  }
  return out;
}

export interface GraphqlResult {
  readonly status: number;
  readonly body: unknown;
}

function executeOperation(store: Store, operation: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  const query = typeof operation.query === 'string' ? operation.query : '';
  const variables = (operation.variables !== null && typeof operation.variables === 'object' && !Array.isArray(operation.variables)
    ? (operation.variables as Record<string, unknown>)
    : {});
  let parsed: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: (error as Error).message }] };
  }
  if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL document contains no operation' }] };
  }
  const requestedName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
  const op = requestedName
    ? parsed.operations.find((o) => o.name === requestedName) ?? parsed.operations[0]
    : parsed.operations[0];
  const ctx: Ctx = { store, variables, fragments: parsed.fragments, errors: [] };
  const rootType = (op as Operation).kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, null, (op as Operation).selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

export function handleGraphql(store: Store, rawBody: string): GraphqlResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody === '' ? '{}' : rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(payload)) {
    return { status: 200, body: payload.map((entry) => executeOperation(store, (entry ?? {}) as Record<string, unknown>)) };
  }
  if (payload === null || typeof payload !== 'object') {
    return { status: 400, body: { errors: [{ message: 'GraphQL request must be an object' }] } };
  }
  return { status: 200, body: executeOperation(store, payload as Record<string, unknown>) };
}
