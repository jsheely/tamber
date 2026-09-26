/** Fake expo-audio for Jest: players and playlists that record calls. */
type Listener = (payload: unknown) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  addListener(event: string, fn: Listener) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return { remove: () => set.delete(fn) };
  }
  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }
}

export class FakeAudioPlaylist extends Emitter {
  sources: { uri: string }[] = [];
  currentIndex = 0;
  currentTime = 0;
  playing = false;
  volume = 1;
  get trackCount() {
    return this.sources.length;
  }
  add(source: { uri: string }) {
    this.sources.push(source);
  }
  clear() {
    this.sources = [];
    this.currentIndex = 0;
    this.currentTime = 0;
  }
  play() {
    this.playing = true;
  }
  pause() {
    this.playing = false;
  }
  skipTo(i: number) {
    this.currentIndex = i;
    this.currentTime = 0;
  }
  async seekTo(s: number) {
    this.currentTime = s;
  }
  next() {
    this.skipTo(this.currentIndex + 1);
  }
  previous() {
    this.skipTo(Math.max(0, this.currentIndex - 1));
  }
  destroy() {
    this.clear();
  }
}

export class FakeAudioPlayer extends Emitter {
  source: unknown = null;
  playing = false;
  isBuffering = false;
  isLoaded = true;
  loop = false;
  volume = 1;
  currentTime = 0;
  lockScreen: { active: boolean; metadata?: unknown } = { active: false };
  replace(source: unknown) {
    this.source = source;
  }
  play() {
    this.playing = true;
  }
  pause() {
    this.playing = false;
  }
  async seekTo(s: number) {
    this.currentTime = s;
  }
  setActiveForLockScreen(active: boolean, metadata?: unknown) {
    this.lockScreen = { active, metadata };
  }
  updateLockScreenMetadata(metadata: unknown) {
    this.lockScreen = { ...this.lockScreen, metadata };
  }
  clearLockScreenControls() {
    this.lockScreen = { active: false };
  }
  remove() {}
}

export const createAudioPlaylist = jest.fn(() => new FakeAudioPlaylist());
export const createAudioPlayer = jest.fn((source?: unknown) => {
  const p = new FakeAudioPlayer();
  p.source = source ?? null;
  return p;
});
export const useAudioPlayer = jest.fn((source?: unknown) => createAudioPlayer(source));
export const useAudioPlaylist = jest.fn(() => createAudioPlaylist());
export const setAudioModeAsync = jest.fn(async () => undefined);
export const setIsAudioActiveAsync = jest.fn(async () => undefined);
