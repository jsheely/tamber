/**
 * Opt-in integration test against a real Tamber server (normally the model-free fake engine):
 *
 *   # api/:  TAMBER_ENGINE=fake TAMBER_API_KEY=k .venv/Scripts/python -m uvicorn tamber_api.main:app --port 8880
 *   TAMBER_E2E_URL=http://127.0.0.1:8880 TAMBER_E2E_KEY=k pnpm --filter @tamber/extension test
 *
 * Skipped unless TAMBER_E2E_URL is set. It drives the extension's own createClient() and
 * ChunkedPlayer with real NDJSON and real WAV chunks; only the AudioContext is faked (it decodes
 * the WAV header to get the duration, and its clock is advanced by hand).
 */
import { describe, expect, it } from 'vitest';
import { createDefaultSettings, TamberApiError, type TamberSettings } from '@tamber/client';
import { createClient, describeError } from '../lib/client';
import { ChunkedPlayer, type AudioBufferLike, type Synthesize } from '../player/ChunkedPlayer';
import { FakeAudioContext, flush } from './fakes';

const URL_ = process.env.TAMBER_E2E_URL ?? '';
const KEY = process.env.TAMBER_E2E_KEY ?? '';

/** Duration of a canonical PCM s16 WAV (API.md section 7.1), validating the header. */
function wavDuration(data: ArrayBuffer): number {
  const v = new DataView(data);
  const tag = (o: number) => String.fromCharCode(...new Uint8Array(data, o, 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') {
    throw new Error('EncodingError: not a canonical WAV');
  }
  const channels = v.getUint16(22, true);
  const rate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  const size = v.getUint32(40, true);
  expect(v.getUint32(4, true)).toBe(data.byteLength - 8); // RIFF size is exact
  expect(size).toBe(data.byteLength - 44);
  return size / ((bits / 8) * channels) / rate;
}

class WavAudioContext extends FakeAudioContext {
  override async decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    return { duration: wavDuration(data) };
  }
}

const settings = (patch: Partial<TamberSettings> = {}): TamberSettings => ({
  ...createDefaultSettings(),
  apiBaseUrl: URL_,
  apiKey: KEY,
  ...patch,
});

const TEXT =
  'Tamber reads text aloud. Each sentence is its own chunk!\n\n' +
  'Offsets index the “original” text, emoji 🙂 included. The last sentence ends here.';

function makePlayer(s: TamberSettings) {
  const ctx = new WavAudioContext();
  const synthesize: Synthesize = (st, request, signal) =>
    createClient(st).synthesize(request, { signal });
  const player = new ChunkedPlayer({
    synthesize,
    createContext: () => ctx,
    tickIntervalMs: 0,
    resumeTimeoutMs: 10_000,
  });
  return { ctx, player, s };
}

async function waitFor(cond: () => boolean, ms = 15_000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await flush(2);
  }
}

describe.skipIf(!URL_)('live Tamber server', () => {
  it('Test connection reports reachable + key accepted, and a wrong key as an auth failure', async () => {
    const ok = await createClient(settings()).testConnection();
    expect(ok.ok).toBe(true);
    expect(ok.authOk).toBe(true);
    expect(ok.compatible).toBe(true);
    expect(ok.voiceCount).toBeGreaterThan(0);
    if (ok.health?.auth_required) {
      const bad = await createClient(settings({ apiKey: 'wrong' })).testConnection();
      expect(bad.ok).toBe(false);
      expect(bad.health).not.toBeNull();
      expect(bad.authOk).toBe(false);
      expect(describeError(bad.error)).toContain('API key');
    }
  });

  it('plays the real NDJSON stream gaplessly with server word timings and offsets', async () => {
    const { ctx, player, s } = makePlayer(settings({ chunkMode: 'sentence' }));
    const words: Array<[number, number]> = [];
    player.subscribe((e) => {
      if (e.type === 'chunk') words.push(...e.chunk.words);
    });
    player.load({ text: TEXT, settings: s });
    await waitFor(() => player.getState().streamDone || player.getState().error !== null);
    const st = player.getState();
    expect(st.error).toBeNull();
    expect(st.totalChunks).toBe(4);
    expect(st.receivedChunks).toEqual([0, 1, 2, 3]);
    // Every plan span and word span indexes the exact text we sent (UTF-16, trimmed).
    for (const c of st.plan) {
      const span = TEXT.slice(c.char_start, c.char_end);
      expect(span).toBe(span.trim());
    }
    expect(words.length).toBeGreaterThan(10);
    for (const [a, b] of words) {
      expect(b).toBeGreaterThan(a);
      expect(/\s/.test(TEXT.slice(a, b))).toBe(false);
    }
    // Back-to-back scheduling on the AudioContext clock.
    const started = ctx.sources.filter((x) => x.started);
    for (let i = 1; i < started.length; i++) {
      const prev = started[i - 1]!;
      expect(started[i]!.started!.when).toBeCloseTo(prev.started!.when + prev.buffer!.duration, 6);
    }
    // The highlight follows the clock through the text.
    const seen = new Set<string>();
    const t0 = started[0]!.started!.when;
    for (let t = 0; t < st.bufferedDuration + 1; t += 0.1) {
      ctx.advance(t0 + t);
      player.tick();
      const w = player.getState().activeWord;
      if (w) seen.add(TEXT.slice(w.charStart, w.charEnd));
    }
    expect(seen.has('Tamber')).toBe(true);
    // The word after the astral emoji: only correct if offsets are UTF-16 code units.
    expect(seen.has('included')).toBe(true);
    expect(words).toContainEqual([TEXT.indexOf('included'), TEXT.indexOf('included') + 8]);
    expect(seen.has('here')).toBe(true);
    expect(player.getState().ended).toBe(true);
    await player.dispose();
  });

  it('seeking far ahead re-requests with start_chunk and keeps plan offsets', async () => {
    const long = Array.from({ length: 10 }, (_, i) => `This is sentence number ${i + 1}.`).join(' ');
    const { player, s } = makePlayer(settings({ chunkMode: 'sentence' }));
    player.load({ text: long, settings: s });
    await waitFor(() => player.getState().receivedChunks.length >= 1);
    player.seekChunk(8);
    await waitFor(() => player.getState().receivedChunks.includes(9));
    const st = player.getState();
    expect(st.error).toBeNull();
    expect(st.plan).toHaveLength(10);
    expect(st.receivedChunks).toContain(8);
    await player.dispose();
  });

  it('a rejected API key surfaces as a readable error state', async () => {
    const health = await createClient(settings()).health();
    if (!health.auth_required) return;
    const { player, s } = makePlayer(settings({ apiKey: 'wrong' }));
    player.load({ text: 'Hello there.', settings: s });
    await waitFor(() => player.getState().error !== null);
    expect(player.getState().status).toBe('error');
    expect(player.getState().error).toContain('API key');
    await expect(
      createClient(settings({ apiKey: 'wrong' })).getVoices(),
    ).rejects.toBeInstanceOf(TamberApiError);
    await player.dispose();
  });
});
