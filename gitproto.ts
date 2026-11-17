// The git smart-HTTP protocol: pkt-line framing, v0 and v2 advertisements,
// ls-refs, fetch (v2 and v0, with shallow/deepen semantics) and receive-pack
// (v0, report-status). Everything the suite's git client speaks, nothing more.

import { Store, type Repo } from './store.ts';
import {
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitstore.ts';

export const AGENT = 'forge/1.0.0';
const MAIN = 'refs/heads/main';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, payload]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** A sideband packet: one band byte followed by up to ~64 KiB of payload. */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65_500;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

interface Pkt {
  readonly kind: 'data' | 'flush' | 'delim';
  readonly payload?: Buffer;
}

/** Decode pkt-lines from the start of `buffer`; returns packets plus the unconsumed tail. */
export function decodePktLines(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function textLines(packets: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload) out.push(packet.payload.toString('utf8'));
  }
  return out;
}

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
}

/** All refs the repo advertises: HEAD, branches, tags (annotated tags carry their peeled commit). */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const mainTip = repo.refs.get(MAIN);
  out.push({ oid: mainTip ?? ZERO_OID, name: 'HEAD' });
  const branches: string[] = [];
  const tags: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) branches.push(ref);
    else if (ref.startsWith('refs/tags/')) tags.push(ref);
  }
  branches.sort();
  tags.sort();
  for (const ref of branches) out.push({ oid: repo.refs.get(ref) as string, name: ref });
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const tag = parseTag(object.data);
      out.push({ oid, name: ref, peeled: tag.object });
    } else {
      out.push({ oid, name: ref });
    }
  }
  return out;
}

function hasCommits(repo: Repo): boolean {
  return repo.refs.size > 0;
}

const UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:${MAIN} agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs thin-pack ofs-delta symref=HEAD:${MAIN} agent=${AGENT}`;

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const serviceLine = pktLine(`# service=${service}\n`);
  const refs = refLines(repo);
  const lines: Buffer[] = [serviceLine, FLUSH];
  if (!hasCommits(repo)) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

/** The v2 advertisement names no refs, so one buffer serves every request. */
const V2_ADVERTISEMENT = v2Advertisement();

/**
 * A content fingerprint of the repo's refs. Git objects are content-addressed
 * and immutable once stored, and every ref-dependent response (advertisement,
 * ls-refs) is a pure function of the refs plus the request, so this string is
 * a sound cache key component for them.
 */
function refsFingerprint(repo: Repo): string {
  let out = '';
  for (const [ref, oid] of repo.refs) out += `${ref} ${oid}\n`;
  return out;
}

const PROTO_CACHE_LIMIT = 512;

function protoCachePut(repo: Repo, key: string, body: Buffer): void {
  if (repo.protoCache.size >= PROTO_CACHE_LIMIT) repo.protoCache.clear();
  repo.protoCache.set(key, body);
}

interface FetchPlan {
  /** Commits whose objects go into the pack. */
  readonly includedCommits: string[];
  /** New shallow boundaries (depth-limited commits). */
  readonly shallow: string[];
  /** Old shallow boundaries that are now interior. */
  readonly unshallow: string[];
  /** Objects the client already holds (excluded from the pack). */
  readonly excluded: Set<string>;
}

