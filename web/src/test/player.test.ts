import { TamberTimeoutError, wordIndexAt } from '@tamber/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playPause } from '../player/actions';
import {
  ChunkedPlayer,
  LOOKAHEAD_CHUNKS,
  STREAM_IDLE_TIMEOUT_MS,
  type PlayerEvent,
  type PlayRequest,
} from '../player/ChunkedPlayer';
import { setPlayer } from '../player/instance';
import { noopAnchor, type AudioAnchor } from '../player/silentAnchor';
import {
  chunkEvent,
  createFakeFetch,
  FakeAudioContext,
  flush,
  makeWav,
  SAMPLE_TEXT,
  samplePlan,
  startEvent,
} from './fakes';

const request = (text = SAMPLE_TEXT): PlayRequest => ({
  text,
  voice: 'af_heart',
  speed: 1,
  format: 'wav',
  chunkMode: 'sentence',
  lang: null,
});

function setup(anchor: AudioAnchor = noopAnchor) {
  const ctx = new FakeAudioContext();
  const player = new ChunkedPlayer({ createContext: () => ctx.asAudioContext(), anchor });
  const net = createFakeFetch();
  const events: PlayerEvent[] = [];
  player.on((e) => events.push(e));
  return { ctx, player, net, events };
}

const DURATIONS = [1.25, 0.8, 2.1, 1.5, 0.9];

afterEach(() => {
  delete (navigator as Navigator & { audioSession?: unknown }).audioSession;
});

