/**
 * Runtime host permission for the user's Tamber API origin.
 *
 * The manifest declares no host_permissions. It lists a superset in `optional_host_permissions`
 * (any https origin, plus http on localhost / 127.0.0.1 for local development), and the options
 * page requests exactly the configured origin when the user clicks Save. Granting it lets the
 * extension's fetch() reach the API without depending on the server's CORS headers.
 */
import { browser } from 'wxt/browser';
import { isValidBaseUrl, normalizeBaseUrl } from '@tamber/client';

/** Must match manifest.optional_host_permissions (wxt.config.ts). */
export const OPTIONAL_HOST_PATTERNS = [
  'https://*/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
] as const;

const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

export type OriginPatternResult =
  | { ok: true; pattern: string; origin: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'insecure' };

/**
 * The match pattern to request for an API base URL, e.g. `https://tts.example.com/*`.
 *
 * Match patterns carry no port and match every port on the host, so `http://localhost:8880`
 * becomes `http://localhost/*` (a pattern with a port could fall outside the declared optional
 * superset). Plain http is only requestable for localhost / 127.0.0.1.
 */
export function originPatternFor(baseUrl: string): OriginPatternResult {
  const url = normalizeBaseUrl(baseUrl);
  if (!url) return { ok: false, reason: 'empty' };
  if (!isValidBaseUrl(url)) return { ok: false, reason: 'invalid' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol === 'http:' && !LOCAL_HTTP_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: 'insecure' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, pattern: `${parsed.protocol}//${parsed.hostname}/*`, origin: parsed.origin };
}

export function describePatternError(reason: 'empty' | 'invalid' | 'insecure'): string {
  switch (reason) {
    case 'empty':
      return 'Enter the address of your Tamber server.';
    case 'invalid':
      return 'That does not look like a valid http(s) address.';
    case 'insecure':
      return 'Use https:// for remote servers (plain http is only allowed for localhost / 127.0.0.1).';
  }
}

/**
 * Ask Chrome for access to the API origin.
 *
 * IMPORTANT: call this synchronously inside a click handler, before any `await`: Chrome only shows
 * the permission prompt while the user gesture is still active. The returned promise resolves to
 * whether access is granted (true immediately if it already was).
 */
export function requestApiPermission(baseUrl: string): Promise<boolean> {
  const r = originPatternFor(baseUrl);
  if (!r.ok) return Promise.resolve(false);
  return browser.permissions.request({ origins: [r.pattern] });
}

export async function hasApiPermission(baseUrl: string): Promise<boolean> {
  const r = originPatternFor(baseUrl);
  if (!r.ok) return false;
  try {
    return await browser.permissions.contains({ origins: [r.pattern] });
  } catch {
    return false;
  }
}