/**
 * Work out what a fetch sends. `wants` are commit oids; `haves` are commits the
 * client holds; `clientShallow` are its shallow boundaries (held, but their
 * parents are not); `depth` limits generations from the wants (depth 1 = the
 * tip commit only, and it becomes the new boundary).
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = new Set(haves);
  const shallowSet = new Set(clientShallow);
  const included: string[] = [];
  const newShallow = new Set<string>();
  const unshallowed = new Set<string>();
  const visited = new Set<string>();
  // BFS by generation from the wants.
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 0 }));
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    // A tag want resolves to its target commit.
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      included.push(oid);
      if (!visited.has(target)) queue.push({ oid: target, gen });
      continue;
    }
    if (object.type !== 'commit') continue;
    const isHave = haveSet.has(oid);
    const isClientShallow = shallowSet.has(oid);
    if (isHave && !isClientShallow) continue; // client holds it and its whole ancestry
    const atDepthLimit = depth !== undefined && gen >= depth - 1;
    if (!isHave) included.push(oid);
    if (atDepthLimit) {
      if (!isHave) newShallow.add(oid);
      continue; // parents stay on the client side of the boundary
    }
    if (isHave && isClientShallow) unshallowed.add(oid); // we are sending its parents now
    const parents = parseCommit(object.data).parents;
    for (const parent of parents) {
      if (!visited.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  // Objects the client already holds: full closures of non-shallow haves, and
  // the shallow haves themselves with their trees/blobs (but not their parents).
  const excluded = new Set<string>();
  for (const have of haveSet) {
    const object = lookup(have);
    if (!object) continue;
    if (shallowSet.has(have)) {
      excluded.add(have);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        excluded.add(commit.tree);
        for (const entry of parseTree(lookup(commit.tree)?.data ?? Buffer.alloc(0))) {
          if (entry.mode !== '160000') excluded.add(entry.oid);
        }
        // Blobs under subtrees: walk the tree closure without touching parents.
        const stack = [commit.tree];
        while (stack.length) {
          const treeOid = stack.pop() as string;
          const treeObject = lookup(treeOid);
          if (!treeObject || treeObject.type !== 'tree') continue;
          for (const entry of parseTree(treeObject.data)) {
            if (entry.mode === '40000') stack.push(entry.oid);
            else if (entry.mode !== '160000') excluded.add(entry.oid);
          }
        }
      }
    } else {
      for (const oid of collectReachable([have], lookup)) excluded.add(oid);
    }
  }
  return { includedCommits: included, shallow: [...newShallow], unshallow: [...unshallowed], excluded };
}

/**
 * The objects a fetch sends for one commit: the commit itself plus its tree
 * closure (trees and blobs) — never its parents. A depth-limited fetch must
 * not leak history past the boundary, so the pack is built from these sets,
 * not from the full reachability closure.
 */
function commitObjects(repo: Repo, oid: string): Set<string> {
  const out = new Set<string>();
  const lookup = (id: string): GitObject | undefined => repo.objects.get(id);
  const object = lookup(oid);
  if (!object) return out;
  out.add(oid);
  if (object.type === 'tag') {
    const target = parseTag(object.data).object;
    const targetObject = lookup(target);
    if (targetObject?.type === 'commit') {
      for (const nested of commitObjects(repo, target)) out.add(nested);
    } else if (targetObject) {
      out.add(target);
    }
    return out;
  }
  if (object.type !== 'commit') return out;
  const commit = parseCommit(object.data);
  out.add(commit.tree);
  const stack = [commit.tree];
  while (stack.length) {
    const treeOid = stack.pop() as string;
    const treeObject = lookup(treeOid);
    if (!treeObject || treeObject.type !== 'tree') continue;
    for (const entry of parseTree(treeObject.data)) {
      out.add(entry.oid);
      if (entry.mode === '40000') stack.push(entry.oid);
    }
  }
  return out;
}

