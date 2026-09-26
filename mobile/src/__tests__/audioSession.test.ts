/**
 * LockScreenSession mirrors the silent anchor player's state changes (lock screen, headset,
 * interruptions) to the StreamPlayer, but must not mistake its own transitions for user commands.
 */
import { createAudioPlayer } from 'expo-audio';

import { LockScreenSession, SELF_CHANGE_GRACE_MS } from '@/player/audioSession';

interface FakeAnchor {
  playing: boolean;
  isBuffering: boolean;
  isLoaded: boolean;
  emit(event: string, payload: unknown): void;
}

function setup() {
  const commands: string[] = [];
  const session = new LockScreenSession((cmd) => commands.push(cmd));
  session.activate({ title: 'Doc', artist: 'Tamber', albumTitle: 'af_heart' });
  const results = (createAudioPlayer as jest.Mock).mock.results;
  const anchor = results[results.length - 1]!.value as FakeAnchor;
  const report = (s: Partial<Pick<FakeAnchor, 'playing' | 'isBuffering' | 'isLoaded'>>) =>
    anchor.emit('playbackStatusUpdate', { playing: false, isBuffering: false, isLoaded: true, ...s });
  return { session, anchor, commands, report };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('LockScreenSession', () => {
  it('ignores the transitional not-playing report iOS emits right after play()', () => {
    const { session, commands, report } = setup();
    session.setPlaying(true);
    report({ playing: false, isBuffering: true, isLoaded: false }); // item still loading
    jest.advanceTimersByTime(SELF_CHANGE_GRACE_MS * 3);
    report({ playing: false, isBuffering: true, isLoaded: true }); // waitingToPlayAtSpecifiedRate
    jest.advanceTimersByTime(SELF_CHANGE_GRACE_MS * 3);
    expect(commands).toEqual([]);
  });

  it('mirrors a lock-screen pause and play', () => {
    const { session, commands, report } = setup();
    session.setPlaying(true);
    report({ playing: true });
    jest.advanceTimersByTime(SELF_CHANGE_GRACE_MS * 2);
    report({ playing: false });
    expect(commands).toEqual(['pause']);
    report({ playing: true });
    expect(commands).toEqual(['pause', 'play']);
  });

  it("does not let a stale 'playing' report undo the user's pause", () => {
    const { session, anchor, commands, report } = setup();
    session.setPlaying(true);
    jest.advanceTimersByTime(SELF_CHANGE_GRACE_MS * 2);
    session.setPlaying(false); // the user paused; the anchor is paused now
    report({ playing: true }); // produced before the pause took effect
    expect(anchor.playing).toBe(false);
    jest.advanceTimersByTime(SELF_CHANGE_GRACE_MS * 2);
    expect(commands).toEqual([]);
  });

  it('applies a genuine change that happened inside the grace window once it has passed', () => {
    const { session, anchor, commands, report } = setup();
    session.setPlaying(true);
    anchor.playing = false; // e.g. an interruption right after Play
    report({ playing: false });
    expect(commands).toEqual([]);
    jest.advanceTimersByTime(SELF_CHANGE_GRACE_MS * 2);
    expect(commands).toEqual(['pause']);
  });
});
