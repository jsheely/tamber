/**
 * Test doubles: a scriptable AudioContext and a fetch that streams NDJSON through a real
 * ReadableStream, so TamberClient.synthesize() runs its production parsing path.
 */
import {
  bytesToBase64,
  parseWav,
  planChunks,
  TamberClient,
  wavHeader,
  type ChunkSpan,
  type TtsChunkEvent,
  type TtsEvent,
  type TtsStartEvent,
  type WordTiming,
} from '@tamber/client';

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------

export function makeWav(seconds: number, sampleRate = 24000): Uint8Array {
  const samples = Math.round(seconds * sampleRate);
  const out = new Uint8Array(44 + samples * 2);
  out.set(wavHeader(samples * 2, sampleRate), 0);
  return out;
}

export class FakeBufferSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  endedFired = false;
  when = 0;
  offset = 0;
  private readonly ctx: FakeAudioContext;
  constructor(ctx: FakeAudioContext) {
    this.ctx = ctx;
  }
  connect(): void {}
  disconnect(): void {}
  start(when = 0, offset = 0): void {
    this.started = true;
    this.when = when;
    this.offset = offset;
  }
  stop(): void {
    this.stopped = true;
  }
  get end(): number {
    return this.when + (this.buffer?.duration ?? 0) - this.offset;
  }
  get context(): FakeAudioContext {
    return this.ctx;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  state: string = 'suspended';
  sampleRate = 48000;
  destination = { connect: () => undefined };
  onstatechange: (() => void) | null = null;
  sources: FakeBufferSource[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  decodeCalls = 0;
  /** Chunk durations that fail to decode (simulates a Safari decode failure). */
  failDecodeForDuration: number | null = null;

  resume(): Promise<void> {
    this.resumeCalls++;
    this.setState('running');
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    this.setState('suspended');
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.setState('closed');
    return Promise.resolve();
  }
  setState(s: string): void {
    if (this.state === s) return;
    this.state = s;
    this.onstatechange?.();
  }
  createGain() {
    return {
      gain: {
        value: 1,
        setTargetAtTime(v: number) {
          this.value = v;
        },
      },
      connect: () => undefined,
      disconnect: () => undefined,
    };
  }
  createAnalyser() {
    return {
      fftSize: 1024,
      frequencyBinCount: 512,
      smoothingTimeConstant: 0,
      connect: () => undefined,
      disconnect: () => undefined,
      getFloatTimeDomainData: (a: Float32Array) => a.fill(0),
      getByteFrequencyData: (a: Uint8Array) => a.fill(0),
    };
  }
  createBufferSource(): FakeBufferSource {
    const s = new FakeBufferSource(this);
    this.sources.push(s);
    return s;
  }
  decodeAudioData(data: ArrayBuffer): Promise<{ duration: number; sampleRate: number }> {
    this.decodeCalls++;
    const info = parseWav(new Uint8Array(data));
    if (this.failDecodeForDuration !== null && Math.abs(info.duration - this.failDecodeForDuration) < 1e-6) {
      return Promise.reject(new Error('EncodingError'));
    }
    return Promise.resolve({ duration: info.duration, sampleRate: info.sampleRate });
  }
  /** Started, not stopped sources (what is actually scheduled). */
  get live(): FakeBufferSource[] {
    return this.sources.filter((s) => s.started && !s.stopped);
  }
  /** Advance the audio clock and fire onended for sources that finished. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const s of [...this.sources]) {
      if (s.started && !s.stopped && !s.endedFired && s.end <= this.currentTime + 1e-9) {
        s.endedFired = true;
        s.onended?.();
      }
    }
  }
  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}

// ---------------------------------------------------------------------------------------------
// NDJSON streaming fetch
// ---------------------------------------------------------------------------------------------

export interface RecordedRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  signal: AbortSignal | undefined;
  stream: ControlledStream;
}

export interface ControlledStream {
  push: (event: TtsEvent | Record<string, unknown>) => void;
  close: () => void;
  readonly aborted: boolean;
}

function controlledStream(signal: AbortSignal | undefined): {
  body: ReadableStream<Uint8Array>;
  ctl: ControlledStream;
} {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let aborted = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    aborted = true;
    if (!closed) {
      closed = true;
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    }
  });
  return {
    body,
    ctl: {
      push(event) {
        if (!closed) controller.enqueue(enc.encode(`${JSON.stringify(event)}\n`));
      },
      close() {
        if (!closed) {
          closed = true;
          controller.close();
        }
      },
      get aborted() {
        return aborted;
      },
    },
  };
}

/** A fake fetch: /v1/tts streams whatever the test pushes; JSON routes answer from `json`. */
export function createFakeFetch(json: Record<string, unknown> = {}) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) => {
    const { body, ctl } = controlledStream(init.signal);
    const parsed = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ url, method: init.method ?? 'GET', body: parsed, signal: init.signal, stream: ctl });
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? url;
    if (path.endsWith('/tts')) {
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    const match = Object.keys(json).find((k) => path.endsWith(k));
    if (match) {
      return new Response(JSON.stringify(json[match]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found', type: 'invalid_request_error', param: null, request_id: null } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new TamberClient({ baseUrl: 'http://tamber.test', fetch: fetchImpl });
  const ttsRequests = () => requests.filter((r) => r.url.endsWith('/v1/tts'));
  return { fetch: fetchImpl, client, requests, ttsRequests };
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export function startEvent(
  text: string,
  plan: ChunkSpan[],
  overrides: Partial<TtsStartEvent> = {},
): TtsStartEvent {
  return {
    type: 'start',
    request_id: 'test',
    sample_rate: 24000,
    format: 'wav',
    voice: 'af_heart',
    lang: 'a',
    speed: 1,
    chunk_mode: 'sentence',
    total_chunks: plan.length,
    start_chunk: 0,
    word_timestamps: true,
    text_length: text.length,
    chunks: plan,
    ...overrides,
  };
}

/** Evenly spaced word timings over the whitespace-separated words of a span. */
export function evenWords(text: string, span: ChunkSpan, duration: number): WordTiming[] {
  const words: { s: number; e: number }[] = [];
  const re = /\S+/g;
  const slice = text.slice(span.char_start, span.char_end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) words.push({ s: span.char_start + m.index, e: span.char_start + m.index + m[0].length });
  const step = duration / Math.max(1, words.length);
  return words.map((w, i) => ({
    text: text.slice(w.s, w.e),
    start: Number((i * step).toFixed(3)),
    end: Number(((i + 1) * step).toFixed(3)),
    char_start: w.s,
    char_end: w.e,
  }));
}

export function chunkEvent(
  text: string,
  span: ChunkSpan,
  duration: number,
  opts: { words?: boolean } = {},
): TtsChunkEvent {
  return {
    type: 'chunk',
    index: span.index,
    text: text.slice(span.char_start, span.char_end),
    char_start: span.char_start,
    char_end: span.char_end,
    audio: bytesToBase64(makeWav(duration)),
    format: 'wav',
    sample_rate: 24000,
    duration,
    words: opts.words === false ? [] : evenWords(text, span, duration),
  };
}

export const SAMPLE_TEXT =
  'Tamber reads anything aloud. Every sentence arrives as its own file. ' +
  'The browser decodes each one. Then it schedules them back to back. ' +
  'Words light up as they are spoken.';

export function samplePlan(text = SAMPLE_TEXT): ChunkSpan[] {
  return planChunks(text, { mode: 'sentence' });
}

/** Let pending promise callbacks (stream reads, decodes) run. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
