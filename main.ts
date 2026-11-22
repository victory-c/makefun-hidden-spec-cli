// mend: applies AI-written edits (unified diff, SEARCH/REPLACE, V4A, JSON edits) to a tree of text files.
// Implements SPEC.md v1. Node 22 standard library only. Run as `node main.ts [options] [PATCH]`.
// When MAKEFUN_ENV_URL is set the file hands over to the kit's runner.ts (see the last lines).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------- failures ----------

/** A whole-run failure: exit 2 with one line. */
class Fatal {
  readonly msg: string;
  constructor(msg: string) {
    this.msg = msg;
  }
}
/** One edit failing: `error: <code> <path>`. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}
const parseErr = (n: number): Fatal => new Fatal(`error: parse ${n}`);

// ---------- text model ----------

const isBlank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Patch text into lines: split at \n, drop one trailing \r each, drop the piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  for (let i = 0; i < out.length; i++) if (out[i].endsWith('\r')) out[i] = out[i].slice(0, -1);
  return out;
}

interface Doc {
  lines: string[];
  br: string;
  fin: boolean;
}

/** A file's text as lines with its own break and whether it ended with one (SPEC 3). */
function readDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, fin: false };
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.fin ? d.br : '');
}

/** New file text with LF breaks, final break unless told otherwise. */
function newText(lines: string[], fin = true): string {
  return writeDoc({ lines, br: '\n', fin });
}

// ---------- matching (SPEC 5) ----------

const TIERS: Array<(s: string) => string> = [(s) => s, stripTrail, stripBoth];

interface Found {
  tier: number;
  at: number[];
}

/**
 * Occurrences of `old` in `lines` at the first tier that has one.
 * `from` restricts to positions >= from; `eof` to the one ending at the last line.
 */
function locate(lines: string[], old: string[], strict: boolean, from = 0, eof = false): Found | null {
  const k = old.length;
  const last = lines.length - k;
  const tiers = strict ? 1 : 3;
  for (let t = 0; t < tiers; t++) {
    const f = TIERS[t];
    const want = old.map(f);
    const at: number[] = [];
    const start = eof ? Math.max(from, last) : from;
    for (let i = start; i <= last; i++) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (f(lines[i + j]) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** A line of N: its text, and for a context line its index in O (else -1). */
interface NLine {
  s: string;
  ctx: number;
}

/** Lines that replace O matched at `pos` on `tier`: contexts from the file, re-indent at tier 2. */
function replacement(lines: string[], pos: number, tier: number, old: string[], neu: NLine[]): string[] {
  const F = leadWs(lines[pos] ?? '');
  const P = leadWs(old[0] ?? '');
  return neu.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx];
    if (tier === 2 && !isBlank(n.s) && n.s.startsWith(P)) return F + n.s.slice(P.length);
    return n.s;
  });
}

/** Replace `old.length` lines at pos; returns the new line array. */
function splice(lines: string[], pos: number, tier: number, old: string[], neu: NLine[]): string[] {
  const rep = replacement(lines, pos, tier, old, neu);
  return [...lines.slice(0, pos), ...rep, ...lines.slice(pos + old.length)];
}

// ---------- the tree (SPEC 3, 10) ----------

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(...paths: string[]): void {
  for (const p of paths) if (!isSafe(p)) throw new EditFail('unsafe', p);
}

/** File states as the edits so far leave them; null means no file. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  cur = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  get(p: string): string | null {
    return this.cur.has(p) ? this.cur.get(p)! : this.before(p);
  }
  set(p: string, v: string | null): void {
    this.cur.set(p, v);
  }
  /** Existing file text, else `missing`. */
  must(p: string): string {
    const t = this.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  }
  /** The path is free, else `exists`. */
  free(p: string): void {
    if (this.get(p) !== null) throw new EditFail('exists', p);
  }
  snapshot(): [Map<string, string | null>, number] {
    return [new Map(this.cur), this.moves.length];
  }
  restore(s: [Map<string, string | null>, number]): void {
    this.cur = s[0];
    this.moves.length = s[1];
  }
}

