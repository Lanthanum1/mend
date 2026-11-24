// main.ts is mend, the CLI SPEC.md (version 1) specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines: its line break, its lines, whether it ends with a break. */
interface FileDoc {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function serializeFile(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBr ? d.br : '');
}

function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(old: string, nw: string): void {
    this.moves.push({ old, nw });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers.                           */
/* ------------------------------------------------------------------ */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `o` occurs at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is, or null. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === a) return i;
    }
  }
  return null;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** Re-indent one non-context line of N at tier 2; at other tiers it is written as it is. */
function reindentLine(t: string, fLead: string, pLead: string, tier: number): string {
  if (tier !== 2) return t;
  if (t === '' || t.trim() === '') return t;
  if (!t.startsWith(pLead)) return t;
  return fLead + t.slice(pLead.length);
}

/** Replace the k matched lines at `pos` with N: context lines take the file's own lines. */
function applyReplace(doc: FileDoc, pos: number, o: string[], n: NLine[], tier: number): void {
  const fLead = leadOf(doc.lines[pos] ?? '');
  const pLead = o.length > 0 ? leadOf(o[0]!) : '';
  const out: string[] = [];
  for (const l of n) {
    if (l.ctx) out.push(doc.lines[pos + l.oIndex]!);
    else out.push(reindentLine(l.text, fLead, pLead, tier));
  }
  doc.lines.splice(pos, o.length, ...out);
}

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

