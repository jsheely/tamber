/**
 * StreamPlayer: progressive, gapless playback of a Tamber /v1/tts NDJSON stream on React Native.
 *
 *   client.synthesize() (expo/fetch streams response.body)
 *     start  -> chunk plan, word_timestamps flag
 *     chunk  -> base64 audio written to  Paths.cache/tamber/<requestId>/<index>.<format>
 *               -> playlist.add({ uri })          (expo-audio AudioPlaylist: native gapless queue)
 *               -> timeline.add(chunk, duration)  (TimelineBuilder from @tamber/client)
 *     error  -> non-fatal: toast and play on
 *     done   -> end of stream
 *
 * The clock is `timeline.chunks[playlist.currentIndex].start + playlist.currentTime`, read
 * synchronously (JSI) from a requestAnimationFrame loop via sample(), which also maps the clock to
 * the active word with wordIndexAt().
 *
 * Invariant: the playlist always holds a contiguous run of plan chunks (minus failed ones) in plan
 * order, and entries[i] / timeline.chunks[i] describe playlist track i.
 *
 * No Media Source Extensions (MSE) anywhere: every chunk is a complete, independently playable file.
 * The class is framework-free; all platform objects are injected so it is unit-testable.
 */
import {
  TimelineBuilder,
  chunkIndexForOffset,
  isAbortError,
  planChunks,
  wordIndexAt,
  type ChunkMode,
  type ChunkSpan,
  type TtsChunkEvent,
  type TtsEvent,
  type TtsRequest,
  type WordTiming,
} from '@tamber/client';

import type { PlayerSnapshot, PlayerStatus, ToastTone } from '@/store/playback';

/** The subset of expo-audio's AudioPlaylist that StreamPlayer drives. */
export interface PlaylistLike {
  readonly currentIndex: number;
  readonly currentTime: number;
  readonly playing: boolean;
  readonly trackCount: number;
  /** Whether the current track can be seeked (iOS: AVPlayerItem readyToPlay). Absent = assume yes. */
  readonly isLoaded?: boolean;
  volume: number;
  add(source: { uri: string }): void;
  clear(): void;
  play(): void;
  pause(): void;
  skipTo(index: number): void;
  seekTo(seconds: number): Promise<void>;
}

/** Writes chunk audio to disk and cleans it up. */
export interface ChunkFileStore {
  /** Write base64 audio for one chunk; returns a file:// URI the playlist can load. */
  write(requestId: string, index: number, format: string, base64: string): string;
  /** Delete every file written for these request ids. */
  remove(requestIds: readonly string[]): void;
}

export interface SynthesizerLike {
  synthesize(
    request: TtsRequest,
    opts: { signal?: AbortSignal },
  ): AsyncIterable<TtsEvent> | AsyncGenerator<TtsEvent, void, void>;
}

/** OS audio session + lock-screen / media-session registration. */
export interface AudioSessionLike {
  /** Configure the audio mode (silent switch, background, interruptions). Called before first play. */
  prepare(): Promise<void>;
  /** Register lock-screen / notification controls with this metadata. */
  activate(meta: { title: string; artist: string; albumTitle: string }): void;
  /** Mirror the play/pause state to the lock-screen controls. */
  setPlaying(playing: boolean): void;
  deactivate(): void;
}

export type SynthesisOptions = Omit<TtsRequest, 'text' | 'start_chunk' | 'stream'>;

export interface LoadOptions {
  title: string;
  request: SynthesisOptions;
}

export interface StreamPlayerDeps {
  playlist: PlaylistLike;
  files: ChunkFileStore;
  /**
   * Resolved at every stream start, so a changed base URL / key applies immediately. `signal` is
   * this stream's AbortSignal; bind it into the client's fetch so stop()/seek close the socket.
   */
  getClient: (signal: AbortSignal) => SynthesizerLike;
  session?: AudioSessionLike;
  onUpdate: (patch: Partial<PlayerSnapshot>) => void;
  onToast?: (message: string, tone: ToastTone) => void;
  /** Seek window: a not-yet-received chunk more than this many chunks ahead triggers a re-request. */
  seekAheadWindow?: number;
}

