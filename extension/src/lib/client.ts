/**
 * TamberClient construction and user-facing error text for every extension context.
 */
import {
  TamberApiError,
  TamberClient,
  TamberNetworkError,
  TamberProtocolError,
  TamberStreamError,
  TamberTimeoutError,
  isAbortError,
  type TamberSettings,
} from '@tamber/client';

/** A client for the configured server. Throws if no API URL is configured. */
export function createClient(
  settings: Pick<TamberSettings, 'apiBaseUrl' | 'apiKey'>,
): TamberClient {
  if (!settings.apiBaseUrl)
    throw new Error('Tamber is not configured yet: set the server address in Options.');
  return TamberClient.fromSettings(settings, {
    // Bind explicitly: an unbound fetch throws "Illegal invocation" in extension contexts.
    fetch: globalThis.fetch.bind(globalThis),
  });
}

export function isConfigured(settings: Pick<TamberSettings, 'apiBaseUrl'>): boolean {
  return settings.apiBaseUrl.length > 0;
}

/** Short, human sentence for any error thrown by the client or the player. */
export function describeError(err: unknown): string {
  if (isAbortError(err)) return 'Cancelled.';
  if (err instanceof TamberApiError) {
    if (err.isAuthError) return 'The server rejected the API key. Check it in Options.';
    switch (err.code) {
      case 'model_loading':
        return 'The voice model is still loading on the server. Try again in a few seconds.';
      case 'server_busy':
        return 'The server is busy. Try again shortly.';
      case 'rate_limited':
        return `Too many requests.${err.retryAfter ? ` Try again in ${err.retryAfter} s.` : ''}`;
      case 'text_too_long':
        return 'That text is longer than the server allows.';
      case 'empty_text':
        return 'There is nothing speakable in that text.';
      case 'unknown_voice':
        return 'The selected voice does not exist on this server. Pick another voice.';
      case 'extract_failed':
        return 'No readable text was found on that page.';
      case 'url_not_allowed':
        return 'The server is not allowed to fetch that address.';
      case 'fetch_failed':
        return 'The server could not download that page.';
      default:
        return err.message || `Server error (HTTP ${err.status}).`;
    }
  }
  if (err instanceof TamberTimeoutError) return 'The server took too long to answer.';
  if (err instanceof TamberNetworkError) {
    return 'Cannot reach the Tamber server. Check the address, your connection, and that access was granted.';
  }
  if (err instanceof TamberStreamError) return err.message || 'Synthesis failed on the server.';
  if (err instanceof TamberProtocolError) return 'The connection to the server was interrupted.';
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
