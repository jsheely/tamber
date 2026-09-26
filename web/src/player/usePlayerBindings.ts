import { useHotkeys } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useEffect } from 'react';
import { notifyError } from '../api/errors';
import { useHistory } from '../store/history';
import { useSession } from '../store/session';
import { useSettings } from '../store/settings';
import { playPause, stopPlayback } from './actions';
import { getPlayer } from './instance';
import { bindMediaSession } from './mediaSession';

const SPEED_RESTART_DEBOUNCE_MS = 350;

/** App-level wiring: MediaSession, player events -> toasts/history, live speed and volume. */
export function usePlayerBindings(): void {
  useEffect(() => {
    const player = getPlayer();
    const unbindMedia = bindMediaSession(player);
    let skipped = 0;
    const off = player.on((e) => {
      switch (e.type) {
        case 'session':
          skipped = 0;
          useHistory.getState().add({ text: e.request.text, title: e.title, voice: e.request.voice });
          break;
        case 'chunk-error':
          skipped++;
          notifications.show({
            id: 'tamber-skipped',
            color: 'orange',
            title: skipped > 1 ? `Skipped ${skipped} sentences` : 'Skipped a sentence',
            message: e.message || 'The server could not synthesize part of the text. Playback continues.',
            autoClose: 5000,
          });
          break;
        case 'error':
          notifyError(e.error, { id: 'tamber-playback', retry: () => player.retry() });
          break;
        default:
          break;
      }
    });

    // Speed during playback restarts synthesis at the current chunk (debounced for slider drags).
    let speedTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubSettings = useSettings.subscribe((s, prev) => {
      if (s.volume !== prev.volume) player.setVolume(s.volume);
      if (s.speed !== prev.speed) {
        if (speedTimer) clearTimeout(speedTimer);
        speedTimer = setTimeout(() => player.setSpeed(s.speed), SPEED_RESTART_DEBOUNCE_MS);
      }
    });
    player.setVolume(useSettings.getState().volume);

    return () => {
      off();
      unbindMedia();
      unsubSettings();
      if (speedTimer) clearTimeout(speedTimer);
    };
  }, []);
}

function focusIsOnControl(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  return el.matches('button, a, [role="button"], [role="slider"], [role="tab"], input, textarea, select');
}

/** Desktop shortcuts: Space play/pause, Left/Right previous/next sentence, Esc stop. */
export function usePlayerHotkeys(): void {
  useHotkeys([
    [
      'space',
      (e) => {
        if (focusIsOnControl()) return; // let the focused control handle Space
        e.preventDefault();
        playPause();
      },
      { preventDefault: false },
    ],
    [
      'ArrowLeft',
      () => {
        if (!getPlayer().getSnapshot().hasSession || focusIsOnControl()) return;
        getPlayer().unlock();
        getPlayer().previous();
      },
      { preventDefault: false },
    ],
    [
      'ArrowRight',
      () => {
        if (!getPlayer().getSnapshot().hasSession || focusIsOnControl()) return;
        getPlayer().unlock();
        getPlayer().next();
      },
      { preventDefault: false },
    ],
    [
      'Escape',
      () => {
        if (useSession.getState().drawer) return; // Esc closes the drawer instead
        stopPlayback();
      },
      { preventDefault: false },
    ],
  ]);
}