interface Entry {
  chunkIndex: number;
  uri: string;
  duration: number;
  charStart: number;
  charEnd: number;
  words: readonly WordTiming[];
}

interface PendingSeek {
  chunkIndex: number;
  /** Source-text offset to start at (resolved to a word time when the chunk arrives). */
  charOffset: number | null;
}

export interface ClockSample {
  clock: number;
  /** Plan index of the active chunk. */
  chunkIndex: number;
  /** Index within that chunk's words, or -1. */
  wordIndex: number;
}

type Intent = 'playing' | 'paused' | 'stopped';

const END_EPSILON = 0.25;
/** Waiting for a freshly skipped-to track to become seekable (see seekThenResume). */
const SEEK_READY_POLL_MS = 25;
const SEEK_READY_TIMEOUT_MS = 2000;

function requestKey(r: SynthesisOptions): string {
  return JSON.stringify([r.voice, r.speed, r.format, r.lang ?? null, r.chunk_mode ?? 'balanced']);
}

export class StreamPlayer {
  private readonly deps: StreamPlayerDeps;
  private readonly seekWindow: number;

  private text = '';
  private title = '';
  private request: SynthesisOptions | null = null;
  private plan: ChunkSpan[] = [];
  private totalChunks = 0;

  private generation = 0;
  private abortCtrl: AbortController | null = null;
  private streamActive = false;
  private streamDone = false;
  /** Next plan index the current stream will deliver. */
  private streamNext = 0;

  private entries: Entry[] = [];
  private timeline = new TimelineBuilder();
  /** Received chunks for the current synthesis options (reused when seeking backwards). */
  private cache = new Map<number, Entry>();
  private cacheKey = '';
  private requestIds = new Set<string>();
  private failed = new Set<number>();

  private intent: Intent = 'stopped';
  private status: PlayerStatus = 'idle';
  private pendingSeek: PendingSeek | null = null;
  private stalled = false;
  private sessionPrepared = false;
  private lastActiveChunk = -1;
  private lastActiveWord = -1;
  private wordTimestamps = true;
  /** Bumped by stop()/load(): an in-flight async play() from an older session must not start. */
  private sessionEpoch = 0;
  /** Bumped by every new seek/skip and playlist reset: cancels a deferred in-track seek. */
  private seekToken = 0;

  constructor(deps: StreamPlayerDeps) {
    this.deps = deps;
    this.seekWindow = deps.seekAheadWindow ?? 2;
  }

  // ------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------

  /** Prepare a new document. Stops any current session. Does not start playback. */
  load(text: string, opts: LoadOptions): void {
    this.stop();
    this.text = text;
    this.title = opts.title;
    this.request = { ...opts.request };
    this.cacheKey = requestKey(this.request);
    const mode: ChunkMode = opts.request.chunk_mode ?? 'balanced';
    // Deterministic local plan (identical algorithm to the server) so the reader can lay the
    // text out before the first byte arrives. The server's `start` plan replaces it.
    this.plan = planChunks(text, { mode });
    this.totalChunks = this.plan.length;
    this.wordsCache = {};
    this.wordTimestamps = true;
    this.emit({
      ...this.progressPatch(),
      plan: this.plan,
      totalChunks: this.totalChunks,
      startChunk: 0,
      chunkWords: this.wordsCache,
      wordTimestamps: true,
      activeChunk: -1,
      activeWord: -1,
      clock: 0,
      error: null,
      queuePosition: null,
      voice: opts.request.voice ?? '',
    });
  }

  get loadedText(): string {
    return this.text;
  }

  get isLoaded(): boolean {
    return this.request !== null;
  }

  /** Start or resume playback. */
  async play(): Promise<void> {
    if (!this.request) return;
    const epoch = this.sessionEpoch;
    await this.ensureSession();
    // stop() / load() / unload() ran while the audio session was being prepared: that session is
    // gone (or belongs to another document), so this play() must not start a stream for it.
    if (epoch !== this.sessionEpoch || !this.request) return;
    if (this.status === 'ended') {
      this.intent = 'playing';
      this.seekToChunk(this.plan[0]?.index ?? 0, null);
      return;
    }
    this.intent = 'playing';
    if (this.entries.length === 0 && !this.streamActive) {
      this.restartFrom(this.firstPlayableIndex(0), null);
      return;
    }
    if (this.entries.length > 0 && !this.stalled && !this.pendingSeek) {
      this.deps.playlist.play();
      this.setStatus('playing');
    } else {
      this.setStatus(this.entries.length ? 'buffering' : 'connecting');
    }
    this.deps.session?.setPlaying(true);
  }

