/**
 * Reference implementation of Tamber's deterministic chunk planner (docs/API.md "Chunking").
 *
 * The server is authoritative (it sends the full plan in the `start` event), but it MUST produce
 * exactly what this function produces for the same inputs; fixtures/chunking.json is the shared
 * conformance suite (generated from this file by scripts/generate-fixtures.mjs, consumed by the
 * Python tests). Clients may use this to preview boundaries before a request is sent.
 *
 * All positions and lengths are UTF-16 code units (JS string indices). The rules only inspect BMP
 * characters, so a code-point-based implementation (Python) makes identical decisions as long as it
 * measures lengths/limits in UTF-16 units and never cuts inside a surrogate pair.
 */
import type { ChunkMode, ChunkSpan } from './types.ts';

export const CHUNK_TARGET_CHARS_DEFAULT = 280;
export const CHUNK_MAX_CHARS_DEFAULT = 400;
/** Lower bound the server enforces for TAMBER_CHUNK_MAX_CHARS. */
export const CHUNK_MAX_CHARS_MIN = 50;

export interface ChunkPlanOptions {
  mode?: ChunkMode;
  targetChars?: number;
  maxChars?: number;
}

/** A half-open `[start, end)` span of the source text. */
export interface TextSpan {
  start: number;
  end: number;
}

// --- Character classes (all BMP) --------------------------------------------------------------

const WHITESPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
/** Sentence terminators. */
const TERMINATORS = new Set(['.', '!', '?', '…', '‼', '⁇', '⁈', '⁉', '。', '！', '？', '｡']);
/** Terminators that end a sentence even without following whitespace (CJK full-width). */
const CJK_TERMINATORS = new Set(['。', '！', '？', '｡']);
/** Closing quotes/brackets that stay attached to the sentence they close. */
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»', '›', '」', '』', '）', '】']);
/** Opening quotes/brackets stripped from the front of a word before the abbreviation check. */
const OPENERS = new Set(['"', "'", '“', '‘', '(', '[', '{', '«', '‹', '「', '『', '（', '【']);
/** Clause punctuation used to split an over-long sentence (needs following whitespace). */
const CLAUSE = new Set([',', ';', ':', '—', '–']);
/** CJK clause punctuation (no following whitespace needed). */
const CJK_CLAUSE = new Set(['，', '；', '：', '、']);

/** Lower-case abbreviations (without the final period) that do not end a sentence. */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'ft',
  'vs',
  'etc',
  'al',
  'cf',
  'approx',
  'dept',
  'est',
  'fig',
  'figs',
  'inc',
  'ltd',
  'co',
  'corp',
  'no',
  'nos',
  'vol',
  'vols',
  'pp',
  'ed',
  'eds',
  'rev',
  'gen',
  'gov',
  'sen',
  'rep',
  'lt',
  'col',
  'capt',
  'sgt',
  'cpl',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'u.s',
  'u.k',
  'e.u',
  'ph.d',
  'm.d',
  'b.a',
  'm.a',
  'ave',
  'blvd',
  'rd',
  'hwy',
]);

const LOWERCASE_LETTER = /^\p{Ll}$/u;
const SPEAKABLE = /[\p{L}\p{N}]/u;
const ASCII_LETTER = /^[A-Za-z]$/;

function isWs(text: string, i: number): boolean {
  return WHITESPACE.has(text.charCodeAt(i));
}

/** Number of line breaks in text[s, e): CRLF counts once, U+2029 (paragraph separator) counts twice. */
function lineBreaks(text: string, s: number, e: number): number {
  let count = 0;
  for (let i = s; i < e; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d) {
      count++;
      if (i + 1 < e && text.charCodeAt(i + 1) === 0x0a) i++;
    } else if (c === 0x0a || c === 0x0b || c === 0x0c || c === 0x85 || c === 0x2028) {
      count++;
    } else if (c === 0x2029) {
      count += 2;
    }
  }
  return count;
}

function trimSpan(text: string, s: number, e: number): TextSpan | null {
  while (s < e && isWs(text, s)) s++;
  while (e > s && isWs(text, e - 1)) e--;
  return s < e ? { start: s, end: e } : null;
}

/**
 * Rule 1 - paragraphs: split at every whitespace run containing >= 2 line breaks; trim each piece;
 * drop empty pieces.
 */
export function splitParagraphs(text: string): TextSpan[] {
  const out: TextSpan[] = [];
  const n = text.length;
  let segStart = 0;
  let i = 0;
  while (i < n) {
    if (isWs(text, i)) {
      let j = i;
      while (j < n && isWs(text, j)) j++;
      if (lineBreaks(text, i, j) >= 2) {
        const span = trimSpan(text, segStart, i);
        if (span) out.push(span);
        segStart = j;
      }
      i = j;
    } else {
      i++;
    }
  }
  const last = trimSpan(text, segStart, n);
  if (last) out.push(last);
  return out;
}

/**
 * Rule 2 - sentences inside one (trimmed) paragraph. A boundary is placed after a terminator run
 * plus any closers when followed by whitespace (or when the run contains a CJK terminator), unless
 * suppressed by an abbreviation, a single-letter initial, or a following lower-case letter.
 */
