/**
 * Regression tests for StreamPlayer state-machine bugs found in verification:
 * underrun + pause deadlock, seek-after-end, near seek while paused, pending seeks that can never
 * resolve, play()/stop() races, iOS seek-before-ready, and highlight jumps while stalled.
 */
import { TamberClient, planChunks } from '@tamber/client';

import { withAbortSignal } from '@/api/fetch';
import { StreamPlayer, type AudioSessionLike, type SynthesisOptions } from '@/player/StreamPlayer';
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
const DONE = { type: 'done', total_duration: 6, chunks_sent: 6, chunks_failed: 0, elapsed_ms: 1 };

function setup(session?: AudioSessionLike) {
  const { fetch, calls } = createStreamingFetch();
  const playlist = new FakePlaylist();
  const state: Partial<PlayerSnapshot> = {};
  const player = new StreamPlayer({
    playlist,
    files: new MemoryChunkFiles(),
    getClient: (signal) =>
      new TamberClient({ baseUrl: 'https://tts.example.com', fetch: withAbortSignal(fetch, signal) }),
    session,
    onUpdate: (patch) => Object.assign(state, patch),
    onToast: () => undefined,
  });
  player.load(TEXT, { title: 'Test', request: REQUEST });
  return { player, playlist, state, calls };
}

async function started(chunks: number) {
  const ctx = setup();
  await ctx.player.play();
  await flush();
  const s = ctx.calls[0]!.stream;
  s.pushLine(startEvent(TEXT, 'sentence'));
  for (const span of PLAN.slice(0, chunks)) s.pushLine(chunkEvent(TEXT, span, 1));
  await flush();
  return { ...ctx, s };
}

describe('StreamPlayer regressions', () => {
  it('resumes with a chunk that arrived while paused during an underrun', async () => {
    const { player, playlist, state, s } = await started(1);
    // The only queued chunk played out: underrun.
    playlist.currentTime = 1;
    playlist.playing = false;
    player.sample();
    expect(state.status).toBe('buffering');
    player.pause();
    s.pushLine(chunkEvent(TEXT, PLAN[1]!, 1));
    await flush();
    expect(playlist.playing).toBe(false); // the user paused: stay paused
    await player.play();
    expect(state.status).toBe('playing'); // previously stuck in 'buffering' forever
    expect(playlist.playing).toBe(true);
    expect(playlist.currentIndex).toBe(1);
  });

  it('continues from a word tapped after the end instead of restarting', async () => {
    const { player, playlist, state, s } = await started(6);
    s.pushLine(DONE);
    s.end();
    await flush();
    playlist.currentIndex = 5;
    playlist.currentTime = 1;
    playlist.playing = false;
    player.sample();
    expect(state.status).toBe('ended');

    player.seekToChar(TEXT.indexOf('crowd')); // 4th word of chunk 2
    await flush();
    expect(state.status).toBe('paused');
    expect(playlist.playing).toBe(false);
    await player.play();
    await flush();
    expect(playlist.currentIndex).toBe(2);
    expect(playlist.currentTime).toBeCloseTo(0.6, 2);
    expect(playlist.playing).toBe(true);
  });

  it('keeps a paused player paused when tapping a word that is about to arrive', async () => {
    const { player, playlist, state, s } = await started(1);
    player.pause();
    player.seekToChar(PLAN[2]!.char_start);
    expect(state.status).toBe('paused');
    s.pushLine(chunkEvent(TEXT, PLAN[1]!, 1));
    s.pushLine(chunkEvent(TEXT, PLAN[2]!, 1));
    await flush();
    expect(playlist.currentIndex).toBe(2);
    expect(playlist.playing).toBe(false);
    expect(state.status).toBe('paused');
    await player.play();
    expect(playlist.playing).toBe(true);
    expect(playlist.currentIndex).toBe(2);
  });

  it('finishes when a pending seek target fails and nothing after it is playable', async () => {
    const { player, state, s } = await started(4);
    player.seekToChar(PLAN[5]!.char_start); // one chunk beyond the stream position: wait for it
    expect(state.status).toBe('buffering');
    s.pushLine(chunkEvent(TEXT, PLAN[4]!, 1));
    s.pushLine({ type: 'error', code: 'synthesis_failed', message: 'nope', index: 5, fatal: false });
    s.pushLine({ ...DONE, chunks_sent: 5, chunks_failed: 1 });
    s.end();
    await flush();
    expect(state.status).toBe('ended');
  });

  it('finishes when the stream ends without delivering a pending seek target', async () => {
    const { player, state, s } = await started(1);
    player.seekToChar(PLAN[2]!.char_start);
    expect(state.status).toBe('buffering');
    s.end(); // connection cut: no chunk 1/2, no done
    await flush();
    expect(state.status).toBe('ended');
  });

  it('does not start streaming when stop() lands while the audio session is being prepared', async () => {
    let releasePrepare: () => void = () => undefined;
    const session: AudioSessionLike = {
      prepare: jest.fn(() => new Promise<void>((resolve) => (releasePrepare = resolve))),
      activate: jest.fn(),
      setPlaying: jest.fn(),
      deactivate: jest.fn(),
    };
    const { player, state, calls } = setup(session);
    const pending = player.play();
    player.stop();
    releasePrepare();
    await pending;
    await flush();
    expect(calls).toHaveLength(0);
    expect(state.status).toBe('idle');
  });

  it('never seeks for a chunk start, and seeks inside a track only once it is loaded (iOS)', async () => {
    const { player, playlist } = await started(3);
    playlist.unloadOnSkip = true;

    player.next(); // chunk 1 from its start: skipTo alone
    expect(playlist.currentIndex).toBe(1);
    expect(playlist.seeks).toHaveLength(0);
    expect(playlist.playing).toBe(true);

    player.seekToChar(TEXT.indexOf('crowd')); // chunk 2, 0.6 s in
    expect(playlist.currentIndex).toBe(2);
    await flush();
    expect(playlist.seeks).toHaveLength(0); // the fresh item is not readyToPlay yet
    expect(playlist.playing).toBe(false); // held until the seek lands

    playlist.isLoaded = true;
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    expect(playlist.seeks).toEqual([{ seconds: 0.6, loaded: true }]);
    expect(playlist.currentTime).toBeCloseTo(0.6, 2);
    expect(playlist.playing).toBe(true);
  });

  it('keeps the highlight in place while the queue has run dry', async () => {
    const { player, playlist, state } = await started(1);
    playlist.currentTime = 0.95; // in the trailing pause: last word ("step.") held
    playlist.playing = false; // ...and the queue just ran dry
    player.sample();
    expect(state.status).toBe('buffering');
    expect(state.activeWord).toBe(2);
    // iOS: an exhausted AVQueuePlayer has no current item and reports currentTime 0.
    playlist.currentTime = 0;
    player.sample();
    expect(state.activeWord).toBe(2);
    expect(state.activeChunk).toBe(0);
  });
});
