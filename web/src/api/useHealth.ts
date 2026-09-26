import { isAbortError, TamberApiError } from '@tamber/client';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { describeError, requestApiKey } from './errors';
import { useTamberClient } from './useTamberClient';

const LOADING_RECHECK_MS = 3000;

/**
 * Checks GET /v1/health on boot and whenever the base URL or key changes. Opens Settings with the
 * key field focused when the server requires a key and none is set. Re-checks while the model is
 * still loading. Returns a manual refresh.
 */
export function useHealth(): () => void {
  const client = useTamberClient();
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const session = useSession.getState();
    const check = async () => {
      session.setConnection('checking');
      try {
        const health = await client.health({ signal: ctrl.signal, timeoutMs: 10_000 });
        if (ctrl.signal.aborted) return;
        session.setHealth(health);
        if (health.auth_required && !client.apiKey) {
          requestApiKey();
          return;
        }
        if (health.status === 'loading') {
          session.setConnection('loading', 'The voice model is loading…');
          timer = setTimeout(() => void check(), LOADING_RECHECK_MS);
          return;
        }
        session.setConnection(
          'ok',
          `Tamber ${health.version} · ${health.engine} on ${health.device}${
            health.status === 'degraded' ? ' (degraded)' : ''
          }`,
        );
      } catch (err) {
        if (isAbortError(err) || ctrl.signal.aborted) return;
        if (err instanceof TamberApiError && err.isAuthError) {
          requestApiKey();
          return;
        }
        session.setConnection('error', describeError(err).title);
      }
    };
    void check();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, nonce]);

  return refresh;
}
