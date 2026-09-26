/**
 * ChunkedPlayer: gapless Web Audio playback of Tamber's NDJSON stream (Chrome only; it runs in the
 * extension's offscreen document). Framework-free and dependency-injected so it can be unit tested
 * with a fake AudioContext and a fake NDJSON stream.
 *
 * Pipeline (docs/ARCHITECTURE.md section 5.3, docs/research/web-stack.md section 9):
 *   synthesize() -> chunk event -> base64ToBytes -> AudioContext.decodeAudioData -> AudioBuffer
 *   -> AudioBufferSourceNode.start(nextStartTime) (back to back, a small lookahead window)
 *   -> TimelineBuilder (absolute word times) -> wordIndexAt(timeline, clock) -> highlight.
 *
 * Every chunk is a complete, independently decodable audio file, so nothing here uses Media Source
 * Extensions. The clock is always AudioContext.currentTime.
 *
 * - Pause = ctx.suspend() (freezes the clock and every scheduled node). Resume = ctx.resume().
 * - Seek = stop the scheduled nodes and reschedule from the target chunk at an offset. When the
 *   target is not decoded and is more than `farSeekChunks` ahead of the stream (or behind it), the
 *   current request is aborted and a new one starts with `start_chunk = target`.
 * - Speed / voice change = re-request from the current chunk (durations change, so decoded audio
 *   is dropped).
 * - Memory: decoded buffers are bounded to ~`maxBufferedSeconds`; chunks well behind the playhead
 *   are evicted first (their timing metadata is kept, so the timeline stays stable). Ahead of the
 *   playhead, the request is stopped once `maxAheadSeconds` are decoded and re-issued with
 *   `start_chunk` when fewer than `refillAheadSeconds` remain.
 * - A fatal stream error lets already-decoded audio play out; Play then retries from there.
 */
import {
  base64ToBytes,
  chunkIndexForOffset,
  isAbortError,
  TimelineBuilder,
  ttsRequestFromSettings,
  wordIndexAt,
  wordIndexAtChar,
  type ChunkSpan,
  type TamberSettings,
  type Timeline,
  type TtsEvent,
  type TtsRequest,
  type WordTiming,
} from '@tamber/client';
import { describeError } from '../lib/client';
import {
  createIdleState,
  type CharSpan,
  type ChunkWords,
  type PlayerState,
  type PlayerStatus,
} from '../lib/messages';

// ---------------------------------------------------------------------------------------------
// Minimal Web Audio surface (the real AudioContext satisfies it; tests pass a fake)
// ---------------------------------------------------------------------------------------------

export interface AudioBufferLike {
  readonly duration: number;
}

export interface AudioParamLike {
  value: number;
  setTargetAtTime?(target: number, startTime: number, timeConstant: number): unknown;
}

