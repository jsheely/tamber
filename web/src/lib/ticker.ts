/**
 * One shared requestAnimationFrame loop for everything that animates from the audio clock
 * (highlight, time readout, orb, waveform). Runs only while something is subscribed.
 */
export type FrameCallback = (now: number) => void;

const subscribers = new Set<FrameCallback>();
let handle = 0;

function loop(now: number): void {
  handle = requestAnimationFrame(loop);
  for (const cb of subscribers) {
    try {
      cb(now);
    } catch (err) {
      console.error('[tamber] frame callback failed', err);
    }
  }
}

export function onFrame(cb: FrameCallback): () => void {
  subscribers.add(cb);
  if (!handle && typeof requestAnimationFrame === 'function') {
    handle = requestAnimationFrame(loop);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && handle) {
      cancelAnimationFrame(handle);
      handle = 0;
    }
  };
}