  pause(): void {
    if (this.intent !== 'playing') return;
    this.intent = 'paused';
    this.deps.playlist.pause();
    this.deps.session?.setPlaying(false);
    this.setStatus('paused');
  }

  async toggle(): Promise<void> {
    if (this.intent === 'playing') this.pause();
    else await this.play();
  }

  /** Abort synthesis, clear the playlist and delete this session's cache files. */
  stop(): void {
    this.sessionEpoch++;
    this.abortStream();
    this.intent = 'stopped';
    this.pendingSeek = null;
    this.stalled = false;
    this.resetPlaylist();
    this.clearCache();
    this.failed.clear();
    this.deps.session?.deactivate();
    this.lastActiveChunk = -1;
    this.lastActiveWord = -1;
    this.setStatus('idle', {
      activeChunk: -1,
      activeWord: -1,
      clock: 0,
      received: [],
      failed: [],
      bufferedDuration: 0,
      queuePosition: null,
    });
  }

  /** Stop and forget the document. */
  unload(): void {
    this.stop();
    this.request = null;
    this.text = '';
    this.plan = [];
    this.totalChunks = 0;
  }

  next(): void {
    const cur = this.currentChunkIndex();
    const target = this.neighbour(cur, +1);
    if (target !== null) this.seekToChunk(target, null);
  }

  previous(): void {
    const cur = this.currentChunkIndex();
    // Like a music player: restart the current chunk if we're more than 2 s in.
    const pos = this.entryPosition(cur);
    if (pos >= 0 && this.deps.playlist.currentIndex === pos && this.deps.playlist.currentTime > 2) {
      this.seekToChunk(cur, null);
      return;
    }
    const target = this.neighbour(cur, -1);
    this.seekToChunk(target ?? cur, null);
  }

  /** Seek to the word/chunk covering a source-text offset (tap-to-seek in the reader). */
  seekToChar(offset: number): void {
    if (!this.request || this.plan.length === 0) return;
    let target = chunkIndexForOffset(this.plan, offset);
    if (target < 0) {
      // Between chunks (whitespace / unspeakable text): start at the next chunk.
      const nextChunk = this.plan.find((c) => c.char_start >= offset);
      if (!nextChunk) return;
      target = nextChunk.index;
      offset = nextChunk.char_start;
    }
    this.seekToChunk(target, offset);
  }

  /**
   * Change synthesis options (voice, speed, format...). Audio already synthesised no longer matches,
   * so the session restarts from the chunk being played.
   */
  updateRequest(patch: Partial<SynthesisOptions>): void {
    if (!this.request) return;
    const next = { ...this.request, ...patch };
    if (requestKey(next) === this.cacheKey) {
      this.request = next;
      return;
    }
    const prevMode = this.request.chunk_mode ?? 'balanced';
    const nextMode = next.chunk_mode ?? 'balanced';
    const from = this.currentChunkIndex();
    const fromOffset = this.plan.find((c) => c.index === from)?.char_start ?? 0;
    this.request = next;
    this.cacheKey = requestKey(next);
    this.abortStream();
    this.resetPlaylist();
    this.clearCache();
    this.failed.clear();
    let target = from;
    if (prevMode !== nextMode) {
      // Chunk indices change with the chunk mode: re-plan and map the position by text offset.
      this.plan = planChunks(this.text, { mode: nextMode });
      this.totalChunks = this.plan.length;
      this.wordsCache = {};
      target = Math.max(0, chunkIndexForOffset(this.plan, fromOffset));
      this.emit({ plan: this.plan, totalChunks: this.totalChunks, chunkWords: this.wordsCache });
    }
    this.emit({ voice: next.voice ?? '', ...this.progressPatch() });
    if (this.intent === 'stopped' || this.status === 'ended') {
      // Nothing is playing: the next play() synthesises with the new options.
      this.lastActiveChunk = -1;
      this.lastActiveWord = -1;
      return;
    }
    this.restartFrom(this.firstPlayableIndex(target >= 0 ? target : 0), null);
  }

