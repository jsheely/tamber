import {
  TamberApiError,
  TamberNetworkError,
  TamberProtocolError,
  TamberStreamError,
  TamberTimeoutError,
  isAbortError,
  isApiErrorBody,
  parseRetryAfter,
} from './errors.ts';
import { parseNdjsonText, readNdjson, toTtsEvent } from './ndjson.ts';
import {
  createAbortController,
  createFormData,
  getGlobalFetch,
  type AbortSignalLike,
  type FetchLike,
  type ResponseLike,
} from './platform.ts';
import { normalizeBaseUrl, type TamberSettings } from './settings.ts';
import type {
  AudioFormat,
  ExtractHtmlRequest,
  ExtractResponse,
  ExtractUrlRequest,
  HealthResponse,
  ModelsResponse,
  OpenAISpeechRequest,
  TtsEvent,
  TtsRequest,
  TtsResult,
  VoicesResponse,
} from './types.ts';

/** Contract major version this package implements (compare with HealthResponse.api_version). */
export const API_VERSION = 1;

export interface TamberClientOptions {
  /**
   * API origin (optionally with a path prefix), e.g. `https://tts.example.com`. Normalised with
   * normalizeBaseUrl(). Empty string = relative URLs (same origin; browsers only).
   */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` when non-empty. */
  apiKey?: string;
  /** Custom fetch (tests, extension service worker, RN polyfills). Default: globalThis.fetch. */
  fetch?: FetchLike;
  /** Default timeout for non-streaming requests in ms (default 30000; extract uses 2x). 0 = none. */
  timeoutMs?: number;
  /**
   * Time allowed until a streaming TTS response's headers arrive, in ms (default 120000, generous
   * because requests can queue behind other synthesis jobs). The body itself has no timeout.
   */
  streamOpenTimeoutMs?: number;
  /** Extra headers on every request (mobile: `{ 'Accept-Encoding': 'identity' }`). */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  signal?: AbortSignalLike;
  /** Overrides TamberClientOptions.timeoutMs for this call. */
  timeoutMs?: number;
}

export interface SynthesizeOptions extends RequestOptions {
  /**
   * true (default): a fatal `error` event throws TamberStreamError. false: it is yielded like any
   * other event and the iterator ends.
   */
  throwOnFatal?: boolean;
}

/** A file to upload to /v1/extract. */
export interface ExtractFileInput {
  /**
   * The file. Web/extension: a Blob or File. React Native: `{ uri, name, type }` (RN's FormData
   * file shape). Passed to FormData.append unchanged.
   */
  file: unknown;
  filename: string;
  /** Media type hint, e.g. `application/pdf`. Used only for RN-shaped files without a `type`. */
  contentType?: string;
}

export type ExtractInput = ExtractUrlRequest | ExtractHtmlRequest | ExtractFileInput;

export interface ConnectionTestResult {
  /** Health reachable and (if required) the API key accepted. */
  ok: boolean;
  health: HealthResponse | null;
  /** null = not checked (health unreachable). */
  authOk: boolean | null;
  voiceCount: number | null;
  /** api_version matches API_VERSION. */
  compatible: boolean | null;
  error: Error | null;
}

function isBlobLike(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { size?: unknown }).size === 'number' &&
    typeof (v as { type?: unknown }).type === 'string' &&
    typeof (v as { slice?: unknown }).slice === 'function'
  );
}

interface Deadline {
  signal: AbortSignalLike | undefined;
  timedOut: () => boolean;
  /** Stop the timeout but keep the caller's signal linked (a streamed body is still being read). */
  stopTimer: () => void;
  /** Stop the timeout and unlink the caller's signal. */
  clear: () => void;
}

/** Combine a caller signal with a timeout into one signal (when AbortController exists). */
function makeDeadline(signal: AbortSignalLike | undefined, ms: number): Deadline {
  const passthrough: Deadline = {
    signal,
    timedOut: () => false,
    stopTimer: () => {},
    clear: () => {},
  };
  if (!ms || ms <= 0) return passthrough;
  const ctrl = createAbortController();
  if (!ctrl) return passthrough;
  let timedOut = false;
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    stopTimer: () => clearTimeout(timer),
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

declare function setTimeout(cb: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;

/**
 * Typed client for the Tamber API (docs/API.md). Platform-neutral: needs only a WHATWG fetch.
 * Instances are immutable; use withOptions() to derive one with a different base URL / key.
 */
export class TamberClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly options: TamberClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: TamberClientOptions) {
    this.options = { ...options };
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? '');
    this.apiKey = (options.apiKey ?? '').trim();
    const f = options.fetch ?? getGlobalFetch();
    if (!f) throw new Error('No fetch implementation available; pass options.fetch');
    this.fetchImpl = f;
  }

  /** Build a client from shared settings (baseUrl + apiKey). */
  static fromSettings(
    settings: Pick<TamberSettings, 'apiBaseUrl' | 'apiKey'>,
    extra: Omit<TamberClientOptions, 'baseUrl' | 'apiKey'> = {},
  ): TamberClient {
    return new TamberClient({ ...extra, baseUrl: settings.apiBaseUrl, apiKey: settings.apiKey });
  }

  withOptions(patch: Partial<TamberClientOptions>): TamberClient {
    return new TamberClient({ ...this.options, ...patch });
  }

  /** Absolute (or same-origin relative) URL for an API path such as `/voices`. */
  url(path: string): string {
    return `${this.baseUrl}/v1${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(this.options.headers ?? {}), ...(extra ?? {}) };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async send(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown },
    opts: RequestOptions,
    defaultTimeout: number,
    streaming?: { unlink?: () => void },
  ): Promise<ResponseLike> {
    const deadline = makeDeadline(opts.signal, opts.timeoutMs ?? defaultTimeout);
    let res: ResponseLike;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: init.method ?? 'GET',
        headers: this.headers(init.headers),
        body: init.body,
        signal: deadline.signal,
      });
    } catch (err) {
      deadline.clear();
      if (deadline.timedOut()) throw new TamberTimeoutError(opts.timeoutMs ?? defaultTimeout);
      if (isAbortError(err) || opts.signal?.aborted) throw err;
      throw new TamberNetworkError(
        `Could not reach the Tamber API at ${this.baseUrl || 'this origin'}: ${String(
          (err as { message?: unknown })?.message ?? err,
        )}`,
        { cause: err },
      );
    }
    if (streaming && res.ok) {
      // The timeout only covers opening the stream, but the caller's signal must keep aborting the
      // fetch while the body is read (otherwise abort() would wait for the next NDJSON line).
      deadline.stopTimer();
      streaming.unlink = deadline.clear;
      return res;
    }
    deadline.clear();
    if (!res.ok) throw await TamberClient.toApiError(res);
    return res;
  }

  /** Convert a non-2xx response into a TamberApiError (parses the error envelope when present). */
  static async toApiError(res: ResponseLike): Promise<TamberApiError> {
    let body: unknown = null;
    let raw = '';
    try {
      raw = await res.text();
      body = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      body = null;
    }
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    if (isApiErrorBody(body)) {
      const e = body.error;
      return new TamberApiError({
        status: res.status,
        message: e.message,
        code: typeof e.code === 'string' ? e.code : 'internal_error',
        type: e.type,
        param: e.param ?? null,
        requestId: e.request_id ?? res.headers.get('x-request-id'),
        details: e.details,
        retryAfter,
      });
    }
    return new TamberApiError({
      status: res.status,
      message: `HTTP ${res.status} ${res.statusText}${raw ? `: ${raw.slice(0, 200)}` : ''}`,
      code:
        res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : 'internal_error',
      requestId: res.headers.get('x-request-id'),
      retryAfter,
    });
  }

  private async json<T>(res: ResponseLike): Promise<T> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new TamberProtocolError(`Expected JSON, got: ${text.slice(0, 120)}`, { cause });
    }
  }

  private get timeout(): number {
    return this.options.timeoutMs ?? 30_000;
  }

  /** GET /v1/health (never requires auth). */
  async health(opts: RequestOptions = {}): Promise<HealthResponse> {
    return this.json(await this.send('/health', {}, opts, this.timeout));
  }

  /** GET /v1/voices */
  async getVoices(opts: RequestOptions = {}): Promise<VoicesResponse> {
    return this.json(await this.send('/voices', {}, opts, this.timeout));
  }

  /** GET /v1/models (OpenAI-compatible list). */
  async getModels(opts: RequestOptions = {}): Promise<ModelsResponse> {
    return this.json(await this.send('/models', {}, opts, this.timeout));
  }

  /** GET /v1/voices/{id}/preview: a short, server-cached audition clip (complete audio file bytes). */
  async voicePreview(
    voice: string,
    format: AudioFormat = 'wav',
    opts: RequestOptions = {},
  ): Promise<Uint8Array> {
    const res = await this.send(
      `/voices/${encodeURIComponent(voice)}/preview?format=${format}`,
      {},
      opts,
      this.timeout * 2,
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  /** POST /v1/extract with a URL, raw HTML, or a file upload. */
  async extract(input: ExtractInput, opts: RequestOptions = {}): Promise<ExtractResponse> {
    const timeout = this.timeout * 2;
    if ('file' in input) {
      const form = createFormData();
      if (isBlobLike(input.file)) {
        form.append('file', input.file, input.filename);
      } else if (typeof input.file === 'object' && input.file !== null) {
        const f = input.file as { name?: string; type?: string };
        form.append('file', {
          ...(input.file as object),
          name: f.name ?? input.filename,
          type: f.type ?? input.contentType ?? 'application/octet-stream',
        });
      } else {
        throw new TypeError(
          'extract: `file` must be a Blob/File or a React Native { uri, name, type } object',
        );
      }
      form.append('filename', input.filename);
      return this.json(await this.send('/extract', { method: 'POST', body: form }, opts, timeout));
    }
    return this.json(
      await this.send(
        '/extract',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
        opts,
        timeout,
      ),
    );
  }

  extractUrl(url: string, opts?: RequestOptions): Promise<ExtractResponse> {
    return this.extract({ url }, opts);
  }

  extractHtml(html: string, url?: string, opts?: RequestOptions): Promise<ExtractResponse> {
    return this.extract(url ? { html, url } : { html }, opts);
  }

  extractFile(input: ExtractFileInput, opts?: RequestOptions): Promise<ExtractResponse> {
    return this.extract(input, opts);
  }

  /**
   * POST /v1/tts with stream=true. Yields events as each NDJSON line arrives:
   * `start` (always first), then any of `queued` / `chunk` / non-fatal `error` / `ping`, then `done`.
   * Unknown event types are skipped. Abort with opts.signal (the server stops synthesising).
   *
   * @throws TamberApiError (HTTP error before streaming), TamberStreamError (fatal error line),
   *   TamberProtocolError (malformed stream, or it ended without `done`), TamberNetworkError, AbortError.
   */
  async *synthesize(
    request: TtsRequest,
    opts: SynthesizeOptions = {},
  ): AsyncGenerator<TtsEvent, void, void> {
    const link: { unlink?: () => void } = {};
    const res = await this.send(
      '/tts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ ...request, stream: true }),
      },
      opts,
      this.options.streamOpenTimeoutMs ?? 120_000,
      link,
    );
    try {
      yield* this.readTtsStream(res, opts);
    } finally {
      link.unlink?.();
    }
  }

  private async *readTtsStream(
    res: ResponseLike,
    opts: SynthesizeOptions,
  ): AsyncGenerator<TtsEvent, void, void> {
    const throwOnFatal = opts.throwOnFatal ?? true;
    const source: AsyncIterable<unknown> | Iterable<unknown> =
      res.body && typeof res.body.getReader === 'function'
        ? readNdjson(res.body)
        : parseNdjsonText(await res.text());
    let sawStart = false;
    let finished = false;
    for await (const raw of source) {
      const ev = toTtsEvent(raw);
      if (!ev) continue;
      if (!sawStart) {
        if (ev.type === 'error') {
          if (throwOnFatal) throw new TamberStreamError(ev);
          yield ev;
          return;
        }
        if (ev.type !== 'start') {
          throw new TamberProtocolError(`First stream event must be "start", got "${ev.type}"`);
        }
        sawStart = true;
      }
      if (ev.type === 'error' && ev.fatal) {
        if (throwOnFatal) throw new TamberStreamError(ev);
        yield ev;
        return;
      }
      yield ev;
      if (ev.type === 'done') {
        finished = true;
        return;
      }
    }
    if (!finished) {
      if (opts.signal?.aborted) return;
      throw new TamberProtocolError('TTS stream ended before the "done" event (connection cut?)');
    }
  }

  /** POST /v1/tts with stream=false: the whole result in one JSON body. */
  async synthesizeToResult(request: TtsRequest, opts: RequestOptions = {}): Promise<TtsResult> {
    const res = await this.send(
      '/tts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...request, stream: false }),
      },
      opts,
      opts.timeoutMs ?? 0,
    );
    return this.json(res);
  }

  /** POST /v1/audio/speech (OpenAI-compatible). Returns the complete encoded audio file. */
  async speech(request: OpenAISpeechRequest, opts: RequestOptions = {}): Promise<Uint8Array> {
    const res = await this.send(
      '/audio/speech',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      opts,
      opts.timeoutMs ?? 0,
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * "Test connection" for settings screens: health (reachability, version, auth_required) then
   * voices (proves the API key when auth is required). Never throws.
   */
  async testConnection(opts: RequestOptions = {}): Promise<ConnectionTestResult> {
    let health: HealthResponse | null = null;
    try {
      health = await this.health(opts);
    } catch (error) {
      return {
        ok: false,
        health: null,
        authOk: null,
        voiceCount: null,
        compatible: null,
        error: error as Error,
      };
    }
    const compatible = health.api_version === API_VERSION;
    try {
      const voices = await this.getVoices(opts);
      return {
        ok: true,
        health,
        authOk: true,
        voiceCount: voices.voices.length,
        compatible,
        error: null,
      };
    } catch (error) {
      const authOk = error instanceof TamberApiError && error.status === 401 ? false : null;
      return { ok: false, health, authOk, voiceCount: null, compatible, error: error as Error };
    }
  }
}

/** Map shared settings + text to a /v1/tts request body. */
export function ttsRequestFromSettings(
  settings: Pick<TamberSettings, 'voice' | 'speed' | 'format' | 'lang' | 'chunkMode'>,
  text: string,
  overrides: Partial<TtsRequest> = {},
): TtsRequest {
  return {
    text,
    voice: settings.voice,
    speed: settings.speed,
    format: settings.format,
    lang: settings.lang,
    chunk_mode: settings.chunkMode,
    stream: true,
    ...overrides,
  };
}
