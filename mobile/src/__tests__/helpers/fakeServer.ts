/**
 * Test doubles: a fetch that streams NDJSON lines on demand (like expo/fetch's response.body),
 * WAV chunk builders, and an in-memory chunk file store.
 */
import {
  bytesToBase64,
  planChunks,
  wavHeader,
  type ChunkMode,
  type ChunkSpan,
  type TtsChunkEvent,
  type TtsStartEvent,
} from '@tamber/client';

import type { ChunkFileStore, PlaylistLike } from '@/player/StreamPlayer';

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/** A response body whose lines the test pushes one by one. */
export class ControlledBody {
  private queue: Uint8Array[] = [];
  private waiting: { resolve: (r: { done: boolean; value?: Uint8Array }) => void; reject: (e: unknown) => void } | null =
    null;
  private ended = false;
  private failed: unknown = null;
  cancelled = false;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener('abort', () => this.fail(abortError()));
  }

  pushLine(obj: unknown): void {
    this.push(ascii(`${JSON.stringify(obj)}\n`));
  }

  push(bytes: Uint8Array): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ done: false, value: bytes });
    } else {
      this.queue.push(bytes);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ done: true });
    }
  }

  fail(err: unknown): void {
    this.failed = err;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(err);
    }
  }

  getReader() {
    return {
      read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (this.failed) return Promise.reject(this.failed);
        const next = this.queue.shift();
        if (next) return Promise.resolve({ done: false, value: next });
        if (this.ended) return Promise.resolve({ done: true });
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
      cancel: async () => {
        this.cancelled = true;
        this.end();
      },
      releaseLock: () => undefined,
    };
  }
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  stream: ControlledBody;
}

/** A fetch that answers every POST /v1/tts with a ControlledBody. */
export function createStreamingFetch() {
  const calls: FetchCall[] = [];
  const fetch = jest.fn(async (url: string, init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const stream = new ControlledBody(init.signal);
    calls.push({
      url,
      headers: init.headers ?? {},
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      signal: init.signal,
      stream,
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      body: stream,
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
  return { fetch, calls };
}

/** A complete WAV file (24 kHz mono s16le) of `seconds` silence, base64. */
export function wavBase64(seconds: number): string {
  const dataLength = Math.round(seconds * 24000) * 2;
  const bytes = new Uint8Array(44 + dataLength);
  bytes.set(wavHeader(dataLength), 0);
  return bytesToBase64(bytes);
}

export function startEvent(text: string, mode: ChunkMode, startChunk = 0, wordTimestamps = true): TtsStartEvent {
  const plan = planChunks(text, { mode });
  return {
    type: 'start',
    request_id: `req-${startChunk}`,
    sample_rate: 24000,
    format: 'wav',
    voice: 'af_heart',
    lang: 'a',
    speed: 1,
    chunk_mode: mode,
    total_chunks: plan.length,
    start_chunk: startChunk,
    word_timestamps: wordTimestamps,
    text_length: text.length,
    chunks: plan,
  };
}

/** A chunk event with evenly spaced word timings (like the server's fake engine). */
export function chunkEvent(text: string, span: ChunkSpan, duration = 1, withWords = true): TtsChunkEvent {
  const slice = text.slice(span.char_start, span.char_end);
  const words: TtsChunkEvent['words'] = [];
  if (withWords) {
    const re = /\S+/g;
    const matches = [...slice.matchAll(re)];
    const per = (duration * 0.8) / Math.max(1, matches.length);
    matches.forEach((m, i) => {
      const start = span.char_start + (m.index ?? 0);
      words.push({
        text: m[0],
        start: Number((i * per).toFixed(3)),
        end: Number(((i + 1) * per).toFixed(3)),
        char_start: start,
        char_end: start + m[0].length,
      });
    });
  }
  return {
    type: 'chunk',
    index: span.index,
    text: slice,
    char_start: span.char_start,
    char_end: span.char_end,
    audio: wavBase64(0.05),
    format: 'wav',
    sample_rate: 24000,
    duration,
    words,
  };
}

export class MemoryChunkFiles implements ChunkFileStore {
  writes: { requestId: string; index: number; format: string; bytes: number }[] = [];
  removed: string[][] = [];
  write(requestId: string, index: number, format: string, base64: string): string {
    this.writes.push({ requestId, index, format, bytes: base64.length });
    return `file:///cache/tamber/${requestId}/${index}.${format}`;
  }
  remove(requestIds: readonly string[]): void {
    this.removed.push([...requestIds]);
  }
}

export class FakePlaylist implements PlaylistLike {
  sources: string[] = [];
  currentIndex = 0;
  currentTime = 0;
  playing = false;
  volume = 1;
  clears = 0;
  /** undefined = "always seekable" (Android-like). Tests set it to model iOS item loading. */
  isLoaded: boolean | undefined = undefined;
  /** When true, skipTo() makes the new current track not seekable until the test loads it (iOS). */
  unloadOnSkip = false;
  /** Every seekTo() call, with whether the track was loaded at that moment. */
  seeks: { seconds: number; loaded: boolean }[] = [];
  get trackCount() {
    return this.sources.length;
  }
  add(source: { uri: string }) {
    this.sources.push(source.uri);
  }
  clear() {
    this.sources = [];
    this.currentIndex = 0;
    this.currentTime = 0;
    this.clears++;
  }
  play() {
    this.playing = true;
  }
  pause() {
    this.playing = false;
  }
  skipTo(i: number) {
    this.currentIndex = i;
    this.currentTime = 0;
    if (this.unloadOnSkip) this.isLoaded = false;
  }
  async seekTo(s: number) {
    this.seeks.push({ seconds: s, loaded: this.isLoaded !== false });
    this.currentTime = s;
  }
}

/** Let pending promise chains (stream reads, async iterators) settle. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
