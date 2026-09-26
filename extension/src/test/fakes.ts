/**
 * Test doubles: a fake AudioContext (manual clock) and a controllable fake NDJSON event stream.
 */
import {
  bytesToBase64,
  planChunks,
  type TtsChunkEvent,
  type TtsEvent,
  type TtsStartEvent,
} from '@tamber/client';
import type {
  AudioBufferLike,
  AudioContextLike,
  BufferSourceLike,
  GainNodeLike,
} from '../player/ChunkedPlayer';

export class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  connect() {
    return undefined;
  }
  disconnect() {}
  start(when = 0, offset = 0) {
    this.started = { when, offset };
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  state = 'running';
  destination = {};
  outputLatency = 0;
  baseLatency = 0;
  onstatechange: (() => void) | null = null;
  sources: FakeSource[] = [];
  suspendCalls = 0;
  resumeCalls = 0;
  gain: GainNodeLike = {
    gain: { value: 1 },
    connect: () => undefined,
    disconnect: () => undefined,
  };

  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain() {
    return this.gain;
  }
  /** "Audio" bytes are the ASCII string `dur:<seconds>`. */
  async decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    const txt = new TextDecoder().decode(new Uint8Array(data));
    const m = /^dur:([\d.]+)$/.exec(txt);
    if (!m) throw new Error('EncodingError: unable to decode audio data');
    return { duration: Number(m[1]) };
  }
  async resume() {
    this.resumeCalls++;
    this.state = 'running';
  }
  async suspend() {
    this.suspendCalls++;
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
  /** Advance the clock and fire onended for nodes that finished. */
  advance(to: number) {
    this.currentTime = to;
    for (const s of this.sources) {
      if (s.started && !s.stopped && s.buffer) {
        const end = s.started.when + s.buffer.duration - s.started.offset;
        if (end <= to && s.onended) {
          const cb = s.onended;
          s.onended = null;
          cb();
        }
      }
    }
  }
}

export function fakeAudio(duration: number): string {
  return bytesToBase64(new TextEncoder().encode(`dur:${duration}`));
}

/** Build start + chunk events for `text` with evenly spaced word timings. */
export function buildEvents(
  text: string,
  durations: number[],
  opts: { chunkMode?: 'balanced' | 'sentence' } = {},
): { start: TtsStartEvent; chunks: TtsChunkEvent[] } {
  const plan = planChunks(text, { mode: opts.chunkMode ?? 'sentence' });
  const start: TtsStartEvent = {
    type: 'start',
    request_id: 'test',
    sample_rate: 24000,
    format: 'wav',
    voice: 'af_heart',
    lang: 'a',
    speed: 1,
    chunk_mode: opts.chunkMode ?? 'sentence',
    total_chunks: plan.length,
    start_chunk: 0,
    word_timestamps: true,
    text_length: text.length,
    chunks: plan,
  };
  const chunks = plan.map((c, i): TtsChunkEvent => {
    const duration = durations[i] ?? 1;
    const words: TtsChunkEvent['words'] = [];
    const re = /\S+/g;
    const slice = text.slice(c.char_start, c.char_end);
    const matches = [...slice.matchAll(re)];
    const step = duration / Math.max(1, matches.length);
    matches.forEach((m, k) => {
      const cs = c.char_start + (m.index ?? 0);
      words.push({
        text: m[0],
        start: +(k * step).toFixed(3),
        end: +((k + 1) * step).toFixed(3),
        char_start: cs,
        char_end: cs + m[0].length,
      });
    });
    return {
      type: 'chunk',
      index: c.index,
      text: slice,
      char_start: c.char_start,
      char_end: c.char_end,
      audio: fakeAudio(duration),
      format: 'wav',
      sample_rate: 24000,
      duration,
      words,
    };
  });
  return { start, chunks };
}

export interface FakeStream {
  push: (...events: TtsEvent[]) => void;
  close: () => void;
  /** Make the stream throw (e.g. a TamberStreamError for a fatal error line). */
  fail: (err: Error) => void;
  signal: AbortSignal;
  request: { start_chunk?: number; speed?: number; voice?: string; text: string };
}

/** A synthesize() double: each call creates a stream the test feeds by hand. */
export function createFakeSynthesize() {
  const streams: FakeStream[] = [];
  const synthesize = (
    _settings: unknown,
    request: FakeStream['request'],
    signal: AbortSignal,
  ): AsyncIterable<TtsEvent> => {
    const queue: TtsEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let failure: Error | null = null;
    const stream: FakeStream = {
      push: (...events) => {
        queue.push(...events);
        wake?.();
        wake = null;
      },
      close: () => {
        closed = true;
        wake?.();
        wake = null;
      },
      fail: (err) => {
        failure = err;
        wake?.();
        wake = null;
      },
      signal,
      request,
    };
    streams.push(stream);
    async function* gen(): AsyncGenerator<TtsEvent> {
      for (;;) {
        if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        const next = queue.shift();
        if (!next && failure) throw failure;
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }
    return gen();
  };
  return { synthesize, streams };
}

/** Let pending promises / async generators settle. */
export async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
