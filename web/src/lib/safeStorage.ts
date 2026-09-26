import type { StateStorage } from 'zustand/middleware';

/**
 * localStorage wrapped in try/catch. Safari private mode, blocked site data or a full quota make
 * the accessor or the calls throw; the app must keep working (just without persistence).
 */
export const safeLocalStorage: StateStorage = {
  getItem(name) {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name, value) {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // Quota exceeded or storage blocked: ignore, the in-memory state is still correct.
    }
  },
  removeItem(name) {
    try {
      window.localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};
