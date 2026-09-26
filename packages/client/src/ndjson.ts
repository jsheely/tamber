import { Utf8StreamDecoder } from './encoding.ts';
import { TamberProtocolError } from './errors.ts';
import { getGlobalTextDecoder, type ReadableStreamLike } from './platform.ts';
import type { TtsEvent } from './types.ts';

/**
 * Splits streamed text into complete lines. Push decoded text as it arrives; get back only the
 * lines that are complete. `flush()` returns a trailing line that had no final newline.
 * Handles `\n` and `\r\n`. Blank lines are dropped.
 */
export class NdjsonLineSplitter {
  private buffer = '';

  push(text: string): string[] {
    this.buffer += text;
    const lines: string[] = [];
    let start = 0;
    let nl = this.buffer.indexOf('\n', start);
    while (nl !== -1) {
      let line = this.buffer.slice(start, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() !== '') lines.push(line);
      start = nl + 1;
      nl = this.buffer.indexOf('\n', start);
    }
    this.buffer = this.buffer.slice(start);
    return lines;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

function makeDecoder(): { decode(input?: Uint8Array, options?: { stream?: boolean }): string } {
  const TD = getGlobalTextDecoder();
  if (TD) {
    try {
      return new TD('utf-8');
    } catch {
      // fall through to the pure implementation
    }
  }
  return new Utf8StreamDecoder();
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (cause) {
    throw new TamberProtocolError(`Malformed NDJSON line: ${line.slice(0, 120)}`, { cause });
  }
}

/**
 * Read an NDJSON byte stream and yield one parsed JSON value per line, as soon as each line is
 * complete. Cancels the underlying reader if the consumer stops early (break/return/throw).
 */
export async function* readNdjson(stream: ReadableStreamLike): AsyncGenerator<unknown, void, void> {
  const reader = stream.getReader();
  const decoder = makeDecoder();
  const splitter = new NdjsonLineSplitter();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
          yield parseLine(line);
        }
      }
    }
    for (const line of splitter.push(decoder.decode())) yield parseLine(line);
    for (const line of splitter.flush()) yield parseLine(line);
    finished = true;
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // ignore: stream may already be errored/closed
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/** Parse a whole NDJSON document held in memory (fallback when streaming is unavailable). */
export function parseNdjsonText(text: string): unknown[] {
  const splitter = new NdjsonLineSplitter();
  return [...splitter.push(text), ...splitter.flush()].map(parseLine);
}

const KNOWN_TYPES = new Set(['start', 'queued', 'chunk', 'done', 'error', 'ping']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(o: Record<string, unknown>, k: string): boolean {
  return typeof o[k] === 'number' && Number.isFinite(o[k]);
}

/**
 * Validate one decoded NDJSON value as a TtsEvent. Returns null for unknown event types (clients
 * MUST ignore those, for forward compatibility). Throws TamberProtocolError for a known type whose
 * required fields are missing or mistyped.
 */
export function toTtsEvent(value: unknown): TtsEvent | null {
  if (!isObj(value) || typeof value.type !== 'string') {
    throw new TamberProtocolError('NDJSON line is not an object with a string "type"');
  }
  if (!KNOWN_TYPES.has(value.type)) return null;
  const bad = (what: string): never => {
    throw new TamberProtocolError(`Invalid "${String(value.type)}" event: ${what}`);
  };
  switch (value.type) {
    case 'start':
      if (
        !num(value, 'total_chunks') ||
        !num(value, 'sample_rate') ||
        !Array.isArray(value.chunks)
      ) {
        bad('needs total_chunks, sample_rate and chunks[]');
      }
      break;
    case 'chunk':
      if (
        !num(value, 'index') ||
        !num(value, 'char_start') ||
        !num(value, 'char_end') ||
        !num(value, 'duration') ||
        typeof value.audio !== 'string' ||
        !Array.isArray(value.words)
      ) {
        bad('needs index, char_start, char_end, duration, audio and words[]');
      }
      break;
    case 'done':
      if (!num(value, 'total_duration')) bad('needs total_duration');
      break;
    case 'error':
      if (typeof value.message !== 'string') bad('needs message');
      if (typeof value.fatal !== 'boolean') value.fatal = true;
      if (value.index === undefined) value.index = null;
      if (typeof value.code !== 'string') value.code = 'internal_error';
      break;
    case 'queued':
      if (!num(value, 'position')) value.position = 0;
      break;
    default:
      break;
  }
  return value as unknown as TtsEvent;
}
