/**
 * iOS-safe audio unlocking (docs/research/web-stack.md sections 7.2 and 7.4).
 *
 * Everything in this file is synchronous on purpose: iOS Safari only unlocks Web Audio when the
 * AudioContext is created or resumed inside the call stack of a user gesture (click / pointerup /
 * keydown). One `await` before these calls and the unlock silently fails.
 */

interface AudioSessionLike {
  type: string;
}

type NavigatorWithAudioSession = Navigator & { audioSession?: AudioSessionLike };

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/**
 * Put the page in the "playback" audio session (Safari 16.4+), so narration keeps playing when the
 * ringer switch is on silent. Must run before the AudioContext is created or resumed.
 * Returns true when the API exists.
 */
export function setPlaybackAudioSession(nav: Navigator = navigator): boolean {
  if (!('audioSession' in nav)) return false;
  const session = (nav as NavigatorWithAudioSession).audioSession;
  if (!session) return false;
  try {
    // Flipping the type mid-session confuses iOS: only set it when it differs.
    if (session.type !== 'playback') session.type = 'playback';
  } catch {
    // Read-only or unsupported value: nothing else to do.
  }
  return true;
}

/** The AudioContext constructor, including the legacy prefixed one on old WebKit. */
export function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Default factory: a playback-latency AudioContext at the device's native sample rate. */
export function createAudioContext(): AudioContext {
  const Ctor = getAudioContextCtor();
  if (!Ctor) throw new Error('This browser does not support Web Audio.');
  try {
    return new Ctor({ latencyHint: 'playback' });
  } catch {
    return new Ctor();
  }
}

/**
 * Create the context if needed and ask it to run. Synchronous: the returned promise-less call
 * order (audio session -> construct/resume) is what satisfies the gesture requirement.
 */
export function unlockAudioContext(
  existing: AudioContext | null,
  factory: () => AudioContext = createAudioContext,
  onResumeFailed?: () => void,
): AudioContext {
  setPlaybackAudioSession();
  const ctx = existing && existing.state !== 'closed' ? existing : factory();
  if (ctx.state !== 'running') {
    try {
      const p = ctx.resume();
      if (p && typeof p.then === 'function') p.then(undefined, () => onResumeFailed?.());
    } catch {
      onResumeFailed?.();
    }
  }
  return ctx;
}
