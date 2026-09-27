/**
 * Gesture-level playback actions shared by buttons, hotkeys and the reader. Each one calls
 * player.unlock() synchronously before anything else (the iOS gesture rule), then does the rest.
 */
import { notifications } from '@mantine/notifications';
import { isSingleVoiceId } from '@tamber/client';
import { getClient } from '../api/useTamberClient';
import { notifyError } from '../api/errors';
import { slugify } from '../lib/format';
import { useDraft } from '../store/draft';
import { useSession } from '../store/session';
import { getSettings } from '../store/settings';
import type { PlayRequest } from './ChunkedPlayer';
import { getPlayer } from './instance';

export function currentRequest(text: string): PlayRequest {
  const s = getSettings();
  return {
    text,
    voice: s.voice,
    speed: s.speed,
    format: s.format,
    chunkMode: s.chunkMode,
    lang: s.lang,
  };
}

/** Start reading the composer text (optionally from a chunk). Call from a gesture handler. */
export function startPlayback(opts: { startChunk?: number; startOffset?: number } = {}): boolean {
  const player = getPlayer();
  player.unlock();
  const draft = useDraft.getState();
  const text = draft.text;
  if (!text.trim()) {
    notifications.show({
      id: 'tamber-empty',
      color: 'yellow',
      title: 'Nothing to read yet',
      message: 'Type, paste or import some text first.',
    });
    return false;
  }
  const health = useSession.getState().health;
  if (health && text.length > health.limits.max_text_chars) {
    notifications.show({
      id: 'tamber-too-long',
      color: 'red',
      title: 'Text is too long',
      message: `This server reads up to ${health.limits.max_text_chars.toLocaleString()} characters at a time.`,
    });
    return false;
  }
  const settings = getSettings();
  player.setVolume(settings.volume);
  player.play(currentRequest(text), {
    client: getClient(),
    title: draft.importInfo?.title ?? null,
    startChunk: opts.startChunk,
    startOffset: opts.startOffset,
    targetChars: health?.limits.chunk_target_chars,
    maxChars: health?.limits.chunk_max_chars,
  });
  useSession.getState().setView('read');
  return true;
}

/** The big Play/Pause button, Space, the lock screen. */
export function playPause(): void {
  const player = getPlayer();
  const snap = player.getSnapshot();
  // The OS interrupted audio (status still says playing): this tap is the gesture that resumes it.
  if (snap.needsGesture && snap.hasSession && snap.status !== 'paused') {
    player.resume();
    return;
  }
  if (snap.status === 'playing' || snap.status === 'loading') {
    player.pause();
    return;
  }
  player.unlock();
  const text = useDraft.getState().text;
  if (snap.hasSession && snap.text === text && (snap.status === 'paused' || snap.needsGesture)) {
    player.resume();
    useSession.getState().setView('read');
    return;
  }
  if (snap.hasSession && snap.text === text && snap.status === 'error') {
    player.retry();
    useSession.getState().setView('read');
    return;
  }
  startPlayback();
}

export function stopPlayback(): void {
  getPlayer().stop();
}

/**
 * "New" in the reader: forget the current session, clear the draft and return to an empty
 * composer. The text is already in history (recorded when playback started).
 */
export function startNew(): void {
  getPlayer().reset();
  useDraft.getState().clear();
  useSession.getState().setView('compose');
}

/** "Tap to resume" after an iOS interruption. */
export function resumeFromGesture(): void {
  getPlayer().resume();
}

/** Tap a word/sentence in the reader. Starts playback there if nothing is playing. */
export function seekFromReader(target: { char?: number; chunk?: number }): void {
  const player = getPlayer();
  player.unlock();
  if (!player.getSnapshot().hasSession) return;
  // From idle/ended/error this restarts the same session at the tapped spot (held audio reused).
  if (target.char !== undefined) player.seekToChar(target.char);
  else if (target.chunk !== undefined) player.seekToChunk(target.chunk);
}

const previewCache = new Map<string, Uint8Array>();
let previewToken = 0;

/**
 * Audition a voice through the same AudioContext. The synchronous part (unlock + parking the
 * main playback) runs inside the tap; fetching and decoding come after.
 */
export async function previewVoice(voiceId: string): Promise<void> {
  const player = getPlayer();
  player.beginPreview();
  if (!isSingleVoiceId(voiceId)) return;
  const token = ++previewToken;
  const format = getSettings().format;
  const key = `${voiceId}:${format}`;
  try {
    let bytes = previewCache.get(key);
    if (!bytes) {
      bytes = await getClient().voicePreview(voiceId, format);
      if (previewCache.size > 24) previewCache.clear();
      previewCache.set(key, bytes);
    }
    if (token !== previewToken) return;
    await player.playClip(bytes);
  } catch (err) {
    notifyError(err, { id: 'tamber-preview' });
  }
}

export function stopPreview(): void {
  previewToken++;
  getPlayer().stopPreview();
}

/** Save audio: concatenate the WAV chunks and download tamber-<slug>.wav. */
export function saveAudio(): void {
  const player = getPlayer();
  const snap = player.getSnapshot();
  const wav = player.buildWav();
  if (!wav) {
    notifications.show({
      color: 'yellow',
      title: 'Audio is not ready to save',
      message: 'Let the whole text finish streaming (WAV format) and try again.',
    });
    return;
  }
  const name = `tamber-${slugify(snap.title ?? snap.text.slice(0, 80))}.wav`;
  const copy = new Uint8Array(wav.byteLength);
  copy.set(wav);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
