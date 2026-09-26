import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@tamber/client';
import {
  createIdleState,
  isBackgroundMessage,
  isNoReceiverError,
  isOffscreenMessage,
  isPortMessage,
  isUiMessage,
  toMiniState,
} from '../lib/messages';

describe('message type guards', () => {
  it('accepts well-formed offscreen commands', () => {
    expect(
      isOffscreenMessage({
        target: 'offscreen',
        type: 'play',
        text: 'Hi.',
        settings: DEFAULT_SETTINGS,
      }),
    ).toBe(true);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'pause' })).toBe(true);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'seekToChar', offset: 12 })).toBe(true);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'setSpeed', speed: 1.5 })).toBe(true);
  });

  it('rejects other targets, unknown types and malformed payloads', () => {
    expect(isOffscreenMessage({ target: 'background', type: 'pause' })).toBe(false);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'explode' })).toBe(false);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'play', text: 'x' })).toBe(false);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'seekToChar', offset: 'a' })).toBe(
      false,
    );
    expect(isOffscreenMessage({ target: 'offscreen', type: 'setSpeed', speed: Number.NaN })).toBe(
      false,
    );
    expect(isOffscreenMessage(null)).toBe(false);
    expect(isOffscreenMessage('pause')).toBe(false);
  });

  it('validates background messages', () => {
    expect(isBackgroundMessage({ target: 'background', type: 'control', command: 'toggle' })).toBe(
      true,
    );
    expect(isBackgroundMessage({ target: 'background', type: 'control', command: 'nuke' })).toBe(
      false,
    );
    expect(isBackgroundMessage({ target: 'background', type: 'play', text: 'x' })).toBe(true);
    expect(isBackgroundMessage({ target: 'background', type: 'readTab', tabId: 3 })).toBe(true);
    expect(isBackgroundMessage({ target: 'background', type: 'readTab' })).toBe(false);
    expect(isBackgroundMessage({ target: 'offscreen', type: 'play', text: 'x' })).toBe(false);
  });

  it('validates UI and port messages', () => {
    expect(isUiMessage({ target: 'ui', type: 'offscreenReady' })).toBe(true);
    expect(isUiMessage({ target: 'ui', type: 'whatever' })).toBe(false);
    expect(isPortMessage({ type: 'snapshot', state: createIdleState(), words: [] })).toBe(true);
    expect(isPortMessage({ type: 'patch', patch: { position: 1 } })).toBe(true);
    expect(isPortMessage({ type: 'chunk', chunk: { index: 0, words: [] } })).toBe(true);
    expect(isPortMessage({ type: 'patch' })).toBe(false);
  });

  it('recognizes "no receiver" errors', () => {
    expect(
      isNoReceiverError(new Error('Could not establish connection. Receiving end does not exist.')),
    ).toBe(true);
    expect(isNoReceiverError(new Error('boom'))).toBe(false);
  });
});

describe('toMiniState', () => {
  const text = 'Hello world. This is Tamber.';
  const base = createIdleState({
    status: 'playing',
    sessionId: 3,
    text,
    tabId: 7,
    plan: [
      { index: 0, char_start: 0, char_end: 12 },
      { index: 1, char_start: 13, char_end: 28 },
    ],
    totalChunks: 2,
    progress: 0.6,
  });

  it('extracts the active sentence and the word relative to it', () => {
    const m = toMiniState({ ...base, activeChunk: 1, activeWord: { charStart: 21, charEnd: 27 } });
    expect(m.sentence).toBe('This is Tamber.');
    expect(m.word).toEqual([8, 14]);
    expect(m.sentence.slice(8, 14)).toBe('Tamber');
    expect(m.progress).toBe(0.6);
    expect(m.tabId).toBe(7);
  });

  it('shows the first sentence while loading and no word when none is active', () => {
    const m = toMiniState({ ...base, status: 'loading', activeChunk: -1 });
    expect(m.sentence).toBe('Hello world.');
    expect(m.word).toBeNull();
  });
});
