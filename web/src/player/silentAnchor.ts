import { wavHeader } from '@tamber/client';

/**
 * A looping, near-silent <audio playsinline> element started inside the play gesture.
 *
 * iOS suspends a pure Web Audio page when the screen locks; a real media element keeps the page's
 * media session alive (lock-screen controls, playback through the lock) and is belt-and-braces for
 * the ringer switch if navigator.audioSession is missing. The samples are +-1 LSB dither, not
 * digital zero, because all-zero files are sometimes optimised away.
 */
export interface AudioAnchor {
  /** Synchronous; call inside the user gesture. */
  start(): void;
  pause(): void;
  dispose(): void;
}

/** 16-bit mono PCM WAV of +-1 LSB noise (inaudible, about -90 dBFS). */
export function makeNearSilentWav(seconds = 1, sampleRate = 22050): Uint8Array {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataLength = samples * 2;
  const out = new Uint8Array(44 + dataLength);
  out.set(wavHeader(dataLength, sampleRate, 1, 16), 0);
  const view = new DataView(out.buffer);
  let seed = 0x2545f491;
  for (let i = 0; i < samples; i++) {
    // xorshift32: deterministic, cheap dither in {-1, 0, 1}
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    view.setInt16(44 + i * 2, ((seed >>> 0) % 3) - 1, true);
  }
  return out;
}

export class SilentAnchor implements AudioAnchor {
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;

  private ensure(): HTMLAudioElement | null {
    if (this.el) return this.el;
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    const bytes = makeNearSilentWav();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.url = URL.createObjectURL(new Blob([copy.buffer], { type: 'audio/wav' }));
    const el = document.createElement('audio');
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('data-tamber-anchor', '');
    el.loop = true;
    el.preload = 'auto';
    el.src = this.url;
    el.style.display = 'none';
    document.body.appendChild(el);
    this.el = el;
    return el;
  }

  start(): void {
    const el = this.ensure();
    if (!el) return;
    try {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    } catch {
      // Autoplay refused (no gesture) or not implemented: the anchor is best-effort.
    }
  }

  pause(): void {
    try {
      this.el?.pause();
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.pause();
    this.el?.remove();
    this.el = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

/** Anchor that does nothing (tests, non-browser environments). */
export const noopAnchor: AudioAnchor = {
  start: () => undefined,
  pause: () => undefined,
  dispose: () => undefined,
};