/** Split a hunk/chunk body into its old lines O and its new lines N (with context marks). */
function splitBody(items: BodyItem[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const oi = o.length;
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oIndex: oi });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last line of one of the given kinds. */
function backslashAfterLast(items: BodyItem[], kinds: Array<'ctx' | 'new'>): boolean {
  let last = -1;
  for (let k = 0; k < items.length; k++) {
    if (kinds.includes(items[k]!.kind as 'ctx' | 'new')) last = k;
  }
  if (last < 0) return false;
  return items[last + 1] !== undefined && items[last + 1]!.kind === 'backslash';
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (as in the starter).                          */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      const line2 = line;
      if (line2 < 0 || line2 > lines.length) throw new Fail('no-match', p);
      lines.splice(line2, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UniSection {
  pair: { old: string | null; nw: string | null } | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffX: string | null;
  diffY: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function hunkHeadA(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  return m === null ? null : parseInt(m[1]!, 10);
}

function isDiffGit(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

function parseDiffGit(l: string, num: number): [string, string] {
  const rest = l === 'diff --git' ? '' : l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${num}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${num}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${num}`);
  return [x, y];
}

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let i = 0;
  let cur: UniSection | null = null;
  let state: 'outside' | 'header' | 'body' | 'between' = 'outside';
  let bodyLines: string[] = [];
  let curHunkA = 0;

  const startSection = (s: UniSection): void => {
    cur = s;
    sections.push(cur);
    state = 'header';
  };
  const newSection = (diffX: string | null, diffY: string | null): UniSection => ({
    pair: null,
    renameFrom: null,
    renameTo: null,
    diffX,
    diffY,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const finishBody = (): void => {
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
    const items: BodyItem[] = bodyLines.map((l) => {
      if (l === '') return { kind: 'ctx', text: '' };
      const c = l[0]!;
      if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
      if (c === '-') return { kind: 'old', text: l.slice(1) };
      if (c === '+') return { kind: 'new', text: l.slice(1) };
      return { kind: 'backslash', text: l };
    });
    cur!.hunks.push({ a: curHunkA, items });
    bodyLines = [];
    state = 'between';
  };
  const isBodyLine = (l: string, next: string | undefined): boolean => {
    // A `--- ` line followed by a `+++ ` line ends the body (it starts the next section),
    // even though it starts with `-`.
    if (l.startsWith('--- ') && (next ?? '').startsWith('+++ ')) return false;
    return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
  };

  while (i < n) {
    const l = lines[i]!;
    if (state === 'outside') {
      if (isDiffGit(l)) {
        const dg = parseDiffGit(l, i + 1);
        startSection(newSection(dg[0], dg[1]));
        i++;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSection(null, null);
        s.pair = { old: headerPath(l), nw: headerPath(lines[i + 1]!) };
        startSection(s);
        i += 2;
      } else if (l.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
    } else if (state === 'header') {
      if (isDiffGit(l)) {
        const dg = parseDiffGit(l, i + 1);
        startSection(newSection(dg[0], dg[1]));
        i++;
      } else if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.pair = { old: headerPath(l), nw: headerPath(lines[i + 1]!) };
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (l.startsWith('@@')) {
        const a = hunkHeadA(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        curHunkA = a;
        bodyLines = [];
        state = 'body';
        i++;
      } else if (l.startsWith('rename from ')) {
        cur!.renameFrom = l.slice('rename from '.length).trim();
        i++;
      } else if (l.startsWith('rename to ')) {
        cur!.renameTo = l.slice('rename to '.length).trim();
        i++;
      } else if (l.startsWith('new file mode')) {
        cur!.newFile = true;
        i++;
      } else if (l.startsWith('deleted file mode')) {
        cur!.deletedFile = true;
        i++;
      } else {
        i++;
      }
    } else if (state === 'body') {
      if (isBodyLine(l, lines[i + 1])) {
        bodyLines.push(l);
        i++;
      } else {
        finishBody();
      }
    } else {
      // between
      if (isDiffGit(l)) {
        const dg = parseDiffGit(l, i + 1);
        startSection(newSection(dg[0], dg[1]));
        i++;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSection(null, null);
        s.pair = { old: headerPath(l), nw: headerPath(lines[i + 1]!) };
        startSection(s);
        i += 2;
      } else if (l.startsWith('@@')) {
        const a = hunkHeadA(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        curHunkA = a;
        bodyLines = [];
        state = 'body';
        i++;
      } else {
        i++;
      }
    }
  }
  if (state === 'body') finishBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.items);
    if (o.length === 0) {
      const at = Math.min(h.a + d, doc.lines.length);
      const atEnd = at === doc.lines.length;
      const texts = n.map((l) => l.text);
      doc.lines.splice(at, 0, ...texts);
      if (atEnd) doc.finalBr = !backslashAfterLast(h.items, ['ctx', 'new']);
      d += texts.length;
    } else {
      const found = findTier(doc.lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + o.length === doc.lines.length;
      applyReplace(doc, best, o, n, found.tier);
      if (atEnd) doc.finalBr = !backslashAfterLast(h.items, ['ctx', 'new']);
      d += n.length - o.length;
    }
  }
}

function makeUnifiedEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.pair !== null ? s.pair.old : (s.renameFrom ?? s.diffX ?? null);
  const newPath = s.pair !== null ? s.pair.nw : (s.renameTo ?? s.diffY ?? null);
  const kind =
    (oldPath === null || s.newFile) && newPath !== null
      ? 'create'
      : (newPath === null || s.deletedFile) && oldPath !== null
        ? 'delete'
        : oldPath === null || newPath === null
          ? 'noop'
          : oldPath !== newPath
            ? 'move'
            : 'change';
  return (tree) => {
    const paths: string[] = [];
    if (oldPath !== null) paths.push(oldPath);
    if (newPath !== null && newPath !== oldPath) paths.push(newPath);
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    if (kind === 'noop') return;
    if (kind === 'create') {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      let finalBr = true;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        let lastPlus = -1;
        for (let k = 0; k < h.items.length; k++) if (h.items[k]!.kind === 'new') lastPlus = k;
        if (lastPlus >= 0) {
          finalBr = !(h.items[lastPlus + 1] !== undefined && h.items[lastPlus + 1]!.kind === 'backslash');
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    if (kind === 'move') {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const doc = parseFile(text);
      applyHunks(doc, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, serializeFile(doc));
      tree.recordMove(op, np);
      return;
    }
    const doc = parseFile(text);
    applyHunks(doc, s.hunks, strict, op);
    tree.now.set(op, serializeFile(doc));
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevReplace; j--) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = s + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
      const oldLines = lines.slice(s + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(makeSREdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevReplace = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseFile(text);
    const found = findTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const fLead = leadOf(doc.lines[pos]!);
    const pLead = leadOf(oldLines[0]!);
    const out = newLines.map((t) => reindentLine(t, fLead, pLead, found.tier));
    doc.lines.splice(pos, oldLines.length, ...out);
    tree.now.set(path, serializeFile(doc));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                              */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const t = lines[i]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      raw.push({ text: t, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(parseV4aUpdate(path, headerLine, raw, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseV4aUpdate(path: string, headerLine: number, raw: { text: string; num: number }[], strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let firstChunk = true;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    if (r.text.startsWith('@@')) {
      const anchor = r.text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      chunks.push(cur);
      firstChunk = false;
    } else if (r.text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      cur = null;
      firstChunk = false;
    } else if (r.text.startsWith(' ') || r.text.startsWith('-') || r.text.startsWith('+') || r.text === '') {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${r.num}`);
        cur = { anchor: null, eof: false, items: [] };
        chunks.push(cur);
        firstChunk = false;
      }
      if (r.text === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (r.text[0] === ' ') cur.items.push({ kind: 'ctx', text: r.text.slice(1) });
      else if (r.text[0] === '-') cur.items.push({ kind: 'old', text: r.text.slice(1) });
      else cur.items.push({ kind: 'new', text: r.text.slice(1) });
    } else {
      throw new Exit2(`error: parse ${r.num}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(doc.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitBody(ch.items);
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const texts = n.map((l) => l.text);
        doc.lines.splice(at, 0, ...texts);
        cursor = at + texts.length;
      } else {
        const found = findTier(doc.lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos = -1;
        for (const p of found.occ) {
          if (ch.eof && p + o.length !== doc.lines.length) continue;
          pos = p;
          break;
        }
        if (pos < 0) throw new Fail('no-match', path);
        applyReplace(doc, pos, o, n, found.tier);
        cursor = pos + n.length;
      }
    }
    const out = serializeFile(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 1: the command line, and section 10: the output.            */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mvLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = mvLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // The changed paths, as the patch leaves them.
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  const byPath = new Map<string, { was: string | null; now: string | null }>();
  for (const c of changed) byPath.set(c.p, c);
  const entries: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const m of tree.moves) {
    const o = byPath.get(m.old);
    const n = byPath.get(m.nw);
    if (o === undefined || n === undefined) continue;
    if (o.was === null || n.was !== null) continue;
    if (o.now !== null || n.now === null) continue;
    entries.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    used.add(m.old);
    used.add(m.nw);
  }
  for (const c of changed) {
    if (used.has(c.p)) continue;
    const line = c.was === null ? `A ${c.p}` : c.now === null ? `D ${c.p}` : `M ${c.p}`;
    entries.push({ key: c.p, line });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const c of changed) if (c.now === null) rmSync(c.p, { force: true });
    for (const c of changed) {
      if (c.now === null) continue;
      mkdirSync(dirname(c.p), { recursive: true });
      writeFileSync(c.p, c.now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
