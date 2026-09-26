/**
 * ChunkedPlayer: gapless, iOS-safe playback of Tamber's NDJSON chunk stream on Web Audio.
 *
 * Design (docs/ARCHITECTURE.md section 5.3, docs/research/web-stack.md section 9):
 *  - `unlock()` is synchronous and must run first inside a user gesture: audio session "playback",
 *    create/resume the AudioContext, start the silent <audio> anchor.
 *  - `play()` consumes `client.synthesize()` (fetch body streaming, no MSE). Each chunk line is a
 *    complete audio file: base64 -> bytes -> decodeAudioData -> AudioBufferSourceNode.start(when)
 *    back to back on a gain -> analyser -> destination chain, at most LOOKAHEAD_CHUNKS ahead.
 *  - The clock is `ctx.currentTime - run.origin`, mapped onto a TimelineBuilder that grows as
 *    chunks are scheduled. Pause/resume = ctx.suspend()/resume(). Seek = stop the scheduled nodes
 *    and start a new "run" at (chunk, offset); a chunk that is neither held nor about to arrive is
 *    re-requested with `start_chunk`.
 *
 * Framework-free: React binds to it through subscribe()/getSnapshot() (coarse state only) and the
 * per-frame UI reads getFrame() from its own requestAnimationFrame loop.
 */
import {
  base64ToBytes,
  chunkIndexForOffset,
  chunkPositionAt,
  concatWav,
  isAbortError,
  planChunks,
  TamberTimeoutError,
  TimelineBuilder,
  type AudioFormat,
  type ChunkMode,
  type ChunkSpan,
  type TamberClient,
  type Timeline,
  type TtsChunkEvent,
  type TtsErrorEvent,
  type TtsRequest,
  type TtsStartEvent,
  type WordTiming,
} from '@tamber/client';
import { decodeAudio } from './decode';
import { SilentAnchor, type AudioAnchor } from './silentAnchor';
import { createAudioContext, unlockAudioContext } from './unlock';

/** Chunks scheduled on the audio clock ahead of the playhead. */
export const LOOKAHEAD_CHUNKS = 3;
/** A missing chunk further than this beyond the stream position is re-requested with start_chunk. */
export const FAR_AHEAD_CHUNKS = 2;
/** Decoded buffers more than this many chunks behind the playhead are released. */
export const KEEP_BEHIND_CHUNKS = 2;
/** Upper bound for raw chunk bytes kept for seeking back and "Save audio". */
export const MAX_HELD_BYTES = 200 * 1024 * 1024;
/** Rough speaking rate used for duration estimates before audio arrives. */
export const CHARS_PER_SECOND = 15;
/**
 * Download backpressure (docs/ARCHITECTURE.md 5.3, "about 10 minutes"): with more audio than this
 * held ahead of the playhead the request is closed (which also frees the server's synthesis slot),
 * and it is re-opened with start_chunk once less than RESUME_AHEAD_SECONDS remain. Without it a
 * 100k-character text keeps ~320 MB of WAV in memory whatever the playhead does.
 */
export const MAX_AHEAD_SECONDS = 600;
export const RESUME_AHEAD_SECONDS = 120;

const START_LEAD_S = 0.06;
/** Time allowed for the `start` line to arrive (requests may queue behind other jobs). */
export const STREAM_OPEN_TIMEOUT_MS = 120_000;
/**
 * Once the stream is open, the server writes a line (at worst a `ping`) at least every 15 s. A
 * stream silent for this long was cut by a proxy without closing: fail it (Retry resumes there).
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;
const UNDERRUN_MARGIN_S = 0.012;
const GESTURE_WATCHDOG_MS = 1200;

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
export type ChunkState = 'planned' | 'received' | 'played' | 'failed';

export interface PlayRequest {
  text: string;
  voice: string;
  speed: number;
  format: AudioFormat;
  chunkMode: ChunkMode;
  lang: string | null;
}

export interface PlayOptions {
  client: TamberClient;
  /** Plan index to start at (tap-to-seek before playing). */
  startChunk?: number;
  /** Chunk-relative seconds to start at within startChunk. */
  startOffset?: number;
  /** Import title or similar, for MediaSession. */
  title?: string | null;
  /** Server limits for the local plan preview (health.limits). */
  targetChars?: number;
  maxChars?: number;
}

export interface PlayerSnapshot {
  status: PlayerStatus;
  /** The context was suspended/interrupted by the OS: show "Tap to resume". */
  needsGesture: boolean;
  hasSession: boolean;
  /** Exactly the text sent to /v1/tts (render this, offsets index into it). */
  text: string;
  title: string | null;
  plan: readonly ChunkSpan[];
  totalChunks: number;
  /** False: no word timings (degraded, chunk wash only). */
  wordTimestamps: boolean;
  /** Canonical voice echoed by the server (or the requested one before `start`). */
  voice: string;
  speed: number;
  format: AudioFormat;
  chunkStates: readonly ChunkState[];
  receivedCount: number;
  failedCount: number;
  /** Plan index of the chunk under the playhead, -1 when none. */
  activeChunk: number;
  queuedPosition: number | null;
  /** Every chunk is received or failed. */
  complete: boolean;
  /** Sum of known chunk durations. */
  knownDuration: number;
  /** Known durations plus estimates for chunks not received yet. */
  estimatedDuration: number;
  canSave: boolean;
  error: PlayerErrorInfo | null;
  /** Increments on every emit (cheap change detection). */
  version: number;
}

