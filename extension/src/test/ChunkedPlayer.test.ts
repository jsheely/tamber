import { beforeEach, describe, expect, it } from 'vitest';
import { TamberStreamError, createDefaultSettings, type TamberSettings } from '@tamber/client';
import {
  ChunkedPlayer,
  type AudioBufferLike,
  type ChunkedPlayerOptions,
  type Synthesize,
} from '../player/ChunkedPlayer';
import { buildEvents, createFakeSynthesize, FakeAudioContext, flush } from './fakes';

const TEXT = 'Hello world. This is Tamber. It reads text aloud.';

function settings(patch: Partial<TamberSettings> = {}): TamberSettings {
  return { ...createDefaultSettings(), apiBaseUrl: 'https://tts.example.com', ...patch };
}

function setup(options: Partial<ChunkedPlayerOptions> = {}) {
  const ctx = new FakeAudioContext();
  const fake = createFakeSynthesize();
  const player = new ChunkedPlayer({
    tickIntervalMs: 0,
    resumeTimeoutMs: 10_000,
    lookaheadChunks: 3,
    ...options,
    synthesize: fake.synthesize as unknown as Synthesize,
    createContext: () => ctx,
  });
  return { ctx, player, streams: fake.streams };
}

const DONE = {
  type: 'done',
  total_duration: 0,
  chunks_sent: 0,
  chunks_failed: 0,
  elapsed_ms: 1,
} as const;

function fatalError() {
  return new TamberStreamError({
    type: 'error',
    code: 'internal_error',
    message: 'The TTS engine crashed.',
    index: null,
    fatal: true,
  });
}

