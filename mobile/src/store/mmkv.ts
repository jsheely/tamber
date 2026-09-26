/**
 * The single MMKV instance ('tamber') used for settings, the library index and small UI state, and a
 * zustand StateStorage adapter over it. MMKV is synchronous, so persisted stores hydrate during
 * store creation and the UI never renders with defaults first.
 */
import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

export const storage: MMKV = createMMKV({ id: 'tamber' });

export const mmkvStorage: StateStorage = {
  getItem: (key) => storage.getString(key) ?? null,
  setItem: (key, value) => {
    storage.set(key, value);
  },
  removeItem: (key) => {
    storage.remove(key);
  },
};
