/**
 * Service-worker logic (stateless relay). The entrypoint (src/entrypoints/background.ts) only calls
 * setupBackground(); everything here is exported for unit tests.
 *
 * Responsibilities:
 * - context menus ("Read with Tamber" on a selection, "Read this page", "Read linked page"),
 * - keyboard commands (read selection, toggle, stop),
 * - the offscreen document lifecycle (create on play, close on stop / idle),
 * - relaying compact playback state to the in-page mini-player (tabs.sendMessage) and the badge,
 * - remembering the last session (storage.session) so playback can resume after the offscreen
 *   document was closed.
 *
 * It never streams NDJSON itself: the offscreen document owns synthesis and audio.
 */
import { browser, type Browser } from 'wxt/browser';
import { describeError, createClient } from './client';
import {
  isBackgroundMessage,
  isNoReceiverError,
  toMiniState,
  type BackgroundMessage,
  type ControlCommand,
  type MiniState,
  type PlayerState,
  type PlayRequest,
  type SavedSession,
  type UiMessage,
} from './messages';
import {
  closeOffscreen,
  ensureOffscreen,
  hasOffscreenDocument,
  sendToOffscreen,
} from './offscreen';
import { hasApiPermission } from './permissions';
import {
  DEFAULT_EXTENSION_SETTINGS,
  loadExtensionSettings,
  loadSettings,
  onSettingsChanged,
  type ExtensionSettings,
} from './settings';

export const MENU_IDS = {
  selection: 'tamber-read-selection',
  page: 'tamber-read-page',
  link: 'tamber-read-link',
} as const;

export const MINI_PLAYER_SCRIPT = '/content-scripts/mini-player.js';
const SESSION_KEY = 'tamber.lastSession';
const HIDDEN_KEY = 'tamber.miniHidden';
/** Server default TAMBER_MAX_TEXT_CHARS. Longer page text is cut at a paragraph boundary. */
export const MAX_TEXT_CHARS = 100_000;
const BADGE_COLOR = '#7C3AED';

type Tab = Browser.tabs.Tab;
type MenuInfo = Browser.contextMenus.OnClickData;

// ---------------------------------------------------------------------------------------------
// Extension-settings cache: sidePanel.open() must run synchronously inside the user gesture, so
// the openSidePanelOnPlay flag has to be known without awaiting storage.
// ---------------------------------------------------------------------------------------------

let extCache: ExtensionSettings | null = null;
let extLoading: Promise<ExtensionSettings> | null = null;

export function primeExtensionSettings(): Promise<ExtensionSettings> {
  extLoading ??= loadExtensionSettings()
    .catch(() => ({ ...DEFAULT_EXTENSION_SETTINGS }))
    .then((e) => (extCache = e));
  return extLoading;
}

/** Test hook: set or clear the cached extension settings. */
export function setExtensionSettingsCache(value: ExtensionSettings | null): void {
  extCache = value;
  extLoading = value ? Promise.resolve(value) : null;
}

async function currentExtensionSettings(): Promise<ExtensionSettings> {
  return extCache ?? (await primeExtensionSettings());
}

/** Open the side panel for `tab` if enabled. Synchronous when the cache is warm (keeps the gesture). */
function maybeOpenSidePanel(tab: Tab | undefined): Promise<void> | void {
  if (!tab) return;
  const open = () => {
    const target =
      tab.id !== undefined && tab.id >= 0 ? { tabId: tab.id } : { windowId: tab.windowId };
    return browser.sidePanel.open(target).catch((err: unknown) => {
      console.warn('[tamber] could not open the side panel', err);
    });
  };
  if (extCache) {
    if (extCache.openSidePanelOnPlay) void open();
    return;
  }
  // Cold service worker: the flag is still loading. Try after it arrives (Chrome may refuse if the
  // gesture has expired by then; the popup's "Open reader" button always works).
  return primeExtensionSettings().then((ext) => {
    if (ext.openSidePanelOnPlay) return open();
  });
}

// ---------------------------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------------------------

let lastBadge = '';

export function badgeTextFor(state: Pick<MiniState, 'status' | 'progress'>): string {
  switch (state.status) {
    case 'playing':
      return `${Math.min(99, Math.round(state.progress * 100))}%`;
    case 'loading':
    case 'queued':
      return '…';
    case 'paused':
      return 'II';
    case 'needs-gesture':
      return '▶';
    case 'error':
      return '!';
    default:
      return '';
  }
}

