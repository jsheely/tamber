import { ChunkedPlayer } from './ChunkedPlayer';

let instance: ChunkedPlayer | null = null;

/** The app-wide player (one AudioContext per page, created lazily inside the first gesture). */
export function getPlayer(): ChunkedPlayer {
  if (!instance) instance = new ChunkedPlayer();
  return instance;
}

/** Tests: swap in a player built with fakes (pass null to reset). */
export function setPlayer(player: ChunkedPlayer | null): void {
  instance?.dispose();
  instance = player;
}
