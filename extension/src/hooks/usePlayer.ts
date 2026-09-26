/**
 * Subscribe a UI (popup, side panel) to the offscreen engine's state over a `tamber-player` port.
 * The UI renders only from this state and never re-derives timing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import {
  PLAYER_PORT,
  createIdleState,
  isPortMessage,
  isUiMessage,
  type BackgroundMessage,
  type ControlCommand,
  type PlayerState,
  type PlayRequest,
  type PortMessage,
} from '../lib/messages';
import { sendToOffscreen } from '../lib/offscreen';

export type WordMap = ReadonlyMap<number, ReadonlyArray<readonly [number, number]>>;

export interface PlayerView {
  state: PlayerState;
  /** Word spans per received chunk (identity changes whenever a chunk arrives). */
  words: WordMap;
  /** True while a port to the engine is open. */
  connected: boolean;
}

/** Apply a port message to (state, words). Pure: exported for tests. */
export function reducePortMessage(
  view: { state: PlayerState; words: WordMap },
  msg: PortMessage,
): { state: PlayerState; words: WordMap } {
  switch (msg.type) {
    case 'snapshot':
      return {
        state: msg.state,
        words: new Map(msg.words.map((c) => [c.index, c.words] as const)),
      };
    case 'patch':
      return { state: { ...view.state, ...msg.patch }, words: view.words };
    case 'chunk': {
      const next = new Map(view.words);
      next.set(msg.chunk.index, msg.chunk.words);
      return { state: view.state, words: next };
    }
  }
}

export function usePlayer(): PlayerView {
  const [view, setView] = useState<{ state: PlayerState; words: WordMap }>(() => ({
    state: createIdleState(),
    words: new Map(),
  }));
  const [connected, setConnected] = useState(false);
  const portRef = useRef<Browser.runtime.Port | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed || portRef.current) return;
      let port: Browser.runtime.Port;
      try {
        port = browser.runtime.connect({ name: PLAYER_PORT });
      } catch {
        return;
      }
      portRef.current = port;
      port.onMessage.addListener((msg: unknown) => {
        if (!isPortMessage(msg)) return;
        setConnected(true);
        setView((v) => reducePortMessage(v, msg));
      });
      port.onDisconnect.addListener(() => {
        void browser.runtime.lastError; // consume "Receiving end does not exist"
        portRef.current = null;
        setConnected(false);
        // The engine closed (stop / idle): keep the text on screen, show it as idle.
        setView((v) => ({
          state: { ...v.state, status: 'idle', activeWord: null },
          words: v.words,
        }));
      });
    };

    const onMessage = (msg: unknown) => {
      if (isUiMessage(msg) && msg.type === 'offscreenReady') {
        // A fresh engine: drop a stale port and connect to it.
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          portRef.current?.disconnect();
          portRef.current = null;
          connect();
        }, 50);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      browser.runtime.onMessage.removeListener(onMessage);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  return { state: view.state, words: view.words, connected };
}

// ---------------------------------------------------------------------------------------------
// Commands (fire and forget; state comes back over the port)
// ---------------------------------------------------------------------------------------------

async function sendBackground(msg: BackgroundMessage) {
  try {
    return (await browser.runtime.sendMessage(msg)) as { ok?: boolean; error?: string } | null;
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

export const player = {
  /** play/pause/stop/next/previous through the background (it can resume a closed session). */
  control: (command: ControlCommand) =>
    sendBackground({ target: 'background', type: 'control', command }),
  play: (req: PlayRequest) => sendBackground({ target: 'background', type: 'play', ...req }),
  readTab: (tabId: number) => sendBackground({ target: 'background', type: 'readTab', tabId }),
  seekToChar: (offset: number) =>
    sendToOffscreen({ target: 'offscreen', type: 'seekToChar', offset }, { retries: 0 }),
  seekChunk: (index: number) =>
    sendToOffscreen({ target: 'offscreen', type: 'seekChunk', index }, { retries: 0 }),
  setSpeed: (speed: number) =>
    sendToOffscreen({ target: 'offscreen', type: 'setSpeed', speed }, { retries: 0 }),
  setVolume: (volume: number) =>
    sendToOffscreen({ target: 'offscreen', type: 'setVolume', volume }, { retries: 0 }),
  /** "Click to start audio": resume the AudioContext after Chrome blocked autoplay. */
  resumeAudio: () => sendToOffscreen({ target: 'offscreen', type: 'resume' }, { retries: 0 }),
};

/** Stable callback wrapper for the play/pause toggle. */
export function useToggle(state: PlayerState) {
  return useCallback(() => {
    if (state.status === 'needs-gesture') void player.resumeAudio();
    else void player.control('toggle');
  }, [state.status]);
}
