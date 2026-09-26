/**
 * Minimal structural types for the web-standard globals this package touches (fetch, Response,
 * ReadableStream, AbortSignal, FormData). They are declared here instead of pulling in the DOM or
 * Node type libraries so the package compiles and runs unchanged in browsers, Chrome extension
 * contexts (service worker / offscreen document), React Native (Expo SDK 57 `expo/fetch`) and Node.
 *
 * The real DOM objects are structurally assignable to these (checked by tsconfig.dom-check.json).
 */

export interface ReadResultLike {
  done: boolean;
  value?: Uint8Array | undefined;
}

export interface ReadableStreamReaderLike {
  read(): Promise<ReadResultLike>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface ReadableStreamLike {
  getReader(): ReadableStreamReaderLike;
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeadersLike;
  /** Null/undefined on runtimes without response streaming; the client then falls back to text(). */
  readonly body?: ReadableStreamLike | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignalLike;
}

/**
 * Any fetch implementation. `init` is typed loosely on purpose so the DOM/Node/RN `fetch` functions
 * (whose RequestInit types differ) are all assignable without casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FetchLike = (input: string, init?: any) => Promise<ResponseLike>;

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

interface FormDataLike {
  append(name: string, value: unknown, fileName?: string): void;
}

interface Globals {
  fetch?: FetchLike;
  AbortController?: new () => AbortControllerLike;
  FormData?: new () => FormDataLike;
  TextDecoder?: new (label?: string) => {
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
  };
}

const g = globalThis as unknown as Globals;

/** The global fetch, bound to globalThis (unbound window.fetch throws "Illegal invocation"). */
export function getGlobalFetch(): FetchLike | undefined {
  const f = g.fetch;
  return typeof f === 'function' ? (f.bind(globalThis) as FetchLike) : undefined;
}

export function createAbortController(): AbortControllerLike | undefined {
  return typeof g.AbortController === 'function' ? new g.AbortController() : undefined;
}

export function createFormData(): FormDataLike {
  if (typeof g.FormData !== 'function') {
    throw new Error('FormData is not available in this runtime; cannot upload files.');
  }
  return new g.FormData();
}

export function getGlobalTextDecoder(): Globals['TextDecoder'] {
  return typeof g.TextDecoder === 'function' ? g.TextDecoder : undefined;
}