export interface PlayerErrorInfo {
  message: string;
  code: string | null;
  status: number | null;
  error: unknown;
}

export type PlayerEvent =
  | { type: 'session'; request: PlayRequest; title: string | null }
  | { type: 'chunk-error'; index: number | null; code: string; message: string }
  | { type: 'error'; error: unknown }
  | { type: 'ended' };

/** What the UI reads every animation frame (no allocation beyond this object). */
export interface PlayerFrame {
  /** Timeline of the current run (absolute times start at the run's first chunk), or null. */
  timeline: Timeline | null;
  /** Seconds on that timeline. */
  t: number;
  activeChunk: number;
  /** Seconds into the active chunk. */
  offset: number;
  /** Duration of the active chunk (estimated until its audio arrives). */
  activeDuration: number;
  /** Seconds from the start of the text (estimates for chunks without audio). */
  elapsed: number;
  playing: boolean;
}

export interface ChunkedPlayerOptions {
  createContext?: () => AudioContext;
  anchor?: AudioAnchor;
  lookahead?: number;
  maxHeldBytes?: number;
  maxAheadSeconds?: number;
  resumeAheadSeconds?: number;
}

interface ChunkRecord {
  index: number;
  char_start: number;
  char_end: number;
  duration: number;
  words: WordTiming[];
  bytes: Uint8Array | null;
  buffer: AudioBuffer | null;
  decodedDuration: number | null;
}

interface ScheduledNode {
  index: number;
  source: AudioBufferSourceNode;
  start: number;
  end: number;
  ended: boolean;
}

interface Run {
  id: number;
  startIndex: number;
  firstOffset: number;
  /** ctx time at which this run's timeline t = 0. */
  origin: number;
  timeline: TimelineBuilder;
  /** Next plan index to schedule. */
  next: number;
  nodes: ScheduledNode[];
}

interface Stream {
  id: number;
  ctrl: AbortController;
  startChunk: number;
  /** Next plan index expected from this stream. */
  next: number;
  finished: boolean;
  /** Set when the open or idle timeout aborted the request: the timeout in ms. */
  timedOut: number | null;
}

interface Session {
  key: string;
  request: PlayRequest;
  title: string | null;
  client: TamberClient;
  plan: ChunkSpan[];
  total: number;
  wordTimestamps: boolean;
  voice: string;
  records: (ChunkRecord | undefined)[];
  failed: Set<number>;
  heldBytes: number;
  bytesDropped: boolean;
}

