/**
 * Pure base64 and UTF-8 helpers. They do not rely on atob/btoa/TextDecoder/Buffer, which are
 * missing or incomplete on some targets (older Hermes builds, service workers under test, etc.).
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  // Accept URL-safe variants too.
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Decode standard (or URL-safe) base64, ignoring whitespace and padding. Throws on bad input. */
export function base64ToBytes(b64: string): Uint8Array {
  let len = 0;
  const clean = new Uint8Array(b64.length);
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c === 61 /* = */) break;
    if (c === 32 || c === 10 || c === 13 || c === 9) continue;
    const v = c < 128 ? (B64_LOOKUP[c] ?? -1) : -1;
    if (v < 0) throw new Error(`Invalid base64 character at position ${i}`);
    clean[len++] = v;
  }
  if (len % 4 === 1) throw new Error('Invalid base64 length');
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    const n = (clean[i]! << 18) | (clean[i + 1]! << 12) | (clean[i + 2]! << 6) | clean[i + 3]!;
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  const rem = len - i;
  if (rem === 2) {
    const n = (clean[i]! << 18) | (clean[i + 1]! << 12);
    out[o++] = (n >> 16) & 0xff;
  } else if (rem === 3) {
    const n = (clean[i]! << 18) | (clean[i + 1]! << 12) | (clean[i + 2]! << 6);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
  }
  return out;
}

/** Encode bytes as standard padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      '=';
  }
  return out;
}

/**
 * Streaming UTF-8 decoder: feed byte chunks with `decode(bytes, {stream: true})`; a multi-byte
 * sequence split across chunks is carried over instead of being corrupted. Invalid sequences decode
 * to U+FFFD. Same observable behaviour as `new TextDecoder('utf-8')` for valid input.
 */
export class Utf8StreamDecoder {
  private pending: number[] = [];

  decode(bytes?: Uint8Array, options?: { stream?: boolean }): string {
    const input = bytes ?? new Uint8Array(0);
    const buf = this.pending.length ? concatBytes(Uint8Array.from(this.pending), input) : input;
    this.pending = [];
    let out = '';
    let i = 0;
    const n = buf.length;
    while (i < n) {
      const b0 = buf[i]!;
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
        i++;
        continue;
      }
      let need: number;
      let cp: number;
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        need = 1;
        cp = b0 & 0x1f;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        need = 2;
        cp = b0 & 0x0f;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        need = 3;
        cp = b0 & 0x07;
      } else {
        out += '�';
        i++;
        continue;
      }
      if (i + need >= n) {
        // The sequence runs past the end of this buffer. If what we have so far is a valid prefix,
        // keep it for the next call (streaming) or emit one replacement char (final call).
        let validPrefix = true;
        for (let k = 1; i + k < n; k++) {
          if ((buf[i + k]! & 0xc0) !== 0x80) validPrefix = false;
        }
        if (validPrefix) {
          if (options?.stream) {
            for (let k = i; k < n; k++) this.pending.push(buf[k]!);
          } else {
            out += '�';
          }
          return out;
        }
      }
      let ok = true;
      for (let k = 1; k <= need; k++) {
        const b = buf[i + k];
        if (b === undefined || (b & 0xc0) !== 0x80) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (b & 0x3f);
      }
      if (
        !ok ||
        (need === 2 && cp < 0x800) ||
        (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) ||
        (cp >= 0xd800 && cp <= 0xdfff)
      ) {
        out += '�';
        i++;
        continue;
      }
      if (cp >= 0x10000) {
        const v = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
      i += need + 1;
    }
    return out;
  }
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
