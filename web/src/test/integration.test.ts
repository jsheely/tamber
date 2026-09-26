/**
 * Opt-in: runs the real ChunkedPlayer against a running Tamber API (fake engine is fine), over real
 * HTTP streaming. Skipped unless TAMBER_API_URL is set, e.g.
 *   TAMBER_API_URL=http://localhost:8880 npx vitest run src/test/integration.test.ts
 */
import { TamberClient, wordIndexAt } from '@tamber/client';
import { describe, expect, it, vi } from 'vitest';
import { ChunkedPlayer } from '../player/ChunkedPlayer';
import { noopAnchor } from '../player/silentAnchor';
import { FakeAudioContext } from './fakes';

const API = process.env.TAMBER_API_URL;

const TEXT =
  'Tamber streams one sentence at a time. Each line carries a complete audio file.\n\n' +
  'The browser decodes it and schedules it right after the previous one. ' +
  'Words are highlighted from the server timestamps. Seeking far ahead asks for a new stream.';

describe.skipIf(!API)('live API (TAMBER_API_URL)', () => {
  const client = new TamberClient({ baseUrl: API ?? '' });

  it('health and voices', async () => {
    const h = await client.health();
    expect(h.api_version).toBe(1);
    const v = await client.getVoices();
    expect(v.voices.length).toBeGreaterThan(0);
  });

  it('streams, schedules gaplessly, maps words onto the exact text and seeks with start_chunk', async () => {
    const ctx = new FakeAudioContext();
    const player = new ChunkedPlayer({ createContext: () => ctx.asAudioContext(), anchor: noopAnchor });
    player.unlock();
    player.play(
      { text: TEXT, voice: 'af_heart', speed: 1, format: 'wav', chunkMode: 'sentence', lang: null },
      { client },
    );
    await vi.waitFor(() => expect(ctx.live.length).toBe(3), { timeout: 20_000 });
    const snap = player.getSnapshot();
    expect(snap.totalChunks).toBe(5);
    expect(snap.wordTimestamps).toBe(true);
    const [a, b, c] = ctx.live;
    expect(b!.when - a!.when).toBeCloseTo(a!.buffer!.duration, 6);
    expect(c!.when - b!.when).toBeCloseTo(b!.buffer!.duration, 6);

    const frame = player.getFrame();
    for (const w of frame.timeline!.words) expect(TEXT.slice(w.charStart, w.charEnd)).toBe(w.text);
    ctx.advance(a!.end + 0.05);
    const f2 = player.getFrame();
    expect(f2.timeline!.words[wordIndexAt(f2.timeline!, f2.t)]?.chunkIndex).toBe(1);

    player.seekToChunk(4, 0);
    await vi.waitFor(() => expect(player.getFrame().timeline?.chunks[0]?.index).toBe(4), { timeout: 20_000 });
    player.stop();
  });
});
