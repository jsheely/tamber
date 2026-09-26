import { useSyncExternalStore } from 'react';
import type { PlayerSnapshot } from './ChunkedPlayer';
import { getPlayer } from './instance';

/**
 * Coarse player state for React (status, chunk states, active chunk...). Never per-frame data:
 * the highlight, clock and visuals read player.getFrame() from requestAnimationFrame instead.
 */
export function usePlayerSnapshot(): PlayerSnapshot {
  const player = getPlayer();
  return useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
}

/**
 * Select one value. The selector must return a primitive or a reference owned by the snapshot
 * (never build a new object/array in it), so unchanged values do not re-render.
 */
export function usePlayerState<T>(selector: (s: PlayerSnapshot) => T): T {
  const player = getPlayer();
  const get = () => selector(player.getSnapshot());
  return useSyncExternalStore(player.subscribe, get, get);
}
