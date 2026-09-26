import { SETTINGS_STORAGE_KEY, SETTINGS_VERSION } from '@tamber/client';
import * as SecureStore from 'expo-secure-store';

import { storage } from '@/store/mmkv';
import { API_KEY_SECURE_KEY, migratePersistedSettings, useSettings } from '@/store/settings';

const secure = SecureStore as unknown as { __store: Map<string, string> };

function persisted(): { state: Record<string, unknown>; version: number } {
  return JSON.parse(storage.getString(SETTINGS_STORAGE_KEY) ?? 'null');
}

beforeEach(async () => {
  secure.__store.clear();
  storage.remove(SETTINGS_STORAGE_KEY);
  await useSettings.getState().reset();
});

describe('settings store', () => {
  it('persists the flat settings to MMKV under tamber.settings without the API key', async () => {
    useSettings.getState().update({ apiBaseUrl: 'tts.example.com/', voice: 'bf_emma', speed: 1.337 });
    await useSettings.getState().setApiKey('  s3cret ');
    const p = persisted();
    expect(p.version).toBe(SETTINGS_VERSION);
    expect(p.state).toMatchObject({ apiBaseUrl: 'https://tts.example.com', voice: 'bf_emma', speed: 1.34 });
    expect(p.state).not.toHaveProperty('apiKey');
    expect(JSON.stringify(p)).not.toContain('s3cret');
    expect(secure.__store.get(API_KEY_SECURE_KEY)).toBe('s3cret');
    expect(useSettings.getState().settings.apiKey).toBe('s3cret');
  });

  it('validates every update (clamps speed, rejects bad voices)', () => {
    useSettings.getState().update({ speed: 9, voice: 'not a voice!', volume: -1 });
    const s = useSettings.getState().settings;
    expect(s.speed).toBe(2);
    expect(s.voice).toBe('af_heart');
    expect(s.volume).toBe(0);
  });

  it('hydrates the secret from secure-store', async () => {
    secure.__store.set(API_KEY_SECURE_KEY, 'from-keychain');
    await useSettings.getState().loadSecrets();
    expect(useSettings.getState().settings.apiKey).toBe('from-keychain');
    expect(useSettings.getState().secretsLoaded).toBe(true);
  });

  it('migrates an old persisted shape through migrateSettings on rehydrate', async () => {
    await useSettings.getState().setApiKey('keep-me');
    storage.set(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        state: { baseUrl: 'http://192.168.1.20:8880/v1/', theme: 'system', highlightWords: false, speed: 0.1 },
        version: 0,
      }),
    );
    await useSettings.persist.rehydrate();
    const s = useSettings.getState().settings;
    expect(s.apiBaseUrl).toBe('http://192.168.1.20:8880');
    expect(s.theme).toBe('auto');
    expect(s.highlight).toBe(false);
    expect(s.speed).toBe(0.5);
    // The secret is not part of MMKV and survives rehydration.
    expect(s.apiKey).toBe('keep-me');
  });

  it('migratePersistedSettings strips secrets', () => {
    const out = migratePersistedSettings({ apiKey: 'x', voice: 'am_adam' }, 1);
    expect(out).not.toHaveProperty('apiKey');
    expect(out.voice).toBe('am_adam');
  });

  it('toggles favourites and resets everything', async () => {
    useSettings.getState().toggleFavorite('af_bella');
    useSettings.getState().toggleFavorite('am_adam');
    expect(useSettings.getState().settings.favoriteVoices).toEqual(['am_adam', 'af_bella']);
    useSettings.getState().toggleFavorite('af_bella');
    expect(useSettings.getState().settings.favoriteVoices).toEqual(['am_adam']);
    await useSettings.getState().setApiKey('k');
    await useSettings.getState().reset();
    expect(useSettings.getState().settings.favoriteVoices).toEqual([]);
    expect(secure.__store.has(API_KEY_SECURE_KEY)).toBe(false);
  });
});
