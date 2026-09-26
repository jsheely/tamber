/**
 * Pure helpers that turn per-chunk, chunk-relative word timings into one absolute timeline.
 *
 * Timing model (docs/API.md "Timestamps"): each chunk's `words[].start/end` are seconds from the
 * start of that chunk's own audio. Chunks play back-to-back with no gap, so chunk k starts at the
 * sum of the durations of the chunks placed before it. Use the *decoded* duration when you have it
 * (AudioBuffer.duration on web; the player's duration on mobile) so the timeline matches what is
 * actually scheduled; the server's `duration` is exact for WAV.
 */
import type { WordTiming } from './types.ts';

/** Minimal chunk shape the timeline needs (a TtsChunkEvent satisfies it). */
export interface TimelineChunkInput {
  index: number;
  char_start: number;
  char_end: number;
  duration: number;
  words: readonly WordTiming[];
}

export interface TimelineWord {
  /** Position in Timeline.words. */
  globalIndex: number;
  /** Chunk index from the server (plan index). */
  chunkIndex: number;
  /** Index within the chunk's `words`. */
  wordIndex: number;
  text: string;
  /** Absolute seconds on the playback timeline. */
  start: number;
  end: number;
  charStart: number;
  charEnd: number;
}

export interface TimelineChunk {
  /** Chunk index from the server (plan index). */
  index: number;
  /** Position in Timeline.chunks. */
  position: number;
  start: number;
  end: number;
  duration: number;
  charStart: number;
  charEnd: number;
  /** Index in Timeline.words of this chunk's first word (valid only if wordCount > 0). */
  firstWord: number;
  wordCount: number;
}

export interface Timeline {
  chunks: TimelineChunk[];
  words: TimelineWord[];
  /** End time of the last chunk (absolute seconds). */
  duration: number;
}

export interface TimelineOptions {
  /** Absolute time of the first chunk (default 0). */
  startTime?: number;
  /** Override durations by chunk index (e.g. decoded AudioBuffer durations). */
  durations?: ReadonlyMap<number, number> | Readonly<Record<number, number>>;
}

function lookupDuration(
  durations: TimelineOptions['durations'],
  index: number,
): number | undefined {
  if (!durations) return undefined;
  if (durations instanceof Map) return durations.get(index);
  return (durations as Readonly<Record<number, number>>)[index];
}

function safeDuration(d: number | undefined): number {
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Incrementally builds a Timeline as chunks arrive, in playback order. Chunks are appended
 * back-to-back; skipped chunks (non-fatal errors) simply never get added.
 */
export class TimelineBuilder {
  private readonly chunksArr: TimelineChunk[] = [];
  private readonly wordsArr: TimelineWord[] = [];
  private cursor: number;

  constructor(startTime = 0) {
    this.cursor = startTime;
  }

  /** Append a chunk. `durationOverride` wins over `chunk.duration` when positive. */
  add(chunk: TimelineChunkInput, durationOverride?: number): TimelineChunk {
    const duration = safeDuration(durationOverride) || safeDuration(chunk.duration);
    const start = this.cursor;
    const firstWord = this.wordsArr.length;
    let wordIndex = 0;
    for (const w of chunk.words) {
      const ws = Math.min(Math.max(0, w.start), duration);
      const we = Math.min(Math.max(ws, w.end), duration);
      this.wordsArr.push({
        globalIndex: this.wordsArr.length,
        chunkIndex: chunk.index,
        wordIndex: wordIndex++,
        text: w.text,
        start: start + ws,
        end: start + we,
        charStart: w.char_start,
        charEnd: w.char_end,
      });
    }
    const tc: TimelineChunk = {
      index: chunk.index,
      position: this.chunksArr.length,
      start,
      end: start + duration,
      duration,
      charStart: chunk.char_start,
      charEnd: chunk.char_end,
      firstWord,
      wordCount: this.wordsArr.length - firstWord,
    };
    this.chunksArr.push(tc);
    this.cursor += duration;
    return tc;
  }

  get timeline(): Timeline {
    return { chunks: this.chunksArr, words: this.wordsArr, duration: this.cursor };
  }

  get duration(): number {
    return this.cursor;
  }
}

/** Build a timeline from chunks already in playback order. */
export function buildTimeline(
  chunks: readonly TimelineChunkInput[],
  options: TimelineOptions = {},
): Timeline {
  const b = new TimelineBuilder(options.startTime ?? 0);
  for (const c of chunks) b.add(c, lookupDuration(options.durations, c.index));
  return b.timeline;
}

/** Absolute time of a chunk-relative word time, given the chunk's absolute start. */
export function toAbsolute(
  chunkStart: number,
  word: Pick<WordTiming, 'start' | 'end'>,
): {
  start: number;
  end: number;
} {
  return { start: chunkStart + word.start, end: chunkStart + word.end };
}

/** Position (in timeline.chunks) of the chunk playing at time t; -1 before start / after end. */
export function chunkPositionAt(timeline: Timeline, t: number): number {
  const cs = timeline.chunks;
  if (cs.length === 0 || t < cs[0]!.start || t >= timeline.duration) return -1;
  let lo = 0;
  let hi = cs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cs[mid]!.start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface WordAtOptions {
  /**
   * true (default): during a pause between two words of the same chunk, keep the previous word
   * active, which avoids highlight flicker. false: return -1 whenever t is outside every word.
   */
  holdThroughGaps?: boolean;
}

/** Index (in timeline.words) of the word being spoken at time t, or -1. O(log n). */
export function wordIndexAt(timeline: Timeline, t: number, options: WordAtOptions = {}): number {
  const ws = timeline.words;
  if (ws.length === 0 || t < ws[0]!.start) return -1;
  let lo = 0;
  let hi = ws.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ws[mid]!.start <= t) lo = mid;
    else hi = mid - 1;
  }
  const w = ws[lo]!;
  if (t < w.end) return lo;
  if (options.holdThroughGaps === false) return -1;
  // Hold only while still inside the same chunk and before the next word starts.
  const pos = chunkPositionAt(timeline, t);
  if (pos === -1) return -1;
  const chunk = timeline.chunks[pos]!;
  return chunk.index === w.chunkIndex ? lo : -1;
}

/** Index (in timeline.words) of the word covering source-text offset `offset`, or -1. */
export function wordIndexAtChar(timeline: Timeline, offset: number): number {
  const ws = timeline.words;
  for (let lo = 0, hi = ws.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    const w = ws[mid]!;
    if (offset < w.charStart) hi = mid - 1;
    else if (offset >= w.charEnd) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Position (in timeline.chunks) of the chunk covering source-text offset `offset`, or -1. */
export function chunkPositionAtChar(timeline: Timeline, offset: number): number {
  const cs = timeline.chunks;
  for (let lo = 0, hi = cs.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    const c = cs[mid]!;
    if (offset < c.charStart) hi = mid - 1;
    else if (offset >= c.charEnd) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Time to seek to so playback starts at the word covering `offset` (falls back to its chunk start). */
export function timeForCharOffset(timeline: Timeline, offset: number): number | null {
  const wi = wordIndexAtChar(timeline, offset);
  if (wi >= 0) return timeline.words[wi]!.start;
  const ci = chunkPositionAtChar(timeline, offset);
  return ci >= 0 ? timeline.chunks[ci]!.start : null;
}
