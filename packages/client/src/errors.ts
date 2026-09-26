import type { ApiErrorBody, ErrorCode, TtsErrorEvent } from './types.ts';

/** Base class for every error thrown by this package (except native AbortErrors, see isAbortError). */
export class TamberError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'TamberError';
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** The server answered with a non-2xx status. Carries the parsed error envelope when present. */
export class TamberApiError extends TamberError {
  readonly status: number;
  readonly code: ErrorCode | (string & {});
  readonly type: string;
  readonly param: string | null;
  readonly requestId: string | null;
  readonly details: unknown;
  /** Seconds from the Retry-After header (429/503), else null. */
  readonly retryAfter: number | null;

  constructor(init: {
    status: number;
    message: string;
    code: string;
    type?: string;
    param?: string | null;
    requestId?: string | null;
    details?: unknown;
    retryAfter?: number | null;
  }) {
    super(init.message);
    this.name = 'TamberApiError';
    this.status = init.status;
    this.code = init.code;
    this.type = init.type ?? 'server_error';
    this.param = init.param ?? null;
    this.requestId = init.requestId ?? null;
    this.details = init.details;
    this.retryAfter = init.retryAfter ?? null;
  }

  /** True for 401 (missing/wrong API key): prompt the user for a key. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** True for 429/503: try again later (see retryAfter). */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503 || this.status === 502 || this.status === 504;
  }
}

/** The request never produced an HTTP response (DNS, TLS, CORS, offline, connection reset...). */
export class TamberNetworkError extends TamberError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TamberNetworkError';
  }
}

/** The response did not follow the contract (bad JSON, bad NDJSON line, missing start event...). */
export class TamberProtocolError extends TamberError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TamberProtocolError';
  }
}

/** A fatal `{"type":"error","fatal":true}` line arrived in a TTS stream. */
export class TamberStreamError extends TamberError {
  readonly code: string;
  readonly index: number | null;
  readonly event: TtsErrorEvent;

  constructor(event: TtsErrorEvent) {
    super(event.message);
    this.name = 'TamberStreamError';
    this.code = event.code;
    this.index = event.index;
    this.event = event;
  }
}

/** The request exceeded TamberClientOptions.timeoutMs. */
export class TamberTimeoutError extends TamberError {
  constructor(ms: number) {
    super(`Request timed out after ${ms} ms`);
    this.name = 'TamberTimeoutError';
  }
}

/** True for errors caused by the caller's AbortSignal (DOM AbortError on every runtime). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const e = (value as { error?: unknown }).error;
  return (
    typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
  );
}

/** Parse a Retry-After header value (delta-seconds or HTTP-date) into seconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - now) / 1000));
}
