/**
 * WAV helpers for the chunk format the server emits: RIFF/WAVE, PCM signed 16-bit little-endian,
 * mono, 24000 Hz, a single `data` chunk with correct sizes. Used to stitch streamed chunks into one
 * downloadable file ("Save audio") without re-encoding.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 = PCM. */
  audioFormat: number;
  /** Byte offset of the PCM payload. */
  dataOffset: number;
  /** Byte length of the PCM payload. */
  dataLength: number;
  /** Seconds. */
  duration: number;
}

function ascii(bytes: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i] ?? 0);
  return s;
}

/** Parse a RIFF/WAVE header. Throws if the bytes are not a WAV file with fmt + data chunks. */
export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength' | 'duration'> | null = null;
  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    let size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      // Streaming writers may put 0 / 0xFFFFFFFF here; clamp to what is actually present.
      if (size === 0 || size === 0xffffffff || body + size > bytes.length)
        size = bytes.length - body;
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return {
        ...fmt,
        dataOffset: body,
        dataLength: size,
        duration: bytesPerSec ? size / bytesPerSec : 0,
      };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}

/** Build a canonical 44-byte PCM WAV header. */
export function wavHeader(
  dataLength: number,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const w = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[at + i] = s.charCodeAt(i);
  };
  const blockAlign = channels * (bitsPerSample / 8);
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataLength, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  w(36, 'data');
  v.setUint32(40, dataLength, true);
  return header;
}

/** Concatenate WAV files with identical PCM formats into one WAV file. Throws on format mismatch. */
export function concatWav(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) throw new Error('No WAV parts to concatenate');
  const infos = parts.map(parseWav);
  const f = infos[0]!;
  for (const i of infos) {
    if (
      i.audioFormat !== f.audioFormat ||
      i.sampleRate !== f.sampleRate ||
      i.channels !== f.channels ||
      i.bitsPerSample !== f.bitsPerSample
    ) {
      throw new Error('WAV parts have different formats');
    }
  }
  const total = infos.reduce((s, i) => s + i.dataLength, 0);
  const out = new Uint8Array(44 + total);
  out.set(wavHeader(total, f.sampleRate, f.channels, f.bitsPerSample), 0);
  let at = 44;
  infos.forEach((info, k) => {
    out.set(parts[k]!.subarray(info.dataOffset, info.dataOffset + info.dataLength), at);
    at += info.dataLength;
  });
  return out;
}
