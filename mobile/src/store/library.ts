/**
 * Recent documents ("Library"): the last LIBRARY_LIMIT items. The index (id, title, source,
 * createdAt, charCount) is persisted in MMKV under 'tamber.library'; the full text of each item is a
 * file at Paths.document/library/<id>.txt so MMKV stays small.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStorage } from './mmkv';

export const LIBRARY_STORAGE_KEY = 'tamber.library';
export const LIBRARY_LIMIT = 20;

export type LibrarySourceKind = 'text' | 'url' | 'file' | 'share';

export interface LibraryItem {
  id: string;
  title: string;
  /** URL, file name, or '' for typed/pasted text. */
  source: string;
  kind: LibrarySourceKind;
  createdAt: number;
  charCount: number;
}

export interface NewLibraryItem {
  title?: string | null;
  source?: string;
  kind: LibrarySourceKind;
  text: string;
}

interface LibraryState {
  items: LibraryItem[];
  add: (item: NewLibraryItem) => LibraryItem;
  remove: (id: string) => void;
  clear: () => void;
}

function libraryDir(): Directory {
  return new Directory(Paths.document, 'library');
}

function textFile(id: string): File {
  return new File(Paths.document, 'library', `${id}.txt`);
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A short display title: the given title, else the first line of the text (clipped). */
export function deriveTitle(text: string, title?: string | null): string {
  const t = (title ?? '').trim();
  if (t) return t.length > 120 ? `${t.slice(0, 117)}...` : t;
  const firstLine = text.trim().split(/\n/)[0]?.trim() ?? '';
  if (!firstLine) return 'Untitled';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function deleteText(id: string): void {
  try {
    const f = textFile(id);
    if (f.exists) f.delete();
  } catch (err) {
    console.warn('[tamber] could not delete library text', id, err);
  }
}

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      items: [],
      add: ({ title, source = '', kind, text }) => {
        const displayTitle = deriveTitle(text, title);
        // Re-reading the same document moves it to the top instead of duplicating it.
        const existing = get().items.find(
          (i) => i.charCount === text.length && i.source === source && i.title === displayTitle,
        );
        const item: LibraryItem = {
          id: existing?.id ?? newId(),
          title: displayTitle,
          source,
          kind,
          createdAt: Date.now(),
          charCount: text.length,
        };
        try {
          const dir = libraryDir();
          if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
          textFile(item.id).write(text);
        } catch (err) {
          console.warn('[tamber] could not save library text', err);
        }
        const next = [item, ...get().items.filter((i) => i.id !== item.id)];
        for (const dropped of next.slice(LIBRARY_LIMIT)) deleteText(dropped.id);
        set({ items: next.slice(0, LIBRARY_LIMIT) });
        return item;
      },
      remove: (id) => {
        deleteText(id);
        set({ items: get().items.filter((i) => i.id !== id) });
      },
      clear: () => {
        for (const i of get().items) deleteText(i.id);
        set({ items: [] });
      },
    }),
    {
      name: LIBRARY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (s) => ({ items: s.items }) as LibraryState,
    },
  ),
);

/** Read an item's full text, or null when the file is gone. */
export async function readLibraryText(id: string): Promise<string | null> {
  try {
    const f = textFile(id);
    if (!f.exists) return null;
    return await f.text();
  } catch {
    return null;
  }
}
