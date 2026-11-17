# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

Node 22, stdlib only, one process. No git binary, no proxy, no outside service.

## Layout

- `main.ts` — entry <-> env lifecycle (bind an ephemeral port, register it, poll `/done`, exit 0).
- `app.ts` — the HTTP server: routing, the bearer-token gate on the API surfaces, `X-GitHub-Request-Id`.
- `store.ts` — the forge's store: repositories, git objects and refs, issues, pull requests, labels, comments; squash merge with a file-level 3-way conflict check.
- `gitstore.ts` — the git object model (commit/tree/blob/tag), reachability, and the packfile codec (plain packs on write, OFS/REF delta resolution on read).
- `gitproto.ts` — pkt-line framing, v0 and v2 advertisements, ls-refs, fetch (v2 and v0, with shallow/deepen semantics) and receive-pack (v0, report-status, fast-forward enforced).
- `rest.ts` — REST v3: repos, refs, branches, commits, contents, labels, issues, comments, pull requests.
- `graphql.ts` — a hand-rolled GraphQL parser and executor (viewer, repository, node, issues with cursor pagination, pull requests, the five mutations, `__type` introspection).
- `mcp.ts` — MCP over JSON-RPC 2.0 Streamable HTTP (`server/discover`, `initialize`, `tools/list`, `tools/call` for the six tools).
- `scenario.ts` — the viewer identity, derived the same way the suite derives it from its published scenario seed.

## Run locally

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:1 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` points at an unreachable address on purpose: registration
retries silently in the background while the server serves on its ephemeral
port. Then, from the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token <token> --json
```

## Notes

- All state is in memory for one trial; ordering and timestamps come from one
  monotonic sequence, never from a wall clock or `Math.random`, so two runs on
  the same requests agree.
- The bearer <redacted> is the trial token from `MAKEFUN_SHOP_TOKEN`; it is never
  stored in this repo.
