/**
 * OS audio session, background playback and lock-screen controls.
 *
 * expo-audio SDK 57 exposes setActiveForLockScreen() only on AudioPlayer, not on AudioPlaylist
 * (checked against node_modules/expo-audio/build/AudioModule.types.d.ts). Android requires an
 * active media session for sustained background playback (otherwise audio stops after ~3 min), and
 * iOS needs one for Now Playing metadata. So the speech itself plays through the gapless
 * AudioPlaylist, while a tiny looping, silent "session anchor" AudioPlayer owns the lock-screen /
 * notification registration:
 *
 *   - activate(): anchor.setActiveForLockScreen(true, { title, artist: 'Tamber', albumTitle: voice })
 *   - setPlaying(): keeps the anchor's play state in step with the playlist, so the lock screen shows
 *     the right play/pause button.
 *   - Lock-screen / headset play-pause act on the anchor; its status events are mirrored back to the
 *     StreamPlayer through onRemoteCommand. Transitional reports (buffering / not loaded, e.g. iOS
 *     right after play()) and stale reports racing our own play()/pause() are not mirrored.
 *
 * Audio focus is module-wide in expo-audio (one focus for all players and playlists), so the anchor
 * and the playlist never compete for it.
 */
import { wavHeader, bytesToBase64 } from '@tamber/client';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';

import type { AudioSessionLike } from './StreamPlayer';

const SAMPLE_RATE = 24000;
/**
 * After we play()/pause() the anchor ourselves, a status report produced just before the change
 * can still be in flight; a mismatch inside this window is re-checked against the live state
 * instead of being treated as a lock-screen command.
 */
export const SELF_CHANGE_GRACE_MS = 600;

type AnchorState = Pick<AudioStatus, 'playing' | 'isBuffering' | 'isLoaded'>;

let audioModePromise: Promise<void> | null = null;

/**
 * Configure the audio session once: play with the silent switch on, keep playing in the background,
 * and take audio focus exclusively (setActiveForLockScreen requires 'doNotMix'). Shared by the
 * stream player and voice previews.
 */
export function ensureAudioMode(): Promise<void> {
  if (!audioModePromise) {
    audioModePromise = setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    }).catch((err: unknown) => {
      audioModePromise = null;
      throw err;
    });
  }
  return audioModePromise;
}

/** One second of digital silence as a WAV file (24 kHz mono s16le). */
function silenceFile(): File {
  const dir = new Directory(Paths.cache, 'tamber-session');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, 'silence.wav');
  if (!file.exists) {
    const dataLength = SAMPLE_RATE * 2;
    const bytes = new Uint8Array(44 + dataLength);
    bytes.set(wavHeader(dataLength, SAMPLE_RATE, 1, 16), 0);
    file.create({ intermediates: true });
    file.write(bytesToBase64(bytes), { encoding: 'base64' });
  }
  return file;
}

export class LockScreenSession implements AudioSessionLike {
  private anchor: AudioPlayer | null = null;
  private subscription: { remove: () => void } | null = null;
  /** The play state we asked the anchor for; status events that differ come from the OS. */
  private expectedPlaying = false;
  private active = false;
  private lastCommandAt = 0;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onRemoteCommand: (cmd: 'play' | 'pause') => void;

  constructor(onRemoteCommand: (cmd: 'play' | 'pause') => void) {
    this.onRemoteCommand = onRemoteCommand;
  }

  async prepare(): Promise<void> {
    await ensureAudioMode();
  }

  private ensureAnchor(): AudioPlayer {
    if (this.anchor) return this.anchor;
    const player = createAudioPlayer({ uri: silenceFile().uri }, { updateInterval: 500 });
    player.loop = true;
    player.volume = 0;
    this.subscription = player.addListener('playbackStatusUpdate', (s: AudioStatus) =>
      this.onAnchorStatus(s),
    );
    this.anchor = player;
    return player;
  }

  private onAnchorStatus(status: AnchorState): void {
    if (!this.active) return;
    // Transitional reports are not commands. On iOS `playing` is `timeControlStatus == .playing`,
    // so right after play() (item still loading, or waitingToPlayAtSpecifiedRate) the anchor
    // reports playing=false with isBuffering=true / isLoaded=false. Mirroring that as "pause"
    // would stop the speech the moment the user pressed Play.
    if (status.isBuffering || !status.isLoaded) return;
    if (status.playing === this.expectedPlaying) return;
    const sinceCommand = Date.now() - this.lastCommandAt;
    if (sinceCommand < SELF_CHANGE_GRACE_MS) {
      this.scheduleReconcile(SELF_CHANGE_GRACE_MS - sinceCommand);
      return;
    }
    // The OS (lock screen, notification, headset, Control Center, interruption) changed the
    // anchor's state.
    this.expectedPlaying = status.playing;
    this.onRemoteCommand(status.playing ? 'play' : 'pause');
  }

  /** Re-evaluate the anchor's live state once the self-change grace window has passed. */
  private scheduleReconcile(delayMs: number): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      const anchor = this.anchor;
      if (!anchor || !this.active) return;
      this.onAnchorStatus({
        playing: anchor.playing,
        isBuffering: anchor.isBuffering,
        isLoaded: anchor.isLoaded,
      });
    }, delayMs + 50);
  }

  private clearReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  activate(meta: { title: string; artist: string; albumTitle: string }): void {
    try {
      const anchor = this.ensureAnchor();
      anchor.setActiveForLockScreen(true, meta, {
        showSeekForward: false,
        showSeekBackward: false,
        // The anchor's 1 s loop has no meaningful position; hide the scrubber.
        isLiveStream: true,
      });
      this.active = true;
    } catch (err) {
      console.warn('[tamber] lock-screen controls unavailable', err);
    }
  }

  setPlaying(playing: boolean): void {
    if (!this.anchor || !this.active) return;
    this.expectedPlaying = playing;
    this.lastCommandAt = Date.now();
    try {
      if (playing) this.anchor.play();
      else this.anchor.pause();
    } catch (err) {
      console.warn('[tamber] session anchor error', err);
    }
  }

  deactivate(): void {
    this.clearReconcile();
    if (!this.anchor) return;
    this.active = false;
    this.expectedPlaying = false;
    try {
      this.anchor.pause();
      this.anchor.clearLockScreenControls();
    } catch (err) {
      console.warn('[tamber] could not clear lock-screen controls', err);
    }
  }

  release(): void {
    this.deactivate();
    this.subscription?.remove();
    this.subscription = null;
    this.anchor?.remove();
    this.anchor = null;
  }
}
