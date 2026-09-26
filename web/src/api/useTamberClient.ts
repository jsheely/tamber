import { TamberClient } from '@tamber/client';
import { useMemo } from 'react';
import { getSettings, useSettings } from '../store/settings';

/** A client for the current settings (outside React: handlers, the player). */
export function getClient(): TamberClient {
  return TamberClient.fromSettings(getSettings());
}

/** Memoised TamberClient.fromSettings(settings); changes only with the base URL or key. */
export function useTamberClient(): TamberClient {
  const apiBaseUrl = useSettings((s) => s.apiBaseUrl);
  const apiKey = useSettings((s) => s.apiKey);
  return useMemo(() => TamberClient.fromSettings({ apiBaseUrl, apiKey }), [apiBaseUrl, apiKey]);
}