export interface BufferSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: unknown): unknown;
  disconnect(): void;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export interface GainNodeLike {
  readonly gain: AudioParamLike;
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  onstatechange: (() => void) | null;
  createBufferSource(): BufferSourceLike;
  createGain(): GainNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

/** Wrap the browser's AudioContext in the structural interface above. */
export function createBrowserAudioContext(): AudioContextLike {
  const ctx = new AudioContext({ latencyHint: 'playback' });
  return ctx as unknown as AudioContextLike;
}

export type Synthesize = (
  settings: TamberSettings,
  request: TtsRequest,
  signal: AbortSignal,
) => AsyncIterable<TtsEvent>;

export interface ChunkedPlayerOptions {
  synthesize: Synthesize;
  createContext?: () => AudioContextLike;
  /** Decoded chunks scheduled ahead of the playhead (default 3). */
  lookaheadChunks?: number;
  /** Re-request with start_chunk when a seek target is more than this many chunks ahead (default 2). */
  farSeekChunks?: number;
  /** Upper bound of decoded audio kept in memory, in seconds (default 600). */
  maxBufferedSeconds?: number;
  /**
   * Stop the request once this many seconds of decoded audio are waiting ahead of the playhead
   * (default 300). Without it a fast server would push a whole long article into memory.
   */
  maxAheadSeconds?: number;
  /** Re-request (start_chunk) when the audio ahead of the playhead drops below this (default 120). */
  refillAheadSeconds?: number;
  /** Clock tick interval in ms (default 40). 0 disables the internal timer (tests call tick()). */
  tickIntervalMs?: number;
  /** Position patches are emitted at most this often, in ms (default 250 = 4 Hz). */
  positionIntervalMs?: number;
  /** ms to wait for AudioContext.resume() before reporting `needs-gesture` (default 1500). */
  resumeTimeoutMs?: number;
  /** Monotonic ms clock (for throttling only; audio timing uses the AudioContext). */
  now?: () => number;
}

export type PlayerEvent =
  | { type: 'reset'; state: PlayerState; words: ChunkWords[] }
  | { type: 'patch'; patch: Partial<PlayerState> }
  | { type: 'chunk'; chunk: ChunkWords };

export interface LoadRequest {
  text: string;
  settings: TamberSettings;
  title?: string | null;
  sourceUrl?: string | null;
  tabId?: number | null;
  startChunk?: number;
}

interface ChunkMeta {
  index: number;
  char_start: number;
  char_end: number;
  duration: number;
  words: readonly WordTiming[];
}

interface ScheduledNode {
  index: number;
  source: BufferSourceLike;
  /** ctx time at which this node starts sounding */
  when: number;
  /** offset into the chunk's audio where it starts */
  offset: number;
  /** ctx time at which it stops sounding */
  endWhen: number;
}

interface StreamState {
  gen: number;
  ctrl: AbortController;
  /** Next plan index this stream will deliver. */
  cursor: number;
  active: boolean;
}

/** Leave this much headroom (s) between "now" and a node's start so the first samples are not clipped. */
const START_GUARD = 0.03;
/** Finished nodes kept for position bookkeeping (the lookahead is far smaller). */
const MAX_TRACKED_NODES = 16;
const MAX_RESTARTS_PER_CHUNK = 3;

export class ChunkedPlayer {
  private readonly opts: Required<Omit<ChunkedPlayerOptions, 'createContext' | 'now'>> & {
    createContext: () => AudioContextLike;
    now: () => number;
  };
  private ctx: AudioContextLike | null = null;
  private gain: GainNodeLike | null = null;
  private listeners = new Set<(e: PlayerEvent) => void>();
  private state: PlayerState = createIdleState();
  private settings: TamberSettings | null = null;

  // --- session data ---
  private gen = 0;
  private meta = new Map<number, ChunkMeta>();
  private buffers = new Map<number, AudioBufferLike>();
  private failed = new Set<number>();
  /** Re-requests issued per chunk index (guards against request loops). */
  private restarts = new Map<number, number>();
  private timeline: Timeline = new TimelineBuilder().timeline;
  private builder = new TimelineBuilder();
  private lastTimelineIndex = -1;
  private stream: StreamState | null = null;
  private fatal = false;

  // --- scheduling ---
  private scheduled: ScheduledNode[] = [];
  private nextIndex = 0;
  private nextWhen = 0;
  private pendingOffset = 0;
  /** User intent: true = should be sounding (not paused). */
  private wantPlaying = false;
  private needsGesture = false;
  private anchorChunk = 0;
  private anchorOffset = 0;

  // --- ticking ---
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPositionEmit = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ChunkedPlayerOptions) {
    const maxBufferedSeconds = options.maxBufferedSeconds ?? 600;
    // At most half the budget ahead, so eviction never has to touch the contiguous run ahead.
    const maxAheadSeconds = Math.min(options.maxAheadSeconds ?? 300, maxBufferedSeconds / 2);
    this.opts = {
      synthesize: options.synthesize,
      createContext: options.createContext ?? createBrowserAudioContext,
      lookaheadChunks: options.lookaheadChunks ?? 3,
      farSeekChunks: options.farSeekChunks ?? 2,
      maxBufferedSeconds,
      maxAheadSeconds,
      refillAheadSeconds: Math.min(options.refillAheadSeconds ?? 120, maxAheadSeconds),
      tickIntervalMs: options.tickIntervalMs ?? 40,
      positionIntervalMs: options.positionIntervalMs ?? 250,
      resumeTimeoutMs: options.resumeTimeoutMs ?? 1500,
      now: options.now ?? (() => performance.now()),
    };
  }

  // ===========================================================================================
  // Public API
  // ===========================================================================================

  subscribe(listener: (e: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PlayerState {
    return this.state;
  }

  /** Full state plus every word span received so far (for newly connected UIs). */
  getSnapshot(): { state: PlayerState; words: ChunkWords[] } {
    return { state: this.state, words: this.allChunkWords() };
  }

  /** Start reading `text` (replaces any current session). */
  load(req: LoadRequest): void {
    this.teardownSession();
    this.gen += 1;
    this.settings = req.settings;
    const ctx = this.ensureContext();
    this.applyVolume(req.settings.volume);
    const startChunk = Math.max(0, Math.floor(req.startChunk ?? 0));
    this.nextIndex = startChunk;
    this.anchorChunk = startChunk;
    this.anchorOffset = 0;
    this.wantPlaying = true;
    this.state = createIdleState({
      status: 'loading',
      sessionId: this.state.sessionId + 1,
      text: req.text,
      title: req.title ?? null,
      sourceUrl: req.sourceUrl ?? null,
      tabId: req.tabId ?? null,
      voice: req.settings.voice,
      speed: req.settings.speed,
      volume: req.settings.volume,
      activeChunk: startChunk > 0 ? startChunk : -1,
    });
    this.emit({ type: 'reset', state: this.state, words: [] });
    this.resumeContext(ctx);
    this.startStream(startChunk);
    this.startTimer();
  }

  pause(): void {
    if (!this.hasSession() || !this.wantPlaying) return;
    this.wantPlaying = false;
    this.tick(true);
    void this.ctx?.suspend().catch(() => undefined);
    this.refreshStatus();
  }

  resume(): void {
    if (!this.hasSession()) return;
    if (this.state.ended) {
      this.seekChunk(this.firstPlayableIndex());
    } else if (this.fatal) {
      // Play after a failed request (network drop, server crash): retry from where it stopped.
      this.fatal = false;
      this.restarts.delete(this.nextIndex);
      this.patch({ error: null });
    }
    this.wantPlaying = true;
    this.needsGesture = false;
    if (this.ctx) this.resumeContext(this.ctx);
    this.pump();
    this.refreshStatus();
  }

  toggle(): void {
    if (!this.hasSession()) return;
    // In the error state the UI shows a Play button: pressing it retries instead of pausing.
    const failed = this.computeStatus() === 'error';
    if (this.wantPlaying && !this.state.ended && !this.needsGesture && !failed) this.pause();
    else this.resume();
  }

  /** Stop and forget the session. */
  stop(): void {
    const sessionId = this.state.sessionId;
    this.teardownSession();
    this.state = createIdleState({ sessionId });
    this.emit({ type: 'reset', state: this.state, words: [] });
  }

  /** Seek to the word (or chunk) covering a character offset of the source text. */
  seekToChar(offset: number): void {
    if (!this.hasSession()) return;
    const wi = wordIndexAtChar(this.timeline, offset);
    if (wi >= 0) {
      const w = this.timeline.words[wi]!;
      const start = this.chunkStartTime(w.chunkIndex);
      this.seekTo(w.chunkIndex, start === null ? 0 : Math.max(0, w.start - start));
      return;
    }
    const idx = chunkIndexForOffset(this.state.plan, offset);
    if (idx >= 0) this.seekTo(idx, 0);
  }

  seekChunk(index: number): void {
    if (!this.hasSession()) return;
    const total = this.state.totalChunks;
    if (total <= 0) return;
    this.seekTo(Math.min(total - 1, Math.max(0, Math.floor(index))), 0);
  }

  next(): void {
    const cur = this.currentChunkIndex();
    if (cur + 1 < this.state.totalChunks) this.seekChunk(cur + 1);
  }

  /** Restart the current sentence, or go to the previous one when near its start. */
  previous(): void {
    const cur = this.currentChunkIndex();
    const start = this.chunkStartTime(cur);
    const intoChunk = start === null ? 0 : this.state.position - start;
    if (intoChunk > 2 || cur <= 0) this.seekChunk(Math.max(0, cur));
    else this.seekChunk(cur - 1);
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (this.settings) this.settings = { ...this.settings, volume: v };
    this.applyVolume(v);
    this.patch({ volume: v });
  }

  setSpeed(speed: number): void {
    if (!this.settings) return;
    if (Math.abs(this.settings.speed - speed) < 1e-6) return;
    this.settings = { ...this.settings, speed };
    this.patch({ speed });
    if (this.hasSession()) this.restartFromCurrent();
  }

  /** Apply new settings mid-session: volume live; voice / speed / language re-request from here. */
  updateSettings(next: TamberSettings): void {
    const prev = this.settings;
    this.settings = next;
    if (!prev) return;
    if (prev.volume !== next.volume) this.setVolume(next.volume);
    const audible =
      prev.voice !== next.voice || prev.speed !== next.speed || prev.lang !== next.lang;
    if (audible && this.hasSession()) {
      this.patch({ voice: next.voice, speed: next.speed });
      this.restartFromCurrent();
    }
  }

  /** Stop everything and release the AudioContext. */
  async dispose(): Promise<void> {
    this.teardownSession();
    this.listeners.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }

  /**
   * Advance the clock-driven state: refill the lookahead window, move the highlight, emit position
   * ticks, evict memory and detect the end. Runs on an interval; tests call it directly.
   */
  tick(forcePosition = false): void {
    if (!this.hasSession() || !this.ctx) return;
    this.pump();
    const now = this.clock();
    const pos = this.positionAt(now);
    const sounding = this.soundingNode(now);
    const activeChunk = sounding ? sounding.index : this.state.activeChunk;
    const activeWord = this.wordAt(pos, activeChunk, sounding !== null);
    const patch: Partial<PlayerState> = {};
    if (activeChunk !== this.state.activeChunk) patch.activeChunk = activeChunk;
    if (!sameSpan(activeWord, this.state.activeWord)) patch.activeWord = activeWord;
    const wallNow = this.opts.now();
    const changed = Object.keys(patch).length > 0;
    if (
      changed ||
      forcePosition ||
      wallNow - this.lastPositionEmit >= this.opts.positionIntervalMs
    ) {
      patch.position = round3(pos);
      patch.progress = this.progressAt(activeChunk, pos);
      this.lastPositionEmit = wallNow;
    }
    if (Object.keys(patch).length) this.patch(patch);
    this.evict();
    this.refill();
    this.checkEnded(now);
    this.refreshStatus();
  }

  // ===========================================================================================
  // Streaming
  // ===========================================================================================

  private startStream(startChunk: number): void {
    const settings = this.settings;
    if (!settings) return;
    this.stream?.ctrl.abort();
    this.fatal = false;
    const gen = this.gen;
    const stream: StreamState = {
      gen,
      ctrl: new AbortController(),
      cursor: startChunk,
      active: true,
    };
    this.stream = stream;
    this.patch({ streamDone: false, error: null });
    const request = ttsRequestFromSettings(settings, this.state.text, { start_chunk: startChunk });
    void this.consume(stream, settings, request);
  }

  private isCurrent(stream: StreamState): boolean {
    return this.stream === stream && stream.gen === this.gen && !stream.ctrl.signal.aborted;
  }

  private async consume(stream: StreamState, settings: TamberSettings, request: TtsRequest) {
    try {
      for await (const ev of this.opts.synthesize(settings, request, stream.ctrl.signal)) {
        if (!this.isCurrent(stream)) return;
        switch (ev.type) {
          case 'start':
            this.onStart(ev.chunks, ev.total_chunks, ev.word_timestamps, ev.voice);
            break;
          case 'queued':
            this.patch({ queuePosition: ev.position });
            this.refreshStatus();
            break;
          case 'chunk': {
            if (this.queuePositionSet()) this.patch({ queuePosition: null });
            if (this.buffers.has(ev.index)) {
              stream.cursor = ev.index + 1;
              if (this.allDecodedFrom(stream.cursor)) stream.ctrl.abort();
              break;
            }
            // Until this chunk is decoded it is still on its way: keep the cursor on it, so a clock
            // tick during decodeAudioData waits for it instead of re-requesting it (which would
            // abort this stream and throw the decoded audio away).
            stream.cursor = ev.index;
            let buffer: AudioBufferLike;
            try {
              buffer = await this.decode(ev.audio);
            } catch {
              if (!this.isCurrent(stream)) return;
              stream.cursor = ev.index + 1;
              this.failed.add(ev.index);
              this.patch({
                notice: `Sentence ${ev.index + 1} could not be decoded and was skipped.`,
              });
              this.pump();
              break;
            }
            if (!this.isCurrent(stream)) return;
            stream.cursor = ev.index + 1;
            this.addChunk(ev, buffer);
            if (this.isCurrent(stream) && this.bufferedAhead() > this.opts.maxAheadSeconds) {
              // Far enough ahead: stop synthesizing (frees the server slot and bounds memory).
              // tick() re-requests from the first missing chunk once the buffer runs low.
              stream.active = false;
              stream.ctrl.abort();
              return;
            }
            break;
          }
          case 'error':
            if (ev.index !== null) {
              this.failed.add(ev.index);
              stream.cursor = Math.max(stream.cursor, ev.index + 1);
            }
            this.patch({
              notice: ev.message || 'A sentence could not be synthesized and was skipped.',
            });
            this.pump();
            break;
          case 'done':
            stream.active = false;
            this.patch({ streamDone: true, queuePosition: null });
            this.pump();
            break;
          default:
            break;
        }
      }
      if (this.isCurrent(stream)) stream.active = false;
    } catch (err) {
      if (isAbortError(err) || !this.isCurrent(stream)) return;
      stream.active = false;
      this.fatal = true;
      this.patch({ error: describeError(err), queuePosition: null });
      this.refreshStatus();
    } finally {
      if (this.stream === stream) stream.active = false;
    }
  }

  private onStart(plan: ChunkSpan[], total: number, wordTimestamps: boolean, voice: string) {
    const patch: Partial<PlayerState> = {};
    if (this.state.plan.length === 0 || this.state.totalChunks !== total) {
      patch.plan = plan;
      patch.totalChunks = total;
    }
    if (this.state.wordTimestamps !== wordTimestamps) patch.wordTimestamps = wordTimestamps;
    if (voice && voice !== this.state.voice) patch.voice = voice;
    if (Object.keys(patch).length) this.patch(patch);
    if (this.nextIndex >= total && total > 0) this.nextIndex = total - 1;
    this.refreshStatus();
  }

  private async decode(b64: string): Promise<AudioBufferLike> {
    const ctx = this.ensureContext();
    const bytes = base64ToBytes(b64);
    // decodeAudioData detaches its argument: hand it an exact, owned ArrayBuffer.
    const ab =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    return ctx.decodeAudioData(ab);
  }

  private addChunk(
    ev: { index: number; char_start: number; char_end: number; words: WordTiming[] },
    buffer: AudioBufferLike,
  ) {
    const meta: ChunkMeta = {
      index: ev.index,
      char_start: ev.char_start,
      char_end: ev.char_end,
      duration: buffer.duration,
      words: ev.words,
    };
    const known = this.meta.has(ev.index);
    this.meta.set(ev.index, meta);
    this.buffers.set(ev.index, buffer);
    this.failed.delete(ev.index);
    this.restarts.delete(ev.index);
    if (!known) {
      if (ev.index > this.lastTimelineIndex) {
        this.builder.add(meta, meta.duration);
        this.timeline = this.builder.timeline;
        this.lastTimelineIndex = ev.index;
      } else {
        this.rebuildTimeline();
      }
    }
    const received = [...this.buffers.keys()].sort((a, b) => a - b);
    this.patch({
      receivedChunks: received,
      bufferedDuration: round3(this.timeline.duration),
      estimatedDuration: round3(this.estimateTotal()),
    });
    if (!known) this.emit({ type: 'chunk', chunk: toChunkWords(meta) });
    this.pump();
    this.refreshStatus();
  }

  private rebuildTimeline(): void {
    const b = new TimelineBuilder();
    const sorted = [...this.meta.values()].sort((a, c) => a.index - c.index);
    for (const m of sorted) b.add(m, m.duration);
    this.builder = b;
    this.timeline = b.timeline;
    this.lastTimelineIndex = sorted.length ? sorted[sorted.length - 1]!.index : -1;
  }

  private allDecodedFrom(index: number): boolean {
    for (let i = index; i < this.state.totalChunks; i++) {
      if (!this.buffers.has(i) && !this.failed.has(i)) return false;
    }
    return true;
  }

  private restartFromCurrent(): void {
    const cur = Math.max(0, this.currentChunkIndex());
    this.stopNodes();
    this.meta.clear();
    this.buffers.clear();
    this.failed.clear();
    this.restarts.clear();
    this.builder = new TimelineBuilder();
    this.timeline = this.builder.timeline;
    this.lastTimelineIndex = -1;
    this.nextIndex = cur;
    this.pendingOffset = 0;
    this.nextWhen = 0;
    this.anchorChunk = cur;
    this.anchorOffset = 0;
    this.patch({
      receivedChunks: [],
      bufferedDuration: 0,
      activeWord: null,
      activeChunk: cur,
      ended: false,
    });
    this.startStream(cur);
    this.refreshStatus();
  }

  // ===========================================================================================
  // Scheduling
  // ===========================================================================================

  private ensureContext(): AudioContextLike {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    const ctx = this.opts.createContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    ctx.onstatechange = () => {
      if (ctx.state === 'running' && this.needsGesture) {
        this.needsGesture = false;
        this.pump();
        this.refreshStatus();
      }
    };
    this.ctx = ctx;
    this.gain = gain;
    return ctx;
  }

  /** Resume the context now (synchronously, no await before it) and detect a blocked autoplay. */
  private resumeContext(ctx: AudioContextLike): void {
    if (ctx.state === 'running') return;
    const gen = this.gen;
    const p = ctx.resume();
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    const check = () => {
      if (gen !== this.gen || !this.wantPlaying) return;
      if (ctx.state !== 'running' && !this.needsGesture) {
        this.needsGesture = true;
        this.refreshStatus();
      }
    };
    this.resumeTimer = setTimeout(check, this.opts.resumeTimeoutMs);
    p.then(
      () => {
        if (this.resumeTimer) clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
        check();
        if (ctx.state === 'running') {
          this.pump();
          this.refreshStatus();
        }
      },
      () => {
        this.needsGesture = true;
        this.refreshStatus();
      },
    );
  }

  private applyVolume(volume: number): void {
    const g = this.gain;
    if (!g || !this.ctx) return;
    const v = Math.min(1, Math.max(0, volume));
    if (g.gain.setTargetAtTime) g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    else g.gain.value = v;
  }

  /** Schedule decoded chunks back to back until the lookahead window is full. */
  private pump(): void {
    const ctx = this.ctx;
    // After a fatal stream error, audio that was already decoded still plays out; ensureIncoming()
    // refuses to re-request while `fatal` is set, so this cannot loop.
    if (!ctx || !this.hasSession()) return;
    const now = ctx.currentTime;
    if (this.scheduled.length > MAX_TRACKED_NODES) {
      this.scheduled = this.scheduled.slice(-MAX_TRACKED_NODES);
    }
    const total = this.state.totalChunks;
    if (total === 0) return;
    while (this.upcoming(now) < this.opts.lookaheadChunks && this.nextIndex < total) {
      const index = this.nextIndex;
      if (this.failed.has(index)) {
        this.nextIndex += 1;
        continue;
      }
      const buffer = this.buffers.get(index);
      if (!buffer) {
        this.ensureIncoming(index);
        break;
      }
      const offset = Math.min(this.pendingOffset, Math.max(0, buffer.duration - 0.001));
      this.pendingOffset = 0;
      const when = Math.max(this.nextWhen, now + START_GUARD);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain ?? ctx.destination);
      const node: ScheduledNode = {
        index,
        source,
        when,
        offset,
        endWhen: when + (buffer.duration - offset),
      };
      source.onended = () => this.onNodeEnded(node);
      source.start(when, offset);
      this.scheduled.push(node);
      this.nextWhen = node.endWhen;
      this.nextIndex = index + 1;
    }
  }

  /** Number of scheduled nodes that have not finished yet. */
  private upcoming(now: number): number {
    let n = 0;
    for (const s of this.scheduled) if (s.endWhen > now) n++;
    return n;
  }

  /**
   * Make sure chunk `index` is on its way. It will arrive from the running stream when it is at
   * most `farSeekChunks` ahead of it; otherwise (far ahead, behind the stream, evicted, or the
   * stream is over) the stream restarts with `start_chunk = index`.
   */
  private ensureIncoming(index: number): void {
    if (this.fatal) return;
    const s = this.stream;
    if (s && s.active && index >= s.cursor && index - s.cursor <= this.opts.farSeekChunks) return;
    const attempts = (this.restarts.get(index) ?? 0) + 1;
    this.restarts.set(index, attempts);
    if (attempts > MAX_RESTARTS_PER_CHUNK) {
      // The server keeps not delivering this chunk: skip it rather than loop.
      this.failed.add(index);
      this.patch({ notice: `Sentence ${index + 1} is unavailable and was skipped.` });
      return;
    }
    this.startStream(index);
  }

  private onNodeEnded(node: ScheduledNode): void {
    if (!this.scheduled.includes(node)) return;
    this.pump();
    if (this.ctx) this.checkEnded(this.clock());
    this.refreshStatus();
  }

  private stopNodes(): void {
    for (const n of this.scheduled) {
      n.source.onended = null;
      try {
        n.source.stop();
      } catch {
        // not started / already stopped
      }
      try {
        n.source.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.scheduled = [];
  }

  private seekTo(index: number, offset: number): void {
    this.stopNodes();
    this.restarts.delete(index);
    this.nextIndex = index;
    this.pendingOffset = offset;
    this.nextWhen = 0;
    this.anchorChunk = index;
    this.anchorOffset = offset;
    if (this.fatal) {
      this.fatal = false;
      this.patch({ error: null });
    }
    const start = this.chunkStartTime(index);
    const pos = start === null ? this.state.position : start + offset;
    const word = this.wordAt(pos, index, true);
    this.patch({
      ended: false,
      activeChunk: index,
      activeWord: word,
      position: round3(pos),
      progress: this.progressAt(index, pos),
    });
    this.pump();
    this.refreshStatus();
  }

  // ===========================================================================================
  // Clock & position
  // ===========================================================================================

  /** Audible time: currentTime minus output latency so the highlight matches what is heard. */
  private clock(): number {
    const ctx = this.ctx!;
    const lat = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency! : 0;
    return Math.max(0, ctx.currentTime - lat);
  }

  private soundingNode(now: number): ScheduledNode | null {
    let found: ScheduledNode | null = null;
    for (const n of this.scheduled) if (n.when <= now && now < n.endWhen) found = n;
    return found;
  }

  private positionAt(now: number): number {
    let node: ScheduledNode | null = null;
    for (const n of this.scheduled) if (n.when <= now) node = n;
    if (node) {
      const start = this.chunkStartTime(node.index);
      if (start !== null) {
        const elapsed = Math.min(now - node.when, node.endWhen - node.when);
        return start + node.offset + Math.max(0, elapsed);
      }
    }
    const anchor = this.chunkStartTime(this.anchorChunk);
    return anchor === null ? this.state.position : anchor + this.anchorOffset;
  }

  private chunkStartTime(index: number): number | null {
    const cs = this.timeline.chunks;
    let lo = 0;
    let hi = cs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cs[mid]!;
      if (c.index === index) return c.start;
      if (c.index < index) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  private wordAt(pos: number, chunkIndex: number, sounding: boolean): CharSpan | null {
    if (!sounding || chunkIndex < 0) return null;
    const wi = wordIndexAt(this.timeline, pos);
    if (wi < 0) return null;
    const w = this.timeline.words[wi]!;
    if (w.chunkIndex !== chunkIndex) return null;
    return { charStart: w.charStart, charEnd: w.charEnd };
  }

  private currentChunkIndex(): number {
    if (this.state.activeChunk >= 0) return this.state.activeChunk;
    return Math.min(this.nextIndex, Math.max(0, this.state.totalChunks - 1));
  }

  private firstPlayableIndex(): number {
    for (let i = 0; i < this.state.totalChunks; i++) if (!this.failed.has(i)) return i;
    return 0;
  }

  private progressAt(chunkIndex: number, pos: number): number {
    const len = this.state.text.length;
    if (!len) return 0;
    const span = this.state.plan[chunkIndex];
    if (!span) return this.state.progress;
    const start = this.chunkStartTime(chunkIndex);
    const meta = this.meta.get(chunkIndex);
    let frac = 0;
    if (start !== null && meta && meta.duration > 0) {
      frac = Math.min(1, Math.max(0, (pos - start) / meta.duration));
    }
    const chars = span.char_start + frac * (span.char_end - span.char_start);
    return Math.min(1, Math.max(0, round3(chars / len)));
  }

  /** Seconds per character over the received chunks, extrapolated to the whole text. */
  private estimateTotal(): number {
    let secs = 0;
    let chars = 0;
    for (const m of this.meta.values()) {
      secs += m.duration;
      chars += m.char_end - m.char_start;
    }
    if (!chars) return 0;
    const planChars = this.state.plan.reduce((s, c) => s + (c.char_end - c.char_start), 0);
    return (secs / chars) * (planChars || this.state.text.length);
  }

  private checkEnded(now: number): void {
    if (this.state.ended || !this.state.totalChunks) return;
    if (this.nextIndex < this.state.totalChunks) return;
    if (this.scheduled.some((n) => n.endWhen > now)) return;
    if (this.stream?.active) return;
    this.wantPlaying = false;
    this.stopNodes();
    this.patch({
      ended: true,
      activeWord: null,
      position: round3(this.timeline.duration),
      progress: 1,
    });
    this.refreshStatus();
  }

  /** Release decoded audio beyond the memory budget, oldest (well behind the playhead) first. */
  private evict(): void {
    let total = 0;
    for (const b of this.buffers.values()) total += b.duration;
    if (total <= this.opts.maxBufferedSeconds) return;
    const cur = this.currentChunkIndex();
    const behind = [...this.buffers.keys()].filter((i) => i < cur - 2).sort((a, b) => a - b);
    // Still over budget (e.g. audio left far ahead by a seek backwards): drop the farthest
    // unscheduled audio next. It is re-requested with start_chunk when playback gets there.
    const ahead = [...this.buffers.keys()]
      .filter((i) => i >= this.nextIndex + this.opts.lookaheadChunks)
      .sort((a, b) => b - a);
    let evicted = false;
    for (const i of [...behind, ...ahead]) {
      if (total <= this.opts.maxBufferedSeconds) break;
      total -= this.buffers.get(i)!.duration;
      this.buffers.delete(i);
      evicted = true;
    }
    if (evicted) this.patch({ receivedChunks: [...this.buffers.keys()].sort((a, b) => a - b) });
  }

  /**
   * Seconds of audio that will play without a gap from here: the scheduled remainder plus the
   * decoded chunks that follow contiguously (audio further ahead, past a missing chunk, does not
   * count: playback would stall at the gap first).
   */
  private bufferedAhead(): number {
    const now = this.ctx?.currentTime ?? 0;
    let secs = 0;
    for (const n of this.scheduled) if (n.endWhen > now) secs += n.endWhen - Math.max(now, n.when);
    for (let i = this.nextIndex; i < this.state.totalChunks; i++) {
      const b = this.buffers.get(i);
      if (b) secs += b.duration;
      else if (!this.failed.has(i)) break;
    }
    return secs;
  }

  /** First plan index at or after `from` that is neither decoded nor known to have failed. */
  private firstMissingFrom(from: number): number {
    for (let i = Math.max(0, from); i < this.state.totalChunks; i++) {
      if (!this.buffers.has(i) && !this.failed.has(i)) return i;
    }
    return -1;
  }

  /**
   * After the stream was stopped for being far enough ahead, re-request from the first missing
   * chunk once the audio waiting ahead drops below `refillAheadSeconds` (well before it runs out,
   * so the new request's first-chunk latency is hidden).
   */
  private refill(): void {
    if (this.fatal || this.stream?.active) return;
    if (this.bufferedAhead() >= this.opts.refillAheadSeconds) return;
    const missing = this.firstMissingFrom(this.nextIndex);
    if (missing >= 0) this.ensureIncoming(missing);
  }

  // ===========================================================================================
  // State
  // ===========================================================================================

  private hasSession(): boolean {
    return this.state.text.length > 0 && this.settings !== null;
  }

  private queuePositionSet(): boolean {
    return this.state.queuePosition !== null;
  }

  private computeStatus(): PlayerStatus {
    if (!this.hasSession() || this.state.ended) return 'idle';
    if (!this.wantPlaying) return 'paused';
    if (this.needsGesture) return 'needs-gesture';
    const ctx = this.ctx;
    // Audio already scheduled keeps playing even after a fatal stream error.
    if (ctx && ctx.state === 'running' && this.soundingNode(this.clock())) return 'playing';
    if (this.fatal) return 'error';
    if (this.state.queuePosition !== null) return 'queued';
    return 'loading';
  }

  private refreshStatus(): void {
    const status = this.computeStatus();
    if (status !== this.state.status) this.patch({ status });
  }

  private patch(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'patch', patch });
  }

  private emit(e: PlayerEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('[tamber] player listener failed', err);
      }
    }
  }

  private allChunkWords(): ChunkWords[] {
    return [...this.meta.values()].sort((a, b) => a.index - b.index).map(toChunkWords);
  }

  private startTimer(): void {
    if (this.timer || this.opts.tickIntervalMs <= 0) return;
    this.timer = setInterval(() => this.tick(), this.opts.tickIntervalMs);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private teardownSession(): void {
    this.gen += 1;
    this.stream?.ctrl.abort();
    this.stream = null;
    this.stopNodes();
    this.stopTimer();
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.meta.clear();
    this.buffers.clear();
    this.failed.clear();
    this.restarts.clear();
    this.builder = new TimelineBuilder();
    this.timeline = this.builder.timeline;
    this.lastTimelineIndex = -1;
    this.nextIndex = 0;
    this.nextWhen = 0;
    this.pendingOffset = 0;
    this.wantPlaying = false;
    this.needsGesture = false;
    this.fatal = false;
    this.anchorChunk = 0;
    this.anchorOffset = 0;
  }
}

function toChunkWords(m: ChunkMeta): ChunkWords {
  return { index: m.index, words: m.words.map((w) => [w.char_start, w.char_end]) };
}

function sameSpan(a: CharSpan | null, b: CharSpan | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.charStart === b.charStart && a.charEnd === b.charEnd;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
