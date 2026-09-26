/**
 * TamberClient factory and small data hooks.
 *
 * React Native specifics (see packages/client/README.md and docs/research/mobile-expo.md §7):
 * - SDK 57 installs expo/fetch as the global fetch, so response.body.getReader() streams NDJSON;
 *   the shared client falls back to text() automatically on runtimes without streaming.
 * - `Accept-Encoding: identity` so an Android Brotli decoder never holds streamed lines back.
 */
import {
  TamberClient,
  type ConnectionTestResult,
  type HealthResponse,
  type TamberSettings,
  type VoicesResponse,
} from '@tamber/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSettings, useSettings } from '@/store/settings';

import { globalFetch, withAbortSignal } from './fetch';

export const CLIENT_HEADERS = { 'Accept-Encoding': 'identity' } as const;

export function createClient(settings: Pick<TamberSettings, 'apiBaseUrl' | 'apiKey'>): TamberClient {
  return TamberClient.fromSettings(settings, { headers: { ...CLIENT_HEADERS } });
}

/** Client for the current settings (non-hook; used by the player controller). */
export function getClient(): TamberClient {
  return createClient(getSettings());
}

/** Client for one TTS stream: aborting `signal` closes the HTTP connection immediately. */
export function getStreamingClient(signal: AbortSignal): TamberClient {
  return TamberClient.fromSettings(getSettings(), {
    headers: { ...CLIENT_HEADERS },
    fetch: withAbortSignal(globalFetch(), signal),
  });
}

/** Client bound to the current base URL + key; stable while those don't change. */
export function useTamberClient(): TamberClient | null {
  const apiBaseUrl = useSettings((s) => s.settings.apiBaseUrl);
  const apiKey = useSettings((s) => s.settings.apiKey);
  return useMemo(
    () => (apiBaseUrl ? createClient({ apiBaseUrl, apiKey }) : null),
    [apiBaseUrl, apiKey],
  );
}

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

interface Settled<T> {
  /** The request (key + reload nonce) this result belongs to. */
  request: string;
  data: T | null;
  error: Error | null;
}

/**
 * Minimal keyed async loader. `loading` is derived (the settled result belongs to an older
 * request), so the effect only sets state from async callbacks.
 */
function useAsync<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  cache?: Map<string, T>,
): AsyncState<T> {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const request = key ? `${key}#${nonce}` : null;

  useEffect(() => {
    if (!key || !request) return;
    const ctrl = new AbortController();
    loadRef
      .current(ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        cache?.set(key, data);
        setSettled({ request, data, error: null });
      })
      .catch((error: unknown) => {
        if (ctrl.signal.aborted) return;
        setSettled((prev) => ({ request, data: prev?.data ?? null, error: error as Error }));
      });
    return () => ctrl.abort();
  }, [key, request, cache]);

  const reload = useCallback(() => {
    if (key) cache?.delete(key);
    setNonce((n) => n + 1);
  }, [key, cache]);

  if (!key) return { data: null, error: null, loading: false, reload };
  const current = settled?.request === request;
  const cached = cache?.get(key) ?? null;
  return {
    data: current ? settled!.data : (cached ?? settled?.data ?? null),
    error: current ? settled!.error : null,
    loading: !current,
    reload,
  };
}

const voicesCache = new Map<string, VoicesResponse>();

/** GET /v1/voices for the configured server (cached per server + key for the app session). */
export function useVoices(): AsyncState<VoicesResponse> {
  const client = useTamberClient();
  const key = client ? `${client.baseUrl}|${client.apiKey}` : null;
  return useAsync(key, (signal) => client!.getVoices({ signal }), voicesCache);
}

/** GET /v1/health for the configured server. */
export function useHealth(): AsyncState<HealthResponse> {
  const client = useTamberClient();
  const key = client ? client.baseUrl : null;
  return useAsync(key, (signal) => client!.health({ signal }));
}

export type ConnectionTestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'done'; result: ConnectionTestResult; summary: string; ok: boolean };

/** Human summary of TamberClient.testConnection(). */
export function describeConnection(result: ConnectionTestResult): string {
  const h = result.health;
  if (!h) {
    const msg = result.error?.message ?? 'unknown error';
    return `Could not reach the server. ${msg}`;
  }
  const version = `Tamber ${h.version}${h.engine === 'fake' ? ' (fake engine)' : ''}`;
  if (result.compatible === false) {
    return `${version} speaks API v${h.api_version}; this app needs v1.`;
  }
  if (result.authOk === false) {
    return `${version} is reachable, but the API key was rejected.`;
  }
  if (!result.ok) {
    return `${version} is reachable, but listing voices failed: ${result.error?.message ?? 'error'}`;
  }
  const loading = h.status === 'loading' ? ' The model is still warming up.' : '';
  const auth = h.auth_required ? 'Key accepted.' : 'No key required.';
  return `Connected to ${version}. ${auth} ${result.voiceCount ?? 0} voices.${loading}`;
}

export function useConnectionTest(): {
  state: ConnectionTestState;
  run: (settings: Pick<TamberSettings, 'apiBaseUrl' | 'apiKey'>) => Promise<boolean>;
  reset: () => void;
} {
  const [state, setState] = useState<ConnectionTestState>({ phase: 'idle' });
  const run = useCallback(async (settings: Pick<TamberSettings, 'apiBaseUrl' | 'apiKey'>) => {
    if (!settings.apiBaseUrl) {
      setState({
        phase: 'done',
        ok: false,
        summary: 'Enter your server address first.',
        result: {
          ok: false,
          health: null,
          authOk: null,
          voiceCount: null,
          compatible: null,
          error: new Error('No server URL'),
        },
      });
      return false;
    }
    setState({ phase: 'testing' });
    const result = await createClient(settings).testConnection({ timeoutMs: 10_000 });
    const ok = result.ok && result.compatible !== false;
    setState({ phase: 'done', result, ok, summary: describeConnection(result) });
    return ok;
  }, []);
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, run, reset };
}