describe('ChunkedPlayer', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('schedules chunks back to back at cumulative start times (gapless)', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1.0, 1.5, 0.5]);
    expect(start.total_chunks).toBe(3);
    player.load({ text: TEXT, settings: settings() });
    expect(streams).toHaveLength(1);
    expect(streams[0]!.request.start_chunk).toBe(0);
    streams[0]!.push(start, ...chunks, {
      type: 'done',
      total_duration: 3,
      chunks_sent: 3,
      chunks_failed: 0,
      elapsed_ms: 10,
    });
    await flush();

    const started = ctx.sources.map((s) => s.started!);
    expect(started).toHaveLength(3);
    const t0 = started[0]!.when;
    expect(started[1]!.when).toBeCloseTo(t0 + 1.0, 6);
    expect(started[2]!.when).toBeCloseTo(t0 + 2.5, 6);
    expect(started.every((s) => s.offset === 0)).toBe(true);

    const state = player.getState();
    expect(state.plan).toEqual(start.chunks);
    expect(state.receivedChunks).toEqual([0, 1, 2]);
    expect(state.bufferedDuration).toBeCloseTo(3, 6);
  });

  it('derives the active chunk and word from the AudioContext clock', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1.0, 1.5, 0.5]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, ...chunks);
    await flush();
    const t0 = ctx.sources[0]!.started!.when;

    ctx.advance(t0 + 0.6); // chunk 0 ("Hello world."), second word
    player.tick();
    let s = player.getState();
    expect(s.status).toBe('playing');
    expect(s.activeChunk).toBe(0);
    expect(TEXT.slice(s.activeWord!.charStart, s.activeWord!.charEnd)).toBe('world.');

    ctx.advance(t0 + 1.0 + 1.2); // chunk 1 ("This is Tamber."), third word
    player.tick();
    s = player.getState();
    expect(s.activeChunk).toBe(1);
    expect(TEXT.slice(s.activeWord!.charStart, s.activeWord!.charEnd)).toBe('Tamber.');
    expect(s.position).toBeCloseTo(2.2, 3);
    expect(s.progress).toBeGreaterThan(0.3);
  });

  it('re-requests with start_chunk when seeking far ahead of the stream', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(
      ' ',
    );
    const { start, chunks } = buildEvents(text, Array(12).fill(1));
    const { player, streams } = env;
    player.load({ text, settings: settings() });
    streams[0]!.push(start, chunks[0]!, chunks[1]!);
    await flush();
    expect(player.getState().receivedChunks).toEqual([0, 1]);

    player.seekChunk(9);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(streams[1]!.request.start_chunk).toBe(9);
    expect(player.getState().activeChunk).toBe(9);

    streams[1]!.push({ ...start, start_chunk: 9 }, chunks[9]!);
    await flush();
    const { ctx } = env;
    const last = ctx.sources[ctx.sources.length - 1]!;
    expect(last.started).not.toBeNull();
    expect(player.getState().receivedChunks).toEqual([0, 1, 9]);
  });

  it('waits for a near chunk instead of re-requesting, and seeks inside received audio', async () => {
    const text = Array.from({ length: 6 }, (_, i) => `Line ${i + 1} is spoken now.`).join(' ');
    const { start, chunks } = buildEvents(text, Array(6).fill(2));
    const { ctx, player, streams } = env;
    player.load({ text, settings: settings() });
    streams[0]!.push(start, chunks[0]!, chunks[1]!, chunks[2]!);
    await flush();

    player.seekChunk(4); // cursor is 3: within farSeekChunks (2), so keep the stream
    expect(streams).toHaveLength(1);

    player.seekChunk(1); // already decoded: reschedule locally
    expect(streams).toHaveLength(1);
    const last = ctx.sources[ctx.sources.length - 1]!;
    expect(last.buffer?.duration).toBe(2);
    expect(player.getState().activeChunk).toBe(1);
  });

  it('seekToChar seeks to the word offset inside its chunk', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1.0, 1.5, 0.5]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, ...chunks);
    await flush();
    const offset = TEXT.indexOf('Tamber');
    const before = ctx.sources.length;
    player.seekToChar(offset);
    const node = ctx.sources[before]!;
    expect(node.started!.offset).toBeCloseTo(1.0, 3); // third of three words in a 1.5 s chunk
    expect(player.getState().activeWord).toEqual({ charStart: offset, charEnd: offset + 7 });
  });

  it('pause suspends the context, resume resumes it', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, ...chunks);
    await flush();
    ctx.advance(ctx.sources[0]!.started!.when + 0.2);
    player.tick();
    player.pause();
    expect(ctx.suspendCalls).toBe(1);
    expect(player.getState().status).toBe('paused');
    player.resume();
    expect(ctx.resumeCalls).toBeGreaterThan(0);
    await flush();
    player.tick();
    expect(player.getState().status).toBe('playing');
  });

  it('reports needs-gesture when the AudioContext cannot start', async () => {
    const ctx = new FakeAudioContext();
    ctx.state = 'suspended';
    ctx.resume = async () => {
      ctx.resumeCalls++; // autoplay blocked: stays suspended
    };
    const fake = createFakeSynthesize();
    const player = new ChunkedPlayer({
      synthesize: fake.synthesize as unknown as Synthesize,
      createContext: () => ctx,
      tickIntervalMs: 0,
    });
    player.load({ text: TEXT, settings: settings() });
    await flush();
    expect(ctx.resumeCalls).toBe(1);
    expect(player.getState().status).toBe('needs-gesture');
  });

  it('stop aborts the request and resets to idle', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, chunks[0]!);
    await flush();
    player.stop();
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(ctx.sources.every((s) => s.stopped || !s.started)).toBe(true);
    expect(player.getState().status).toBe('idle');
    expect(player.getState().text).toBe('');
  });

  it('speed change re-requests from the current chunk with the new speed', async () => {
    const { player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, ...chunks);
    await flush();
    player.seekChunk(1);
    player.setSpeed(1.5);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(streams[1]!.request).toMatchObject({ start_chunk: 1, speed: 1.5 });
    expect(player.getState().receivedChunks).toEqual([]);
  });

  it('skips a chunk after a non-fatal error and keeps playing', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(
      start,
      chunks[0]!,
      {
        type: 'error',
        code: 'synthesis_failed',
        message: 'Chunk 1 failed',
        index: 1,
        fatal: false,
      },
      chunks[2]!,
    );
    await flush();
    const scheduled = ctx.sources.filter((s) => s.started).map((s) => s.buffer!.duration);
    expect(scheduled).toHaveLength(2);
    expect(ctx.sources[1]!.started!.when).toBeCloseTo(ctx.sources[0]!.started!.when + 1, 6);
    expect(player.getState().notice).toContain('failed');
  });

  it('ends when the last chunk finished and the stream is done', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, ...chunks, {
      type: 'done',
      total_duration: 3,
      chunks_sent: 3,
      chunks_failed: 0,
      elapsed_ms: 1,
    });
    await flush();
    ctx.advance(10);
    player.tick();
    const s = player.getState();
    expect(s.ended).toBe(true);
    expect(s.status).toBe('idle');
    expect(s.progress).toBe(1);
  });

  it('surfaces a fatal stream error once the buffered audio has played', async () => {
    const { ctx, player, streams } = env;
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, { type: 'ping' }, chunks[0]!);
    await flush();
    streams[0]!.fail(
      new TamberStreamError({
        type: 'error',
        code: 'internal_error',
        message: 'The TTS engine crashed.',
        index: null,
        fatal: true,
      }),
    );
    await flush();
    ctx.advance(ctx.sources[0]!.started!.when + 0.5);
    player.tick();
    expect(player.getState().status).toBe('playing'); // chunk 0 is still audible
    ctx.advance(5);
    player.tick();
    const s = player.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('The TTS engine crashed.');
    expect(streams).toHaveLength(1); // no automatic retry loop after a fatal error
  });

  it('a clock tick while a chunk is decoding waits for it instead of re-requesting it', async () => {
    const { ctx, player, streams } = env;
    const pending: Array<() => void> = [];
    const decode = ctx.decodeAudioData.bind(ctx);
    ctx.decodeAudioData = (data: ArrayBuffer) =>
      new Promise<AudioBufferLike>((resolve, reject) => {
        pending.push(() => void decode(data).then(resolve, reject));
      });
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, chunks[0]!);
    await flush();
    expect(pending).toHaveLength(1); // chunk 0 is inside decodeAudioData
    player.tick();
    player.tick();
    expect(streams).toHaveLength(1);
    expect(streams[0]!.signal.aborted).toBe(false);
    pending.shift()!();
    await flush();
    expect(player.getState().receivedChunks).toEqual([0]);
    expect(ctx.sources.filter((s) => s.started)).toHaveLength(1);
  });

  it('stops the request once enough audio is buffered ahead and resumes it when it runs low', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(
      ' ',
    );
    const { start, chunks } = buildEvents(text, Array(12).fill(1));
    const { ctx, player, streams } = (env = setup({
      maxAheadSeconds: 5,
      refillAheadSeconds: 3.5,
    }));
    player.load({ text, settings: settings() });
    streams[0]!.push(start, ...chunks);
    await flush(20);
    // 3 chunks scheduled + 3 decoded = 6 s ahead > 5 s: the request was stopped after chunk 5.
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(player.getState().receivedChunks).toEqual([0, 1, 2, 3, 4, 5]);

    // Play on in real-time-ish steps; the lookahead window stays full (3 chunks) throughout.
    const t0 = ctx.sources[0]!.started!.when;
    for (let t = 0.25; t <= 2.5; t += 0.25) {
      ctx.advance(t0 + t);
      player.tick();
    }
    expect(streams).toHaveLength(1); // still >= 3.5 s ahead
    ctx.advance(t0 + 2.75); // 3.25 s ahead: below the refill mark
    player.tick();
    expect(streams).toHaveLength(2);
    expect(streams[1]!.request.start_chunk).toBe(6);
    streams[1]!.push({ ...start, start_chunk: 6 }, chunks[6]!);
    await flush();
    expect(player.getState().receivedChunks).toContain(6);
  });

  it('audio buffered far ahead (after a seek back) does not throttle the stream at the playhead', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i + 1} is here.`).join(
      ' ',
    );
    const { start, chunks } = buildEvents(text, Array(20).fill(1));
    const { player, streams } = (env = setup({ maxAheadSeconds: 5, refillAheadSeconds: 3.5 }));
    player.load({ text, settings: settings() });
    streams[0]!.push(start, chunks[0]!, chunks[1]!);
    await flush();
    player.seekChunk(10); // far ahead: new request from 10, stopped once 6 s are buffered
    streams[1]!.push({ ...start, start_chunk: 10 }, ...chunks.slice(10));
    await flush(20);
    expect(streams[1]!.signal.aborted).toBe(true);
    expect(player.getState().receivedChunks).toEqual([0, 1, 10, 11, 12, 13, 14, 15]);

    player.seekChunk(2); // back to audio that was never received
    expect(streams).toHaveLength(3);
    expect(streams[2]!.request.start_chunk).toBe(2);
    streams[2]!.push({ ...start, start_chunk: 2 }, chunks[2]!, chunks[3]!, chunks[4]!);
    await flush(10);
    // Only the gapless run from the playhead counts (chunks 2-4), not 10-15 further on.
    expect(streams[2]!.signal.aborted).toBe(false);
    expect(player.getState().receivedChunks).toEqual([0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15]);
  });

  it('keeps decoded audio within maxBufferedSeconds by dropping the farthest audio first', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i + 1} is here.`).join(
      ' ',
    );
    const { start, chunks } = buildEvents(text, Array(20).fill(1));
    const { player, streams } = (env = setup({ maxBufferedSeconds: 8, maxAheadSeconds: 4 }));
    player.load({ text, settings: settings() });
    streams[0]!.push(start, chunks[0]!);
    await flush();
    player.seekChunk(12);
    streams[1]!.push({ ...start, start_chunk: 12 }, ...chunks.slice(12));
    await flush(20);
    player.seekChunk(3);
    streams[2]!.push({ ...start, start_chunk: 3 }, ...chunks.slice(3, 9));
    await flush(20);
    player.tick();
    const received = player.getState().receivedChunks;
    expect(received.length).toBeLessThanOrEqual(8);
    expect(received).toContain(3); // the audio being played is kept
    expect(received).toContain(4);
  });

  it('plays decoded audio out after a fatal error, then Play retries from there', async () => {
    const { ctx, player, streams } = (env = setup({ lookaheadChunks: 1 }));
    const { start, chunks } = buildEvents(TEXT, [1, 1, 1]);
    player.load({ text: TEXT, settings: settings() });
    streams[0]!.push(start, chunks[0]!, chunks[1]!);
    await flush();
    streams[0]!.fail(fatalError());
    await flush();
    expect(ctx.sources.filter((s) => s.started)).toHaveLength(1); // lookahead 1

    ctx.advance(ctx.sources[0]!.started!.when + 1.01); // chunk 0 over: decoded chunk 1 follows
    player.tick();
    expect(ctx.sources.filter((s) => s.started)).toHaveLength(2);
    ctx.advance(ctx.sources[1]!.started!.when + 0.2);
    player.tick();
    expect(player.getState().status).toBe('playing');

    ctx.advance(10);
    player.tick();
    expect(player.getState().status).toBe('error');
    expect(streams).toHaveLength(1);

    player.toggle(); // the UI shows Play in the error state
    expect(streams).toHaveLength(2);
    expect(streams[1]!.request.start_chunk).toBe(2);
    expect(player.getState().error).toBeNull();
    expect(player.getState().status).not.toBe('paused');
    streams[1]!.push({ ...start, start_chunk: 2 }, chunks[2]!, DONE);
    await flush();
    const retried = ctx.sources[2]!;
    expect(retried.buffer?.duration).toBe(1);
    ctx.advance(retried.started!.when + 0.1);
    player.tick();
    expect(player.getState().status).toBe('playing');
    expect(player.getState().activeChunk).toBe(2);
  });
});
