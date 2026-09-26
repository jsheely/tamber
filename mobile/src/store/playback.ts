/**
 * In-memory playback state shared by the player screen, the reader, the mini player bar and the
 * share-intent router. Not persisted: a playback session does not survive an app restart (the
 * document itself does, in the library).
 *
 * StreamPlayer pushes snapshots here through its onUpdate callback; UI components subscribe with
 * narrow selectors so a word change re-renders only the active chunk.
 */
import type { ChunkSpan, WordTiming } from '@tamber/client';
import { create } from 'zustand';

import type { LibrarySourceKind } from './library';

export type PlayerStatus =
  | 'idle'
  | 'extracting'
  | 'connecting'
  | 'queued'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export interface PlaybackDocument {
  title: string;
  text: string;
  source: string;
  kind: LibrarySourceKind;
  libraryId?: string;
}

export type ToastTone = 'info' | 'warning' | 'error' | 'success';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export interface PlayerSnapshot {
  status: PlayerStatus;
  /** Full chunk plan (local planChunks() until the server's `start` event replaces it). */
  plan: ChunkSpan[];
  totalChunks: number;
  startChunk: number;
  /** Plan indices whose audio has arrived in this session. */
  received: number[];
  /** Plan indices the server skipped (non-fatal errors). */
  failed: number[];
  wordTimestamps: boolean;
  /** Word timings per plan index (chunk-relative), for the reader's word spans. */
  chunkWords: Readonly<Record<number, readonly WordTiming[]>>;
  /** Plan index of the chunk being spoken, or -1. */
  activeChunk: number;
  /** Index into chunkWords[activeChunk] of the word being spoken, or -1. */
  activeWord: number;
  /** Absolute seconds on the playback timeline (for progress UI). */
  clock: number;
  /** Seconds of audio received so far in this session. */
  bufferedDuration: number;
  /** Position in the server's synthesis queue while waiting (1 = next), else null. */
  queuePosition: number | null;
  error: string | null;
  /** Canonical voice spec the server is using. */
  voice: string;
}

export interface PlaybackState extends PlayerSnapshot {
  doc: PlaybackDocument | null;
  /** Label for the extraction spinner ("Fetching article..."), or null. */
  extracting: string | null;
  toast: Toast | null;
  apply: (patch: Partial<PlayerSnapshot>) => void;
  setDoc: (doc: PlaybackDocument | null) => void;
  setExtracting: (label: string | null) => void;
  showToast: (message: string, tone?: ToastTone) => void;
  dismissToast: () => void;
  resetSession: () => void;
}

export const INITIAL_SNAPSHOT: PlayerSnapshot = {
  status: 'idle',
  plan: [],
  totalChunks: 0,
  startChunk: 0,
  received: [],
  failed: [],
  wordTimestamps: true,
  chunkWords: {},
  activeChunk: -1,
  activeWord: -1,
  clock: 0,
  bufferedDuration: 0,
  queuePosition: null,
  error: null,
  voice: '',
};

let toastSeq = 0;

export const usePlayback = create<PlaybackState>()((set) => ({
  ...INITIAL_SNAPSHOT,
  doc: null,
  extracting: null,
  toast: null,
  apply: (patch) => set(patch),
  setDoc: (doc) => set({ doc }),
  setExtracting: (extracting) => set({ extracting }),
  showToast: (message, tone = 'info') => set({ toast: { id: ++toastSeq, message, tone } }),
  dismissToast: () => set({ toast: null }),
  resetSession: () => set({ ...INITIAL_SNAPSHOT }),
}));

export function isBusy(status: PlayerStatus): boolean {
  return status === 'connecting' || status === 'queued' || status === 'buffering';
}

export function isActive(status: PlayerStatus): boolean {
  return status !== 'idle' && status !== 'ended' && status !== 'error' && status !== 'extracting';
}
