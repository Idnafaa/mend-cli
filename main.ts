// mend — apply AI-written edits (unified diffs, SEARCH/REPLACE, V4A, JSON tool calls) to a file tree.
// Behaviour follows SPEC.md v1 sentence by sentence. Node standard library only.
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = new Set(['auto', 'unified', 'search-replace', 'v4a', 'json']);

class Stop2 {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class EditFail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

function isBlankLine(s: string): boolean {
  return s.trim() === '';
}

function toPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function leadOf(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function stripTrailST(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end -= 1;
  return s.slice(0, end);
}

function stripBothST(s: string): string {
  return stripTrailST(s.slice(leadOf(s).length));
}

function onlyST(s: string): boolean {
  for (const ch of s) {
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function eqAtTier(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailST(a) === stripTrailST(b);
  return stripBothST(a) === stripBothST(b);
}

interface Doc {
  rows: string[];
  eol: string;
  tail: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { rows: [], eol: '\n', tail: false };
  const at = text.indexOf('\n');
  const eol = at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  const tail = text.endsWith(eol);
  const rows = text.split(eol);
  if (tail) rows.pop();
  return { rows, eol, tail };
}

function renderDoc(rows: string[], eol: string, tail: boolean): string {
  if (rows.length === 0) return '';
  return rows.join(eol) + (tail ? eol : '');
}

class Overlay {
  base = new Map<string, string | null>();
  top = new Map<string, string | null>();

  original(p: string): string | null {
    const hit = this.base.get(p);
    if (hit !== undefined) return hit;
    let value: string | null = null;
    try {
      if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
    } catch {
      value = null;
    }
    this.base.set(p, value);
    return value;
  }

  current(p: string): string | null {
    if (this.top.has(p)) return this.top.get(p) as string | null;
    return this.original(p);
  }
}

type Job = (ov: Overlay, moves: [string, string][]) => void;

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function hitsAtTier(rows: string[], oldRows: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (oldRows.length === 0) return out;
  for (let i = Math.max(0, from); i + oldRows.length <= rows.length; i += 1) {
    if (eofOnly && i + oldRows.length !== rows.length) continue;
    let ok = true;
    for (let k = 0; k < oldRows.length; k += 1) {
      if (!eqAtTier(tier, rows[i + k] as string, oldRows[k] as string)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Located {
  tier: number;
  hits: number[];
}

function locateOld(rows: string[], oldRows: string[], strict: boolean, from: number, eofOnly: boolean): Located | null {
  for (const tier of tierList(strict)) {
    const hits = hitsAtTier(rows, oldRows, tier, from, eofOnly);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

interface NewPiece {
  txt: string;
  ctxOld: number | null;
}

function buildReplacement(rows: string[], pos: number, oldRows: string[], news: NewPiece[], tier: number): string[] {
  const out: string[] = [];
  let fileLead = '';
  let patchLead = '';
  if (tier === 2 && oldRows.length > 0) {
    fileLead = leadOf(rows[pos] as string);
    patchLead = leadOf(oldRows[0] as string);
  }
  for (const piece of news) {
    if (piece.ctxOld !== null) {
      out.push(rows[pos + piece.ctxOld] as string);
    } else if (tier === 2 && piece.txt !== '' && !onlyST(piece.txt) && piece.txt.startsWith(patchLead)) {
      out.push(fileLead + piece.txt.slice(patchLead.length));
    } else {
      out.push(piece.txt);
    }
  }
  return out;
}

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const head = (lines[first] as string).trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && ((lines[i + 1] as string | undefined) ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- JSON edits (SPEC section 9) ----------

function jsonJobFor(value: unknown): Job | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const path = rec.path;
  if (typeof path !== 'string') return null;

  const needFile = (ov: Overlay): string => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    const cur = ov.current(path);
    if (cur === null) throw new EditFail('missing', path);
    return cur;
  };

  if (rec.command === 'create' && typeof rec.file_text === 'string') {
    const body = rec.file_text;
    return (ov) => {
      if (!isSafePath(path)) throw new EditFail('unsafe', path);
      if (ov.current(path) !== null) throw new EditFail('exists', path);
      ov.top.set(path, body);
    };
  }

  if (
    rec.command === 'str_replace' &&
    typeof rec.old_str === 'string' &&
    rec.old_str !== '' &&
    (rec.new_str === undefined || typeof rec.new_str === 'string')
  ) {
    const oldRaw = rec.old_str;
    const newRaw = (rec.new_str as string | undefined) ?? '';
    return (ov) => {
      const before = needFile(ov);
      const nlAt = before.indexOf('\n');
      const crlf = nlAt > 0 && before[nlAt - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const hay = norm(before);
      const needle = norm(oldRaw);
      let seen = 0;
      let firstAt = -1;
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
        if (firstAt < 0) firstAt = at;
        seen += 1;
      }
      if (seen === 0) throw new EditFail('no-match', path);
      if (seen > 1) throw new EditFail('ambiguous', path);
      const joined = hay.slice(0, firstAt) + norm(newRaw) + hay.slice(firstAt + needle.length);
      ov.top.set(path, crlf ? joined.replaceAll('\n', '\r\n') : joined);
    };
  }

  if (
    rec.command === 'insert' &&
    typeof rec.insert_line === 'number' &&
    Number.isInteger(rec.insert_line) &&
    typeof rec.new_str === 'string'
  ) {
    const atLine = rec.insert_line;
    const extra = toPatchLines(rec.new_str);
    return (ov) => {
      const before = needFile(ov);
      const doc = parseDoc(before);
      if (atLine < 0 || atLine > doc.rows.length) throw new EditFail('no-match', path);
      const rows = [...doc.rows];
      rows.splice(atLine, 0, ...extra);
      ov.top.set(path, renderDoc(rows, doc.eol, doc.tail));
    };
  }

  return null;
}

function parseJsonJobs(text: string, lines: string[]): Job[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw new Stop2('error: parse 1');
  const jobs: Job[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Stop2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Stop2(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const job = jsonJobFor(item);
      if (job === null) throw new Stop2(`error: parse ${first + 1}`);
      jobs.push(job);
    }
    return jobs;
  }
  lines.forEach((line, idx) => {
    if (isBlankLine(line)) return;
    let job: Job | null = null;
    try {
      job = jsonJobFor(JSON.parse(line));
    } catch {
      job = null;
    }
    if (job === null) throw new Stop2(`error: parse ${idx + 1}`);
    jobs.push(job);
  });
  return jobs;
}

// ---------- Unified diffs (SPEC section 6) ----------

interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'slash';
  txt: string;
}

interface Hunk {
  aStart: number;
  body: BodyItem[];
}

interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renFrom: string | undefined;
  renTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function isDiffLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function parseDiffPaths(line: string): [string, string] | null {
  const prefix = 'diff --git a/';
  if (!line.startsWith(prefix)) return null;
  const sep = line.indexOf(' b/', prefix.length);
  if (sep < 0) return null;
  const x = line.slice(prefix.length, sep);
  const y = line.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tabAt = rest.indexOf('\t');
  if (tabAt >= 0) rest = rest.slice(0, tabAt);
  const trimmed = rest.trim();
  if (trimmed === '/dev/null') return null;
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2);
  return trimmed;
}

function renamePath(line: string, prefix: string): string {
  let rest = line.slice(prefix.length);
  const tabAt = rest.indexOf('\t');
  if (tabAt >= 0) rest = rest.slice(0, tabAt);
  return rest.trim();
}

function slashAfterLastNew(hunk: Hunk): boolean {
  // A backslash line counts only when it immediately follows the hunk's
  // last context or added line (it refers to the body line before it).
  let lastNewAt = -1;
  for (let idx = 0; idx < hunk.body.length; idx += 1) {
    const item = hunk.body[idx] as BodyItem;
    if (item.kind === 'ctx' || item.kind === 'add') lastNewAt = idx;
  }
  if (lastNewAt < 0) return false;
  const following = hunk.body[lastNewAt + 1] as BodyItem | undefined;
  return following !== undefined && following.kind === 'slash';
}

function pickNearest(hits: number[], target: number): number {
  // Nearest hit to the (possibly wrong) hunk position; ties go to the earlier hit.
  let best = hits[0] as number;
  let bestDist = Math.abs(best - target);
  for (const hit of hits) {
    const dist = Math.abs(hit - target);
    if (dist < bestDist) {
      best = hit;
      bestDist = dist;
    }
  }
  return best;
}

function hunkOldNew(hunk: Hunk): { oldRows: string[]; news: NewPiece[] } {
  const oldRows: string[] = [];
  const news: NewPiece[] = [];
  for (const item of hunk.body) {
    if (item.kind === 'ctx') {
      const oi = oldRows.length;
      oldRows.push(item.txt);
      news.push({ txt: item.txt, ctxOld: oi });
    } else if (item.kind === 'del') {
      oldRows.push(item.txt);
    } else if (item.kind === 'add') {
      news.push({ txt: item.txt, ctxOld: null });
    }
  }
  return { oldRows, news };
}

function parseUnifiedJobs(lines: string[], strict: boolean): Job[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;

  const freshSection = (): Section => ({
    diffOld: undefined,
    diffNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    hasPair: false,
    renFrom: undefined,
    renTo: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
  });

  while (i < lines.length) {
    const line = lines[i] as string;

    if (isDiffLine(line)) {
      const pair = parseDiffPaths(line);
      if (pair === null) throw new Stop2(`error: parse ${i + 1}`);
      cur = freshSection();
      cur.diffOld = pair[0];
      cur.diffNew = pair[1];
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      if (cur === null) throw new Stop2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Stop2(`error: parse ${i + 1}`);
      const aStart = Number(m[1]);
      let j = i + 1;
      const raw: string[] = [];
      while (j < lines.length) {
        const bl = lines[j] as string;
        if (isDiffLine(bl)) break;
        if (bl.startsWith('--- ') && ((lines[j + 1] as string | undefined) ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          raw.push(bl);
          j += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const body: BodyItem[] = raw.map((r) => {
        if (r === '') return { kind: 'ctx' as const, txt: '' };
        const c = r[0] as string;
        if (c === ' ') return { kind: 'ctx' as const, txt: r.slice(1) };
        if (c === '-') return { kind: 'del' as const, txt: r.slice(1) };
        if (c === '+') return { kind: 'add' as const, txt: r.slice(1) };
        return { kind: 'slash' as const, txt: r.slice(1) };
      });
      cur.hunks.push({ aStart, body });
      inHeader = false;
      i = j;
      continue;
    }

    if (line.startsWith('--- ') && ((lines[i + 1] as string | undefined) ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1] as string);
      if (cur !== null && inHeader) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      } else {
        cur = freshSection();
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }

    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Stop2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renFrom = renamePath(line, 'rename from ');
      else if (line.startsWith('rename to ')) cur.renTo = renamePath(line, 'rename to ');
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }

    i += 1;
  }

  const jobs: Job[] = [];
  for (const sec of sections) {
    let oldPath: string | null;
    let newPath: string | null;
    if (sec.hasPair) {
      oldPath = sec.pairOld as string | null;
      newPath = sec.pairNew as string | null;
    } else if (sec.renFrom !== undefined || sec.renTo !== undefined) {
      oldPath = sec.renFrom ?? (sec.diffOld as string);
      newPath = sec.renTo ?? (sec.diffNew as string);
    } else {
      oldPath = sec.diffOld as string;
      newPath = sec.diffNew as string;
    }

    let kind: 'create' | 'delete' | 'move' | 'change';
    if (newPath === null) kind = 'delete';
    else if (oldPath === null) kind = 'create';
    else if (sec.newFile && !sec.delFile) kind = 'create';
    else if (sec.delFile && !sec.newFile) kind = 'delete';
    else if (sec.newFile && sec.delFile) kind = 'create';
    else if (oldPath !== newPath) kind = 'move';
    else kind = 'change';

    const hunks = sec.hunks;
    const oPath = oldPath;
    const nPath = newPath;

    if (kind === 'create') {
      const target = nPath as string;
      jobs.push((ov) => {
        if (!isSafePath(target)) throw new EditFail('unsafe', target);
        if (ov.current(target) !== null) throw new EditFail('exists', target);
        const added: string[] = [];
        let lastHunk = -1;
        let lastAt = -1;
        hunks.forEach((h, hi) => {
          h.body.forEach((item, bi) => {
            if (item.kind === 'add') {
              added.push(item.txt);
              lastHunk = hi;
              lastAt = bi;
            }
          });
        });
        let tail = true;
        if (lastHunk >= 0) {
          const nxt = (hunks[lastHunk] as Hunk).body[lastAt + 1] as BodyItem | undefined;
          tail = !(nxt !== undefined && nxt.kind === 'slash');
        }
        ov.top.set(target, added.length === 0 ? '' : added.join('\n') + (tail ? '\n' : ''));
      });
    } else if (kind === 'delete') {
      const target = oPath as string;
      jobs.push((ov) => {
        if (!isSafePath(target)) throw new EditFail('unsafe', target);
        if (ov.current(target) === null) throw new EditFail('missing', target);
        ov.top.set(target, null);
      });
    } else {
      const fromPath = oPath as string;
      const toPath = nPath as string;
      const isMove = kind === 'move';
      jobs.push((ov, moves) => {
        if (!isSafePath(fromPath)) throw new EditFail('unsafe', fromPath);
        if (isMove && !isSafePath(toPath)) throw new EditFail('unsafe', toPath);
        const before = ov.current(fromPath);
        if (before === null) throw new EditFail('missing', fromPath);
        if (isMove && ov.current(toPath) !== null) throw new EditFail('exists', toPath);
        const doc = parseDoc(before);
        let rows = [...doc.rows];
        let tail = doc.tail;
        let drift = 0;
        for (const hunk of hunks) {
          const { oldRows, news } = hunkOldNew(hunk);
          if (oldRows.length === 0) {
            const want = hunk.aStart + drift;
            const pos = Math.max(0, Math.min(want, rows.length));
            const atEnd = pos === rows.length;
            const fresh = news.map((n) => n.txt);
            rows.splice(pos, 0, ...fresh);
            if (atEnd) tail = !slashAfterLastNew(hunk);
          } else {
            const found = locateOld(rows, oldRows, strict, 0, false);
            if (found === null) throw new EditFail('no-match', fromPath);
            const best = pickNearest(found.hits, hunk.aStart - 1 + drift);
            const preLen = rows.length;
            const repl = buildReplacement(rows, best, oldRows, news, found.tier);
            const touchesEnd = best + oldRows.length === preLen;
            rows.splice(best, oldRows.length, ...repl);
            if (touchesEnd) tail = !slashAfterLastNew(hunk);
          }
          drift += news.length - oldRows.length;
        }
        const text = renderDoc(rows, doc.eol, tail);
        if (isMove) {
          ov.top.set(fromPath, null);
          ov.top.set(toPath, text);
          moves.push([fromPath, toPath]);
        } else {
          ov.top.set(fromPath, text);
        }
      });
    }
  }
  return jobs;
}

// ---------- SEARCH/REPLACE (SPEC section 7) ----------

function parseSearchJobs(lines: string[], strict: boolean): Job[] {
  interface Block {
    path: string;
    oldRows: string[];
    newRows: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eqAt = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if ((lines[j] as string).trimEnd() === '=======') {
        eqAt = j;
        break;
      }
    }
    if (eqAt < 0) throw new Stop2(`error: parse ${searchAt + 1}`);
    let repAt = -1;
    for (let j = eqAt + 1; j < lines.length; j += 1) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        repAt = j;
        break;
      }
    }
    if (repAt < 0) throw new Stop2(`error: parse ${searchAt + 1}`);
    const oldRows = lines.slice(searchAt + 1, eqAt);
    const newRows = lines.slice(eqAt + 1, repAt);
    let path: string | null = null;
    for (let b = searchAt - 1; b > prevEnd; b -= 1) {
      const cand = lines[b] as string;
      if (isBlankLine(cand)) continue;
      const trimmed = cand.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Stop2(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldRows, newRows });
    prevPath = path;
    prevEnd = repAt;
    i = repAt + 1;
  }

  return blocks.map((block) => (ov: Overlay) => {
    const path = block.path;
    if (block.oldRows.length === 0) {
      if (!isSafePath(path)) throw new EditFail('unsafe', path);
      if (ov.current(path) !== null) throw new EditFail('exists', path);
      ov.top.set(path, block.newRows.length === 0 ? '' : block.newRows.join('\n') + '\n');
      return;
    }
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    const before = ov.current(path);
    if (before === null) throw new EditFail('missing', path);
    const doc = parseDoc(before);
    const found = locateOld(doc.rows, block.oldRows, strict, 0, false);
    if (found === null) throw new EditFail('no-match', path);
    if (found.hits.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.hits[0] as number;
    const news: NewPiece[] = block.newRows.map((t) => ({ txt: t, ctxOld: null }));
    const repl = buildReplacement(doc.rows, pos, block.oldRows, news, found.tier);
    const rows = [...doc.rows];
    rows.splice(pos, block.oldRows.length, ...repl);
    ov.top.set(path, renderDoc(rows, doc.eol, doc.tail));
  });
}

// ---------- V4A (SPEC section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addRows: string[];
  chunks: VChunk[];
}

function isVHeader(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function parseV4aJobs(lines: string[], strict: boolean): Job[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw new Stop2('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Stop2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlankLine(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if (last < 0 || (lines[last] as string).trim() !== '*** End Patch') {
    throw new Stop2(`error: parse ${lines.length + 1}`);
  }

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (isBlankLine(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Stop2(`error: parse ${i + 1}`);
    }
    const headerAt = i;
    i += 1;
    const rawStart = i;
    while (i < last && !isVHeader(lines[i] as string)) i += 1;
    let rawEnd = i;
    while (rawEnd > rawStart && isBlankLine(lines[rawEnd - 1] as string)) rawEnd -= 1;
    const raw = lines.slice(rawStart, rawEnd);

    if (kind === 'add') {
      const addRows: string[] = [];
      raw.forEach((r, off) => {
        if (r === '') addRows.push('');
        else if (r.startsWith('+')) addRows.push(r.slice(1));
        else throw new Stop2(`error: parse ${rawStart + off + 1}`);
      });
      sections.push({ kind, path, moveTo: null, addRows, chunks: [] });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Stop2(`error: parse ${rawStart + 1}`);
      sections.push({ kind, path, moveTo: null, addRows: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let rest = raw;
      let restStart = rawStart;
      if (rest.length > 0 && (rest[0] as string).startsWith('*** Move to: ')) {
        moveTo = (rest[0] as string).slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
        restStart += 1;
      }
      if (rest.length === 0 && moveTo === null) throw new Stop2(`error: parse ${headerAt + 1}`);
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      rest.forEach((r, off) => {
        const lineNo = restStart + off + 1;
        if (r === '*** End of File') {
          if (curChunk === null) throw new Stop2(`error: parse ${lineNo}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          return;
        }
        if (r.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          const anchorText = r.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          return;
        }
        if (r === '' || r[0] === ' ' || r[0] === '-' || r[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Stop2(`error: parse ${lineNo}`);
            curChunk = { anchor: null, eof: false, body: [] };
          }
          curChunk.body.push(r);
          return;
        }
        throw new Stop2(`error: parse ${lineNo}`);
      });
      if (curChunk !== null) chunks.push(curChunk);
      sections.push({ kind, path, moveTo, addRows: [], chunks });
    }
  }

  return sections.map((sec) => (ov: Overlay, moves: [string, string][]) => {
    if (sec.kind === 'add') {
      if (!isSafePath(sec.path)) throw new EditFail('unsafe', sec.path);
      if (ov.current(sec.path) !== null) throw new EditFail('exists', sec.path);
      ov.top.set(sec.path, sec.addRows.length === 0 ? '' : sec.addRows.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!isSafePath(sec.path)) throw new EditFail('unsafe', sec.path);
      if (ov.current(sec.path) === null) throw new EditFail('missing', sec.path);
      ov.top.set(sec.path, null);
      return;
    }
    if (!isSafePath(sec.path)) throw new EditFail('unsafe', sec.path);
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) throw new EditFail('unsafe', sec.moveTo);
    const before = ov.current(sec.path);
    if (before === null) throw new EditFail('missing', sec.path);
    if (sec.moveTo !== null && ov.current(sec.moveTo) !== null) throw new EditFail('exists', sec.moveTo);
    const doc = parseDoc(before);
    let rows = [...doc.rows];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let foundAt = -1;
        for (const tier of tierList(strict)) {
          for (let k = cursor; k < rows.length; k += 1) {
            if (eqAtTier(tier, rows[k] as string, chunk.anchor)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new EditFail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const oldRows: string[] = [];
      const news: NewPiece[] = [];
      for (const r of chunk.body) {
        if (r === '') {
          const oi = oldRows.length;
          oldRows.push('');
          news.push({ txt: '', ctxOld: oi });
        } else if (r[0] === ' ') {
          const oi = oldRows.length;
          oldRows.push(r.slice(1));
          news.push({ txt: r.slice(1), ctxOld: oi });
        } else if (r[0] === '-') {
          oldRows.push(r.slice(1));
        } else {
          news.push({ txt: r.slice(1), ctxOld: null });
        }
      }
      if (oldRows.length === 0) {
        const pos = chunk.eof ? rows.length : cursor;
        const fresh = news.map((n) => n.txt);
        rows.splice(pos, 0, ...fresh);
        cursor = pos + fresh.length;
      } else {
        const found = locateOld(rows, oldRows, strict, cursor, chunk.eof);
        if (found === null) throw new EditFail('no-match', sec.path);
        const pos = found.hits[0] as number;
        const repl = buildReplacement(rows, pos, oldRows, news, found.tier);
        rows.splice(pos, oldRows.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const text = renderDoc(rows, doc.eol, doc.tail);
    if (sec.moveTo !== null) {
      ov.top.set(sec.path, null);
      ov.top.set(sec.moveTo, text);
      moves.push([sec.path, sec.moveTo]);
    } else {
      ov.top.set(sec.path, text);
    }
  });
}

// ---------- Driver (SPEC sections 1, 2, 10) ----------

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsDone = false;
  for (const arg of args) {
    if (!optionsDone && arg === '--') {
      optionsDone = true;
    } else if (!optionsDone && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && KNOWN_FORMATS.has(arg.slice(9))) {
        format = arg.slice(9);
      } else if (arg === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchFile = positional.length === 0 || positional[0] === '-' ? null : (positional[0] as string);
  let patchText = '';
  try {
    patchText = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = toPatchLines(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let jobs: Job[];
  try {
    if (kind === 'json') jobs = parseJsonJobs(patchText, lines);
    else if (kind === 'unified') jobs = parseUnifiedJobs(lines, strict);
    else if (kind === 'search-replace') jobs = parseSearchJobs(lines, strict);
    else jobs = parseV4aJobs(lines, strict);
    if (jobs.length === 0) throw new Stop2('error: parse 1');
  } catch (err) {
    if (err instanceof Stop2) return { code: 2, out: [err.text] };
    throw err;
  }

  const ov = new Overlay();
  const moves: [string, string][] = [];
  const fails: EditFail[] = [];
  for (const job of jobs) {
    const savedTop = new Map(ov.top);
    const savedMoves = moves.length;
    try {
      job(ov, moves);
    } catch (err) {
      if (!(err instanceof EditFail)) throw err;
      ov.top.clear();
      for (const [k, v] of savedTop) ov.top.set(k, v);
      moves.length = savedMoves;
      fails.push(err);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${jobs.length} edits`],
    };
  }

  const claimed = new Set<string>();
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const [oldP, newP] of moves) {
    if (claimed.has(oldP) || claimed.has(newP)) continue;
    if (ov.original(oldP) === null) continue;
    if (ov.current(oldP) !== null) continue;
    if (ov.original(newP) !== null) continue;
    if (ov.current(newP) === null) continue;
    claimed.add(oldP);
    claimed.add(newP);
    rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  }
  const changed: string[] = [];
  for (const p of ov.top.keys()) {
    if (ov.original(p) === ov.top.get(p)) continue;
    changed.push(p);
    if (claimed.has(p)) continue;
    const was = ov.original(p);
    const now = ov.top.get(p) as string | null;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  if (!checkOnly) {
    for (const p of changed) {
      const now = ov.top.get(p) as string | null;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