async function setBadge(text: string, title?: string): Promise<void> {
  try {
    if (text !== lastBadge) {
      lastBadge = text;
      await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      await browser.action.setBadgeText({ text });
    }
    if (title !== undefined) await browser.action.setTitle({ title });
  } catch {
    // badge is cosmetic
  }
}

async function flashBadge(text: string, title: string): Promise<void> {
  await setBadge(text, title);
  setTimeout(() => {
    if (lastBadge === text) void setBadge('', 'Tamber');
  }, 4000);
}

// ---------------------------------------------------------------------------------------------
// Session memory (storage.session: cleared when the browser closes)
// ---------------------------------------------------------------------------------------------

let savedChunk = -1;

async function saveSession(session: SavedSession | null): Promise<void> {
  savedChunk = session?.chunk ?? -1;
  const prev = await getSavedSession().catch(() => null);
  if (session) await browser.storage.session.set({ [SESSION_KEY]: session });
  else await browser.storage.session.remove(SESSION_KEY);
  // The previous reading's mini-player only ever gets state for its own session, so it would keep
  // showing its last sentence and a live Pause button. Hide it when reading stops (from the popup,
  // side panel or a shortcut) or moves to another tab / to pasted text.
  const prevTab = prev?.tabId ?? null;
  if (prevTab !== null && prevTab !== (session?.tabId ?? null)) {
    await sendToTab(prevTab, { target: 'ui', type: 'miniHide' });
  }
}

export async function getSavedSession(): Promise<SavedSession | null> {
  const r = await browser.storage.session.get(SESSION_KEY);
  const s = r[SESSION_KEY] as SavedSession | undefined;
  return s && typeof s.text === 'string' && s.text ? s : null;
}

async function updateSessionChunk(chunk: number, sessionId: number): Promise<void> {
  if (chunk < 0 || chunk === savedChunk) return;
  savedChunk = chunk;
  const s = await getSavedSession();
  // Only for the session this position belongs to: a stale read must never write an older
  // session back over a newer one.
  if (s && s.sessionId === sessionId) {
    await browser.storage.session.set({ [SESSION_KEY]: { ...s, chunk } });
  }
}

// ---------------------------------------------------------------------------------------------
// Page access (activeTab is granted by the menu click / shortcut / toolbar click)
// ---------------------------------------------------------------------------------------------

/** Runs in the page: the current selection, including selections inside inputs and textareas. */
function pageSelection(): string {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (
    el &&
    (el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && /^(text|search|url)$/i.test(el.type))) &&
    typeof el.selectionStart === 'number' &&
    typeof el.selectionEnd === 'number' &&
    el.selectionEnd > el.selectionStart
  ) {
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return window.getSelection()?.toString() ?? '';
}

/** Runs in the page: its HTML for server-side extraction (works behind logins). */
function pageHtml(): { html: string; url: string; title: string } {
  return { html: document.documentElement.outerHTML, url: location.href, title: document.title };
}

/**
 * Runs in the page: readable text without the server (fallback). Prefers <article>/<main>, drops
 * navigation chrome, and joins blocks with blank lines so they become paragraphs.
 */
function pageReadableText(): { text: string; url: string; title: string } {
  const root =
    document.querySelector('article') ??
    document.querySelector('main, [role="main"]') ??
    document.body;
  const skip =
    'script,style,noscript,template,nav,header,footer,aside,form,button,svg,iframe,[aria-hidden="true"],[hidden]';
  const blocks: string[] = [];
  const blockTags = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|FIGCAPTION|DD|DT|TD|TH|CAPTION|SUMMARY)$/;
  const walker = document.createTreeWalker(root ?? document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as Element;
      if (el.matches(skip)) return NodeFilter.FILTER_REJECT;
      return blockTags.test(el.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as HTMLElement;
    if (el.parentElement?.closest('p,li,blockquote,pre,td,th')) continue;
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  }
  let text = blocks.join('\n\n');
  if (text.length < 200) {
    text = ((root as HTMLElement | null)?.innerText ?? document.body.innerText ?? '')
      .split(/\n\s*\n+/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
  }
  return { text, url: location.href, title: document.title };
}

async function execInTab<T>(
  tabId: number,
  func: () => T,
  frameId?: number,
): Promise<T | undefined> {
  const results = await browser.scripting.executeScript({
    target: frameId !== undefined && frameId > 0 ? { tabId, frameIds: [frameId] } : { tabId },
    func,
  });
  return results?.[0]?.result as T | undefined;
}

async function selectionInTab(tabId: number): Promise<string> {
  const results = await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: pageSelection,
  });
  for (const r of results ?? []) {
    const t = typeof r.result === 'string' ? r.result.trim() : '';
    if (t) return t;
  }
  return '';
}

