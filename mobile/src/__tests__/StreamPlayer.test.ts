import { TamberClient, planChunks } from '@tamber/client';

import { withAbortSignal } from '@/api/fetch';
import { StreamPlayer, type SynthesisOptions } from '@/player/StreamPlayer';
import type { PlayerSnapshot } from '@/store/playback';

import {
  FakePlaylist,
  MemoryChunkFiles,
  chunkEvent,
  createStreamingFetch,
  flush,
  startEvent,
} from './helpers/fakeServer';

const TEXT = 'One small step. Two more words here. Three is a crowd. Four on the floor. Five alive now. Six picks up sticks.';
const REQUEST: SynthesisOptions = { voice: 'af_heart', speed: 1, format: 'wav', lang: null, chunk_mode: 'sentence' };
const PLAN = planChunks(TEXT, { mode: 'sentence' });

function setup() {
  const { fetch, calls } = createStreamingFetch();
  const makeClient = (signal: AbortSignal) =>
    new TamberClient({
      baseUrl: 'https://tts.example.com',
      apiKey: 'secret',
      fetch: withAbortSignal(fetch, signal),
      headers: { 'Accept-Encoding': 'identity' },
    });
  const playlist = new FakePlaylist();
  const files = new MemoryChunkFiles();
  const state: Partial<PlayerSnapshot> = {};
  const toasts: string[] = [];
  const session = {
    prepare: jest.fn(async () => undefined),
    activate: jest.fn(),
    setPlaying: jest.fn(),
    deactivate: jest.fn(),
  };
  const player = new StreamPlayer({
    playlist,
    files,
    getClient: makeClient,
    session,
    onUpdate: (patch) => Object.assign(state, patch),
    onToast: (m) => toasts.push(m),
  });
  player.load(TEXT, { title: 'Test', request: REQUEST });
  return { player, playlist, files, state, calls, toasts, session };
}

describe('StreamPlayer', () => {
  it('has a six-chunk sentence plan for the fixture text', () => {
    expect(PLAN).toHaveLength(6);
  });

  it('writes one file per chunk and adds them to the playlist in order', async () => {
    const { player, playlist, files, state, calls, session } = setup();
    await player.play();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://tts.example.com/v1/tts');
    expect(calls[0]!.headers['Accept-Encoding']).toBe('identity');
    expect(calls[0]!.headers.Authorization).toBe('Bearer secret');
    expect(calls[0]!.body).toMatchObject({ text: TEXT, voice: 'af_heart', start_chunk: 0, stream: true, chunk_mode: 'sentence' });
    expect(session.prepare).toHaveBeenCalled();
    expect(session.activate).toHaveBeenCalledWith({ title: 'Test', artist: 'Tamber', albumTitle: 'af_heart' });

    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    s.pushLine({ type: 'queued', position: 2 });
    await flush();
    expect(state.status).toBe('queued');
    expect(state.queuePosition).toBe(2);

    for (const span of PLAN) s.pushLine(chunkEvent(TEXT, span));
    s.pushLine({ type: 'done', total_duration: 6, chunks_sent: 6, chunks_failed: 0, elapsed_ms: 10 });
    s.end();
    await flush();

    expect(files.writes.map((w) => w.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(files.writes.every((w) => w.requestId === 'req-0' && w.format === 'wav')).toBe(true);
    expect(playlist.sources).toEqual(PLAN.map((c) => `file:///cache/tamber/req-0/${c.index}.wav`));
    expect(playlist.playing).toBe(true);
    expect(state.status).toBe('playing');
    expect(state.received).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.keys(state.chunkWords ?? {})).toHaveLength(6);
  });

  it('aborts the request and clears playlist and cache on stop', async () => {
    const { player, playlist, files, state, calls, session } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    s.pushLine(chunkEvent(TEXT, PLAN[0]!));
    await flush();
    expect(playlist.sources).toHaveLength(1);

    player.stop();
    await flush();
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(playlist.sources).toHaveLength(0);
    expect(playlist.playing).toBe(false);
    expect(files.removed).toEqual([['req-0']]);
    expect(state.status).toBe('idle');
    expect(session.deactivate).toHaveBeenCalled();
  });

  it('re-requests with start_chunk when seeking far beyond what has arrived', async () => {
    const { player, playlist, calls } = setup();
    await player.play();
    await flush();
    calls[0]!.stream.pushLine(startEvent(TEXT, 'sentence'));
    calls[0]!.stream.pushLine(chunkEvent(TEXT, PLAN[0]!));
    await flush();

    // Tap a word in the last sentence: 4 chunks beyond the stream position.
    const target = PLAN[5]!;
    player.seekToChar(target.char_start + 5);
    await flush();

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.start_chunk).toBe(5);
    expect(playlist.sources).toHaveLength(0);

    const s2 = calls[1]!.stream;
    s2.pushLine(startEvent(TEXT, 'sentence', 5));
    s2.pushLine(chunkEvent(TEXT, target));
    await flush();
    expect(playlist.sources).toEqual(['file:///cache/tamber/req-5/5.wav']);
    expect(playlist.playing).toBe(true);
    // The tapped word ("picks") starts after the first word of the chunk.
    expect(playlist.currentTime).toBeGreaterThan(0);
  });

  it('waits for a chunk that is at most two chunks ahead instead of re-requesting', async () => {
    const { player, playlist, calls, state } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    s.pushLine(chunkEvent(TEXT, PLAN[0]!));
    await flush();

    player.seekToChar(PLAN[2]!.char_start);
    expect(state.status).toBe('buffering');
    s.pushLine(chunkEvent(TEXT, PLAN[1]!));
    s.pushLine(chunkEvent(TEXT, PLAN[2]!));
    await flush();

    expect(calls).toHaveLength(1);
    expect(playlist.currentIndex).toBe(2);
    expect(playlist.playing).toBe(true);
    expect(state.status).toBe('playing');
  });

  it('seeks within received audio with skipTo + seekTo', async () => {
    const { player, playlist, calls } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    for (const span of PLAN.slice(0, 3)) s.pushLine(chunkEvent(TEXT, span));
    await flush();

    const word = TEXT.indexOf('crowd');
    player.seekToChar(word);
    await flush();
    expect(playlist.currentIndex).toBe(2);
    expect(playlist.currentTime).toBeCloseTo(0.6, 2); // 4th of 4 words, 0.2 s each
    expect(calls).toHaveLength(1);
  });

  it('shows non-fatal chunk errors as toasts and keeps playing', async () => {
    const { player, playlist, calls, toasts, state } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    s.pushLine(chunkEvent(TEXT, PLAN[0]!));
    s.pushLine({ type: 'error', code: 'synthesis_failed', message: 'nope', index: 1, fatal: false });
    s.pushLine(chunkEvent(TEXT, PLAN[2]!));
    await flush();
    expect(toasts[0]).toMatch(/part 2/);
    expect(state.failed).toEqual([1]);
    expect(playlist.sources).toHaveLength(2);
    expect(playlist.playing).toBe(true);
  });

  it('restarts from the current chunk when the speed changes', async () => {
    const { player, calls } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    s.pushLine(chunkEvent(TEXT, PLAN[0]!));
    s.pushLine(chunkEvent(TEXT, PLAN[1]!));
    await flush();
    player.seekToChar(PLAN[1]!.char_start);
    player.updateRequest({ speed: 1.5 });
    await flush();
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ speed: 1.5, start_chunk: 1 });
  });
});