function sessionKey(r: PlayRequest): string {
  return JSON.stringify([r.text, r.voice, r.speed, r.format, r.chunkMode, r.lang]);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export class ChunkedPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Float32Array<ArrayBuffer> | null = null;
  private readonly createContext: () => AudioContext;
  private readonly anchor: AudioAnchor;
  private readonly lookahead: number;
  private readonly maxHeldBytes: number;
  private readonly maxAheadSeconds: number;
  private readonly resumeAheadSeconds: number;

  private session: Session | null = null;
  private run: Run | null = null;
  private stream: Stream | null = null;
  private runSeq = 0;
  private streamSeq = 0;
  private intent: 'play' | 'pause' | 'stop' = 'stop';
  private ended = false;
  private parked: { index: number; offset: number } | null = null;
  private activeChunk = -1;
  private queuedPosition: number | null = null;
  private streamError: unknown = null;
  private needsGesture = false;
  private volume = 1;
  private pumping = false;
  private pumpAgain = false;
  private disposed = false;
  private preview: AudioBufferSourceNode | null = null;
  /** Resolves the playClip() promise of the current preview. */
  private previewDone: (() => void) | null = null;
  /** Bumped by stopPreview(): a clip whose decode finishes after that is not started. */
  private previewSeq = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  private prefix: Float64Array = new Float64Array(1);
  private prefixDirty = true;

  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: PlayerEvent) => void>();
  private snapshot: PlayerSnapshot;
  private version = 0;

  constructor(options: ChunkedPlayerOptions = {}) {
    this.createContext = options.createContext ?? createAudioContext;
    this.anchor = options.anchor ?? new SilentAnchor();
    this.lookahead = options.lookahead ?? LOOKAHEAD_CHUNKS;
    this.maxHeldBytes = options.maxHeldBytes ?? MAX_HELD_BYTES;
    this.maxAheadSeconds = options.maxAheadSeconds ?? MAX_AHEAD_SECONDS;
    this.resumeAheadSeconds = Math.min(options.resumeAheadSeconds ?? RESUME_AHEAD_SECONDS, this.maxAheadSeconds);
    this.snapshot = this.buildSnapshot();
  }

  // ---------------------------------------------------------------------------------------------
  // Subscription (React: useSyncExternalStore)
  // ---------------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  /** Discrete events (errors, non-fatal chunk errors, end, new session). */
  on(listener: (e: PlayerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of [...this.listeners]) l();
  }

  private emitEvent(e: PlayerEvent): void {
    for (const l of [...this.eventListeners]) l(e);
  }

  // ---------------------------------------------------------------------------------------------
  // Audio graph + unlock
  // ---------------------------------------------------------------------------------------------

  /**
   * Synchronous. Call first thing inside every click/pointer/key handler that may start audio,
   * before any await: audioSession "playback", create/resume the AudioContext, start the anchor.
   */
  unlock(): void {
    if (this.disposed) return;
    const had = this.ctx;
    const ctx = unlockAudioContext(this.ctx, this.createContext, () => {
      if (this.intent === 'play') this.setNeedsGesture(true);
    });
    if (ctx !== had) this.attachContext(ctx);
    this.anchor.start();
    if (ctx.state === 'running' && this.needsGesture) this.setNeedsGesture(false);
  }

  private attachContext(ctx: AudioContext): void {
    this.ctx = ctx;
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    this.gain = gain;
    this.analyser = analyser;
    this.levelData = null;
    ctx.onstatechange = () => this.onContextState();
  }

  private onContextState(): void {
    const state = this.ctx?.state as string | undefined;
    if (state === 'running') {
      if (this.needsGesture) this.setNeedsGesture(false);
      return;
    }
    // The OS suspended or interrupted us (call, lock, background) while we meant to play. Never
    // retry resume() from here or from a timer: it only works inside the next user gesture.
    if ((state === 'suspended' || state === 'interrupted') && this.intent === 'play') {
      this.setNeedsGesture(true);
    }
  }

  private setNeedsGesture(value: boolean): void {
    if (this.needsGesture === value) return;
    this.needsGesture = value;
    this.emit();
  }

  /** The AudioContext, if one was created (voice previews reuse it). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** The analyser at the end of the chain (visuals). */
  get analyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    const g = this.gain;
    if (!g || !this.ctx) return;
    try {
      g.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
    } catch {
      g.gain.value = this.volume;
    }
  }

  /** RMS of the output in 0..1 (about 0.3 for loud speech). 0 when silent or not playing. */
  getLevel(): number {
    const a = this.analyser;
    if (!a || this.ctx?.state !== 'running') return 0;
    if (!this.levelData || this.levelData.length !== a.fftSize) {
      this.levelData = new Float32Array(new ArrayBuffer(a.fftSize * 4));
    }
    a.getFloatTimeDomainData(this.levelData);
    let sum = 0;
    for (let i = 0; i < this.levelData.length; i++) {
      const v = this.levelData[i]!;
      sum += v * v;
    }
    return Math.sqrt(sum / this.levelData.length);
  }

  // ---------------------------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------------------------

  /**
   * Start (or restart) playback of `request`. Call unlock() first in the same gesture. A request
   * identical to the current session reuses the audio it already holds.
   */
  play(request: PlayRequest, options: PlayOptions): void {
    if (this.disposed) return;
    if (!this.ctx) this.unlock();
    this.stopPreview();
    const key = sessionKey(request);
    let s = this.session;
    if (!s || s.key !== key) {
      this.abortStream();
      this.stopNodes();
      s = this.newSession(request, options);
      this.session = s;
      this.emitEvent({ type: 'session', request, title: s.title });
    } else {
      s.client = options.client;
      if (options.title !== undefined) s.title = options.title;
    }
    this.streamError = null;
    this.ended = false;
    this.parked = null;
    this.intent = 'play';
    this.stopNodes();
    const start = clamp(Math.floor(options.startChunk ?? 0), 0, Math.max(0, s.total - 1));
    this.startRun(start, options.startOffset ?? 0);
    this.emit();
    this.pump();
  }

  private newSession(request: PlayRequest, options: PlayOptions): Session {
    const plan = planChunks(request.text, {
      mode: request.chunkMode,
      targetChars: options.targetChars,
      maxChars: options.maxChars,
    });
    return {
      key: sessionKey(request),
      request,
      title: options.title ?? null,
      client: options.client,
      plan,
      total: plan.length,
      wordTimestamps: true,
      voice: request.voice,
      records: [],
      failed: new Set(),
      heldBytes: 0,
      bytesDropped: false,
    };
  }

  /** Pause (ctx.suspend: freezes the clock and every scheduled node). */
  pause(): void {
    if (this.intent !== 'play') return;
    this.intent = 'pause';
    const ctx = this.ctx;
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => undefined);
    this.anchor.pause();
    this.emit();
  }

  /**
   * Resume after pause, OS interruption, end or stop. Must run inside a user gesture (it calls
   * unlock(), which resumes the AudioContext synchronously).
   */
  resume(): void {
    const s = this.session;
    if (!s || this.disposed) return;
    this.unlock();
    this.stopPreview();
    if (this.ended || this.intent === 'stop') {
      const from = this.ended ? 0 : Math.max(0, this.activeChunk);
      this.ended = false;
      this.intent = 'play';
      this.streamError = null;
      this.stopNodes();
      this.startRun(from >= s.total ? 0 : from, 0);
      this.emit();
      this.pump();
      return;
    }
    this.intent = 'play';
    if (this.streamError) this.streamError = null;
    if (this.parked) {
      const p = this.parked;
      this.parked = null;
      this.startRun(p.index, p.offset);
    }
    this.emit();
    this.pump();
  }

  /** Play/pause toggle for an existing session (gesture handler). */
  toggle(): void {
    const st = this.snapshot.status;
    if (st === 'playing' || st === 'loading') this.pause();
    else this.resume();
  }

  /** Stop playback and synthesis. The session (text, plan, received audio) is kept for replay. */
  stop(): void {
    this.abortStream();
    this.stopNodes();
    this.stopPreview();
    this.run = null;
    this.parked = null;
    this.intent = 'stop';
    this.ended = false;
    this.activeChunk = -1;
    this.queuedPosition = null;
    this.streamError = null;
    this.anchor.pause();
    this.clearWatchdog();
    this.emit();
  }

  /** Stop and forget the session entirely. */
  reset(): void {
    this.stop();
    this.session = null;
    this.prefixDirty = true;
    this.emit();
  }

  /** Retry after a fatal stream error, from the chunk under the playhead. */
  retry(): void {
    if (!this.session) return;
    this.unlock();
    const pos = this.currentPosition();
    this.streamError = null;
    this.intent = 'play';
    this.ended = false;
    this.stopNodes();
    this.startRun(pos.index, pos.offset);
    this.emit();
    this.pump();
  }

  /**
   * Seek to a plan chunk (and a chunk-relative offset). While paused the new position is shown
   * and plays on resume; from idle/ended it starts playing (call unlock() first, in the gesture).
   */
  seekToChunk(index: number, offset = 0): void {
    const s = this.session;
    if (!s || s.total === 0) return;
    let k = clamp(Math.floor(index), 0, s.total - 1);
    while (k < s.total - 1 && s.failed.has(k)) k++;
    const off = Math.max(0, offset);
    this.stopPreview();
    if (this.parked) {
      this.parked = { index: k, offset: off };
      this.activeChunk = k;
      this.emit();
      return;
    }
    if (this.ended || this.intent === 'stop') {
      this.ended = false;
      this.intent = 'play';
      this.anchor.start();
    }
    this.streamError = null;
    this.stopNodes();
    this.startRun(k, off);
    this.emit();
    this.pump();
  }

  /** Seek to the word covering a character offset of the text (tap a word). */
  seekToChar(charOffset: number): void {
    const s = this.session;
    if (!s) return;
    const index = chunkIndexForOffset(s.plan, charOffset);
    if (index < 0) return;
    const rec = s.records[index];
    const word = rec?.words.find((w) => charOffset >= w.char_start && charOffset < w.char_end);
    this.seekToChunk(index, word ? word.start : 0);
  }

  next(): void {
    const s = this.session;
    if (!s) return;
    let k = this.currentPosition().index + 1;
    while (k < s.total && s.failed.has(k)) k++;
    if (k < s.total) this.seekToChunk(k);
  }

  previous(): void {
    const s = this.session;
    if (!s) return;
    const pos = this.currentPosition();
    if (pos.offset > 1.5) {
      this.seekToChunk(pos.index);
      return;
    }
    let k = pos.index - 1;
    while (k > 0 && s.failed.has(k)) k--;
    this.seekToChunk(Math.max(0, k));
  }

  /** Relative seek in seconds (MediaSession seekforward/seekbackward). */
  seekBy(seconds: number): void {
    const s = this.session;
    if (!s) return;
    const pos = this.currentPosition();
    let index = pos.index;
    let offset = pos.offset + seconds;
    while (offset < 0 && index > 0) {
      index--;
      offset += this.durationOf(index);
    }
    while (index < s.total - 1 && offset >= this.durationOf(index)) {
      offset -= this.durationOf(index);
      index++;
      if (!s.records[index]) {
        offset = 0;
        break;
      }
    }
    this.seekToChunk(index, Math.max(0, offset));
  }

  /**
   * Change speed. During playback this restarts synthesis at the current chunk (start_chunk),
   * because the server renders speed into the audio. Otherwise it applies to the next play.
   */
  setSpeed(speed: number): void {
    const s = this.session;
    if (!s || s.request.speed === speed) return;
    const pos = this.currentPosition();
    const active = this.intent !== 'stop' && !this.ended;
    this.abortStream();
    this.stopNodes();
    const request = { ...s.request, speed };
    const next = this.newSession(request, { client: s.client, title: s.title });
    next.plan = s.plan;
    next.total = s.total;
    next.wordTimestamps = s.wordTimestamps;
    next.voice = s.voice;
    this.session = next;
    this.prefixDirty = true;
    if (!active) {
      this.run = null;
      this.emit();
      return;
    }
    this.parked = null;
    this.startRun(pos.index, 0);
    this.emit();
    this.pump();
  }

  // ---------------------------------------------------------------------------------------------
  // Voice preview (same AudioContext, same output chain)
  // ---------------------------------------------------------------------------------------------

  /**
   * Synchronous part of a preview tap: parks the main playback (position kept for resume) and
   * unlocks audio. Then fetch the clip and call playClip().
   */
  beginPreview(): void {
    this.stopPreview();
    if (this.session && (this.intent === 'play' || (this.intent === 'pause' && this.run))) {
      this.parked = this.currentPosition();
      this.stopNodes();
      this.run = null;
      this.intent = 'pause';
      this.activeChunk = this.parked.index;
      this.emit();
    }
    this.unlock();
  }

  /**
   * Decode and play a complete audio file (voice preview). Resolves when it finishes, when it is
   * stopped (stopPreview(), a new preview, main playback) or when it was superseded while decoding.
   */
  async playClip(bytes: Uint8Array): Promise<void> {
    const ctx = this.ctx;
    const gain = this.gain;
    if (!ctx || !gain) throw new Error('Audio is locked: tap again.');
    const seq = this.previewSeq;
    const buffer = await decodeAudio(ctx, bytes);
    if (seq !== this.previewSeq || this.ctx !== ctx || this.disposed) return;
    this.stopPreview();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    this.preview = src;
    await new Promise<void>((resolve) => {
      const done = () => {
        if (this.preview === src) this.preview = null;
        if (this.previewDone === done) this.previewDone = null;
        resolve();
      };
      this.previewDone = done;
      src.onended = done;
      try {
        src.start(ctx.currentTime + 0.02);
      } catch {
        done();
      }
    });
  }

  stopPreview(): void {
    this.previewSeq++;
    const p = this.preview;
    const done = this.previewDone;
    this.preview = null;
    this.previewDone = null;
    if (p) {
      p.onended = null;
      try {
        p.stop();
      } catch {
        // not started
      }
    }
    done?.();
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------

  /** Word timings received for a chunk (stable array identity once received), or null. */
  getChunkWords(index: number): readonly WordTiming[] | null {
    return this.session?.records[index]?.words ?? null;
  }

  /** Current (chunk, offset) position. */
  currentPosition(): { index: number; offset: number } {
    if (this.parked) return { ...this.parked };
    const run = this.run;
    if (!run || !this.ctx) return { index: Math.max(0, this.activeChunk), offset: 0 };
    const tl = run.timeline.timeline;
    const first = tl.chunks[0];
    if (!first) return { index: run.startIndex, offset: run.firstOffset };
    const t = this.ctx.currentTime - run.origin;
    const pos = chunkPositionAt(tl, t);
    if (pos >= 0) {
      const c = tl.chunks[pos]!;
      return { index: c.index, offset: Math.max(0, t - c.start) };
    }
    if (t < first.start) return { index: first.index, offset: run.firstOffset };
    return { index: Math.min(run.next, (this.session?.total ?? 1) - 1), offset: 0 };
  }

  /** Per-frame read for the UI (highlight, time, visuals). */
  getFrame(): PlayerFrame {
    const run = this.run;
    const ctx = this.ctx;
    const pos = this.currentPosition();
    const t = run && ctx && run.timeline.timeline.chunks.length ? ctx.currentTime - run.origin : -1;
    const playing = this.snapshot.status === 'playing' && ctx?.state === 'running';
    const index = this.session ? pos.index : -1;
    return {
      timeline: run && !this.parked ? run.timeline.timeline : null,
      t,
      activeChunk: this.intent === 'stop' && !this.ended ? -1 : index,
      offset: pos.offset,
      activeDuration: index >= 0 ? this.durationOf(index) : 0,
      elapsed: index >= 0 ? this.prefixAt(index) + pos.offset : 0,
      playing,
    };
  }

  /** One WAV file of every chunk (Save audio). Null when not possible (see snapshot.canSave). */
  buildWav(): Uint8Array | null {
    const s = this.session;
    if (!s || !this.snapshot.canSave) return null;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < s.total; i++) {
      const b = s.records[i]?.bytes;
      if (b) parts.push(b);
    }
    return parts.length ? concatWav(parts) : null;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.anchor.dispose();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) ctx.close().catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // Runs and scheduling
  // ---------------------------------------------------------------------------------------------

  private startRun(index: number, offset: number): void {
    this.run = {
      id: ++this.runSeq,
      startIndex: index,
      firstOffset: Math.max(0, offset),
      origin: 0,
      timeline: new TimelineBuilder(0),
      next: index,
      nodes: [],
    };
    this.activeChunk = index;
  }

  private stopNodes(): void {
    const run = this.run;
    if (!run) return;
    for (const n of run.nodes) {
      n.source.onended = null;
      if (!n.ended) {
        try {
          n.source.stop();
        } catch {
          // already stopped
        }
      }
      try {
        n.source.disconnect();
      } catch {
        // ignore
      }
      n.ended = true;
    }
    run.nodes = [];
  }

  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void (async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.pumpOnce();
        } while (this.pumpAgain && !this.disposed);
      } catch (err) {
        // Unexpected (e.g. the context was closed under us): surface it as a retryable error
        // rather than an unhandled rejection with the player stuck in "loading".
        if (this.disposed) return;
        this.abortStream();
        this.streamError = err;
        this.emit();
        this.emitEvent({ type: 'error', error: err });
      } finally {
        this.pumping = false;
      }
    })();
  }

  private pendingNodes(run: Run): number {
    let n = 0;
    for (const node of run.nodes) if (!node.ended) n++;
    return n;
  }

  private async pumpOnce(): Promise<void> {
    for (;;) {
      const s = this.session;
      const run = this.run;
      const ctx = this.ctx;
      if (!s || !run || !ctx || this.disposed || this.intent === 'stop') return;
      if (this.pendingNodes(run) >= this.lookahead) {
        this.resumeDownloadIfLow(s);
        return;
      }
      let k = run.next;
      while (k < s.total && s.failed.has(k)) k++;
      run.next = k;
      if (k >= s.total) {
        this.checkEnded();
        return;
      }
      const rec = s.records[k];
      if (!rec || (!rec.buffer && !rec.bytes)) {
        if (rec) s.records[k] = undefined;
        this.ensureStreamFor(k);
        this.emitIfStatusChanged();
        return;
      }
      let buffer = rec.buffer;
      if (!buffer) {
        try {
          buffer = await decodeAudio(ctx, rec.bytes!);
        } catch {
          if (this.session !== s) return;
          s.failed.add(k);
          this.emitEvent({
            type: 'chunk-error',
            index: k,
            code: 'decode_failed',
            message: 'This browser could not decode a chunk of audio.',
          });
          this.prefixDirty = true;
          this.emit();
          continue;
        }
        if (this.session !== s || this.run !== run || this.ctx !== ctx) {
          // Stale: a seek or new session happened while decoding. Keep the buffer, let the next
          // pump decide what to schedule.
          if (s.records[k] === rec) rec.buffer = buffer;
          this.pumpAgain = true;
          return;
        }
        rec.buffer = buffer;
        rec.decodedDuration = buffer.duration;
        this.prefixDirty = true;
      }
      if (run.next !== k) {
        this.pumpAgain = true;
        return;
      }
      this.schedule(run, rec, buffer);
    }
  }

  private schedule(run: Run, rec: ChunkRecord, buffer: AudioBuffer): void {
    const ctx = this.ctx!;
    const first = run.timeline.timeline.chunks.length === 0;
    let offset = 0;
    let when: number;
    if (first) {
      offset = Math.min(run.firstOffset, Math.max(0, buffer.duration - 0.005));
      when = ctx.currentTime + START_LEAD_S;
      run.origin = when - offset;
    } else {
      when = run.origin + run.timeline.duration;
      if (when < ctx.currentTime + UNDERRUN_MARGIN_S) {
        // Underrun: everything scheduled already played. Start a fresh run at this chunk.
        this.stopNodes();
        this.startRun(rec.index, 0);
        this.schedule(this.run!, rec, buffer);
        return;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain!);
    const tc = run.timeline.add(rec, buffer.duration);
    const node: ScheduledNode = {
      index: rec.index,
      source: src,
      start: when,
      end: run.origin + tc.end,
      ended: false,
    };
    src.onended = () => this.onNodeEnded(run, node);
    src.start(when, offset);
    run.nodes.push(node);
    run.next = rec.index + 1;
    if (first) {
      this.activeChunk = rec.index;
      this.armWatchdog();
    }
    this.emitIfStatusChanged();
  }

  private onNodeEnded(run: Run, node: ScheduledNode): void {
    node.ended = true;
    if (run !== this.run) return;
    run.nodes = run.nodes.filter((n) => !n.ended);
    const nextNode = run.nodes[0];
    this.activeChunk = nextNode ? nextNode.index : run.next;
    this.evictBehind(this.activeChunk);
    this.emit();
    this.pump();
    this.checkEnded();
  }

  private checkEnded(): void {
    const s = this.session;
    const run = this.run;
    if (!s || !run || this.intent !== 'play' || this.ended) return;
    let k = run.next;
    while (k < s.total && s.failed.has(k)) k++;
    if (k < s.total || this.pendingNodes(run) > 0) return;
    this.ended = true;
    this.activeChunk = -1;
    this.anchor.pause();
    this.clearWatchdog();
    this.emit();
    this.emitEvent({ type: 'ended' });
  }

  private evictBehind(active: number): void {
    const s = this.session;
    if (!s) return;
    const limit = active - KEEP_BEHIND_CHUNKS;
    for (let i = 0; i < limit; i++) {
      const r = s.records[i];
      if (r?.buffer) r.buffer = null;
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running') return;
    // Only *checks* the state; resuming is left to the next user gesture.
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.ctx === ctx && ctx.state !== 'running' && this.intent === 'play') {
        this.setNeedsGesture(true);
      }
    }, GESTURE_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private emitIfStatusChanged(): void {
    const prev = this.snapshot;
    if (prev.status !== this.deriveStatus() || prev.activeChunk !== this.activeChunk) this.emit();
  }

  // ---------------------------------------------------------------------------------------------
  // Streams
  // ---------------------------------------------------------------------------------------------

  private ensureStreamFor(k: number): void {
    if (this.streamError) return; // wait for retry()
    const st = this.stream;
    if (st && !st.finished && st.startChunk <= k && k >= st.next && k - st.next <= FAR_AHEAD_CHUNKS) {
      return; // it is on its way
    }
    this.startStream(k);
  }

  private abortStream(): void {
    const st = this.stream;
    this.stream = null;
    this.queuedPosition = null;
    if (st && !st.finished) {
      st.finished = true;
      st.ctrl.abort();
    }
  }

  private startStream(startChunk: number): void {
    const s = this.session;
    if (!s) return;
    this.abortStream();
    const st: Stream = {
      id: ++this.streamSeq,
      ctrl: new AbortController(),
      startChunk,
      next: startChunk,
      finished: false,
      timedOut: null,
    };
    this.stream = st;
    void this.consume(s, st);
  }

  private async consume(s: Session, st: Stream): Promise<void> {
    const r = s.request;
    const req: TtsRequest = {
      text: r.text,
      voice: r.voice,
      speed: r.speed,
      format: r.format,
      lang: r.lang,
      chunk_mode: r.chunkMode,
      stream: true,
    };
    if (st.startChunk > 0) req.start_chunk = st.startChunk;
    // streamOpenTimeoutMs: 0 makes the client hand our signal straight to fetch(), so abort()
    // cancels the response body at once. (@tamber/client >= 0.1.0 also keeps a caller signal linked
    // while the body is read; disabling its timeout avoids two competing timers.) Timeouts are
    // enforced here instead: STREAM_OPEN_TIMEOUT_MS until the first line, then
    // STREAM_IDLE_TIMEOUT_MS between lines (the server pings every 15 s).
    const client = s.client.withOptions({ streamOpenTimeoutMs: 0 });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = (ms: number) => {
      disarm();
      timer = setTimeout(() => {
        timer = null;
        st.timedOut = ms;
        st.ctrl.abort();
      }, ms);
    };
    arm(STREAM_OPEN_TIMEOUT_MS);
    try {
      for await (const ev of client.synthesize(req, { signal: st.ctrl.signal })) {
        if (this.stream !== st || this.session !== s) return;
        arm(STREAM_IDLE_TIMEOUT_MS);
        switch (ev.type) {
          case 'start':
            this.onStart(s, ev);
            break;
          case 'queued':
            this.queuedPosition = ev.position;
            this.emit();
            break;
          case 'chunk':
            this.onChunk(s, st, ev);
            break;
          case 'error':
            this.onChunkError(s, st, ev);
            break;
          case 'done':
            disarm();
            st.finished = true;
            this.queuedPosition = null;
            this.emit();
            this.pump();
            break;
          default:
            break; // ping and unknown events
        }
      }
      // An aborted body can also end the iteration quietly: a timeout must still be reported.
      if (st.timedOut !== null) throw new TamberTimeoutError(st.timedOut);
      if (this.stream === st) st.finished = true;
    } catch (caught) {
      disarm();
      if (this.stream !== st || this.session !== s) return;
      st.finished = true;
      this.queuedPosition = null;
      const err = st.timedOut !== null ? new TamberTimeoutError(st.timedOut) : caught;
      if (st.timedOut === null && (isAbortError(caught) || st.ctrl.signal.aborted)) return;
      this.streamError = err;
      this.emit();
      this.emitEvent({ type: 'error', error: err });
    } finally {
      disarm();
    }
  }

  private onStart(s: Session, ev: TtsStartEvent): void {
    if (Array.isArray(ev.chunks) && ev.chunks.length > 0) {
      const same =
        ev.chunks.length === s.plan.length &&
        ev.chunks.every(
          (c, i) => c.char_start === s.plan[i]?.char_start && c.char_end === s.plan[i]?.char_end,
        );
      if (!same) {
        s.plan = ev.chunks.map((c) => ({ index: c.index, char_start: c.char_start, char_end: c.char_end }));
      }
    }
    s.total = ev.total_chunks;
    s.wordTimestamps = ev.word_timestamps;
    s.voice = ev.voice || s.voice;
    this.prefixDirty = true;
    this.emit();
  }

  private onChunk(s: Session, st: Stream, ev: TtsChunkEvent): void {
    st.next = ev.index + 1;
    this.queuedPosition = null;
    const bytes = base64ToBytes(ev.audio);
    const prev = s.records[ev.index];
    if (prev?.bytes) s.heldBytes -= prev.bytes.length;
    s.records[ev.index] = {
      index: ev.index,
      char_start: ev.char_start,
      char_end: ev.char_end,
      duration: ev.duration,
      words: Array.isArray(ev.words) ? ev.words : [],
      bytes,
      buffer: null,
      decodedDuration: null,
    };
    s.failed.delete(ev.index);
    s.heldBytes += bytes.length;
    this.enforceByteCap(s);
    this.prefixDirty = true;
    if (this.stream === st && this.bufferedAhead(s).seconds > this.maxAheadSeconds) {
      // Far enough ahead: close the request (frees the server slot); resumeDownloadIfLow()
      // re-opens it with start_chunk before the buffer runs out.
      this.abortStream();
    }
    this.emit();
    this.pump();
  }

  /** Audio held contiguously from the playhead: its length and the first plan index not held. */
  private bufferedAhead(s: Session): { seconds: number; firstMissing: number } {
    let seconds = 0;
    let k = Math.max(0, this.activeChunk);
    for (; k < s.total; k++) {
      if (s.failed.has(k)) continue;
      const r = s.records[k];
      if (!r || (!r.bytes && !r.buffer)) break;
      seconds += r.decodedDuration ?? r.duration;
    }
    return { seconds, firstMissing: k };
  }

  /** Re-open a paused download (see MAX_AHEAD_SECONDS) once the buffer ahead runs low. */
  private resumeDownloadIfLow(s: Session): void {
    const st = this.stream;
    if ((st && !st.finished) || this.streamError || this.parked) return;
    const { seconds, firstMissing } = this.bufferedAhead(s);
    if (firstMissing < s.total && seconds < this.resumeAheadSeconds) this.startStream(firstMissing);
  }

  private onChunkError(s: Session, st: Stream, ev: TtsErrorEvent): void {
    if (ev.index !== null && ev.index !== undefined) {
      st.next = Math.max(st.next, ev.index + 1);
      s.failed.add(ev.index);
    }
    this.emitEvent({ type: 'chunk-error', index: ev.index, code: String(ev.code), message: ev.message });
    this.prefixDirty = true;
    this.emit();
    this.pump();
  }

  private enforceByteCap(s: Session): void {
    if (s.heldBytes <= this.maxHeldBytes) return;
    const keepFrom = Math.max(0, this.activeChunk - KEEP_BEHIND_CHUNKS);
    for (let i = 0; i < keepFrom && s.heldBytes > this.maxHeldBytes; i++) {
      const r = s.records[i];
      if (r?.bytes) {
        s.heldBytes -= r.bytes.length;
        r.bytes = null;
        s.bytesDropped = true;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------------------------

  private durationOf(i: number): number {
    const s = this.session;
    if (!s) return 0;
    const r = s.records[i];
    if (r) return r.decodedDuration ?? r.duration;
    if (s.failed.has(i)) return 0;
    const span = s.plan[i];
    if (!span) return 0;
    return (span.char_end - span.char_start) / (CHARS_PER_SECOND * (s.request.speed || 1));
  }

  private ensurePrefix(): void {
    if (!this.prefixDirty) return;
    const s = this.session;
    const n = s?.total ?? 0;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + this.durationOf(i);
    this.prefix = prefix;
    this.prefixDirty = false;
  }

  private prefixAt(index: number): number {
    this.ensurePrefix();
    return this.prefix[clamp(index, 0, this.prefix.length - 1)] ?? 0;
  }

  private deriveStatus(): PlayerStatus {
    if (!this.session) return 'idle';
    if (this.ended) return 'ended';
    if (this.intent === 'stop') return 'idle';
    if (this.intent === 'pause') return 'paused';
    const run = this.run;
    if (run && this.pendingNodes(run) > 0) return 'playing';
    if (this.streamError) return 'error';
    return 'loading';
  }

  private buildSnapshot(): PlayerSnapshot {
    const s = this.session;
    const status = this.deriveStatus();
    const err = this.streamError;
    const errorInfo: PlayerErrorInfo | null = err
      ? {
          message: err instanceof Error ? err.message : String(err),
          code: (err as { code?: unknown })?.code != null ? String((err as { code: unknown }).code) : null,
          status:
            typeof (err as { status?: unknown })?.status === 'number'
              ? (err as { status: number }).status
              : null,
          error: err,
        }
      : null;
    this.version++;
    if (!s) {
      return {
        status,
        needsGesture: this.needsGesture,
        hasSession: false,
        text: '',
        title: null,
        plan: [],
        totalChunks: 0,
        wordTimestamps: true,
        voice: '',
        speed: 1,
        format: 'wav',
        chunkStates: [],
        receivedCount: 0,
        failedCount: 0,
        activeChunk: -1,
        queuedPosition: null,
        complete: false,
        knownDuration: 0,
        estimatedDuration: 0,
        canSave: false,
        error: errorInfo,
        version: this.version,
      };
    }
    const active = status === 'idle' || status === 'ended' ? -1 : this.activeChunk;
    const states: ChunkState[] = new Array<ChunkState>(s.total);
    let received = 0;
    let known = 0;
    let allBytes = true;
    for (let i = 0; i < s.total; i++) {
      const r = s.records[i];
      if (s.failed.has(i)) states[i] = 'failed';
      else if (status === 'ended' || (active >= 0 && i < active)) states[i] = r ? 'played' : 'planned';
      else states[i] = r ? 'received' : 'planned';
      if (r) {
        received++;
        known += r.decodedDuration ?? r.duration;
        if (!r.bytes) allBytes = false;
      } else if (!s.failed.has(i)) {
        allBytes = false;
      }
    }
    this.ensurePrefix();
    const complete = received + s.failed.size >= s.total && s.total > 0;
    return {
      status,
      needsGesture: this.needsGesture,
      hasSession: true,
      text: s.request.text,
      title: s.title,
      plan: s.plan,
      totalChunks: s.total,
      wordTimestamps: s.wordTimestamps,
      voice: s.voice,
      speed: s.request.speed,
      format: s.request.format,
      chunkStates: states,
      receivedCount: received,
      failedCount: s.failed.size,
      activeChunk: active,
      queuedPosition: this.queuedPosition,
      complete,
      knownDuration: known,
      estimatedDuration: this.prefix[this.prefix.length - 1] ?? 0,
      canSave: s.request.format === 'wav' && complete && allBytes && !s.bytesDropped && received > 0,
      error: errorInfo,
      version: this.version,
    };
  }
}
