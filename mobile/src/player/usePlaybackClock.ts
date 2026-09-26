/**
 * Drives word highlighting: while enabled, reads the playlist position synchronously on every
 * animation frame (StreamPlayer.sample -> wordIndexAt). This is far finer than expo-audio's
 * status events (250-500 ms), which are used only for end-of-queue detection in the background.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';

export interface Sampler {
  sample(): unknown;
}

export function usePlaybackClock(getSampler: () => Sampler, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const sampler = getSampler();
    let frame: number | null = null;
    let foreground = AppState.currentState !== 'background';

    const loop = () => {
      sampler.sample();
      frame = requestAnimationFrame(loop);
    };
    const start = () => {
      if (frame === null && foreground) frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };

    start();
    const sub = AppState.addEventListener('change', (state) => {
      foreground = state === 'active';
      if (foreground) start();
      else stop();
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [enabled, getSampler]);
}
