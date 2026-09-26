/**
 * Offscreen document: the extension's playback engine and single source of truth.
 *
 * - Owns TamberClient.synthesize (NDJSON fetch), decodeAudioData, the AudioContext clock and
 *   gapless scheduling (ChunkedPlayer).
 * - UIs (popup, side panel) connect a `tamber-player` port: they get a full snapshot on connect,
 *   then patches on every word / chunk / status change plus a 4 Hz position tick.
 * - The background gets a compact MiniState on word / chunk / status changes (it relays it to the
 *   in-page mini-player with tabs.sendMessage and drives the badge).
 * - Only chrome.runtime is available here (no chrome.storage / tabs), so settings arrive in
 *   messages. After 30 s without audio the document asks the background to close it.
 */
import { browser, type Browser } from 'wxt/browser';
import { createClient } from '../../lib/client';
import {
  PLAYER_PORT,
  isOffscreenMessage,
  toMiniState,
  type BackgroundMessage,
  type OffscreenMessage,
  type PortMessage,
  type StateReason,
  type UiMessage,
} from '../../lib/messages';
import { ChunkedPlayer, type PlayerEvent } from '../../player/ChunkedPlayer';

const IDLE_CLOSE_MS = 30_000;
const TICK_RELAY_MS = 1_000;

const player = new ChunkedPlayer({
  synthesize: (settings, request, signal) => createClient(settings).synthesize(request, { signal }),
});

const ports = new Set<Browser.runtime.Port>();

function post(port: Browser.runtime.Port, msg: PortMessage) {
  try {
    port.postMessage(msg);
  } catch {
    ports.delete(port);
  }
}

function broadcast(msg: PortMessage) {
  for (const port of ports) post(port, msg);
}

function sendRuntime(msg: BackgroundMessage | UiMessage) {
  browser.runtime.sendMessage(msg).catch(() => {
    // Nobody listening (e.g. the service worker is restarting): the next update will get through.
  });
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PLAYER_PORT) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  post(port, { type: 'snapshot', ...player.getSnapshot() });
});

// --- relay compact state to the background (mini-player + badge) -----------------------------
let lastTickRelay = 0;
/** settings.highlight (word-level karaoke), from the latest play / updateSettings message. */
let highlightWords = true;

function relayToBackground(reason: StateReason) {
  const state = player.getState();
  if (reason === 'tick') {
    const now = performance.now();
    if (now - lastTickRelay < TICK_RELAY_MS) return;
    lastTickRelay = now;
  }
  const mini = toMiniState(state);
  sendRuntime({
    target: 'background',
    type: 'state',
    // Highlight off: the mini-player shows the sentence only, like the popup and side panel.
    state: highlightWords ? mini : { ...mini, word: null },
    reason,
    chunk: state.activeChunk,
  });
}

// --- idle auto-close (belt and braces over Chrome's own 30 s AUDIO_PLAYBACK limit) ----------
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function updateIdleTimer() {
  const { status } = player.getState();
  const active = status === 'playing' || status === 'loading' || status === 'queued';
  if (active) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    return;
  }
  if (!idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const s = player.getState().status;
      if (s !== 'playing' && s !== 'loading' && s !== 'queued') {
        sendRuntime({ target: 'background', type: 'closeOffscreen', reason: 'idle' });
      }
    }, IDLE_CLOSE_MS);
  }
}

player.subscribe((e: PlayerEvent) => {
  if (e.type === 'reset') {
    broadcast({ type: 'snapshot', state: e.state, words: e.words });
    const s = e.state;
    sendRuntime({
      target: 'background',
      type: 'session',
      session: s.text
        ? {
            text: s.text,
            title: s.title,
            sourceUrl: s.sourceUrl,
            tabId: s.tabId,
            chunk: Math.max(0, s.activeChunk),
            sessionId: s.sessionId,
          }
        : null,
    });
    relayToBackground('status');
  } else if (e.type === 'chunk') {
    broadcast({ type: 'chunk', chunk: e.chunk });
  } else {
    broadcast({ type: 'patch', patch: e.patch });
    const p = e.patch;
    if (p.status !== undefined || p.error !== undefined) relayToBackground('status');
    else if (p.activeChunk !== undefined) relayToBackground('chunk');
    else if (p.activeWord !== undefined) relayToBackground('word');
    else if (p.position !== undefined) relayToBackground('tick');
  }
  updateIdleTimer();
});

function handle(msg: OffscreenMessage): unknown {
  switch (msg.type) {
    case 'play':
      highlightWords = msg.settings.highlight !== false;
      player.load({
        text: msg.text,
        settings: msg.settings,
        title: msg.title ?? null,
        sourceUrl: msg.sourceUrl ?? null,
        tabId: msg.tabId ?? null,
        startChunk: msg.startChunk,
      });
      break;
    case 'pause':
      player.pause();
      break;
    case 'resume':
      player.resume();
      break;
    case 'toggle':
      player.toggle();
      break;
    case 'stop':
      player.stop();
      sendRuntime({ target: 'background', type: 'closeOffscreen', reason: 'stopped' });
      break;
    case 'seekToChar':
      player.seekToChar(msg.offset);
      break;
    case 'seekChunk':
      player.seekChunk(msg.index);
      break;
    case 'next':
      player.next();
      break;
    case 'previous':
      player.previous();
      break;
    case 'setSpeed':
      player.setSpeed(msg.speed);
      break;
    case 'setVolume':
      player.setVolume(msg.volume);
      break;
    case 'updateSettings':
      highlightWords = msg.settings.highlight !== false;
      player.updateSettings(msg.settings);
      relayToBackground('word');
      break;
    case 'getState':
      return player.getState();
  }
  return { ok: true };
}

browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  // Offscreen documents receive every runtime message: only handle ours.
  if (!isOffscreenMessage(msg)) return;
  try {
    sendResponse(handle(msg));
  } catch (err) {
    sendResponse({ ok: false, error: String((err as Error)?.message ?? err) });
  }
});

// Tell open UIs that the engine exists, so they (re)connect their ports.
sendRuntime({ target: 'ui', type: 'offscreenReady' });
updateIdleTimer();
