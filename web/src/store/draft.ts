import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createDebouncedStorage } from '../lib/debouncedStorage';

export const DRAFT_STORAGE_KEY = 'tamber.draft';
/** About 1 MB of serialized JSON. */
export const DRAFT_MAX_CHARS = 1_000_000;
export const DRAFT_DEBOUNCE_MS = 500;

export interface ImportInfo {
  title: string | null;
  source: string;
  sourceType: 'url' | 'html' | 'file';
  wordCount: number;
  truncated: boolean;
}

export interface DraftState {
  text: string;
  /** Set by an import; cleared when the text is cleared. Used for the title and MediaSession. */
  importInfo: ImportInfo | null;
  /** True when the last save was skipped because the draft exceeds DRAFT_MAX_CHARS. */
  tooLargeToSave: boolean;
  setText: (text: string) => void;
  setImported: (text: string, info: ImportInfo) => void;
  clear: () => void;
}

const storage = createDebouncedStorage({
  delayMs: DRAFT_DEBOUNCE_MS,
  maxChars: DRAFT_MAX_CHARS,
  onWrite: (tooLarge) => {
    if (useDraft.getState().tooLargeToSave !== tooLarge) {
      useDraft.setState({ tooLargeToSave: tooLarge });
    }
  },
});

/** Write the pending draft immediately. */
export function flushDraft(): void {
  storage.flush();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraft();
  });
}

/** The composer text (localStorage["tamber.draft"], debounced 500 ms, capped at about 1 MB). */
export const useDraft = create<DraftState>()(
  persist(
    (set) => ({
      text: '',
      importInfo: null,
      tooLargeToSave: false,
      setText: (text) => set(text ? { text } : { text, importInfo: null }),
      setImported: (text, importInfo) => set({ text, importInfo }),
      clear: () => set({ text: '', importInfo: null }),
    }),
    {
      name: DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ text: s.text, importInfo: s.importInfo }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DraftState>;
        return {
          ...current,
          text: typeof p.text === 'string' ? p.text : '',
          importInfo: p.importInfo && typeof p.importInfo === 'object' ? p.importInfo : null,
        };
      },
    },
  ),
);