/** Trim to the server's text limit at the last paragraph (else sentence, else space) boundary. */
export function clampText(text: string, max = MAX_TEXT_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return cut.slice(0, at > max * 0.5 ? at + (cut[at] === '.' ? 1 : 0) : max).trim();
}

function withTitle(title: string | null | undefined, text: string): string {
  const t = (title ?? '').trim();
  if (!t || text.startsWith(t)) return text;
  return `${t}\n\n${text}`;
}

// ---------------------------------------------------------------------------------------------
// Playback orchestration
// ---------------------------------------------------------------------------------------------

async function openOptions(reason: 'setup' | 'permission'): Promise<void> {
  await flashBadge(
    '!',
    reason === 'setup' ? 'Tamber: set up your server' : 'Tamber: allow server access',
  );
  await browser.tabs.create({ url: browser.runtime.getURL(`/options.html#${reason}`) });
}

/** Settings ready for a request, or null after sending the user to Options. */
async function readySettings() {
  const settings = await loadSettings();
  if (!settings.apiBaseUrl) {
    await openOptions('setup');
    return null;
  }
  if (!(await hasApiPermission(settings.apiBaseUrl))) {
    await openOptions('permission');
    return null;
  }
  return settings;
}

export async function injectMiniPlayer(tabId: number): Promise<void> {
  try {
    await browser.storage.session.remove(HIDDEN_KEY);
    await browser.scripting.executeScript({ target: { tabId }, files: [MINI_PLAYER_SCRIPT] });
  } catch (err) {
    // chrome:// pages, the Web Store and PDF viewers cannot be scripted: the side panel still works.
    console.info('[tamber] mini-player not available on this tab', err);
  }
}

/** Ensure the offscreen engine exists and tell it to read `req`. */
export async function startPlayback(
  req: PlayRequest,
  settingsIn?: Awaited<ReturnType<typeof loadSettings>>,
): Promise<boolean> {
  const settings = settingsIn ?? (await readySettings());
  if (!settings) return false;
  const text = clampText(req.text);
  if (!text) {
    await flashBadge('?', 'Tamber: nothing to read');
    return false;
  }
  await ensureOffscreen();
  await setBadge('…', `Tamber: ${req.title ?? 'reading'}`);
  await sendToOffscreen({ target: 'offscreen', type: 'play', settings, ...req, text });
  return true;
}

async function reportError(err: unknown, tabId?: number): Promise<void> {
  const message = describeError(err);
  console.warn('[tamber]', message, err);
  await flashBadge('!', `Tamber: ${message}`);
  if (tabId !== undefined) {
    await sendToTab(tabId, {
      target: 'ui',
      type: 'miniState',
      state: {
        status: 'error',
        sessionId: -1,
        title: null,
        sentence: '',
        word: null,
        progress: 0,
        tabId,
        error: message,
      },
    });
  }
}

/**
 * contextMenus.onClicked. The side panel is opened synchronously at the top (before any await),
 * because chrome.sidePanel.open() only works inside the user gesture.
 */
export function handleContextMenuClick(info: MenuInfo, tab?: Tab): Promise<void> {
  const panel = maybeOpenSidePanel(tab);
  return (async () => {
    await panel;
    const tabId = tab?.id !== undefined && tab.id >= 0 ? tab.id : undefined;
    const settings = await readySettings();
    if (!settings) return;
    const ext = await currentExtensionSettings();
    try {
      let req: PlayRequest | null = null;
      if (info.menuItemId === MENU_IDS.selection) {
        let text = '';
        if (tabId !== undefined) {
          // Prefer the live selection (keeps line breaks); selectionText is whitespace-collapsed.
          text = (await execInTab(tabId, pageSelection, info.frameId).catch(() => '')) ?? '';
        }
        if (!text.trim()) text = info.selectionText ?? '';
        req = { text, title: tab?.title ?? null, sourceUrl: tab?.url ?? null };
      } else if (info.menuItemId === MENU_IDS.page) {
        if (tabId === undefined) return;
        req = await readPage(tabId, settings);
      } else if (info.menuItemId === MENU_IDS.link) {
        if (!info.linkUrl) return;
        await setBadge('…', 'Tamber: fetching the page');
        const ex = await createClient(settings).extractUrl(info.linkUrl);
        req = {
          text: withTitle(ex.title, ex.text),
          title: ex.title,
          sourceUrl: ex.source || info.linkUrl,
        };
      }
      if (!req) return;
      if (tabId !== undefined && ext.showMiniPlayer) await injectMiniPlayer(tabId);
      await startPlayback({ ...req, tabId: tabId ?? null }, settings);
    } catch (err) {
      await reportError(err, tabId);
    }
  })();
}

