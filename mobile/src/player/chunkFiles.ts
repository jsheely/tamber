/**
 * Chunk audio on disk: Paths.cache/tamber/<requestId>/<index>.<format>.
 *
 * Every NDJSON chunk carries one complete audio file (base64), so each is written as-is and handed
 * to the AudioPlaylist by file:// URI (more reliable than data: URIs, see docs/research/mobile-expo.md
 * §4.4). The whole Paths.cache/tamber tree is disposable and is wiped at app start.
 */
import { Directory, File, Paths } from 'expo-file-system';

import type { ChunkFileStore } from './StreamPlayer';

const ROOT = 'tamber';

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'req';
}

export const chunkFiles: ChunkFileStore = {
  write(requestId, index, format, base64) {
    const dir = new Directory(Paths.cache, ROOT, safeSegment(requestId));
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `${index}.${format === 'mp3' ? 'mp3' : 'wav'}`);
    if (!file.exists) file.create({ intermediates: true });
    file.write(base64, { encoding: 'base64' });
    return file.uri;
  },
  remove(requestIds) {
    for (const id of requestIds) {
      const dir = new Directory(Paths.cache, ROOT, safeSegment(id));
      if (dir.exists) dir.delete();
    }
  },
};

/** Delete every cached chunk (stale sessions from a previous run). */
export function clearChunkCache(): void {
  try {
    const root = new Directory(Paths.cache, ROOT);
    if (root.exists) root.delete();
  } catch (err) {
    console.warn('[tamber] could not clear the chunk cache', err);
  }
}

/** Write arbitrary audio bytes (voice previews) to a cache file and return its URI. */
export function writeCacheAudio(name: string, bytes: Uint8Array): string {
  const dir = new Directory(Paths.cache, ROOT, 'previews');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, safeSegment(name));
  if (!file.exists) file.create({ intermediates: true });
  file.write(bytes);
  return file.uri;
}