export function splitSentences(text: string, para: TextSpan): TextSpan[] {
  const { start: ps, end: pe } = para;
  const cuts: number[] = [];
  let i = ps;
  while (i < pe) {
    const ch = text[i]!;
    if (!TERMINATORS.has(ch)) {
      i++;
      continue;
    }
    const runStart = i;
    let j = i;
    let hasCjk = false;
    while (j < pe && TERMINATORS.has(text[j]!)) {
      if (CJK_TERMINATORS.has(text[j]!)) hasCjk = true;
      j++;
    }
    const runEnd = j;
    let end = j;
    while (end < pe && CLOSERS.has(text[end]!)) end++;
    if (end < pe && (hasCjk || isWs(text, end))) {
      let valid = true;
      // Suppression (a): a single "." after an abbreviation or a single ASCII letter (initial).
      if (runEnd - runStart === 1 && ch === '.') {
        let ws = runStart;
        while (ws > ps && !isWs(text, ws - 1)) ws--;
        let w = ws;
        while (w < runStart && OPENERS.has(text[w]!)) w++;
        const word = text.slice(w, runStart);
        if (ABBREVIATIONS.has(word.toLowerCase()) || ASCII_LETTER.test(word)) valid = false;
      }
      // Suppression (b): next non-whitespace character is a lower-case letter (Unicode Ll).
      if (valid) {
        let m = end;
        while (m < pe && isWs(text, m)) m++;
        if (m < pe) {
          const cp = text.codePointAt(m)!;
          if (LOWERCASE_LETTER.test(String.fromCodePoint(cp))) valid = false;
        }
      }
      if (valid) cuts.push(end);
    }
    i = end > runEnd ? end : runEnd;
  }
  const out: TextSpan[] = [];
  let s = ps;
  for (const c of cuts) {
    const span = trimSpan(text, s, c);
    if (span) out.push(span);
    s = c;
  }
  const last = trimSpan(text, s, pe);
  if (last) out.push(last);
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Rule 3 - split a sentence longer than maxChars into pieces of at most maxChars: cut after the
 * last clause punctuation that is followed by whitespace within the window; else before the last
 * whitespace within the window; else hard-cut at maxChars (never inside a surrogate pair).
 */
export function splitLongSentence(text: string, sentence: TextSpan, maxChars: number): TextSpan[] {
  const out: TextSpan[] = [];
  let a = sentence.start;
  const b = sentence.end;
  while (b - a > maxChars) {
    const limit = a + maxChars;
    let cut = -1;
    for (let x = limit; x >= a + 1; x--) {
      const prev = text[x - 1]!;
      if ((CLAUSE.has(prev) && isWs(text, x)) || CJK_CLAUSE.has(prev)) {
        cut = x;
        break;
      }
    }
    if (cut < 0) {
      for (let x = limit; x >= a + 1; x--) {
        if (isWs(text, x)) {
          cut = x;
          break;
        }
      }
    }
    if (cut < 0) {
      cut = limit;
      if (isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
    }
    const piece = trimSpan(text, a, cut);
    if (piece) out.push(piece);
    a = cut;
    while (a < b && isWs(text, a)) a++;
  }
  if (a < b) out.push({ start: a, end: b });
  return out;
}

/** True if the span contains at least one letter or digit (Unicode L* or N*). */
export function isSpeakable(text: string, span: TextSpan): boolean {
  return SPEAKABLE.test(text.slice(span.start, span.end));
}

function resolveLimits(opts: ChunkPlanOptions): { mode: ChunkMode; target: number; max: number } {
  const mode: ChunkMode = opts.mode === 'sentence' ? 'sentence' : 'balanced';
  const max = Math.max(CHUNK_MAX_CHARS_MIN, Math.floor(opts.maxChars ?? CHUNK_MAX_CHARS_DEFAULT));
  const target = Math.min(
    max,
    Math.max(1, Math.floor(opts.targetChars ?? CHUNK_TARGET_CHARS_DEFAULT)),
  );
  return { mode, target, max };
}

/**
 * Plan the chunks for `text`:
 *  1. paragraphs (rule 1) -> 2. sentences (rule 2) -> 3. long-sentence pieces (rule 3)
 *  4. drop pieces with no letter/digit
 *  5. pack: `sentence` = one piece per chunk. `balanced` = the first piece of the whole text is a
 *     chunk on its own; after that, consecutive pieces of the same paragraph are merged while
 *     (last.end - first.start) <= targetChars. Chunks never cross paragraphs.
 *  6. number chunks 0..n-1.
 */
export function planChunks(text: string, options: ChunkPlanOptions = {}): ChunkSpan[] {
  const { mode, target, max } = resolveLimits(options);
  const chunks: ChunkSpan[] = [];
  let isFirst = true;
  for (const para of splitParagraphs(text)) {
    const pieces: TextSpan[] = [];
    for (const sentence of splitSentences(text, para)) {
      for (const piece of splitLongSentence(text, sentence, max)) {
        if (isSpeakable(text, piece)) pieces.push(piece);
      }
    }
    let cur: TextSpan | null = null;
    for (const p of pieces) {
      if (mode === 'sentence') {
        chunks.push({ index: chunks.length, char_start: p.start, char_end: p.end });
        continue;
      }
      if (isFirst) {
        chunks.push({ index: chunks.length, char_start: p.start, char_end: p.end });
        isFirst = false;
        continue;
      }
      if (cur && p.end - cur.start <= target) {
        cur.end = p.end;
      } else {
        if (cur) chunks.push({ index: chunks.length, char_start: cur.start, char_end: cur.end });
        cur = { start: p.start, end: p.end };
      }
    }
    if (cur) chunks.push({ index: chunks.length, char_start: cur.start, char_end: cur.end });
  }
  return chunks;
}

/** Index of the chunk containing `offset` (or the next chunk after it, when it falls in a gap); -1 if none. */
export function chunkIndexForOffset(plan: readonly ChunkSpan[], offset: number): number {
  let lo = 0;
  let hi = plan.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (plan[mid]!.char_end > offset) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}
