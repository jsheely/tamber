/**
 * Fetch wrapper that ties an extra AbortSignal to every request it makes.
 *
 * Why: older @tamber/client builds unlinked the caller's signal from fetch once response headers
 * arrived, so aborting mid-stream only took effect at the next NDJSON line. The client now keeps
 * the signal linked while the body is read; this wrapper is kept as defence in depth. Binding the
 * StreamPlayer's own signal into fetch() closes the socket immediately, so the server stops
 * synthesising at once (API.md §8.4.4).
 */
import type { FetchLike } from '@tamber/client';

export function withAbortSignal(fetchImpl: FetchLike, extra: AbortSignal): FetchLike {
  return (input, init) => {
    const ctrl = new AbortController();
    const forward = () => ctrl.abort();
    const inner = (init as { signal?: AbortSignal } | undefined)?.signal;
    if (extra.aborted || inner?.aborted) ctrl.abort();
    extra.addEventListener('abort', forward, { once: true });
    inner?.addEventListener('abort', forward, { once: true });
    return fetchImpl(input, { ...(init ?? {}), signal: ctrl.signal });
  };
}

/** The runtime's global fetch (expo/fetch on SDK 57), bound to globalThis. */
export function globalFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error('fetch is not available');
  return f.bind(globalThis) as FetchLike;
}
