import { splitParagraphs, type ChunkSpan, type WordTiming } from '@tamber/client';

/**
 * A block is a paragraph-sized slice of the text rendered as its own element, so that
 * `content-visibility: auto` can skip layout of off-screen paragraphs in 100k-character texts.
 * Blocks tile the whole text ([0, text.length)) so the rendered textContent equals the text.
 */
export interface ReaderBlock {
  start: number;
  end: number;
  chunks: ChunkSpan[];
}

/** Split at paragraph starts, never inside a chunk (chunks do not cross paragraphs anyway). */
export function buildBlocks(text: string, plan: readonly ChunkSpan[]): ReaderBlock[] {
  if (!text) return [];
  const starts = splitParagraphs(text)
    .map((p) => p.start)
    .filter((s) => s > 0);
  const inside = (pos: number) => plan.some((c) => c.char_start < pos && pos < c.char_end);
  const bounds = [0, ...starts.filter((s) => !inside(s)), text.length];
  const blocks: ReaderBlock[] = [];
  let ci = 0;
  for (let b = 0; b < bounds.length - 1; b++) {
    const start = bounds[b]!;
    const end = bounds[b + 1]!;
    if (end <= start) continue;
    const chunks: ChunkSpan[] = [];
    while (ci < plan.length && plan[ci]!.char_start < end) {
      if (plan[ci]!.char_end > start) chunks.push(plan[ci]!);
      ci++;
    }
    blocks.push({ start, end, chunks });
  }
  return blocks;
}

export type Piece =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'word'; start: number; end: number };

/** Split a chunk's range into plain text and timed-word pieces (words sorted, clamped, no overlap). */
export function chunkPieces(chunk: ChunkSpan, words: readonly WordTiming[] | null): Piece[] {
  const out: Piece[] = [];
  let cursor = chunk.char_start;
  if (words) {
    for (const w of words) {
      const ws = Math.max(w.char_start, cursor);
      const we = Math.min(w.char_end, chunk.char_end);
      if (we <= ws) continue;
      if (ws > cursor) out.push({ kind: 'text', start: cursor, end: ws });
      out.push({ kind: 'word', start: ws, end: we });
      cursor = we;
    }
  }
  if (cursor < chunk.char_end) out.push({ kind: 'text', start: cursor, end: chunk.char_end });
  return out;
}
