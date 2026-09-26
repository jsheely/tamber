import { Button, Group, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  isAbortError,
  TamberApiError,
  TamberNetworkError,
  TamberProtocolError,
  TamberStreamError,
  TamberTimeoutError,
} from '@tamber/client';
import { useSession } from '../store/session';

export interface ErrorDescription {
  title: string;
  message: string;
  auth: boolean;
  retryable: boolean;
}

const API_TITLES: Record<string, string> = {
  unauthorized: 'API key needed',
  rate_limited: 'Too many requests',
  server_busy: 'Server is busy',
  model_loading: 'The voice model is warming up',
  text_too_long: 'Text is too long',
  empty_text: 'Nothing to read',
  unknown_voice: 'Unknown voice',
  unsupported_language: 'Language not enabled on this server',
  unsupported_format: 'Audio format not supported',
  invalid_request: 'Invalid request',
  file_too_large: 'File is too large',
  unsupported_media_type: 'Unsupported file type',
  extract_failed: 'No readable text found',
  fetch_failed: 'Could not fetch that page',
  url_not_allowed: 'That address is not allowed',
  synthesis_failed: 'Synthesis failed',
  not_found: 'Not found',
};

/** Human wording for any error thrown by @tamber/client (uses error.code / message). */
export function describeError(err: unknown): ErrorDescription {
  if (err instanceof TamberApiError) {
    const wait = err.retryAfter ? ` Try again in ${err.retryAfter}s.` : '';
    return {
      title: API_TITLES[err.code] ?? `Server error (${err.status})`,
      message: `${err.message}${wait}`,
      auth: err.isAuthError,
      retryable: err.isRetryable,
    };
  }
  if (err instanceof TamberNetworkError) {
    return {
      title: 'Cannot reach the Tamber server',
      message: 'Check your connection and the API address in Settings.',
      auth: false,
      retryable: true,
    };
  }
  if (err instanceof TamberTimeoutError) {
    return { title: 'The server took too long', message: err.message, auth: false, retryable: true };
  }
  if (err instanceof TamberStreamError) {
    return { title: 'Synthesis stopped', message: err.message, auth: false, retryable: true };
  }
  if (err instanceof TamberProtocolError) {
    return {
      title: 'Connection interrupted',
      message: 'The audio stream ended early. A proxy may be buffering or cutting it.',
      auth: false,
      retryable: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { title: 'Something went wrong', message, auth: false, retryable: true };
}

/** Open Settings with the API key focused and say why (401 or auth_required without a key). */
export function requestApiKey(message = 'This server needs an API key. Paste it in Settings.'): void {
  useSession.getState().setConnection('auth', message);
  useSession.getState().openDrawer('settings', { focusApiKey: true });
  notifications.show({
    id: 'tamber-auth',
    color: 'yellow',
    title: 'API key needed',
    message,
    autoClose: 7000,
  });
}

/** Toast for an error; AbortError is silent; 401 opens Settings. */
export function notifyError(err: unknown, opts: { retry?: () => void; id?: string } = {}): void {
  if (isAbortError(err)) return;
  const d = describeError(err);
  if (d.auth) {
    requestApiKey('The server rejected the API key. Check it in Settings.');
    return;
  }
  const id = opts.id ?? `tamber-error-${Date.now()}`;
  const retry = opts.retry;
  notifications.show({
    id,
    color: 'red',
    title: d.title,
    autoClose: retry ? 12000 : 7000,
    message: retry ? (
      <Group gap="sm" justify="space-between" wrap="nowrap">
        <Text size="sm">{d.message}</Text>
        <Button
          size="compact-sm"
          variant="light"
          onClick={() => {
            notifications.hide(id);
            retry();
          }}
        >
          Retry
        </Button>
      </Group>
    ) : (
      d.message
    ),
  });
}
