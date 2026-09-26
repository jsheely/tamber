import type { StateStorage } from 'zustand/middleware';
import { safeLocalStorage } from './safeStorage';

export interface DebouncedStorage extends StateStorage {
  /** Write any pending value now (call on pagehide / visibilitychange). */
  flush: () => void;
}

export interface DebouncedStorageOptions {
  delayMs: number;
  /** Serialized values longer than this (UTF-16 units) are not written. */
  maxChars: number;
  /** Called after each write attempt with whether the value was too large to persist. */
  onWrite?: (tooLarge: boolean) => void;
}

/** A StateStorage that coalesces writes (typing in a 100k-char textarea must not hit disk per key). */
export function createDebouncedStorage(options: DebouncedStorageOptions): DebouncedStorage {
  let pending: { name: string; value: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    const tooLarge = p.value.length > options.maxChars;
    if (!tooLarge) safeLocalStorage.setItem(p.name, p.value);
    options.onWrite?.(tooLarge);
  };

  return {
    getItem: (name) => safeLocalStorage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(write, options.delayMs);
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = null;
      return safeLocalStorage.removeItem(name);
    },
    flush: write,
  };
}
