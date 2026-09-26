/**
 * The server's voice list, cached in chrome.storage.local per server so the popup opens instantly.
 */
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { TamberSettings, Voice, VoicesResponse } from '@tamber/client';
import { createClient, describeError } from '../lib/client';

const CACHE_KEY = 'tamber.voicesCache';
const MAX_AGE_MS = 10 * 60 * 1000;

interface VoicesCache {
  baseUrl: string;
  at: number;
  data: VoicesResponse;
}

export interface VoicesState {
  voices: Voice[];
  languages: VoicesResponse['languages'];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useVoices(settings: Pick<TamberSettings, 'apiBaseUrl' | 'apiKey'>): VoicesState {
  const [entry, setEntry] = useState<{ baseUrl: string; data: VoicesResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const { apiBaseUrl, apiKey } = settings;

  useEffect(() => {
    if (!apiBaseUrl) return;
    let alive = true;
    const ctrl = new AbortController();
    (async () => {
      const stored: Record<string, unknown> = await browser.storage.local
        .get(CACHE_KEY)
        .catch(() => ({}));
      const cached = stored[CACHE_KEY] as VoicesCache | undefined;
      const fresh = cached && cached.baseUrl === apiBaseUrl;
      if (fresh && alive) setEntry({ baseUrl: apiBaseUrl, data: cached.data });
      if (fresh && nonce === 0 && Date.now() - cached.at < MAX_AGE_MS) return;
      if (!alive) return;
      setLoading(true);
      try {
        const res = await createClient({ apiBaseUrl, apiKey }).getVoices({ signal: ctrl.signal });
        if (!alive) return;
        setEntry({ baseUrl: apiBaseUrl, data: res });
        setError(null);
        // The cache only speeds up the next popup: failing to write it is not an error.
        await browser.storage.local
          .set({
            [CACHE_KEY]: { baseUrl: apiBaseUrl, at: Date.now(), data: res } satisfies VoicesCache,
          })
          .catch(() => undefined);
      } catch (err) {
        if (alive) setError(describeError(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [apiBaseUrl, apiKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const data = entry && entry.baseUrl === apiBaseUrl ? entry.data : null;

  return {
    voices: data?.voices ?? [],
    languages: data?.languages ?? [],
    loading,
    error,
    reload,
  };
}