  setVolume(volume: number): void {
    this.deps.playlist.volume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Read the playback position (synchronous JSI reads) and update the active chunk/word. Call from
   * a requestAnimationFrame loop while visible. Also detects buffer underruns and the end.
   */
  sample(): ClockSample | null {
    // While waiting for a seek target the playlist position is stale: keep the target shown.
    if (this.entries.length === 0 || this.pendingSeek) return null;
    // Queue ran dry (underrun) or finished: iOS then has no current item and reports
    // currentTime 0, which would jump the highlight back to the first word of the last chunk.
    if (this.stalled || this.status === 'ended') return null;
    const pl = this.deps.playlist;
    const tl = this.timeline.timeline;
    const pos = Math.min(Math.max(pl.currentIndex, 0), this.entries.length - 1);
    const tc = tl.chunks[pos];
    if (!tc) return null;
    const t = Math.min(Math.max(pl.currentTime, 0), tc.duration);
    const clock = tc.start + t;

    let wordIndex = -1;
    const gi = wordIndexAt(tl, clock);
    if (gi >= 0) {
      const w = tl.words[gi]!;
      if (w.chunkIndex === tc.index) wordIndex = w.wordIndex;
    }

    if (tc.index !== this.lastActiveChunk || wordIndex !== this.lastActiveWord) {
      this.lastActiveChunk = tc.index;
      this.lastActiveWord = wordIndex;
      this.emit({ activeChunk: tc.index, activeWord: wordIndex, clock });
    }

    this.detectEnd(pos, t, tc.duration);
    return { clock, chunkIndex: tc.index, wordIndex };
  }

  /** Feed expo-audio playlistStatusUpdate events (works in the background, when rAF is paused). */
  onPlaylistStatus(status: { didJustFinish?: boolean; playing?: boolean; currentIndex?: number }): void {
    if (this.entries.length === 0) return;
    const last = this.entries.length - 1;
    if (status.didJustFinish && (status.currentIndex ?? last) >= last) this.onReachedEnd();
  }

  /** Lock-screen / headset command mirrored from the OS media session. */
  remoteCommand(cmd: 'play' | 'pause'): void {
    if (cmd === 'pause') this.pause();
    else this.play().catch((err: unknown) => console.warn('[tamber] remote play failed', err));
  }

  get currentIntent(): Intent {
    return this.intent;
  }

  get currentStatus(): PlayerStatus {
    return this.status;
  }

  /** Test/debug view of the playlist mapping. */
  get playlistChunkIndices(): number[] {
    return this.entries.map((e) => e.chunkIndex);
  }

  // ------------------------------------------------------------------------------------------
  // Seeking
  // ------------------------------------------------------------------------------------------

  private seekToChunk(target: number, charOffset: number | null): void {
    if (!this.request) return;
    target = this.firstPlayableIndex(target);
    if (target < 0) return;
    this.stalled = false;
    const pos = this.entryPosition(target);
    if (pos >= 0) {
      this.pendingSeek = null;
      const entry = this.entries[pos]!;
      const offsetSec = charOffset === null ? 0 : wordStartForChar(entry.words, charOffset);
      const pl = this.deps.playlist;
      // Hold the audio while an in-track seek is pending, so the chunk start doesn't blip.
      if (offsetSec > 0) pl.pause();
      // skipTo starts the track at 0 (iOS rebuilds fresh items; Android seeks to the default
      // position), so a chunk-start seek needs no seekTo at all.
      pl.skipTo(pos);
      if (this.intent !== 'paused') {
        this.intent = 'playing';
        this.deps.session?.setPlaying(true);
        this.setStatus('playing');
      } else if (this.status === 'ended') {
        // Tapping a word after the end repositions without playing; Play then continues from here
        // (not from the beginning, which is what play() does in the 'ended' state).
        this.setStatus('paused');
      }
      this.markActive(entry.chunkIndex, -1, this.timeline.timeline.chunks[pos]?.start ?? 0);
      this.seekThenResume(pos, offsetSec);
      return;
    }
    const firstQueued = this.entries[0]?.chunkIndex ?? Number.POSITIVE_INFINITY;
    const aheadOfStream = target - this.streamNext;
    if (
      this.streamActive &&
      target > firstQueued &&
      target >= this.streamNext &&
      aheadOfStream <= this.seekWindow
    ) {
      // Arrives soon on the current stream: wait for it. A paused player stays paused.
      this.seekToken++;
      this.pendingSeek = { chunkIndex: target, charOffset };
      this.deps.playlist.pause();
      this.setStatus(this.intent === 'playing' ? 'buffering' : 'paused');
      this.markActive(target, -1, this.timeline.duration);
      return;
    }
    // Far ahead, behind the queued run, or the stream has ended: re-request from the target.
    if (this.intent !== 'paused') this.intent = 'playing';
    this.restartFrom(target, charOffset);
  }

  /**
   * Rebuild the playlist starting at plan index `from`: reuse cached chunks contiguous from there,
   * then stream the rest with start_chunk.
   */
  private restartFrom(from: number, charOffset: number | null): void {
    this.abortStream();
    this.resetPlaylist();
    this.stalled = false;
    this.pendingSeek = { chunkIndex: from, charOffset };
    let k: number | null = from;
    while (k !== null && this.cache.has(k)) {
      this.appendEntry(this.cache.get(k)!);
      k = this.neighbour(k, +1);
    }
    this.emit({ startChunk: from, ...this.progressPatch() });
    if (k !== null && k < this.totalChunks) {
      void this.startStream(k);
    } else {
      this.streamDone = true;
    }
    if (this.entries.length > 0) this.startQueuedPlayback();
    else this.setStatus('connecting');
  }

  /** First entry is in the playlist: apply any pending seek and start if the user wants audio. */
  private startQueuedPlayback(): void {
    const pl = this.deps.playlist;
    const ps = this.pendingSeek;
    let pos = -1;
    let offsetSec = 0;
    if (ps) {
      const exact = this.entryPosition(ps.chunkIndex);
      const usable = exact >= 0 ? exact : this.entries.findIndex((e) => e.chunkIndex > ps.chunkIndex);
      if (usable < 0) return; // still waiting for the target
      this.pendingSeek = null;
      const entry = this.entries[usable]!;
      offsetSec =
        ps.charOffset === null || usable !== exact ? 0 : wordStartForChar(entry.words, ps.charOffset);
      if (offsetSec > 0) pl.pause();
      if (usable !== 0 || pl.currentIndex !== 0) pl.skipTo(usable);
      pos = usable;
      this.markActive(entry.chunkIndex, -1, this.timeline.timeline.chunks[usable]?.start ?? 0);
    }
    if (this.intent === 'playing') {
      this.deps.session?.setPlaying(true);
      this.setStatus('playing');
    } else if (this.intent === 'paused') {
      this.setStatus('paused');
    }
    this.seekThenResume(pos, offsetSec);
  }

  /**
   * Seek `offsetSec` into playlist track `pos` (already skipped to), then start playback if the
   * user wants audio.
   *
   * iOS: AudioPlaylist.skipTo()/add() create fresh AVPlayerItems, and AVFoundation raises an
   * exception for a completion-handler seek on an item that is not readyToPlay yet. So the seek
   * waits until the current track reports isLoaded (polling, bounded); if it never does, playback
   * starts at the chunk start instead of risking the native seek. Android/ExoPlayer accepts early
   * seeks and usually reports isLoaded already. No offset = no seek.
   */
  private seekThenResume(pos: number, offsetSec: number): void {
    const pl = this.deps.playlist;
    const token = ++this.seekToken;
    const resume = () => {
      if (token === this.seekToken && this.intent === 'playing') pl.play();
    };
    if (!(offsetSec > 0) || pos < 0) {
      resume();
      return;
    }
    const deadline = Date.now() + SEEK_READY_TIMEOUT_MS;
    const attempt = (): void => {
      if (token !== this.seekToken) return; // superseded by a newer seek, stop or restart
      if (pl.currentIndex === pos && pl.isLoaded !== false) {
        pl.seekTo(offsetSec)
          .catch(() => undefined)
          .then(resume, resume);
      } else if (Date.now() < deadline) {
        setTimeout(attempt, SEEK_READY_POLL_MS);
      } else {
        resume();
      }
    };
    attempt();
  }

  // ------------------------------------------------------------------------------------------
  // Streaming
  // ------------------------------------------------------------------------------------------

  private async startStream(fromChunk: number): Promise<void> {
    const request = this.request;
    if (!request) return;
    const gen = ++this.generation;
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    this.streamActive = true;
    this.streamDone = false;
    this.streamNext = fromChunk;
    let requestId = '';
    try {
      const client = this.deps.getClient(ctrl.signal);
      const events = client.synthesize(
        { ...request, text: this.text, stream: true, start_chunk: fromChunk },
        { signal: ctrl.signal },
      );
      for await (const ev of events) {
        if (gen !== this.generation) return;
        switch (ev.type) {
          case 'start': {
            requestId = ev.request_id || `req${gen}`;
            this.requestIds.add(requestId);
            this.plan = ev.chunks;
            this.totalChunks = ev.total_chunks;
            this.wordTimestamps = ev.word_timestamps;
            this.emit({
              plan: ev.chunks,
              totalChunks: ev.total_chunks,
              startChunk: ev.start_chunk,
              wordTimestamps: ev.word_timestamps,
              voice: ev.voice,
              queuePosition: null,
            });
            break;
          }
          case 'queued':
            this.emit({ queuePosition: ev.position });
            if (this.entries.length === 0) this.setStatus('queued');
            break;
          case 'chunk':
            this.handleChunk(ev, requestId || `req${gen}`);
            break;
          case 'error':
            if (typeof ev.index === 'number') {
              this.failed.add(ev.index);
              this.streamNext = Math.max(this.streamNext, ev.index + 1);
              this.emit(this.progressPatch());
              this.toast(`Couldn't read part ${ev.index + 1}; skipping it.`, 'warning');
              this.resolvePendingPastFailure();
            }
            break;
          case 'done':
            break;
          default:
            break;
        }
      }
      if (gen !== this.generation) return;
      this.streamActive = false;
      this.streamDone = true;
      this.emit({ queuePosition: null });
      this.checkEndAfterStream();
    } catch (err) {
      if (gen !== this.generation || isAbortError(err) || ctrl.signal.aborted) return;
      this.streamActive = false;
      this.streamDone = true;
      const message = errorMessage(err);
      if (this.entries.length === 0) {
        this.intent = 'stopped';
        this.setStatus('error', { error: message, queuePosition: null });
      } else {
        this.emit({ queuePosition: null });
        this.toast(`Reading stopped early: ${message}`, 'error');
        this.checkEndAfterStream();
      }
    } finally {
      if (this.abortCtrl === ctrl) this.abortCtrl = null;
    }
  }

  private handleChunk(ev: TtsChunkEvent, requestId: string): void {
    this.streamNext = Math.max(this.streamNext, ev.index + 1);
    let uri: string;
    try {
      uri = this.deps.files.write(requestId, ev.index, ev.format, ev.audio);
    } catch (err) {
      this.failed.add(ev.index);
      this.emit(this.progressPatch());
      this.toast(`Couldn't store audio for part ${ev.index + 1}: ${errorMessage(err)}`, 'warning');
      this.resolvePendingPastFailure();
      return;
    }
    const entry: Entry = {
      chunkIndex: ev.index,
      uri,
      // Server duration is exact for WAV; MP3's nominal value is close enough for the timeline.
      duration: ev.duration,
      charStart: ev.char_start,
      charEnd: ev.char_end,
      words: ev.words,
    };
    this.cache.set(ev.index, entry);
    const last = this.entries[this.entries.length - 1];
    const wasEmpty = this.entries.length === 0;
    const wasAtEnd = !wasEmpty && this.isAtEnd();
    const appended = !last || ev.index > last.chunkIndex;
    if (appended) this.appendEntry(entry);
    this.emit({
      ...this.progressPatch(),
      chunkWords: this.wordsPatch(ev.index, ev.words),
    });

    if (wasEmpty || this.pendingSeek) {
      this.startQueuedPlayback();
      return;
    }
    if (appended && (this.stalled || (wasAtEnd && this.intent === 'playing'))) {
      // Synthesis fell behind playback and the queue ran dry: continue with the new chunk. This
      // also runs when the user paused during the underrun, so the next play() resumes here instead
      // of waiting (in 'buffering') for a chunk that already arrived.
      this.stalled = false;
      this.seekToken++;
      this.deps.playlist.skipTo(this.entries.length - 1);
      if (this.intent === 'playing') {
        this.deps.playlist.play();
        this.setStatus('playing');
      }
    }
  }

  private appendEntry(entry: Entry): void {
    this.deps.playlist.add({ uri: entry.uri });
    this.timeline.add(
      {
        index: entry.chunkIndex,
        char_start: entry.charStart,
        char_end: entry.charEnd,
        duration: entry.duration,
        words: entry.words,
      },
      entry.duration,
    );
    this.entries.push(entry);
  }

  /** A pending seek whose target chunk failed moves on to the next chunk that arrives. */
  private resolvePendingPastFailure(): void {
    const ps = this.pendingSeek;
    if (ps && this.failed.has(ps.chunkIndex)) {
      const next = this.neighbour(ps.chunkIndex, +1);
      if (next === null) {
        // The target failed and nothing after it is playable: this is the end of the text.
        // (Clearing the seek and doing nothing would leave the player in 'buffering' forever.)
        this.pendingSeek = null;
        if (this.entries.length > 0) this.finish();
        return;
      }
      this.pendingSeek = { chunkIndex: next, charOffset: null };
      if (this.entryPosition(next) >= 0) this.startQueuedPlayback();
    }
  }

  // ------------------------------------------------------------------------------------------
  // End / underrun detection
  // ------------------------------------------------------------------------------------------

  private isAtEnd(): boolean {
    const pl = this.deps.playlist;
    const lastPos = this.entries.length - 1;
    if (lastPos < 0 || pl.playing) return false;
    if (this.stalled) return true;
    const last = this.entries[lastPos]!;
    return pl.currentIndex >= lastPos && pl.currentTime >= last.duration - END_EPSILON;
  }

  private detectEnd(pos: number, t: number, duration: number): void {
    if (this.intent !== 'playing' || this.pendingSeek) return;
    const pl = this.deps.playlist;
    if (pl.playing) return;
    if (pos === this.entries.length - 1 && t >= duration - END_EPSILON) this.onReachedEnd();
  }

  private onReachedEnd(): void {
    if (this.intent !== 'playing' || this.pendingSeek) return;
    if (this.streamDone && !this.streamActive) {
      this.finish();
    } else if (!this.stalled) {
      this.stalled = true;
      this.setStatus('buffering');
    }
  }

  private checkEndAfterStream(): void {
    if (this.pendingSeek && this.entries.length > 0) {
      // The stream ended (done, fatal error or cut) without delivering the seek target or anything
      // after it: nothing more will arrive, so finish instead of buffering forever.
      this.pendingSeek = null;
      this.stalled = false;
      this.finish();
      return;
    }
    if (this.stalled || (this.entries.length > 0 && this.isAtEnd() && this.intent === 'playing')) {
      this.stalled = false;
      this.finish();
    } else if (this.entries.length === 0 && this.intent === 'playing') {
      // Every chunk failed.
      this.intent = 'stopped';
      this.setStatus('error', { error: 'The server could not read any part of this text.' });
    }
  }

  private finish(): void {
    this.intent = 'paused';
    this.deps.playlist.pause();
    this.deps.session?.setPlaying(false);
    const lastChunk = this.entries[this.entries.length - 1];
    this.lastActiveWord = -1;
    this.setStatus('ended', {
      activeWord: -1,
      activeChunk: lastChunk?.chunkIndex ?? -1,
      clock: this.timeline.duration,
    });
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  private async ensureSession(): Promise<void> {
    const session = this.deps.session;
    if (!session) return;
    if (!this.sessionPrepared) {
      try {
        await session.prepare();
        this.sessionPrepared = true;
      } catch (err) {
        console.warn('[tamber] audio session setup failed', err);
      }
    }
    session.activate({
      title: this.title || 'Tamber',
      artist: 'Tamber',
      albumTitle: this.request?.voice ?? '',
    });
  }

  private abortStream(): void {
    this.generation++;
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.streamActive = false;
  }

  private resetPlaylist(): void {
    this.seekToken++;
    try {
      this.deps.playlist.pause();
      this.deps.playlist.clear();
    } catch (err) {
      console.warn('[tamber] playlist reset failed', err);
    }
    this.entries = [];
    this.timeline = new TimelineBuilder();
  }

  private clearCache(): void {
    this.cache.clear();
    if (this.requestIds.size > 0) {
      try {
        this.deps.files.remove([...this.requestIds]);
      } catch (err) {
        console.warn('[tamber] cache cleanup failed', err);
      }
      this.requestIds.clear();
    }
  }

  private entryPosition(chunkIndex: number): number {
    // entries are sorted by chunkIndex: binary search.
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.entries[mid]!.chunkIndex;
      if (c === chunkIndex) return mid;
      if (c < chunkIndex) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private currentChunkIndex(): number {
    if (this.lastActiveChunk >= 0) return this.lastActiveChunk;
    const pos = this.deps.playlist.currentIndex;
    return this.entries[pos]?.chunkIndex ?? this.entries[0]?.chunkIndex ?? this.plan[0]?.index ?? 0;
  }

  /** Adjacent plan index in direction dir that did not fail, or null. */
  private neighbour(index: number, dir: 1 | -1): number | null {
    let i = this.plan.findIndex((c) => c.index === index);
    if (i < 0) return null;
    for (i += dir; i >= 0 && i < this.plan.length; i += dir) {
      const idx = this.plan[i]!.index;
      if (!this.failed.has(idx)) return idx;
    }
    return null;
  }

  private firstPlayableIndex(from: number): number {
    if (!this.failed.has(from)) return from;
    return this.neighbour(from, +1) ?? -1;
  }

  private markActive(chunkIndex: number, wordIndex: number, clock: number): void {
    this.lastActiveChunk = chunkIndex;
    this.lastActiveWord = wordIndex;
    this.emit({ activeChunk: chunkIndex, activeWord: wordIndex, clock });
  }

  private wordsCache: Record<number, readonly WordTiming[]> = {};

  private wordsPatch(index: number, words: readonly WordTiming[]): Record<number, readonly WordTiming[]> {
    this.wordsCache = { ...this.wordsCache, [index]: words };
    return this.wordsCache;
  }

  private progressPatch(): Partial<PlayerSnapshot> {
    const received = [...this.cache.keys()].sort((a, b) => a - b);
    let buffered = 0;
    for (const e of this.cache.values()) buffered += e.duration;
    return {
      received,
      failed: [...this.failed].sort((a, b) => a - b),
      bufferedDuration: buffered,
    };
  }

  private setStatus(status: PlayerStatus, extra: Partial<PlayerSnapshot> = {}): void {
    this.status = status;
    if (status !== 'error') extra = { error: null, ...extra };
    if (status === 'playing' || status === 'paused' || status === 'buffering') {
      extra = { queuePosition: null, ...extra };
    }
    this.emit({ status, ...extra });
  }

  private emit(patch: Partial<PlayerSnapshot>): void {
    this.deps.onUpdate(patch);
  }

  private toast(message: string, tone: ToastTone): void {
    this.deps.onToast?.(message, tone);
  }
}

/** Start time (chunk-relative) of the word covering `charOffset`, else 0 (chunk start). */
export function wordStartForChar(words: readonly WordTiming[], charOffset: number): number {
  for (const w of words) {
    if (charOffset < w.char_start) return w.start;
    if (charOffset < w.char_end) return w.start;
  }
  return 0;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return String(err);
}
