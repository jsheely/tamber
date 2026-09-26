/**
 * The one typed message protocol shared by every extension context.
 *
 * Every runtime message carries a `target`:
 * - `offscreen`: commands for the playback engine (the offscreen document owns the audio).
 * - `background`: requests for the service worker (lifecycle, relays, reads that need tabs).
 * - `ui`: notifications for popup / side panel / options / mini-player.
 *
 * `runtime.sendMessage` fans out to *every* extension page (including the offscreen document), so
 * every listener validates `target` and ignores everything else. High-frequency playback state goes
 * over `runtime.connect` ports named {@link PLAYER_PORT} instead (see {@link PortMessage}).
 */
import type { ChunkSpan, TamberSettings } from '@tamber/client';

export const PLAYER_PORT = 'tamber-player';

export type MessageTarget = 'offscreen' | 'background' | 'ui';

// ---------------------------------------------------------------------------------------------
// Player state (owned by the offscreen document)
// ---------------------------------------------------------------------------------------------

export type PlayerStatus =
  'idle' | 'loading' | 'queued' | 'playing' | 'paused' | 'error' | 'needs-gesture';

/** A span of the source text, UTF-16 offsets, half-open. */
export interface CharSpan {
  charStart: number;
  charEnd: number;
}

/** Word spans of one received chunk, as compact `[charStart, charEnd]` pairs. */
export interface ChunkWords {
  index: number;
  words: Array<[number, number]>;
}

export interface PlayerState {
  status: PlayerStatus;
  /** Increments on every new `play`, so UIs can reset per-session caches. */
  sessionId: number;
  /** The exact text sent to the API (offsets index into it). */
  text: string;
  title: string | null;
  sourceUrl: string | null;
  /** Tab the reading came from (the mini-player lives there), if any. */
  tabId: number | null;
  /** Full chunk plan from the `start` event ([] until it arrives). */
  plan: ChunkSpan[];
  /** Plan indices whose audio has been received and decoded. */
  receivedChunks: number[];
  totalChunks: number;
  /** Plan index being heard, or -1. */
  activeChunk: number;
  /** Source span of the word being heard, or null (no word timings, or between chunks). */
  activeWord: CharSpan | null;
  /** Seconds on the playback timeline (sum of received chunk durations before the playhead). */
  position: number;
  /** Seconds of decoded audio on the timeline. */
  bufferedDuration: number;
  /** Estimated total seconds, extrapolated from the received chunks' seconds-per-character. */
  estimatedDuration: number;
  /** 0..1 through the text (character based, so it stays right across seeks and re-requests). */
  progress: number;
  /** False when the language has no word timings (sentence-level highlight only). */
  wordTimestamps: boolean;
  /** Queue position while waiting for a synthesis slot. */
  queuePosition: number | null;
  /** Server finished sending (done event). */
  streamDone: boolean;
  /** Playback reached the end of the text. */
  ended: boolean;
  voice: string;
  speed: number;
  volume: number;
  error: string | null;
  /** Non-fatal notice (e.g. a skipped chunk). */
  notice: string | null;
}

export function createIdleState(partial: Partial<PlayerState> = {}): PlayerState {
  return {
    status: 'idle',
    sessionId: 0,
    text: '',
    title: null,
    sourceUrl: null,
    tabId: null,
    plan: [],
    receivedChunks: [],
    totalChunks: 0,
    activeChunk: -1,
    activeWord: null,
    position: 0,
    bufferedDuration: 0,
    estimatedDuration: 0,
    progress: 0,
    wordTimestamps: true,
    queuePosition: null,
    streamDone: false,
    ended: false,
    voice: '',
    speed: 1,
    volume: 1,
    error: null,
    notice: null,
    ...partial,
  };
}