describe('playback clock -> word mapping', () => {
  it('maps playlist index + currentTime to the active chunk and word', async () => {
    const { player, playlist, calls, state } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    for (const span of PLAN.slice(0, 3)) s.pushLine(chunkEvent(TEXT, span, 1));
    await flush();

    // Chunk 1 ("Two more words here.") has 4 words of 0.2 s each.
    playlist.currentIndex = 1;
    playlist.currentTime = 0.45;
    const sample = player.sample();
    expect(sample).toEqual({ clock: 1.45, chunkIndex: 1, wordIndex: 2 });
    expect(state.activeChunk).toBe(1);
    expect(state.activeWord).toBe(2);
    const words = state.chunkWords?.[1];
    expect(words?.[2]?.text).toBe('words');

    // In the trailing pause of chunk 2 the last word stays active (no flicker).
    playlist.currentIndex = 2;
    playlist.currentTime = 0.95;
    expect(player.sample()?.wordIndex).toBe(3);
  });

  it('highlights only the chunk when word timestamps are off', async () => {
    const { player, playlist, calls, state } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence', 0, false));
    s.pushLine(chunkEvent(TEXT, PLAN[0]!, 1, false));
    await flush();
    playlist.currentTime = 0.5;
    expect(player.sample()).toEqual({ clock: 0.5, chunkIndex: 0, wordIndex: -1 });
    expect(state.wordTimestamps).toBe(false);
    expect(state.activeChunk).toBe(0);
  });

  it('detects the end of the stream and finishes', async () => {
    const { player, playlist, calls, state, session } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    for (const span of PLAN) s.pushLine(chunkEvent(TEXT, span, 1));
    s.pushLine({ type: 'done', total_duration: 6, chunks_sent: 6, chunks_failed: 0, elapsed_ms: 1 });
    s.end();
    await flush();
    playlist.currentIndex = 5;
    playlist.currentTime = 1;
    playlist.playing = false;
    player.sample();
    expect(state.status).toBe('ended');
    expect(session.setPlaying).toHaveBeenLastCalledWith(false);
  });

  it('resumes after an underrun when the next chunk arrives', async () => {
    const { player, playlist, calls, state } = setup();
    await player.play();
    await flush();
    const s = calls[0]!.stream;
    s.pushLine(startEvent(TEXT, 'sentence'));
    s.pushLine(chunkEvent(TEXT, PLAN[0]!, 1));
    await flush();
    // Playback reached the end of the only queued chunk.
    playlist.currentTime = 1;
    playlist.playing = false;
    player.sample();
    expect(state.status).toBe('buffering');
    s.pushLine(chunkEvent(TEXT, PLAN[1]!, 1));
    await flush();
    expect(playlist.currentIndex).toBe(1);
    expect(playlist.playing).toBe(true);
    expect(state.status).toBe('playing');
  });
});
