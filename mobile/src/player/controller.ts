/**
 * App-wide playback controller. Owns the single StreamPlayer, its expo-audio AudioPlaylist and the
 * lock-screen session, so playback survives screen changes and continues in the background.
 *
 * openContent() is the one entry point for everything the user wants read: typed/pasted text,
 * links, documents, library items and OS share-sheet payloads.
 */
import { ttsRequestFromSettings, type TamberSettings } from '@tamber/client';
import { createAudioPlaylist, type AudioPlaylist } from 'expo-audio';

import { getClient, getStreamingClient } from '@/api/client';
import { extractFromFile, extractFromUrl, type FileInput } from '@/content/extract';
import { readLibraryText, useLibrary, type LibrarySourceKind } from '@/store/library';
import { usePlayback } from '@/store/playback';
import { getSettings, useSettings } from '@/store/settings';

import { LockScreenSession } from './audioSession';
import { chunkFiles } from './chunkFiles';
import { StreamPlayer, type SynthesisOptions } from './StreamPlayer';

let player: StreamPlayer | null = null;
let playlist: AudioPlaylist | null = null;
let session: LockScreenSession | null = null;
let unsubscribeSettings: (() => void) | null = null;

export function synthesisOptionsFromSettings(settings: TamberSettings): SynthesisOptions {
  const { text: _text, stream: _stream, ...rest } = ttsRequestFromSettings(settings, '');
  return rest;
}

function sameSynthesis(a: TamberSettings, b: TamberSettings): boolean {
  return (
    a.voice === b.voice &&
    a.speed === b.speed &&
    a.format === b.format &&
    a.lang === b.lang &&
    a.chunkMode === b.chunkMode
  );
}

/** The StreamPlayer singleton (created on first use; needs the native audio module). */
export function getPlayer(): StreamPlayer {
  if (player) return player;
  playlist = createAudioPlaylist({ loop: 'none', updateInterval: 250 });
  session = new LockScreenSession((cmd) => player?.remoteCommand(cmd));
  const created = new StreamPlayer({
    playlist,
    files: chunkFiles,
    getClient: getStreamingClient,
    session,
    onUpdate: (patch) => usePlayback.getState().apply(patch),
    onToast: (message, tone) => usePlayback.getState().showToast(message, tone),
  });
  player = created;
  // Native status events (every 250 ms, also in the background) drive end/underrun detection and
  // coarse progress on every screen; the player screen adds a rAF loop for word-accurate timing.
  playlist.addListener('playlistStatusUpdate', (status) => {
    created.onPlaylistStatus(status);
    created.sample();
  });
  created.setVolume(getSettings().volume);
  unsubscribeSettings = useSettings.subscribe((state, prev) => {
    const s = state.settings;
    const p = prev.settings;
    if (s.volume !== p.volume) created.setVolume(s.volume);
    if (!sameSynthesis(s, p)) created.updateRequest(synthesisOptionsFromSettings(s));
  });
  return created;
}

/** For tests / hot reload. */
export function disposePlayer(): void {
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  player?.unload();
  session?.release();
  playlist?.destroy();
  player = null;
  playlist = null;
  session = null;
}

export type ContentRequest =
  | { kind: 'text'; text: string; title?: string | null; source?: string; libraryKind?: LibrarySourceKind }
  | { kind: 'url'; url: string; title?: string | null; fallbackText?: string | null; fromShare?: boolean }
  | ({ kind: 'file'; fromShare?: boolean } & FileInput)
  | { kind: 'library'; id: string };

let openToken = 0;

function labelFor(req: ContentRequest): string | null {
  switch (req.kind) {
    case 'url':
      return 'Fetching the page...';
    case 'file':
      return `Reading ${req.name}...`;
    case 'library':
      return 'Opening...';
    default:
      return null;
  }
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as Error).message);
  return String(err);
}

/**
 * Resolve a request to text (extracting when needed), record it in the library, load it into the
 * player and optionally start playback. Returns false when nothing could be loaded. A newer call
 * supersedes an older one still extracting.
 */
export async function openContent(req: ContentRequest, opts: { autoStart: boolean }): Promise<boolean> {
  const token = ++openToken;
  const pb = usePlayback.getState();
  const settings = getSettings();
  if (!settings.apiBaseUrl) {
    pb.showToast('Connect to your Tamber server first.', 'warning');
    return false;
  }
  const p = getPlayer();
  p.unload();
  pb.resetSession();
  const label = labelFor(req);
  pb.setExtracting(label);
  if (label) pb.apply({ status: 'extracting' });

  let text = '';
  let title: string | null = null;
  let source = '';
  let kind: LibrarySourceKind = 'text';
  try {
    switch (req.kind) {
      case 'text':
        text = req.text;
        title = req.title ?? null;
        source = req.source ?? '';
        kind = req.libraryKind ?? 'text';
        break;
      case 'url': {
        kind = req.fromShare ? 'share' : 'url';
        source = req.url;
        try {
          const c = await extractFromUrl(getClient(), req.url);
          text = c.text;
          title = c.title ?? req.title ?? null;
          if (c.truncated) pb.showToast('This page is very long; reading the first part.', 'info');
        } catch (err) {
          if (!req.fallbackText) throw err;
          text = req.fallbackText;
          title = req.title ?? null;
          pb.showToast(`Couldn't fetch the page (${describeError(err)}). Reading what was shared.`, 'warning');
        }
        break;
      }
      case 'file': {
        kind = req.fromShare ? 'share' : 'file';
        source = req.name;
        const c = await extractFromFile(getClient(), req);
        text = c.text;
        title = c.title ?? req.name.replace(/\.[^.]+$/, '');
        if (c.truncated) pb.showToast('This document is very long; reading the first part.', 'info');
        break;
      }
      case 'library': {
        const item = useLibrary.getState().items.find((i) => i.id === req.id);
        const stored = await readLibraryText(req.id);
        if (!item || stored === null) throw new Error('This item is no longer available.');
        text = stored;
        title = item.title;
        source = item.source;
        kind = item.kind;
        break;
      }
    }
  } catch (err) {
    if (token !== openToken) return false;
    const message = describeError(err);
    pb.setExtracting(null);
    pb.apply({ status: 'error', error: message });
    pb.showToast(message, 'error');
    return false;
  }
  if (token !== openToken) return false;
  pb.setExtracting(null);

  if (!text.trim()) {
    pb.apply({ status: 'error', error: 'There is nothing to read.' });
    return false;
  }

  const item = useLibrary.getState().add({ title, source, kind, text });
  pb.setDoc({ title: item.title, text, source, kind, libraryId: item.id });
  p.load(text, { title: item.title, request: synthesisOptionsFromSettings(getSettings()) });
  if (opts.autoStart) await p.play().catch(reportPlaybackError);
  return true;
}

/** Callers fire-and-forget these; a native failure becomes a toast, never an unhandled rejection. */
function reportPlaybackError(err: unknown): void {
  usePlayback.getState().showToast(`Playback failed: ${describeError(err)}`, 'error');
}

export const playerActions = {
  toggle: () => getPlayer().toggle().catch(reportPlaybackError),
  play: () => getPlayer().play().catch(reportPlaybackError),
  pause: () => getPlayer().pause(),
  stop: () => getPlayer().stop(),
  next: () => getPlayer().next(),
  previous: () => getPlayer().previous(),
  seekToChar: (offset: number) => getPlayer().seekToChar(offset),
};