type Edit = (tree: Tree) => void;

// ---------- JSON edits (SPEC 9) ----------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Build an edit from one JSON value, or null on any parse fault. */
function jsonEdit(v: unknown): Edit | null {
  if (!isObj(v) || typeof v.path !== 'string') return null;
  const path = v.path;
  switch (v.command) {
    case 'create': {
      if (typeof v.file_text !== 'string') return null;
      const text = v.file_text;
      return (tree) => {
        needSafe(path);
        tree.free(path);
        tree.set(path, text);
      };
    }
    case 'str_replace': {
      if (typeof v.old_str !== 'string' || v.old_str === '') return null;
      if (v.new_str !== undefined && typeof v.new_str !== 'string') return null;
      const oldS = v.old_str;
      const newS = (v.new_str as string | undefined) ?? '';
      return (tree) => {
        needSafe(path);
        const text = tree.must(path);
        const crlf = readDoc(text).br === '\r\n';
        const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const body = norm(text);
        const o = norm(oldS);
        const first = body.indexOf(o);
        if (first < 0) throw new EditFail('no-match', path);
        if (body.indexOf(o, first + 1) >= 0) throw new EditFail('ambiguous', path);
        const out = body.slice(0, first) + norm(newS) + body.slice(first + o.length);
        tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
      };
    }
    case 'insert': {
      if (typeof v.insert_line !== 'number' || !Number.isInteger(v.insert_line)) return null;
      if (typeof v.new_str !== 'string') return null;
      const at = v.insert_line;
      const add = splitPatch(v.new_str);
      return (tree) => {
        needSafe(path);
        const d = readDoc(tree.must(path));
        if (at < 0 || at > d.lines.length) throw new EditFail('no-match', path);
        d.lines.splice(at, 0, ...add);
        tree.set(path, writeDoc(d));
      };
    }
    default:
      return null;
  }
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseErr(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    // Array form: any fault names the line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseErr(first + 1);
    }
    if (!Array.isArray(v)) throw parseErr(first + 1);
    for (const item of v) {
      const e = jsonEdit(item);
      if (!e) throw parseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(lines[i]));
    } catch {
      e = null;
    }
    if (!e) throw parseErr(i + 1);
    edits.push(e);
  }
  return edits;
}

// ---------- unified diffs (SPEC 6) ----------

interface UBody {
  t: ' ' | '-' | '+';
  s: string;
  nonl: boolean; // a `\` line follows it
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  gitOld?: string;
  gitNew?: string;
  pair: boolean;
  pairOld?: string | null;
  pairNew?: string | null;
  renFrom?: string;
  renTo?: string;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `--- `/`+++ ` path: after 4 chars, up to the first tab, spaces trimmed, a/ or b/ removed; null for /dev/null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +/, '').replace(/ +$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** `diff --git a/X b/Y` paths, or null when the line is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cuts: number[] = [];
  for (let k = rest.indexOf(' b/'); k >= 0; k = rest.indexOf(' b/', k + 1)) cuts.push(k);
  if (cuts.length === 0) return null;
  const pick = cuts.find((k) => rest.slice(2, k) === rest.slice(k + 3)) ?? cuts[0];
  return [rest.slice(2, pick), rest.slice(pick + 3)];
}

const isPair = (lines: string[], i: number): boolean =>
  lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

