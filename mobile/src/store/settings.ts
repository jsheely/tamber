/**
 * Persisted Tamber settings (the shared model from @tamber/client, docs/ARCHITECTURE.md §7).
 *
 * - Everything except `apiKey` lives in MMKV under 'tamber.settings' (SETTINGS_STORAGE_KEY) through
 *   zustand `persist` + createJSONStorage. The persisted value is the flat settings object (same shape
 *   as the web client's localStorage entry), versioned with SETTINGS_VERSION.
 * - `apiKey` lives in expo-secure-store under 'tamber.apiKey' (Keychain / Android Keystore). It is
 *   loaded asynchronously at boot by loadSecrets(); the root layout keeps the splash screen up until
 *   both MMKV (synchronous) and secure-store are hydrated.
 * - Every setter goes through updateSettings(), which re-validates and clamps.
 */
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  createDefaultSettings,
  migrateSettings,
  splitSecrets,
  toggleFavoriteVoice,
  updateSettings,
  type TamberSettings,
} from '@tamber/client';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStorage } from './mmkv';

export const API_KEY_SECURE_KEY = 'tamber.apiKey';

export type SettingsPatch = Partial<Omit<TamberSettings, 'version'>>;
export type PersistedSettings = Omit<TamberSettings, 'apiKey'>;

export interface SettingsState {
  settings: TamberSettings;
  /** True once the secure-store secret has been read (success or failure). */
  secretsLoaded: boolean;
  /** Apply a validated patch. An `apiKey` in the patch is also written to secure-store. */
  update: (patch: SettingsPatch) => void;
  setApiKey: (apiKey: string) => Promise<void>;
  toggleFavorite: (voice: string) => void;
  /** Restore defaults and delete the stored API key. */
  reset: () => Promise<void>;
  loadSecrets: () => Promise<void>;
}

async function writeSecret(apiKey: string): Promise<void> {
  try {
    if (apiKey) await SecureStore.setItemAsync(API_KEY_SECURE_KEY, apiKey);
    else await SecureStore.deleteItemAsync(API_KEY_SECURE_KEY);
  } catch (err) {
    console.warn('[tamber] could not persist the API key in secure storage', err);
  }
}

/** zustand persist `migrate`: run any stored shape (any version) through migrateSettings. */
export function migratePersistedSettings(persisted: unknown, version: number): PersistedSettings {
  return splitSecrets(migrateSettings(persisted, version)).shared;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: createDefaultSettings(),
      secretsLoaded: false,
      update: (patch) => {
        const next = updateSettings(get().settings, patch);
        set({ settings: next });
        if ('apiKey' in patch) void writeSecret(next.apiKey);
      },
      setApiKey: async (apiKey) => {
        const next = updateSettings(get().settings, { apiKey });
        set({ settings: next });
        await writeSecret(next.apiKey);
      },
      toggleFavorite: (voice) => {
        const s = get().settings;
        set({
          settings: updateSettings(s, {
            favoriteVoices: toggleFavoriteVoice(s.favoriteVoices, voice),
          }),
        });
      },
      reset: async () => {
        set({ settings: createDefaultSettings() });
        await writeSecret('');
      },
      loadSecrets: async () => {
        let apiKey = '';
        try {
          apiKey = (await SecureStore.getItemAsync(API_KEY_SECURE_KEY)) ?? '';
        } catch (err) {
          console.warn('[tamber] could not read the API key from secure storage', err);
        }
        set({ settings: updateSettings(get().settings, { apiKey }), secretsLoaded: true });
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: SETTINGS_VERSION,
      storage: createJSONStorage(() => mmkvStorage),
      // Persist the flat settings object minus secrets (apiKey goes to secure-store).
      partialize: (state) => splitSecrets(state.settings).shared as unknown as SettingsState,
      migrate: (persisted, version) =>
        migratePersistedSettings(persisted, version) as unknown as SettingsState,
      // Always re-validate what comes out of storage, and keep the in-memory secret.
      merge: (persisted, current) => ({
        ...current,
        settings: migrateSettings(
          {
            ...((persisted as Record<string, unknown> | null | undefined) ?? {}),
            apiKey: current.settings.apiKey,
          },
          SETTINGS_VERSION,
        ),
      }),
    },
  ),
);

/** Non-hook accessor for services (player controller, API client factory). */
export function getSettings(): TamberSettings {
  return useSettings.getState().settings;
}

export function settingsHydrated(): boolean {
  return useSettings.persist.hasHydrated() && useSettings.getState().secretsLoaded;
}