function buildFetchPack(repo: Repo, plan: FetchPlan): Buffer {
  const wanted = new Set<string>();
  for (const oid of plan.includedCommits) {
    for (const nested of commitObjects(repo, oid)) wanted.add(nested);
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (plan.excluded.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return writePack(objects);
}

export class GitProto {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  infoRefs(repo: Repo, service: string, gitProtocol: string | undefined): GitResponse {
    if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
    }
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      const contentType =
        service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';
      const key = `adv0|${service}|${refsFingerprint(repo)}`;
      const cached = repo.protoCache.get(key);
      if (cached !== undefined) return { status: 200, contentType, body: cached };
      const body = v0Advertisement(repo, service);
      protoCachePut(repo, key, body);
      return { status: 200, contentType, body };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8') };
  }

  lsRefsV2(repo: Repo, packets: readonly Pkt[]): GitResponse {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    let pastDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') { pastDelim = true; continue; }
      if (packet.kind !== 'data' || !packet.payload) continue;
      const line = packet.payload.toString('utf8');
      if (line.startsWith('command=')) continue;
      if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
      if (!pastDelim) continue;
      const trimmed = line.replace(/\n$/, '');
      if (trimmed === 'peel') peel = true;
      else if (trimmed === 'symrefs') symrefs = true;
      else if (trimmed === 'unborn') unborn = true;
      else if (trimmed.startsWith('ref-prefix ')) prefixes.push(trimmed.slice('ref-prefix '.length));
    }
    const cacheKey = `lsr|${refsFingerprint(repo)}|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}|${prefixes.join(',')}`;
    const cached = repo.protoCache.get(cacheKey);
    if (cached !== undefined) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: Buffer[] = [];
    const mainTip = repo.refs.get(MAIN);
    if (keep('HEAD')) {
      if (mainTip === undefined) {
        if (unborn) out.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${MAIN}` : ''}\n`));
      } else {
        out.push(pktLine(`${mainTip} HEAD${symrefs ? ` symref-target:${MAIN}` : ''}\n`));
      }
    }
    for (const ref of refLines(repo)) {
      if (ref.name === 'HEAD') continue;
      if (!keep(ref.name)) continue;
      const peeled = peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
      out.push(pktLine(`${ref.oid} ${ref.name}${peeled}\n`));
    }
    out.push(FLUSH);
    const result = Buffer.concat(out);
    protoCachePut(repo, cacheKey, result);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: result };
  }

  fetchV2(repo: Repo, packets: readonly Pkt[]): GitResponse {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let pastDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') { pastDelim = true; continue; }
      if (packet.kind !== 'data' || !packet.payload) continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('command=')) continue;
      if (!pastDelim) continue;
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: this.fetchBody(repo, wants, haves, shallow, depth, true) };
  }

  /**
   * The full fetch response for one negotiation. It is a pure function of the
   * request and the object graph reachable from the named oids, and stored
   * objects are immutable — so once every want/have/shallow names an object
   * already in the store, the answer can be cached and replayed verbatim.
   * When any named oid is missing, a later push could add it and change the
   * answer, so those requests are never cached.
   */
  private fetchBody(repo: Repo, wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | undefined, v2: boolean): Buffer {
    const allKnown = [...wants, ...haves, ...shallow].every((oid) => repo.objects.has(oid));
    const key = allKnown ? `f${v2 ? 2 : 0}|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}` : null;
    if (key !== null) {
      const cached = repo.protoCache.get(key);
      if (cached !== undefined) return cached;
    }
    const plan = planFetch(repo, wants, haves, shallow, depth);
    const pack = buildFetchPack(repo, plan);
    const parts: Buffer[] = v2 ? [pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH] : [pktLine('NAK\n')];
    if (v2) {
      if (plan.shallow.length || plan.unshallow.length) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(FLUSH);
      }
      parts.push(pktLine('packfile\n'));
    } else {
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    }
    parts.push(...sidebandPackets(1, pack));
    parts.push(FLUSH);
    const body = Buffer.concat(parts);
    if (key !== null) protoCachePut(repo, key, body);
    return body;
  }

  fetchV0(repo: Repo, packets: readonly Pkt[]): GitResponse {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const line of textLines(packets)) {
      const trimmed = line.replace(/\n$/, '');
      if (trimmed.startsWith('want ')) wants.push(trimmed.slice(5).split(' ')[0] as string);
      else if (trimmed.startsWith('have ')) haves.push(trimmed.slice(5).trim());
      else if (trimmed.startsWith('shallow ')) shallow.push(trimmed.slice(8).trim());
      else if (trimmed.startsWith('deepen ')) depth = Number(trimmed.slice(7).trim());
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: this.fetchBody(repo, wants, haves, shallow, depth, false) };
  }

  /** Dispatch a POST to git-upload-pack: v2 command or v0 want/have negotiation. */
  uploadPack(repo: Repo, body: Buffer, gitProtocol: string | undefined): GitResponse {
    const { packets } = decodePktLines(body);
    const first = packets.find((p) => p.kind === 'data' && p.payload)?.payload?.toString('utf8') ?? '';
    if (gitProtocol === 'version=2' && first.startsWith('command=ls-refs')) return this.lsRefsV2(repo, packets);
    if (gitProtocol === 'version=2' && first.startsWith('command=fetch')) return this.fetchV2(repo, packets);
    return this.fetchV0(repo, packets);
  }

  receivePack(repo: Repo, body: Buffer): GitResponse {
    const { packets, rest } = decodePktLines(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of packets) {
      if (packet.kind !== 'data' || !packet.payload) continue;
      const line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      const clean = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
      const parts = clean.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    const reportLines: string[] = [];
    let unpackOk = true;
    if (rest.length > 0) {
      try {
        const { objects } = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (error) {
        unpackOk = false;
        reportLines.push(`unpack ${(error as Error).message}\n`);
      }
    }
    if (unpackOk) reportLines.push('unpack ok\n');
    for (const command of commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${command.ref} unpack failed\n`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) reportLines.push(`ng ${command.ref} ref does not exist\n`);
        else if (current !== command.oldOid) reportLines.push(`ng ${command.ref} old value does not match\n`);
        else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reportLines.push(`ng ${command.ref} ref already exists\n`);
        else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} ref does not exist\n`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} old value does not match\n`);
      } else if (!isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
    // The report-status stream is pkt-lined inside band 1, then the outer
    // sideband stream ends with a flush.
    const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), FLUSH]);
    const parts = [...sidebandPackets(1, inner), FLUSH];
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
  }
}

export { hashObject };
