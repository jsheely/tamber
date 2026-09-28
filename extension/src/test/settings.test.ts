import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS } from '@tamber/client';
import {
  EXTENSION_SETTINGS_KEY,
  SECRETS_KEY,
  SYNC_ITEM_BUDGET_BYTES,
  SYNC_SETTINGS_KEY,
  fitSyncPayload,
  loadExtensionSettings,
  loadSettings,
  onSettingsChanged,
  resetSettings,
  saveExtensionSettings,
  saveSettings,
  syncItemBytes,
} from '../lib/settings';

describe('settings adapter', () => {
  it('returns defaults when nothing is stored (apiBaseUrl "" = not configured)', async () => {
    const s = await loadSettings();
    expect(s).toEqual({ ...DEFAULT_SETTINGS, favoriteVoices: [], savedBlends: [] });
    expect(s.apiBaseUrl).toBe('');
    expect(await loadExtensionSettings()).toEqual({
      showMiniPlayer: true,
      openOnPlay: 'none',
    });
  });

  it('splits the API key into storage.local and never syncs it', async () => {
    await saveSettings({
      apiBaseUrl: 'tts.example.com/v1/',
      apiKey: '  secret-key ',
      voice: 'af_bella',
    });
    const sync = await fakeBrowser.storage.sync.get(SYNC_SETTINGS_KEY);
    const local = await fakeBrowser.storage.local.get(SECRETS_KEY);
    expect(sync[SYNC_SETTINGS_KEY]).not.toHaveProperty('apiKey');
    expect(sync[SYNC_SETTINGS_KEY]).toMatchObject({
      apiBaseUrl: 'https://tts.example.com',
      voice: 'af_bella',
      version: 1,
    });
    expect(local[SECRETS_KEY]).toEqual({ apiKey: 'secret-key' });
  });

  it('round-trips through load()', async () => {
    const saved = await saveSettings({
      apiBaseUrl: 'https://tts.example.com',
      apiKey: 'k',
      speed: 1.25,
      format: 'mp3',
      theme: 'dark',
      favoriteVoices: ['af_heart', 'af_bella(2)+af_sky(1)'],
    });
    expect(await loadSettings()).toEqual(saved);
  });

  it('migrates and validates legacy / garbage data', async () => {
    await fakeBrowser.storage.sync.set({
      [SYNC_SETTINGS_KEY]: {
        version: 0,
        baseUrl: 'localhost:8880',
        theme: 'system',
        speed: 9,
        format: 'ogg',
        voice: 'not a voice!',
        highlightWords: false,
        unknownKey: 123,
      },
    });
    const s = await loadSettings();
    expect(s.apiBaseUrl).toBe('http://localhost:8880');
    expect(s.theme).toBe('auto');
    expect(s.speed).toBe(2);
    expect(s.format).toBe('wav');
    expect(s.voice).toBe('af_heart');
    expect(s.highlight).toBe(false);
    expect(s).not.toHaveProperty('unknownKey');
  });

  it('serializes concurrent saves so no update is lost', async () => {
    await Promise.all([
      saveSettings({ speed: 1.5 }),
      saveSettings({ voice: 'am_adam' }),
      saveSettings({ volume: 0.4 }),
    ]);
    const s = await loadSettings();
    expect(s).toMatchObject({ speed: 1.5, voice: 'am_adam', volume: 0.4 });
  });

  it('stores extension-only settings separately', async () => {
    await saveExtensionSettings({ openOnPlay: 'popup' });
    const sync = await fakeBrowser.storage.sync.get(EXTENSION_SETTINGS_KEY);
    expect(sync[EXTENSION_SETTINGS_KEY]).toEqual({ showMiniPlayer: true, openOnPlay: 'popup' });
    expect(await loadExtensionSettings()).toEqual({ showMiniPlayer: true, openOnPlay: 'popup' });
  });

  it('migrates the legacy openSidePanelOnPlay flag and rejects unknown openOnPlay values', async () => {
    await fakeBrowser.storage.sync.set({
      [EXTENSION_SETTINGS_KEY]: { showMiniPlayer: false, openSidePanelOnPlay: true },
    });
    expect(await loadExtensionSettings()).toEqual({ showMiniPlayer: false, openOnPlay: 'sidepanel' });

    await fakeBrowser.storage.sync.set({
      [EXTENSION_SETTINGS_KEY]: { openSidePanelOnPlay: false },
    });
    expect((await loadExtensionSettings()).openOnPlay).toBe('none');

    // An explicit value wins over the legacy flag; garbage falls back to the default.
    await fakeBrowser.storage.sync.set({
      [EXTENSION_SETTINGS_KEY]: { openOnPlay: 'popup', openSidePanelOnPlay: true },
    });
    expect((await loadExtensionSettings()).openOnPlay).toBe('popup');
    await fakeBrowser.storage.sync.set({ [EXTENSION_SETTINGS_KEY]: { openOnPlay: 'window' } });
    expect((await loadExtensionSettings()).openOnPlay).toBe('none');

    // Saving rewrites the item in the new shape (the legacy key is dropped).
    await saveExtensionSettings({ showMiniPlayer: true });
    expect((await fakeBrowser.storage.sync.get(EXTENSION_SETTINGS_KEY))[EXTENSION_SETTINGS_KEY]).toEqual({
      showMiniPlayer: true,
      openOnPlay: 'none',
    });
  });

  it('notifies subscribers when any part changes', async () => {
    const listener = vi.fn();
    const off = onSettingsChanged(listener);
    await saveSettings({ speed: 1.1 });
    expect(listener).toHaveBeenCalledWith({ settings: true });
    await saveExtensionSettings({ showMiniPlayer: false });
    expect(listener).toHaveBeenCalledWith({ extension: true });
    off();
    listener.mockClear();
    await saveSettings({ speed: 1.2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset() restores the defaults', async () => {
    await saveSettings({ apiBaseUrl: 'https://tts.example.com', apiKey: 'k' });
    await saveExtensionSettings({ showMiniPlayer: false });
    await resetSettings();
    expect((await loadSettings()).apiBaseUrl).toBe('');
    expect((await loadSettings()).apiKey).toBe('');
    expect((await loadExtensionSettings()).showMiniPlayer).toBe(true);
  });

  it('keeps the synced item well under the 8 KB per-item quota', () => {
    const shared = {
      ...DEFAULT_SETTINGS,
      favoriteVoices: Array.from(
        { length: 400 },
        (_, i) => `af_voice_number_${i}(1)+am_other_${i}(2)`,
      ),
      savedBlends: Array.from({ length: 200 }, (_, i) => ({
        name: `A rather long saved blend name number ${i}`,
        spec: `af_voice_number_${i}(1)+am_other_${i}(2)`,
      })),
    };
    const { apiKey: _k, ...rest } = shared;
    const fitted = fitSyncPayload(rest);
    expect(syncItemBytes(SYNC_SETTINGS_KEY, fitted)).toBeLessThanOrEqual(SYNC_ITEM_BUDGET_BYTES);
    // Favourites are trimmed first; the saved blends only when favourites alone are not enough.
    expect(fitted.savedBlends.length).toBeGreaterThan(0);
    expect(fitted.savedBlends.length).toBeLessThan(200);
  });
});
