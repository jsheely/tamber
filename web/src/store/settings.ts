import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  createDefaultSettings,
  migrateSettings,
  toggleFavoriteVoice,
  updateSettings,
  type TamberSettings,
} from '@tamber/client';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from '../lib/safeStorage';

export type SettingsPatch = Partial<Omit<TamberSettings, 'version'>>;

export interface SettingsActions {
  /** Apply a patch through updateSettings() (validates, clamps, normalises). */
  update: (patch: SettingsPatch) => void;
  toggleFavorite: (voice: string) => void;
  reset: () => void;
}

export type SettingsState = TamberSettings & SettingsActions;

/** Only the TamberSettings fields (drops the actions). */
export function pickSettings(state: TamberSettings): TamberSettings {
  return {
    version: state.version,
    apiBaseUrl: state.apiBaseUrl,
    apiKey: state.apiKey,
    voice: state.voice,
    speed: state.speed,
    format: state.format,
    lang: state.lang,
    chunkMode: state.chunkMode,
    highlight: state.highlight,
    autoScroll: state.autoScroll,
    theme: state.theme,
    motion: state.motion,
    volume: state.volume,
    favoriteVoices: state.favoriteVoices,
  };
}

/**
 * The persisted settings (localStorage["tamber.settings"], see docs/ARCHITECTURE.md section 7).
 * Every write goes through updateSettings() and every read of persisted data through
 * migrateSettings(), so garbage or old shapes can never reach the UI.
 */
export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...createDefaultSettings(),
      update: (patch) => set(updateSettings(pickSettings(get()), patch)),
      toggleFavorite: (voice) =>
        set(
          updateSettings(pickSettings(get()), {
            favoriteVoices: toggleFavoriteVoice(get().favoriteVoices, voice),
          }),
        ),
      reset: () => {
        // Keep the connection so a reset of preferences does not lock the user out.
        const { apiBaseUrl, apiKey } = get();
        set({ ...createDefaultSettings(), apiBaseUrl, apiKey });
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: SETTINGS_VERSION,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => pickSettings(state),
      migrate: (persisted, version) => migrateSettings(persisted, version),
      merge: (persisted, current) => ({ ...current, ...migrateSettings(persisted) }),
    },
  ),
);

/** Non-hook accessor for code outside React (player, handlers). */
export function getSettings(): TamberSettings {
  return pickSettings(useSettings.getState());
}