function readUnified(lines: string[]): USection[] {
  const secs: USection[] = [];
  let sec: USection | null = null;
  let header = false;
  const fresh = (): USection => ({ pair: false, create: false, del: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const g = gitPaths(l);
      if (!g) throw parseErr(i + 1);
      sec = fresh();
      sec.gitOld = g[0];
      sec.gitNew = g[1];
      secs.push(sec);
      header = true;
      i++;
      continue;
    }
    if (isPair(lines, i)) {
      if (!(sec && header && !sec.pair)) {
        sec = fresh();
        secs.push(sec);
        header = true;
      }
      sec.pair = true;
      sec.pairOld = headerPath(l);
      sec.pairNew = headerPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (sec && header && l.startsWith('--- ')) throw parseErr(i + 2);
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (!m || !sec) throw parseErr(i + 1);
      header = false;
      let j = i + 1;
      while (j < lines.length && isBodyLine(lines[j]) && !isPair(lines, j)) j++;
      let end = j;
      while (end > i + 1 && lines[end - 1] === '') end--;
      const body: UBody[] = [];
      for (let k = i + 1; k < end; k++) {
        const b = lines[k];
        if (b.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1].nonl = true;
        } else if (b === '') body.push({ t: ' ', s: '', nonl: false });
        else body.push({ t: b[0] as UBody['t'], s: b.slice(1), nonl: false });
      }
      sec.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (sec && header) {
      if (l.startsWith('rename from ')) sec.renFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) sec.renTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) sec.create = true;
      else if (l.startsWith('deleted file mode')) sec.del = true;
    }
    i++;
  }
  return secs;
}

