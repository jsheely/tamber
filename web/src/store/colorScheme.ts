import type { MantineColorScheme, MantineColorSchemeManager } from '@mantine/core';
import { useSettings } from './settings';

/**
 * Mantine colour-scheme manager backed by settings.theme, so the persisted Tamber settings are the
 * single source of truth (index.html reads the same key before first paint: no flash).
 */
export function settingsColorSchemeManager(): MantineColorSchemeManager {
  let unsubscribe: (() => void) | null = null;
  return {
    get: (defaultValue) => useSettings.getState().theme ?? defaultValue,
    set: (value: MantineColorScheme) => {
      if (useSettings.getState().theme !== value) useSettings.getState().update({ theme: value });
    },
    subscribe: (onUpdate) => {
      unsubscribe?.();
      unsubscribe = useSettings.subscribe((state, prev) => {
        if (state.theme !== prev.theme) onUpdate(state.theme);
      });
    },
    unsubscribe: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
    clear: () => useSettings.getState().update({ theme: 'auto' }),
  };
}
