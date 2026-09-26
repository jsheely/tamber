import { isAbortError, TamberApiError } from '@tamber/client';
import { useEffect } from 'react';
import { useSession } from '../store/session';
import { describeError, requestApiKey } from './errors';
import { useTamberClient } from './useTamberClient';

/** Loads GET /v1/voices once the server is reachable (and re-loads when the key changes). */
export function useVoices(): void {
  const client = useTamberClient();
  const connection = useSession((s) => s.connection);
  const ready = connection === 'ok' || connection === 'loading';

  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    const session = useSession.getState();
    session.setVoicesLoading(true);
    client
      .getVoices({ signal: ctrl.signal })
      .then((res) => session.setVoices(res))
      .catch((err: unknown) => {
        if (isAbortError(err) || ctrl.signal.aborted) return;
        if (err instanceof TamberApiError && err.isAuthError) {
          session.setVoices(null, 'API key required');
          requestApiKey('The server rejected the API key. Check it in Settings.');
          return;
        }
        session.setVoices(null, describeError(err).title);
      });
    return () => ctrl.abort();
  }, [client, ready]);
}
