import type { ChunkedPlayer, PlayerSnapshot } from './ChunkedPlayer';

/**
 * Lock-screen / hardware-key integration (docs/ARCHITECTURE.md section 5.3). Title is the import
 * title or the first 60 characters, artist "Tamber", album the voice, artwork the brand icon.
 */
export interface MediaMeta {
  title: string;
  voice: string;
}

type Action = MediaSessionAction;

function hasMediaSession(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function mediaTitle(snapshot: Pick<PlayerSnapshot, 'title' | 'text'>): string {
  if (snapshot.title?.trim()) return snapshot.title.trim();
  const flat = snapshot.text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat || 'Tamber';
}

function setHandler(action: Action, handler: MediaSessionActionHandler | null): void {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Action not supported by this browser.
  }
}

/** Wire MediaSession to the player. Returns an unbind function. */
export function bindMediaSession(player: ChunkedPlayer): () => void {
  if (!hasMediaSession()) return () => undefined;
  const ms = navigator.mediaSession;

  setHandler('play', () => player.resume());
  setHandler('pause', () => player.pause());
  setHandler('stop', () => player.stop());
  setHandler('previoustrack', () => player.previous());
  setHandler('nexttrack', () => player.next());
  setHandler('seekbackward', (d) => player.seekBy(-(d.seekOffset ?? 10)));
  setHandler('seekforward', (d) => player.seekBy(d.seekOffset ?? 10));

  let lastKey = '';
  const sync = () => {
    const s = player.getSnapshot();
    ms.playbackState =
      s.status === 'playing' || s.status === 'loading'
        ? 'playing'
        : s.status === 'paused'
          ? 'paused'
          : 'none';
    if (!s.hasSession) {
      if (lastKey) {
        ms.metadata = null;
        lastKey = '';
      }
      return;
    }
    const title = mediaTitle(s);
    const key = `${title}\u0000${s.voice}`;
    if (key === lastKey || typeof MediaMetadata === 'undefined') return;
    lastKey = key;
    ms.metadata = new MediaMetadata({
      title,
      artist: 'Tamber',
      album: s.voice,
      artwork: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  };
  sync();
  const unsubscribe = player.subscribe(sync);
  return () => {
    unsubscribe();
    for (const a of [
      'play',
      'pause',
      'stop',
      'previoustrack',
      'nexttrack',
      'seekbackward',
      'seekforward',
    ] as Action[]) {
      setHandler(a, null);
    }
  };
}