/** Apply a section's hunks in order to a file's text (SPEC 6, "Applying hunks"). */
function applyHunks(text: string, hunks: UHunk[], path: string, strict: boolean): string {
  const doc = readDoc(text);
  let lines = doc.lines;
  let d = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const neu: NLine[] = [];
    let lastNew: UBody | null = null;
    for (const b of h.body) {
      if (b.t === ' ') {
        neu.push({ s: b.s, ctx: old.length });
        old.push(b.s);
        lastNew = b;
      } else if (b.t === '-') old.push(b.s);
      else {
        neu.push({ s: b.s, ctx: -1 });
        lastNew = b;
      }
    }
    const endFin = !(lastNew && lastNew.nonl);
    if (old.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      if (at === lines.length) doc.fin = endFin;
      lines = [...lines.slice(0, at), ...neu.map((n) => n.s), ...lines.slice(at)];
    } else {
      const found = locate(lines, old, strict);
      if (!found) throw new EditFail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.at[0];
      for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      if (pos + old.length === lines.length) doc.fin = endFin;
      lines = splice(lines, pos, found.tier, old, neu);
    }
    d += neu.length - old.length;
  }
  doc.lines = lines;
  return writeDoc(doc);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.pair ? sec.pairOld! : sec.renFrom ?? sec.gitOld ?? null;
  const newP = sec.pair ? sec.pairNew! : sec.renTo ?? sec.gitNew ?? null;
  // Sides not named by a pair fall back to rename / git paths when the pair left them undefined.
  if (sec.create || oldP === null) {
    const path = newP ?? oldP ?? '';
    return (tree) => {
      needSafe(path);
      tree.free(path);
      const plus: UBody[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.t === '+') plus.push(b);
      const fin = !(plus.length > 0 && plus[plus.length - 1].nonl);
      tree.set(path, newText(plus.map((b) => b.s), fin));
    };
  }
  if (sec.del || newP === null) {
    const path = oldP;
    return (tree) => {
      needSafe(path);
      tree.must(path);
      tree.set(path, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      needSafe(oldP, newP);
      const text = tree.must(oldP);
      tree.free(newP);
      const out = applyHunks(text, sec.hunks, oldP, strict);
      tree.set(oldP, null);
      tree.set(newP, out);
      tree.moves.push([oldP, newP]);
    };
  }
  return (tree) => {
    needSafe(oldP);
    const text = tree.must(oldP);
    tree.set(oldP, applyHunks(text, sec.hunks, oldP, strict));
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC 7) ----------

const marker = (l: string, m: string): boolean => stripTrailWs(l) === m;
function stripTrailWs(s: string): string {
  return s.replace(/\s+$/, '');
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let floor = 0; // first line after the previous block
  let i = 0;
  while (i < lines.length) {
    if (!marker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= floor; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw parseErr(i + 1);
    let mid = -1;
    for (let k = i + 1; k < lines.length; k++) if (marker(lines[k], '=======')) {
      mid = k;
      break;
    }
    let end = -1;
    if (mid >= 0) for (let k = mid + 1; k < lines.length; k++) if (marker(lines[k], '>>>>>>> REPLACE')) {
      end = k;
      break;
    }
    if (end < 0) throw parseErr(i + 1);
    edits.push(srEdit(path, lines.slice(i + 1, mid), lines.slice(mid + 1, end), strict));
    prevPath = path;
    floor = end + 1;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, old: string[], neu: string[], strict: boolean): Edit {
  return (tree) => {
    needSafe(path);
    if (old.length === 0) {
      tree.free(path);
      tree.set(path, newText(neu));
      return;
    }
    const doc = readDoc(tree.must(path));
    const found = locate(doc.lines, old, strict);
    if (!found) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    doc.lines = splice(doc.lines, found.at[0], found.tier, old, neu.map((s) => ({ s, ctx: -1 })));
    tree.set(path, writeDoc(doc));
  };
}

// ---------- V4A patches (SPEC 8) ----------

interface VChunk {
  anchor: string | null;
  body: UBody[];
  eof: boolean;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw parseErr(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last])) last--;
  if (last <= first || lines[last].trim() !== '*** End Patch') throw parseErr(lines.length + 1);
  // Split into sections; each is [header line index, body line indices].
  const heads: number[] = [];
  for (let i = first + 1; i < last; i++) {
    const l = lines[i];
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) heads.push(i);
    else if (heads.length === 0 && !isBlank(l)) throw parseErr(i + 1);
  }
  const edits: Edit[] = [];
  heads.forEach((h, n) => {
    let end = n + 1 < heads.length ? heads[n + 1] : last;
    while (end > h + 1 && isBlank(lines[end - 1])) end--;
    const head = lines[h];
    const body = lines.slice(h + 1, end);
    const at = (k: number): number => h + 2 + k; // 1-based patch line of body[k]
    if (head.startsWith('*** Add File: ')) {
      const path = head.slice(14).trim();
      const out: string[] = [];
      body.forEach((b, k) => {
        if (b.startsWith('+')) out.push(b.slice(1));
        else if (b === '') out.push('');
        else throw parseErr(at(k));
      });
      edits.push((tree) => {
        needSafe(path);
        tree.free(path);
        tree.set(path, newText(out));
      });
    } else if (head.startsWith('*** Delete File: ')) {
      const path = head.slice(17).trim();
      if (body.length > 0) throw parseErr(at(0));
      edits.push((tree) => {
        needSafe(path);
        tree.must(path);
        tree.set(path, null);
      });
    } else {
      const path = head.slice(17).trim();
      let k = 0;
      let moveTo: string | null = null;
      if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
        moveTo = body[0].slice(13).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < body.length; k++) {
        const b = body[k];
        if (b.startsWith('@@')) {
          const a = b.slice(2).trim();
          cur = { anchor: a === '' ? null : a, body: [], eof: false };
          chunks.push(cur);
        } else if (b.trim() === '*** End of File') {
          if (!cur) throw parseErr(at(k));
          cur.eof = true;
          cur = null;
        } else if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (!cur) {
            if (chunks.length > 0) throw parseErr(at(k));
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(b === '' ? { t: ' ', s: '', nonl: false } : { t: b[0] as UBody['t'], s: b.slice(1), nonl: false });
        } else throw parseErr(at(k));
      }
      if (chunks.length === 0 && moveTo === null) throw parseErr(h + 1);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  });
  if (edits.length === 0) throw parseErr(1);
  return edits;
}