describe('ChunkedPlayer', () => {
  it('unlock() is synchronous: audio session, context resume and anchor, before any await', () => {
    const session = { type: 'auto' };
    Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
    const anchor = { start: vi.fn(), pause: vi.fn(), dispose: vi.fn() };
    const { ctx, player } = setup(anchor);

    const result = player.unlock();

    expect(result).toBeUndefined(); // not a promise: nothing to await
    expect(session.type).toBe('playback');
    expect(player.context).toBe(ctx);
    expect(ctx.resumeCalls).toBe(1);
    expect(anchor.start).toHaveBeenCalledTimes(1);
  });

  it('schedules chunks back to back: start(when) values follow the cumulative durations', async () => {
    const { ctx, player, net } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    for (let i = 0; i < 3; i++) stream.push(chunkEvent(SAMPLE_TEXT, plan[i]!, DURATIONS[i]!));
    await vi.waitFor(() => expect(ctx.live.length).toBe(3));

    const whens = ctx.live.map((s) => s.when);
    expect(whens[1]! - whens[0]!).toBeCloseTo(DURATIONS[0]!, 6);
    expect(whens[2]! - whens[0]!).toBeCloseTo(DURATIONS[0]! + DURATIONS[1]!, 6);
    expect(ctx.live.every((s) => s.offset === 0)).toBe(true);
    expect(player.getSnapshot().status).toBe('playing');
  });

  it('advances the timeline with decoded durations and keeps at most LOOKAHEAD chunks scheduled', async () => {
    const { ctx, player, net } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    plan.forEach((span, i) => stream.push(chunkEvent(SAMPLE_TEXT, span, DURATIONS[i]!)));
    stream.push({ type: 'done', total_duration: 6.55, chunks_sent: 5, chunks_failed: 0, elapsed_ms: 10 });
    await vi.waitFor(() => expect(ctx.live.length).toBe(LOOKAHEAD_CHUNKS));

    const frame = player.getFrame();
    expect(frame.timeline?.chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(frame.timeline?.duration).toBeCloseTo(DURATIONS[0]! + DURATIONS[1]! + DURATIONS[2]!, 6);

    // Play into chunk 1: the first node ends, the 4th chunk gets scheduled right after chunk 2.
    const first = ctx.live[0]!;
    ctx.advance(first.end + 0.3);
    await vi.waitFor(() => expect(ctx.sources.filter((s) => s.started).length).toBe(4));
    const f2 = player.getFrame();
    expect(f2.activeChunk).toBe(1);
    expect(f2.timeline?.chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    const fourth = ctx.sources[3]!;
    expect(fourth.when).toBeCloseTo(ctx.sources[2]!.end, 6);
    // The clock maps onto a word of chunk 1.
    const wi = wordIndexAt(f2.timeline!, f2.t);
    expect(f2.timeline!.words[wi]!.chunkIndex).toBe(1);

    // Play to the end.
    for (let i = 0; i < 10; i++) {
      ctx.advance(3);
      await flush(2);
    }
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('ended'));
    expect(player.getSnapshot().canSave).toBe(true);
    const wav = player.buildWav();
    expect(wav).not.toBeNull();
    // 44-byte header + all PCM samples.
    const total = DURATIONS.reduce((a, b) => a + b, 0);
    expect(wav!.length).toBe(44 + Math.round(total * 24000) * 2);
  });

  it('skips a chunk on a non-fatal error event and keeps playing gaplessly', async () => {
    const { ctx, player, net, events } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    stream.push(chunkEvent(SAMPLE_TEXT, plan[0]!, 1));
    stream.push({ type: 'error', code: 'synthesis_failed', message: 'Chunk 1 failed', index: 1, fatal: false });
    stream.push(chunkEvent(SAMPLE_TEXT, plan[2]!, 1.5));
    await vi.waitFor(() => expect(ctx.live.length).toBe(2));

    expect(ctx.live[1]!.when - ctx.live[0]!.when).toBeCloseTo(1, 6);
    expect(player.getFrame().timeline?.chunks.map((c) => c.index)).toEqual([0, 2]);
    expect(events.some((e) => e.type === 'chunk-error' && e.index === 1)).toBe(true);
    const snap = player.getSnapshot();
    expect(snap.chunkStates[1]).toBe('failed');
    expect(snap.failedCount).toBe(1);
    expect(snap.status).toBe('playing');
  });

  it('stop() aborts the fetch and stops scheduled audio', async () => {
    const { ctx, player, net } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const req = net.ttsRequests()[0]!;
    req.stream.push(startEvent(SAMPLE_TEXT, plan));
    req.stream.push(chunkEvent(SAMPLE_TEXT, plan[0]!, 1));
    await vi.waitFor(() => expect(ctx.live.length).toBe(1));

    player.stop();

    expect(req.signal?.aborted).toBe(true);
    expect(req.stream.aborted).toBe(true);
    expect(ctx.live.length).toBe(0);
    expect(player.getSnapshot().status).toBe('idle');
    await flush();
    expect(player.getSnapshot().error).toBeNull(); // AbortError is silent
  });

  it('seeking beyond what was received aborts and re-requests with start_chunk', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
    const plan = samplePlan(text);
    expect(plan.length).toBe(12);
    const { ctx, player, net } = setup();
    player.unlock();
    player.play(request(text), { client: net.client });
    await flush();
    const first = net.ttsRequests()[0]!;
    first.stream.push(startEvent(text, plan));
    first.stream.push(chunkEvent(text, plan[0]!, 1));
    first.stream.push(chunkEvent(text, plan[1]!, 1));
    await vi.waitFor(() => expect(ctx.live.length).toBe(2));

    player.seekToChunk(9);
    await flush();

    expect(first.signal?.aborted).toBe(true);
    const second = net.ttsRequests()[1]!;
    expect(second.body?.start_chunk).toBe(9);
    expect(second.body?.text).toBe(text);
    expect(ctx.live.length).toBe(0);

    second.stream.push(startEvent(text, plan, { start_chunk: 9 }));
    second.stream.push(chunkEvent(text, plan[9]!, 1.2));
    await vi.waitFor(() => expect(ctx.live.length).toBe(1));
    expect(player.getFrame().activeChunk).toBe(9);
    expect(player.getFrame().timeline?.chunks[0]?.index).toBe(9);
  });

  it('seeking to a chunk that is about to arrive waits for the running stream', async () => {
    const text = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} ends now.`).join(' ');
    const plan = samplePlan(text);
    const { ctx, player, net } = setup();
    player.unlock();
    player.play(request(text), { client: net.client });
    await flush();
    const first = net.ttsRequests()[0]!;
    first.stream.push(startEvent(text, plan));
    first.stream.push(chunkEvent(text, plan[0]!, 1));
    await vi.waitFor(() => expect(ctx.live.length).toBe(1));

    player.seekToChunk(2); // next expected is 1, so 2 is within reach
    await flush();
    expect(net.ttsRequests().length).toBe(1);
    first.stream.push(chunkEvent(text, plan[1]!, 1));
    first.stream.push(chunkEvent(text, plan[2]!, 1));
    await vi.waitFor(() => expect(ctx.live.length).toBe(1));
    expect(ctx.live[0]!.buffer?.duration).toBe(1);
    expect(player.getFrame().activeChunk).toBe(2);
  });

  it('seeks within a chunk with start(when, offset) and pauses with ctx.suspend()', async () => {
    const { ctx, player, net } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    stream.push(chunkEvent(SAMPLE_TEXT, plan[0]!, 2));
    stream.push(chunkEvent(SAMPLE_TEXT, plan[1]!, 2));
    await vi.waitFor(() => expect(ctx.live.length).toBe(2));

    player.seekToChunk(1, 0.75);
    await vi.waitFor(() => expect(ctx.live.length).toBe(1));
    expect(ctx.live[0]!.offset).toBeCloseTo(0.75, 6);

    player.pause();
    expect(ctx.suspendCalls).toBe(1);
    expect(player.getSnapshot().status).toBe('paused');
    player.resume();
    expect(ctx.state).toBe('running');
    expect(player.getSnapshot().status).toBe('playing');
  });

  it('asks for a gesture when the OS interrupts the context, instead of retrying', async () => {
    const { ctx, player, net } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    stream.push(chunkEvent(SAMPLE_TEXT, plan[0]!, 1));
    await vi.waitFor(() => expect(ctx.live.length).toBe(1));
    const resumes = ctx.resumeCalls;

    ctx.setState('interrupted');
    expect(player.getSnapshot().needsGesture).toBe(true);
    await flush();
    expect(ctx.resumeCalls).toBe(resumes); // no automatic resume

    player.resume(); // the "Tap to resume" gesture
    expect(ctx.resumeCalls).toBe(resumes + 1);
    expect(player.getSnapshot().needsGesture).toBe(false);
  });

  it('reports a fatal stream error and can retry from the current chunk', async () => {
    const { ctx, player, net, events } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    stream.push({ type: 'error', code: 'internal_error', message: 'Engine crashed', index: null, fatal: true });
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('error'));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(player.getSnapshot().error?.message).toBe('Engine crashed');

    player.retry();
    await flush();
    expect(net.ttsRequests().length).toBe(2);
    expect(player.getSnapshot().status).toBe('loading');
    expect(ctx.state).toBe('running');
  });

  it('changing speed during playback restarts synthesis at the current chunk', async () => {
    const { ctx, player, net } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const first = net.ttsRequests()[0]!;
    first.stream.push(startEvent(SAMPLE_TEXT, plan));
    first.stream.push(chunkEvent(SAMPLE_TEXT, plan[0]!, 1));
    first.stream.push(chunkEvent(SAMPLE_TEXT, plan[1]!, 1));
    await vi.waitFor(() => expect(ctx.live.length).toBe(2));
    ctx.advance(ctx.live[0]!.end + 0.2); // into chunk 1
    await flush();

    player.setSpeed(1.5);
    await flush();
    expect(first.signal?.aborted).toBe(true);
    const second = net.ttsRequests()[1]!;
    expect(second.body?.speed).toBe(1.5);
    expect(second.body?.start_chunk).toBe(1);
  });

  it('reuses held audio when the same request is played again', async () => {
    const { ctx, player, net } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    plan.forEach((span) => stream.push(chunkEvent(SAMPLE_TEXT, span, 0.5)));
    stream.push({ type: 'done', total_duration: 2.5, chunks_sent: 5, chunks_failed: 0, elapsed_ms: 1 });
    await vi.waitFor(() => expect(player.getSnapshot().complete).toBe(true));

    player.stop();
    player.play(request(), { client: net.client });
    await vi.waitFor(() => expect(ctx.live.length).toBe(LOOKAHEAD_CHUNKS));
    expect(net.ttsRequests().length).toBe(1);
  });

  it('pauses the download far ahead of the playhead and resumes it with start_chunk in time', async () => {
    const ctx = new FakeAudioContext();
    const player = new ChunkedPlayer({
      createContext: () => ctx.asAudioContext(),
      anchor: noopAnchor,
      lookahead: 2,
      maxAheadSeconds: 3.5,
      resumeAheadSeconds: 2.5,
    });
    const net = createFakeFetch();
    const plan = samplePlan();
    expect(plan).toHaveLength(5);
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const first = net.ttsRequests()[0]!;
    first.stream.push(startEvent(SAMPLE_TEXT, plan));
    for (const i of [0, 1, 2, 3]) first.stream.push(chunkEvent(SAMPLE_TEXT, plan[i]!, 1));
    await vi.waitFor(() => expect(player.getSnapshot().receivedCount).toBe(4));
    // 4 s held ahead > 3.5 s: the request is closed (the server frees its synthesis slot).
    expect(first.signal?.aborted).toBe(true);
    expect(player.getSnapshot().status).toBe('playing');
    expect(player.getSnapshot().error).toBeNull();

    ctx.advance(ctx.live[0]!.end - ctx.currentTime + 0.01); // chunk 0 done: 3 s ahead, keep waiting
    await flush();
    expect(net.ttsRequests()).toHaveLength(1);

    ctx.advance(ctx.live.find((n) => !n.endedFired)!.end - ctx.currentTime + 0.01); // chunk 1 done: 2 s ahead
    await flush();
    expect(net.ttsRequests()).toHaveLength(2);
    const second = net.ttsRequests()[1]!;
    expect(second.body?.start_chunk).toBe(4);
    second.stream.push(startEvent(SAMPLE_TEXT, plan, { start_chunk: 4 }));
    second.stream.push(chunkEvent(SAMPLE_TEXT, plan[4]!, 1));
    second.stream.push({ type: 'done', total_duration: 1, chunks_sent: 1, chunks_failed: 0, elapsed_ms: 1 });
    await vi.waitFor(() => expect(player.getSnapshot().complete).toBe(true));

    ctx.advance(ctx.live.find((n) => !n.endedFired)!.end - ctx.currentTime + 0.01); // chunk 2 done
    await flush();
    // Chunk 4 is scheduled exactly where chunk 3 ends: no gap from the paused download.
    const pending = ctx.sources.filter((n) => n.started && !n.stopped && !n.endedFired);
    expect(pending).toHaveLength(2);
    expect(pending[1]!.when).toBeCloseTo(pending[0]!.end, 9);
    expect(player.getSnapshot().error).toBeNull();
  });

  it('fails a stream that goes silent (no line, not even a ping) instead of loading forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { player, net, events } = setup();
      const plan = samplePlan();
      player.unlock();
      player.play(request(), { client: net.client });
      await vi.advanceTimersByTimeAsync(0);
      const req = net.ttsRequests()[0]!;
      req.stream.push(startEvent(SAMPLE_TEXT, plan));
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000);
      expect(player.getSnapshot().status).toBe('loading');
      req.stream.push({ type: 'ping' }); // server keep-alive re-arms the watchdog
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000);
      expect(player.getSnapshot().status).toBe('loading');
      expect(req.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(2000);
      expect(req.signal?.aborted).toBe(true);
      expect(player.getSnapshot().status).toBe('error');
      expect(player.getSnapshot().error?.error).toBeInstanceOf(TamberTimeoutError);
      expect(events.some((e) => e.type === 'error')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unexpected scheduling failure becomes a retryable error (no unhandled rejection)', async () => {
    const { ctx, player, net, events } = setup();
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const req = net.ttsRequests()[0]!;
    const original = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => {
      throw new DOMException('The context is closed', 'InvalidStateError');
    };
    req.stream.push(startEvent(SAMPLE_TEXT, plan));
    req.stream.push(chunkEvent(SAMPLE_TEXT, plan[0]!, 1));
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('error'));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(req.signal?.aborted).toBe(true);

    ctx.createBufferSource = original;
    player.retry();
    await vi.waitFor(() => expect(ctx.live.length).toBe(1)); // the held chunk 0 is reused
    expect(net.ttsRequests().length).toBe(2);
  });

  it('a stopped voice preview settles its promise, and a superseded decode never plays', async () => {
    const { ctx, player } = setup();
    player.unlock();
    player.beginPreview();
    const first = player.playClip(makeWav(1));
    await flush();
    expect(ctx.live.length).toBe(1);
    player.stopPreview();
    await expect(first).resolves.toBeUndefined();
    expect(ctx.live.length).toBe(0);

    // Two taps in a row: the first clip is still decoding when the second preview begins.
    player.beginPreview();
    const a = player.playClip(makeWav(0.5));
    player.beginPreview();
    const b = player.playClip(makeWav(0.75));
    await flush();
    await expect(a).resolves.toBeUndefined();
    expect(ctx.live.map((src) => src.buffer?.duration)).toEqual([0.75]);

    // Main playback stops the preview (and settles its promise).
    player.play(request(), { client: createFakeFetch().client });
    await expect(b).resolves.toBeUndefined();
    expect(ctx.live.length).toBe(0);
    player.stop();
  });
});

describe('playPause()', () => {
  afterEach(() => setPlayer(null));

  it('resumes (instead of pausing) when the OS interrupted audio while playing', async () => {
    const { ctx, player, net } = setup();
    setPlayer(player);
    const plan = samplePlan();
    player.unlock();
    player.play(request(), { client: net.client });
    await flush();
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(SAMPLE_TEXT, plan));
    stream.push(chunkEvent(SAMPLE_TEXT, plan[0]!, 1));
    await vi.waitFor(() => expect(ctx.live.length).toBe(1));

    ctx.setState('interrupted');
    expect(player.getSnapshot().status).toBe('playing');
    expect(player.getSnapshot().needsGesture).toBe(true);

    playPause(); // Space / the big button / lock screen: this tap is the resume gesture
    expect(ctx.state).toBe('running');
    expect(player.getSnapshot().needsGesture).toBe(false);
    expect(player.getSnapshot().status).toBe('playing');
    expect(ctx.suspendCalls).toBe(0);
  });
});
