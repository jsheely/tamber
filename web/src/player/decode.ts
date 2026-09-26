/**
 * decodeAudioData with Safari fallbacks (docs/research/web-stack.md section 7.3):
 * the Promise form first, then the legacy two-callback form on a fresh copy of the bytes, because
 * Safari has been seen rejecting the Promise form for files the callback form decodes.
 */

type DecodeContext = Pick<BaseAudioContext, 'decodeAudioData'>;

/** decodeAudioData detaches its input, so every attempt gets its own ArrayBuffer. */
function freshBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeWithPromise(ctx: DecodeContext, data: ArrayBuffer): Promise<AudioBuffer> {
  try {
    const result = ctx.decodeAudioData(data) as Promise<AudioBuffer> | undefined;
    if (result && typeof result.then === 'function') return result;
    return Promise.reject(new Error('decodeAudioData did not return a promise'));
  } catch (err) {
    return Promise.reject(err);
  }
}

function decodeWithCallbacks(ctx: DecodeContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const maybe = ctx.decodeAudioData(
        data,
        (buffer) => resolve(buffer),
        (err) => reject(err ?? new Error('Audio decoding failed')),
      ) as Promise<AudioBuffer> | undefined;
      // Modern engines also return a promise here; its rejection is reported via the callback.
      if (maybe && typeof maybe.catch === 'function') maybe.catch(() => undefined);
    } catch (err) {
      reject(err);
    }
  });
}

/** Decode one complete audio file (a WAV or MP3 chunk) into an AudioBuffer. */
export function decodeAudio(ctx: DecodeContext, bytes: Uint8Array): Promise<AudioBuffer> {
  return decodeWithPromise(ctx, freshBuffer(bytes)).catch((first: unknown) =>
    decodeWithCallbacks(ctx, freshBuffer(bytes)).catch(() => {
      throw first instanceof Error ? first : new Error('Audio decoding failed');
    }),
  );
}
