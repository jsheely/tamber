import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from '../lib/safeStorage';

export const HISTORY_STORAGE_KEY = 'tamber.history';
export const HISTORY_MAX_ENTRIES = 20;
/** Total text kept across all entries (localStorage is ~5 MB per origin, shared with the draft). */
export const HISTORY_MAX_TOTAL_CHARS = 600_000;

export interface HistoryEntry {
  id: string;
  title: string;
  text: string;
  chars: number;
  voice: string;
  createdAt: number;
}

export interface HistoryState {
  entries: HistoryEntry[];
  add: (entry: { text: string; title: string | null; voice: string }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export function titleFromText(text: string, max = 60): string {
  const firstLine = text.trim().split(/\n/)[0] ?? '';
  const oneLine = firstLine.replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'Untitled';
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Newest first, de-duplicated by text, bounded by count and total characters. */
export function addHistoryEntry(
  entries: readonly HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  const next = [entry, ...entries.filter((e) => e.text !== entry.text)];
  const out: HistoryEntry[] = [];
  let total = 0;
  for (const e of next) {
    if (out.length >= HISTORY_MAX_ENTRIES) break;
    if (total + e.chars > HISTORY_MAX_TOTAL_CHARS) continue; // skip what does not fit
    out.push(e);
    total += e.chars;
  }
  return out;
}

function isEntry(e: unknown): e is HistoryEntry {
  if (typeof e !== 'object' || e === null) return false;
  const h = e as Partial<HistoryEntry>;
  return (
    typeof h.id === 'string' &&
    typeof h.text === 'string' &&
    typeof h.title === 'string' &&
    typeof h.createdAt === 'number'
  );
}

/** Recently played texts (localStorage["tamber.history"], newest first, capped). */
export const useHistory = create<HistoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      add: ({ text, title, voice }) => {
        if (!text.trim()) return;
        set({
          entries: addHistoryEntry(get().entries, {
            id: makeId(),
            title: title?.trim() || titleFromText(text),
            text,
            chars: text.length,
            voice,
            createdAt: Date.now(),
          }),
        });
      },
      remove: (id) => set({ entries: get().entries.filter((e) => e.id !== id) }),
      clear: () => set({ entries: [] }),
    }),
    {
      name: HISTORY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({ entries: s.entries }),
      merge: (persisted, current) => {
        const raw = (persisted as { entries?: unknown } | null)?.entries;
        const entries = Array.isArray(raw)
          ? raw.filter(isEntry).map((e) => ({ ...e, chars: e.text.length, voice: e.voice ?? '' }))
          : [];
        return { ...current, entries: entries.slice(0, HISTORY_MAX_ENTRIES) };
      },
    },
  ),
);
