import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useSettingsState } from '../hooks/useSettings';
import { saveExtensionSettings, saveSettings, SECRETS_KEY, SYNC_SETTINGS_KEY } from '../lib/settings';

describe('useSettingsState (every extension page)', () => {
  it('rehydrates persisted settings on open (a reopened popup remembers them)', async () => {
    await saveSettings({ apiBaseUrl: 'https://tts.example.com', apiKey: 'k1', voice: 'bf_emma', speed: 1.4 });
    await saveExtensionSettings({ showMiniPlayer: false });
    const { result } = renderHook(() => useSettingsState());
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.settings).toMatchObject({
      apiBaseUrl: 'https://tts.example.com',
      apiKey: 'k1',
      voice: 'bf_emma',
      speed: 1.4,
    });
    expect(result.current.ext.showMiniPlayer).toBe(false);
  });

  it('persists its own changes and follows changes made in other contexts', async () => {
    const { result } = renderHook(() => useSettingsState());
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(() => result.current.save({ voice: 'am_michael', apiKey: 'secret' }));
    const sync = await fakeBrowser.storage.sync.get(SYNC_SETTINGS_KEY);
    const local = await fakeBrowser.storage.local.get(SECRETS_KEY);
    expect(sync[SYNC_SETTINGS_KEY]).toMatchObject({ voice: 'am_michael' });
    expect(sync[SYNC_SETTINGS_KEY]).not.toHaveProperty('apiKey');
    expect(local[SECRETS_KEY]).toEqual({ apiKey: 'secret' });

    // e.g. the options page changes the speed while the popup is open
    await act(async () => {
      await saveSettings({ speed: 0.75 });
    });
    await waitFor(() => expect(result.current.settings.speed).toBe(0.75));
    expect(result.current.settings.voice).toBe('am_michael');
  });
});
