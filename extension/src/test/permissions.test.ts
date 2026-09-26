import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  OPTIONAL_HOST_PATTERNS,
  hasApiPermission,
  originPatternFor,
  requestApiPermission,
} from '../lib/permissions';

describe('originPatternFor', () => {
  it('maps an https base URL to its host pattern', () => {
    expect(originPatternFor('https://tts.example.com')).toEqual({
      ok: true,
      pattern: 'https://tts.example.com/*',
      origin: 'https://tts.example.com',
    });
  });

  it('normalizes input first (scheme, trailing slash, /v1, path prefix)', () => {
    const r = originPatternFor('tts.example.com/tamber/v1/');
    expect(r).toMatchObject({ ok: true, pattern: 'https://tts.example.com/*' });
  });

  it('drops the port (match patterns cover every port) but keeps it in the origin', () => {
    expect(originPatternFor('https://tts.example.com:8443')).toMatchObject({
      pattern: 'https://tts.example.com/*',
      origin: 'https://tts.example.com:8443',
    });
    expect(originPatternFor('localhost:8880')).toMatchObject({
      pattern: 'http://localhost/*',
      origin: 'http://localhost:8880',
    });
    expect(originPatternFor('http://127.0.0.1:8880')).toMatchObject({
      pattern: 'http://127.0.0.1/*',
    });
  });

  it('rejects empty, invalid and remote plain-http addresses', () => {
    expect(originPatternFor('')).toEqual({ ok: false, reason: 'empty' });
    expect(originPatternFor('ftp://x.example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(originPatternFor('http://tts.example.com')).toEqual({ ok: false, reason: 'insecure' });
  });

  it('only produces patterns inside the manifest optional_host_permissions', () => {
    const covers = (pattern: string) =>
      OPTIONAL_HOST_PATTERNS.some((opt) =>
        opt === 'https://*/*' ? pattern.startsWith('https://') : opt === pattern,
      );
    for (const url of ['https://a.b.c', 'localhost:8880', 'http://127.0.0.1:1']) {
      const r = originPatternFor(url);
      expect(r.ok && covers(r.pattern)).toBe(true);
    }
  });
});

describe('requestApiPermission', () => {
  it('calls permissions.request synchronously with the origin pattern', async () => {
    const request = vi.fn(async () => true);
    fakeBrowser.permissions.request = request as never;
    const p = requestApiPermission('https://tts.example.com/');
    // Called before any await: required for the user gesture to count.
    expect(request).toHaveBeenCalledWith({ origins: ['https://tts.example.com/*'] });
    await expect(p).resolves.toBe(true);
  });

  it('resolves false without prompting for an invalid address', async () => {
    const request = vi.fn(async () => true);
    fakeBrowser.permissions.request = request as never;
    await expect(requestApiPermission('http://remote.example.com')).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('hasApiPermission checks the same pattern', async () => {
    const contains = vi.fn(async () => true);
    fakeBrowser.permissions.contains = contains as never;
    await expect(hasApiPermission('https://tts.example.com')).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://tts.example.com/*'] });
  });
});