/** Everything the in-page mini-player needs, small enough to relay on every word change. */
export interface MiniState {
  status: PlayerStatus;
  sessionId: number;
  title: string | null;
  /** Text of the active chunk (sentence), or ''. */
  sentence: string;
  /** Active word as offsets into `sentence`, or null. */
  word: [number, number] | null;
  /** 0..1 */
  progress: number;
  tabId: number | null;
  error: string | null;
}

export function toMiniState(s: PlayerState): MiniState {
  const active = s.activeChunk >= 0 ? s.plan[s.activeChunk] : undefined;
  const span = active ?? (s.status === 'loading' || s.status === 'queued' ? s.plan[0] : undefined);
  const sentence = span ? s.text.slice(span.char_start, span.char_end) : '';
  let word: [number, number] | null = null;
  if (span && s.activeWord) {
    const a = s.activeWord.charStart - span.char_start;
    const b = s.activeWord.charEnd - span.char_start;
    if (a >= 0 && b <= sentence.length && b > a) word = [a, b];
  }
  return {
    status: s.status,
    sessionId: s.sessionId,
    title: s.title,
    sentence,
    word,
    progress: s.ended ? 1 : s.progress,
    tabId: s.tabId,
    error: s.error,
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime messages
// ---------------------------------------------------------------------------------------------

export interface PlayRequest {
  text: string;
  title?: string | null;
  sourceUrl?: string | null;
  tabId?: number | null;
  /** Start reading at this plan index (resume a closed session). */
  startChunk?: number;
}

export type OffscreenMessage =
  | ({ target: 'offscreen'; type: 'play'; settings: TamberSettings } & PlayRequest)
  | { target: 'offscreen'; type: 'pause' }
  | { target: 'offscreen'; type: 'resume' }
  | { target: 'offscreen'; type: 'toggle' }
  | { target: 'offscreen'; type: 'stop' }
  | { target: 'offscreen'; type: 'seekToChar'; offset: number }
  | { target: 'offscreen'; type: 'seekChunk'; index: number }
  | { target: 'offscreen'; type: 'next' }
  | { target: 'offscreen'; type: 'previous' }
  | { target: 'offscreen'; type: 'setSpeed'; speed: number }
  | { target: 'offscreen'; type: 'setVolume'; volume: number }
  | { target: 'offscreen'; type: 'updateSettings'; settings: TamberSettings }
  | { target: 'offscreen'; type: 'getState' };

/** Commands routed through the background, which can also resume a session whose offscreen doc closed. */
export type ControlCommand = 'toggle' | 'pause' | 'resume' | 'stop' | 'next' | 'previous';

export type StateReason = 'status' | 'word' | 'chunk' | 'tick';

/** Last session, persisted by the background (storage.session) so a closed offscreen doc can resume. */
export interface SavedSession {
  text: string;
  title: string | null;
  sourceUrl: string | null;
  tabId: number | null;
  chunk: number;
  sessionId: number;
}

export type BackgroundMessage =
  | { target: 'background'; type: 'state'; state: MiniState; reason: StateReason; chunk: number }
  | { target: 'background'; type: 'session'; session: SavedSession | null }
  | { target: 'background'; type: 'ensureOffscreen' }
  | ({ target: 'background'; type: 'play' } & PlayRequest)
  | { target: 'background'; type: 'control'; command: ControlCommand }
  | { target: 'background'; type: 'closeOffscreen'; reason: 'stopped' | 'idle' }
  | { target: 'background'; type: 'getMiniState' }
  | { target: 'background'; type: 'hideMiniPlayer' }
  /** Read a tab's selection, or its readable text when nothing is selected (popup button). */
  | { target: 'background'; type: 'readTab'; tabId: number };

export type UiMessage =
  | { target: 'ui'; type: 'offscreenReady' }
  | { target: 'ui'; type: 'miniState'; state: MiniState }
  | { target: 'ui'; type: 'miniHide' };

export type ExtensionMessage = OffscreenMessage | BackgroundMessage | UiMessage;

// ---------------------------------------------------------------------------------------------
// Port messages (offscreen -> UI, high frequency)
// ---------------------------------------------------------------------------------------------

export type PortMessage =
  /** Full state plus every word span received so far (sent on connect and on new sessions). */
  | { type: 'snapshot'; state: PlayerState; words: ChunkWords[] }
  /** Partial state update (status, position, active word ...). */
  | { type: 'patch'; patch: Partial<PlayerState> }
  /** Word spans of a newly received chunk. */
  | { type: 'chunk'; chunk: ChunkWords };

// ---------------------------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------------------------

const OFFSCREEN_TYPES: ReadonlySet<string> = new Set<OffscreenMessage['type']>([
  'play',
  'pause',
  'resume',
  'toggle',
  'stop',
  'seekToChar',
  'seekChunk',
  'next',
  'previous',
  'setSpeed',
  'setVolume',
  'updateSettings',
  'getState',
]);

const BACKGROUND_TYPES: ReadonlySet<string> = new Set<BackgroundMessage['type']>([
  'state',
  'session',
  'ensureOffscreen',
  'play',
  'control',
  'closeOffscreen',
  'getMiniState',
  'hideMiniPlayer',
  'readTab',
]);

const UI_TYPES: ReadonlySet<string> = new Set<UiMessage['type']>([
  'offscreenReady',
  'miniState',
  'miniHide',
]);

const CONTROL_COMMANDS: ReadonlySet<string> = new Set<ControlCommand>([
  'toggle',
  'pause',
  'resume',
  'stop',
  'next',
  'previous',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isOffscreenMessage(msg: unknown): msg is OffscreenMessage {
  if (!isRecord(msg) || msg.target !== 'offscreen' || typeof msg.type !== 'string') return false;
  if (!OFFSCREEN_TYPES.has(msg.type)) return false;
  switch (msg.type) {
    case 'play':
      return typeof msg.text === 'string' && isRecord(msg.settings);
    case 'seekToChar':
      return isFiniteNumber(msg.offset);
    case 'seekChunk':
      return isFiniteNumber(msg.index);
    case 'setSpeed':
      return isFiniteNumber(msg.speed);
    case 'setVolume':
      return isFiniteNumber(msg.volume);
    case 'updateSettings':
      return isRecord(msg.settings);
    default:
      return true;
  }
}

export function isBackgroundMessage(msg: unknown): msg is BackgroundMessage {
  if (!isRecord(msg) || msg.target !== 'background' || typeof msg.type !== 'string') return false;
  if (!BACKGROUND_TYPES.has(msg.type)) return false;
  switch (msg.type) {
    case 'state':
      return isRecord(msg.state);
    case 'play':
      return typeof msg.text === 'string';
    case 'control':
      return typeof msg.command === 'string' && CONTROL_COMMANDS.has(msg.command);
    case 'readTab':
      return isFiniteNumber(msg.tabId);
    default:
      return true;
  }
}

export function isUiMessage(msg: unknown): msg is UiMessage {
  return (
    isRecord(msg) && msg.target === 'ui' && typeof msg.type === 'string' && UI_TYPES.has(msg.type)
  );
}

export function isPortMessage(msg: unknown): msg is PortMessage {
  if (!isRecord(msg)) return false;
  return (
    (msg.type === 'snapshot' && isRecord(msg.state) && Array.isArray(msg.words)) ||
    (msg.type === 'patch' && isRecord(msg.patch)) ||
    (msg.type === 'chunk' && isRecord(msg.chunk))
  );
}

/** True for the "nobody is listening" errors runtime/tabs.sendMessage throw when a context is gone. */
export function isNoReceiverError(err: unknown): boolean {
  const m = String((err as { message?: unknown } | null)?.message ?? err);
  return /Receiving end does not exist|Could not establish connection|message port closed|No tab with id/i.test(
    m,
  );
}
