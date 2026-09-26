/**
 * Pure layout of the submitted text into reader paragraphs, driven by the chunk plan.
 *
 * Every character of the original text is accounted for: chunk spans render as ChunkText, the text
 * between chunks inside a paragraph renders verbatim, and a gap containing a paragraph break
 * (2+ line breaks, API.md §6.3) becomes a paragraph boundary. Non-whitespace inside such a gap
 * (e.g. a "***" separator the planner dropped as unspeakable) becomes its own plain paragraph.
 */
import type { ChunkSpan } from '@tamber/client';

export type Segment =
  | { kind: 'gap'; start: number; end: number }
  | { kind: 'chunk'; chunk: ChunkSpan };

export interface Paragraph {
  key: string;
  start: number;
  end: number;
  /** Plan indices in this paragraph (empty for plain paragraphs). */
  chunkIndices: number[];
  segments: Segment[];
}

/** Line breaks in `s` counted as in API.md §6.1 (\r\n = 1, U+2029 = 2). */
export function countLineBreaks(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0d) {
      n++;
      if (s.charCodeAt(i + 1) === 0x0a) i++;
    } else if (c === 0x0a || c === 0x0b || c === 0x0c || c === 0x85 || c === 0x2028) n++;
    else if (c === 0x2029) n += 2;
  }
  return n;
}

function plainParagraph(text: string, start: number, end: number): Paragraph | null {
  // Trim whitespace on both sides, keep the exact inner slice.
  let a = start;
  let b = end;
  while (a < b && /\s/.test(text[a]!)) a++;
  while (b > a && /\s/.test(text[b - 1]!)) b--;
  if (a >= b) return null;
  return { key: `t${a}`, start: a, end: b, chunkIndices: [], segments: [{ kind: 'gap', start: a, end: b }] };
}

export function buildParagraphs(text: string, plan: readonly ChunkSpan[]): Paragraph[] {
  const chunks = [...plan].sort((x, y) => x.char_start - y.char_start);
  const out: Paragraph[] = [];
  if (chunks.length === 0) {
    const p = plainParagraph(text, 0, text.length);
    return p ? [p] : [];
  }

  const lead = plainParagraph(text, 0, chunks[0]!.char_start);
  if (lead) out.push(lead);

  let current: Paragraph | null = null;
  let prevEnd = -1;
  for (const chunk of chunks) {
    if (current && prevEnd >= 0) {
      const gap = text.slice(prevEnd, chunk.char_start);
      if (countLineBreaks(gap) >= 2) {
        out.push(current);
        const sep = plainParagraph(text, prevEnd, chunk.char_start);
        if (sep) out.push(sep);
        current = null;
      } else if (chunk.char_start > prevEnd) {
        current.segments.push({ kind: 'gap', start: prevEnd, end: chunk.char_start });
      }
    }
    if (!current) {
      current = {
        key: `p${chunk.char_start}`,
        start: chunk.char_start,
        end: chunk.char_end,
        chunkIndices: [],
        segments: [],
      };
    }
    current.segments.push({ kind: 'chunk', chunk });
    current.chunkIndices.push(chunk.index);
    current.end = chunk.char_end;
    prevEnd = chunk.char_end;
  }
  if (current) out.push(current);

  const tail = plainParagraph(text, prevEnd, text.length);
  if (tail) out.push(tail);
  return out;
}

/** Map plan index -> paragraph position. */
export function paragraphIndexByChunk(paragraphs: readonly Paragraph[]): Map<number, number> {
  const m = new Map<number, number>();
  paragraphs.forEach((p, i) => {
    for (const c of p.chunkIndices) m.set(c, i);
  });
  return m;
}

/** The exact text a paragraph renders (for accessibility and tests). */
export function paragraphText(text: string, p: Paragraph): string {
  return p.segments
    .map((s) => (s.kind === 'gap' ? text.slice(s.start, s.end) : text.slice(s.chunk.char_start, s.chunk.char_end)))
    .join('');
}

/** "#RRGGBB" + alpha -> "rgba(...)". */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