function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (moveTo !== null) needSafe(path, moveTo);
    else needSafe(path);
    const doc = readDoc(tree.must(path));
    if (moveTo !== null) tree.free(moveTo);
    let lines = doc.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const hit = locate(lines, [c.anchor], strict, cursor);
        if (!hit) throw new EditFail('no-match', path);
        cursor = hit.at[0] + 1;
      }
      const old: string[] = [];
      const neu: NLine[] = [];
      for (const b of c.body) {
        if (b.t === ' ') {
          neu.push({ s: b.s, ctx: old.length });
          old.push(b.s);
        } else if (b.t === '-') old.push(b.s);
        else neu.push({ s: b.s, ctx: -1 });
      }
      if (old.length === 0) {
        const at = c.eof ? lines.length : Math.min(cursor, lines.length);
        lines = [...lines.slice(0, at), ...neu.map((n) => n.s), ...lines.slice(at)];
        cursor = at + neu.length;
      } else {
        const hit = locate(lines, old, strict, cursor, c.eof);
        if (!hit) throw new EditFail('no-match', path);
        const pos = hit.at[0];
        lines = splice(lines, pos, hit.tier, old, neu);
        cursor = pos + neu.length;
      }
    }
    doc.lines = lines;
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else tree.set(path, out);
  };
}

// ---------- detection and the run (SPEC 1, 2, 4, 10) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => stripTrailWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('diff --git ') || isPair(lines, i)) return 'unified';
  return null;
}

const NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface Result {
  code: number;
  out: string[];
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function parseArgs(args: string[]): { format: string; check: boolean; strict: boolean; file: string | null } | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let done = false;
  const pos: string[] = [];
  for (const a of args) {
    if (done || a === '-' || !a.startsWith('-')) pos.push(a);
    else if (a === '--') done = true;
    else if (a.startsWith('--format=')) {
      const v = a.slice(9);
      if (format !== null || !NAMES.includes(v)) return null;
      format = v;
    } else if (a === '--check') {
      if (check) return null;
      check = true;
    } else if (a === '--strict') {
      if (strict) return null;
      strict = true;
    } else return null;
  }
  if (pos.length > 1) return null;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  return { format: format ?? 'auto', check, strict, file };
}

function readEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  let edits: Edit[];
  if (kind === 'json') edits = parseJson(text, lines);
  else if (kind === 'v4a') edits = parseV4A(lines, strict);
  else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
  else edits = readUnified(lines).map((s) => unifiedEdit(s, strict));
  if (edits.length === 0) throw parseErr(1);
  return edits;
}

function run(args: string[]): Result {
  const opt = parseArgs(args);
  if (!opt) return { code: 2, out: ['error: usage'] };
  let text = '';
  if (opt.file !== null) {
    try {
      text = readFileSync(opt.file, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  }
  const lines = splitPatch(text);
  const kind = opt.format === 'auto' ? detect(lines) : opt.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = readEdits(kind, text, lines, opt.strict);
  } catch (e) {
    if (e instanceof Fatal) return { code: 2, out: [e.msg] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  return commit(tree, opt.check);
}

/** Report (and unless --check, write) every changed path (SPEC 2, exit 0). */
function commit(tree: Tree, check: boolean): Result {
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const [p, now] of tree.cur) {
    const was = tree.before(p);
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<[string, string]> = [];
  for (const [from, to] of tree.moves) {
    if (changed.get(from) === 'D' && changed.get(to) === 'A') {
      changed.delete(from);
      changed.delete(to);
      rows.push([to, `R ${from} -> ${to}`]);
    }
  }
  for (const [p, k] of changed) rows.push([p, `${k} ${p}`]);
  rows.sort((a, b) => byteOrder(a[0], b[0]));
  if (!check) {
    for (const [p, now] of tree.cur) {
      if (tree.before(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
    }
    for (const [p, now] of tree.cur) {
      if (now === null || tree.before(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r[1]), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