/** Readable text of a tab: server-side extraction of its HTML, else in-page extraction. */
async function readPage(
  tabId: number,
  settings: NonNullable<Awaited<ReturnType<typeof readySettings>>>,
): Promise<PlayRequest> {
  await setBadge('…', 'Tamber: reading the page');
  const page = await execInTab(tabId, pageHtml);
  if (page?.html) {
    try {
      const ex = await createClient(settings).extractHtml(page.html, page.url);
      if (ex.text.trim()) {
        return {
          text: withTitle(ex.title ?? page.title, ex.text),
          title: ex.title ?? page.title,
          sourceUrl: page.url,
        };
      }
    } catch (err) {
      console.info('[tamber] server extraction failed, using in-page text', err);
    }
  }
  const local = await execInTab(tabId, pageReadableText);
  return {
    text: withTitle(local?.title, local?.text ?? ''),
    title: local?.title ?? page?.title ?? null,
    sourceUrl: local?.url ?? page?.url ?? null,
  };
}

async function activeTab(): Promise<Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/** Read a tab's selection, or its readable page text when nothing is selected. */
async function readSelectionOrPage(
  tabArg: Tab | undefined,
  panel?: Promise<void> | void,
): Promise<boolean> {
  await panel;
  const tab = tabArg ?? (await activeTab());
  const tabId = tab?.id;
  if (tabId === undefined || tabId < 0) return false;
  const settings = await readySettings();
  if (!settings) return false;
  const ext = await currentExtensionSettings();
  try {
    let req: PlayRequest;
    const selected = await selectionInTab(tabId).catch(() => '');
    if (selected) {
      req = { text: selected, title: tab?.title ?? null, sourceUrl: tab?.url ?? null };
    } else {
      // Nothing selected: read the page's readable text, extracted in the page.
      const local = await execInTab(tabId, pageReadableText);
      const text = local?.text?.trim() ?? '';
      if (!text) {
        await flashBadge('?', 'Tamber: select some text first');
        return false;
      }
      req = {
        text: withTitle(local?.title, text),
        title: local?.title ?? tab?.title ?? null,
        sourceUrl: local?.url ?? null,
      };
    }
    if (ext.showMiniPlayer) await injectMiniPlayer(tabId);
    return await startPlayback({ ...req, tabId }, settings);
  } catch (err) {
    await reportError(err, tabId);
    return false;
  }
}

/** commands.onCommand */
export function handleCommand(command: string, tabArg?: Tab): Promise<void> {
  if (command === 'read-selection') {
    const panel = maybeOpenSidePanel(tabArg);
    return readSelectionOrPage(tabArg, panel).then(() => undefined);
  }
  if (command === 'toggle-playback') return control('toggle').then(() => undefined);
  if (command === 'stop-playback') return control('stop').then(() => undefined);
  return Promise.resolve();
}

/** Play/pause/stop/next/previous; resumes the remembered session when the engine was closed. */
export async function control(command: ControlCommand): Promise<boolean> {
  if (await hasOffscreenDocument()) {
    await sendToOffscreen({ target: 'offscreen', type: command });
    if (command === 'stop') {
      await closeOffscreen();
      await saveSession(null);
      await setBadge('', 'Tamber');
    }
    return true;
  }
  if (command === 'toggle' || command === 'resume') {
    const s = await getSavedSession();
    if (!s) return false;
    return startPlayback({
      text: s.text,
      title: s.title,
      sourceUrl: s.sourceUrl,
      tabId: s.tabId,
      startChunk: s.chunk,
    });
  }
  if (command === 'stop') {
    await saveSession(null);
    await setBadge('', 'Tamber');
  }
  return false;
}

async function sendToTab(tabId: number, msg: UiMessage): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, msg);
  } catch (err) {
    if (!isNoReceiverError(err)) console.debug('[tamber] tab relay failed', err);
  }
}

