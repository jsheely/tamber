/**
 * React access to the persisted settings. One provider per page; every page stays in sync with the
 * others (and with other synced Chromes) through chrome.storage.onChanged.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createDefaultSettings, updateSettings, type TamberSettings } from '@tamber/client';
import {
  DEFAULT_EXTENSION_SETTINGS,
  loadExtensionSettings,
  loadSettings,
  migrateExtensionSettings,
  onSettingsChanged,
  resetSettings,
  saveExtensionSettings,
  saveSettings,
  type ExtensionSettings,
} from '../lib/settings';

export interface SettingsApi {
  settings: TamberSettings;
  ext: ExtensionSettings;
  /** False until both parts were read from storage. */
  ready: boolean;
  /** Optimistically apply and persist a partial update. */
  save: (patch: Partial<Omit<TamberSettings, 'version'>>) => Promise<TamberSettings>;
  saveExt: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
  reset: () => Promise<void>;
}

export function useSettingsState(): SettingsApi {
  const [settings, setSettings] = useState<TamberSettings | null>(null);
  const [ext, setExt] = useState<ExtensionSettings | null>(null);

  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => alive && setSettings(s));
    void loadExtensionSettings().then((e) => alive && setExt(e));
    const off = onSettingsChanged((change) => {
      if (change.settings) void loadSettings().then((s) => alive && setSettings(s));
      if (change.extension) void loadExtensionSettings().then((e) => alive && setExt(e));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const save = useCallback(async (patch: Partial<Omit<TamberSettings, 'version'>>) => {
    setSettings((cur) => updateSettings(cur ?? createDefaultSettings(), patch));
    const next = await saveSettings(patch);
    setSettings(next);
    return next;
  }, []);

  const saveExt = useCallback(async (patch: Partial<ExtensionSettings>) => {
    setExt((cur) => migrateExtensionSettings({ ...(cur ?? DEFAULT_EXTENSION_SETTINGS), ...patch }));
    const next = await saveExtensionSettings(patch);
    setExt(next);
    return next;
  }, []);

  const reset = useCallback(async () => {
    await resetSettings();
    setSettings(createDefaultSettings());
    setExt({ ...DEFAULT_EXTENSION_SETTINGS });
  }, []);

  return useMemo(
    () => ({
      settings: settings ?? createDefaultSettings(),
      ext: ext ?? { ...DEFAULT_EXTENSION_SETTINGS },
      ready: settings !== null && ext !== null,
      save,
      saveExt,
      reset,
    }),
    [settings, ext, save, saveExt, reset],
  );
}

export const SettingsContext = createContext<SettingsApi | null>(null);

export function useSettings(): SettingsApi {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings() must be used inside <SettingsProvider>');
  return ctx;
}