async function relayState(state: MiniState, chunk: number): Promise<void> {
  const text = badgeTextFor(state);
  await setBadge(
    text,
    state.error ? `Tamber: ${state.error}` : state.title ? `Tamber: ${state.title}` : 'Tamber',
  );
  if (chunk >= 0) void updateSessionChunk(chunk, state.sessionId).catch(() => undefined);
  if (state.tabId === null || state.tabId < 0) return;
  const ext = await currentExtensionSettings();
  if (!ext.showMiniPlayer) return;
  const hidden = (await browser.storage.session.get(HIDDEN_KEY))[HIDDEN_KEY] as
    { tabId: number; sessionId: number } | undefined;
  if (hidden && hidden.tabId === state.tabId && hidden.sessionId === state.sessionId) return;
  await sendToTab(state.tabId, { target: 'ui', type: 'miniState', state });
}

export async function handleBackgroundMessage(
  msg: BackgroundMessage,
  sender: Browser.runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case 'state':
      await relayState(msg.state, msg.chunk);
      return { ok: true };
    case 'session':
      await saveSession(msg.session);
      return { ok: true };
    case 'ensureOffscreen':
      await ensureOffscreen();
      return { ok: true };
    case 'play': {
      const { target: _t, type: _p, ...req } = msg;
      try {
        return { ok: await startPlayback(req) };
      } catch (err) {
        return { ok: false, error: describeError(err) };
      }
    }
    case 'control':
      return { ok: await control(msg.command) };
    case 'closeOffscreen': {
      const tabId = (await getSavedSession())?.tabId ?? null;
      await closeOffscreen();
      await setBadge('', 'Tamber');
      if (msg.reason === 'stopped') {
        await saveSession(null);
        if (tabId !== null) await sendToTab(tabId, { target: 'ui', type: 'miniHide' });
      }
      return { ok: true };
    }
    case 'getMiniState': {
      if (!(await hasOffscreenDocument())) return null;
      const state = await sendToOffscreen<PlayerState>({ target: 'offscreen', type: 'getState' });
      return state ? toMiniState(state) : null;
    }
    case 'readTab': {
      const tab = await browser.tabs.get(msg.tabId).catch(() => undefined);
      return { ok: await readSelectionOrPage(tab) };
    }
    case 'hideMiniPlayer': {
      const tabId = sender.tab?.id;
      const s = await getSavedSession();
      if (tabId !== undefined && s) {
        await browser.storage.session.set({ [HIDDEN_KEY]: { tabId, sessionId: s.sessionId } });
      }
      return { ok: true };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

export async function createContextMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: MENU_IDS.selection,
    title: 'Read with Tamber',
    contexts: ['selection'],
  });
  browser.contextMenus.create({
    id: MENU_IDS.page,
    title: 'Read this page with Tamber',
    contexts: ['page'],
  });
  browser.contextMenus.create({
    id: MENU_IDS.link,
    title: 'Read linked page with Tamber',
    contexts: ['link'],
  });
}

async function forwardSettingsToEngine(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  const settings = await loadSettings();
  await sendToOffscreen({ target: 'offscreen', type: 'updateSettings', settings }, { retries: 0 });
}

/** Register every listener synchronously at the top level of the service worker. */
export function setupBackground(): void {
  void primeExtensionSettings();

  browser.runtime.onInstalled.addListener((details) => {
    void createContextMenus();
    void browser.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch(() => undefined);
    if (details.reason === 'install') {
      void browser.tabs.create({ url: browser.runtime.getURL('/options.html#setup') });
    }
  });

  // Anything that escapes the handlers (e.g. offscreen.createDocument failing) becomes a badge
  // and a mini-player error instead of an unhandled rejection in the service worker.
  browser.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab).catch((err: unknown) => reportError(err, tab?.id));
  });

  browser.commands.onCommand.addListener((command, tab) => {
    handleCommand(command, tab).catch((err: unknown) => reportError(err, tab?.id));
  });

  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isBackgroundMessage(msg)) return;
    handleBackgroundMessage(msg, sender).then(
      (r) => sendResponse(r ?? null),
      (err: unknown) => sendResponse({ ok: false, error: describeError(err) }),
    );
    return true; // async response
  });

  onSettingsChanged((change) => {
    if (change.extension) {
      extLoading = null;
      void primeExtensionSettings();
    }
    if (change.settings) void forwardSettingsToEngine().catch(() => undefined);
  });
}
