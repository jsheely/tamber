import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Browser } from 'wxt/browser';
import {
  MENU_IDS,
  MINI_PLAYER_SCRIPT,
  badgeTextFor,
  clampText,
  control,
  handleBackgroundMessage,
  handleCommand,
  handleContextMenuClick,
  setExtensionSettingsCache,
} from '../lib/background';
import { OFFSCREEN_JUSTIFICATION, OFFSCREEN_PATH } from '../lib/offscreen';
import { saveSettings } from '../lib/settings';

type Injection = { target: unknown; func?: (...a: unknown[]) => unknown; files?: string[] };

const TAB = {
  id: 5,
  windowId: 1,
  title: 'A page',
  url: 'https://news.example.com/a',
} as Browser.tabs.Tab;

function mockExtensionApis(pageResults: Record<string, unknown> = {}) {
  let docOpen = false;
  const createDocument = vi.fn(async () => {
    docOpen = true;
  });
  const hasDocument = vi.fn(async () => docOpen);
  const closeDocument = vi.fn(async () => {
    docOpen = false;
  });
  Object.assign(fakeBrowser.offscreen, { createDocument, hasDocument, closeDocument });

  const executeScript = vi.fn(async (inj: Injection) => {
    if (inj.files) return [{ frameId: 0, documentId: 'd', result: 'mounted' }];
    const name = inj.func?.name ?? '';
    const result = name in pageResults ? pageResults[name] : undefined;
    return [{ frameId: 0, documentId: 'd', result }];
  });
  Object.assign(fakeBrowser.scripting, { executeScript });

  const open = vi.fn(async () => undefined);
  Object.assign(fakeBrowser.sidePanel, { open });

  const openPopup = vi.fn(async () => undefined);
  Object.assign(fakeBrowser.action, { openPopup });

  const contains = vi.fn(async () => true);
  Object.assign(fakeBrowser.permissions, { contains });

  // Stand-in for the offscreen document's listener.
  const played: Array<Record<string, unknown>> = [];
  fakeBrowser.runtime.onMessage.addListener(
    (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      const m = msg as Record<string, unknown>;
      if (m?.target !== 'offscreen') return;
      played.push(m);
      sendResponse({ ok: true });
      return true;
    },
  );
  return {
    createDocument,
    hasDocument,
    closeDocument,
    executeScript,
    open,
    openPopup,
    contains,
    played,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('background: context menu', () => {
  beforeEach(async () => {
    await saveSettings({ apiBaseUrl: 'https://tts.example.com', voice: 'af_bella', speed: 1.25 });
    setExtensionSettingsCache({ showMiniPlayer: false, openOnPlay: 'none' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setExtensionSettingsCache(null);
  });

  it('reads a selection through the offscreen document with the configured voice and speed', async () => {
    const apis = mockExtensionApis({ pageSelection: 'Hello there.\n\nSecond paragraph.' });
    await handleContextMenuClick(
      { menuItemId: MENU_IDS.selection, selectionText: 'Hello there. Second paragraph.' } as never,
      TAB,
    );
    expect(apis.hasDocument).toHaveBeenCalled();
    expect(apis.createDocument).toHaveBeenCalledWith({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: OFFSCREEN_JUSTIFICATION,
    });
    const play = apis.played.find((m) => m.type === 'play')!;
    expect(play).toBeDefined();
    expect(play.text).toBe('Hello there.\n\nSecond paragraph.');
    expect(play.tabId).toBe(5);
    expect(play.settings).toMatchObject({ voice: 'af_bella', speed: 1.25 });
  });

  it('falls back to info.selectionText when the page cannot be scripted', async () => {
    const apis = mockExtensionApis();
    apis.executeScript.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    await handleContextMenuClick(
      { menuItemId: MENU_IDS.selection, selectionText: 'Plain selection.' } as never,
      TAB,
    );
    expect(apis.played.find((m) => m.type === 'play')?.text).toBe('Plain selection.');
  });

  it('"Read this page" injects a script for the HTML and extracts it on the server', async () => {
    const apis = mockExtensionApis({
      pageHtml: { html: '<html><body><p>Body</p></body></html>', url: TAB.url, title: 'A page' },
    });
    const fetchMock = vi.fn(async (url: string, init: { body?: string }) => {
      expect(url).toBe('https://tts.example.com/v1/extract');
      expect(JSON.parse(init.body ?? '{}')).toMatchObject({ url: TAB.url });
      return jsonResponse({
        title: 'Extracted title',
        text: 'First paragraph.\n\nSecond paragraph.',
        source: TAB.url,
        source_type: 'html',
        mime_type: 'text/html',
        word_count: 4,
        char_count: 35,
        truncated: false,
        language: 'en',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick({ menuItemId: MENU_IDS.page } as never, TAB);

    expect(apis.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 5 }, func: expect.any(Function) }),
    );
    expect(apis.executeScript.mock.calls[0]![0].func!.name).toBe('pageHtml');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const play = apis.played.find((m) => m.type === 'play')!;
    expect(play.text).toBe('Extracted title\n\nFirst paragraph.\n\nSecond paragraph.');
    expect(play.title).toBe('Extracted title');
  });

  it('creates the offscreen document only once (hasDocument guard)', async () => {
    const apis = mockExtensionApis({ pageSelection: 'One.' });
    await handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    await handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    expect(apis.hasDocument.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(apis.createDocument).toHaveBeenCalledTimes(1);
    expect(apis.played.filter((m) => m.type === 'play')).toHaveLength(2);
  });

  it('opens the side panel synchronously, before any await, when chosen', async () => {
    setExtensionSettingsCache({ showMiniPlayer: false, openOnPlay: 'sidepanel' });
    const apis = mockExtensionApis({ pageSelection: 'Hi.' });
    const pending = handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    // Nothing has been awaited yet: the gesture-bound call already happened.
    expect(apis.open).toHaveBeenCalledWith({ tabId: 5 });
    expect(apis.openPopup).not.toHaveBeenCalled();
    expect(apis.contains).not.toHaveBeenCalled();
    expect(apis.executeScript).not.toHaveBeenCalled();
    await pending;
    expect(apis.open.mock.invocationCallOrder[0]).toBeLessThan(
      apis.executeScript.mock.invocationCallOrder[0]!,
    );
  });

  it('opens the toolbar popup synchronously, before any await, when chosen', async () => {
    setExtensionSettingsCache({ showMiniPlayer: false, openOnPlay: 'popup' });
    const apis = mockExtensionApis({ pageSelection: 'Hi.' });
    const pending = handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    expect(apis.openPopup).toHaveBeenCalledWith({ windowId: 1 });
    expect(apis.open).not.toHaveBeenCalled();
    expect(apis.executeScript).not.toHaveBeenCalled();
    await pending;
    expect(apis.played.find((m) => m.type === 'play')?.text).toBe('Hi.');
  });

  it('still reads when the popup cannot be opened', async () => {
    setExtensionSettingsCache({ showMiniPlayer: false, openOnPlay: 'popup' });
    const apis = mockExtensionApis({ pageSelection: 'Hi.' });
    apis.openPopup.mockRejectedValueOnce(new Error('Could not find an active browser window.'));
    await handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    expect(apis.played.find((m) => m.type === 'play')?.text).toBe('Hi.');
  });

  it('opens nothing with "just read"', async () => {
    const apis = mockExtensionApis({ pageSelection: 'Hi.' });
    await handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    expect(apis.open).not.toHaveBeenCalled();
    expect(apis.openPopup).not.toHaveBeenCalled();
  });

  it('injects the mini-player into the tab when enabled', async () => {
    setExtensionSettingsCache({ showMiniPlayer: true, openOnPlay: 'none' });
    const apis = mockExtensionApis({ pageSelection: 'Hi.' });
    await handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    expect(apis.executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: [MINI_PLAYER_SCRIPT],
    });
  });

  it('sends the user to Options when no server is configured', async () => {
    await saveSettings({ apiBaseUrl: '' });
    const apis = mockExtensionApis({ pageSelection: 'Hi.' });
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    await handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    expect(create).toHaveBeenCalledWith({ url: expect.stringContaining('options.html#setup') });
    expect(apis.createDocument).not.toHaveBeenCalled();
  });

  it('asks for the host permission when it is missing', async () => {
    const apis = mockExtensionApis({ pageSelection: 'Hi.' });
    apis.contains.mockResolvedValue(false);
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    await handleContextMenuClick({ menuItemId: MENU_IDS.selection } as never, TAB);
    expect(create).toHaveBeenCalledWith({
      url: expect.stringContaining('options.html#permission'),
    });
    expect(apis.played).toHaveLength(0);
  });
});

describe('background: commands', () => {
  beforeEach(async () => {
    await saveSettings({ apiBaseUrl: 'https://tts.example.com' });
    setExtensionSettingsCache({ showMiniPlayer: false, openOnPlay: 'none' });
  });
  afterEach(() => setExtensionSettingsCache(null));

  it('read-selection reads the selection from every frame', async () => {
    const apis = mockExtensionApis({ pageSelection: 'Selected words.' });
    await handleCommand('read-selection', TAB);
    expect(apis.executeScript.mock.calls[0]![0]).toMatchObject({
      target: { tabId: 5, allFrames: true },
    });
    expect(apis.played.find((m) => m.type === 'play')?.text).toBe('Selected words.');
  });

  it('read-selection opens the chosen reader UI inside the gesture', async () => {
    setExtensionSettingsCache({ showMiniPlayer: false, openOnPlay: 'popup' });
    const apis = mockExtensionApis({ pageSelection: 'Selected words.' });
    const pending = handleCommand('read-selection', TAB);
    expect(apis.openPopup).toHaveBeenCalledWith({ windowId: 1 });
    await pending;
    expect(apis.played.find((m) => m.type === 'play')?.text).toBe('Selected words.');
  });

  it('read-selection with nothing selected reads the page text extracted in-page', async () => {
    const apis = mockExtensionApis({
      pageSelection: '',
      pageReadableText: { text: 'The article body.', title: 'Article', url: TAB.url },
    });
    await handleCommand('read-selection', TAB);
    const names = apis.executeScript.mock.calls.map((c) => c[0].func?.name);
    expect(names).toContain('pageReadableText');
    expect(apis.played.find((m) => m.type === 'play')?.text).toBe('Article\n\nThe article body.');
  });

  it('read-selection with an empty page shows a badge instead of playing', async () => {
    const apis = mockExtensionApis({
      pageSelection: '',
      pageReadableText: { text: '', title: '', url: '' },
    });
    await handleCommand('read-selection', TAB);
    expect(apis.played).toHaveLength(0);
    expect(await fakeBrowser.action.getBadgeText({})).toBe('?');
  });

  it('toggle/stop are forwarded to the offscreen document when it exists', async () => {
    const apis = mockExtensionApis();
    await apis.createDocument();
    await handleCommand('toggle-playback', TAB);
    await handleCommand('stop-playback', TAB);
    expect(apis.played.map((m) => m.type)).toEqual(['toggle', 'stop']);
    expect(apis.closeDocument).toHaveBeenCalled();
  });

  it('toggle resumes the remembered session after the offscreen document closed', async () => {
    const apis = mockExtensionApis();
    await fakeBrowser.storage.session.set({
      'tamber.lastSession': {
        text: 'Resume me. Second.',
        title: 'Saved',
        sourceUrl: null,
        tabId: 5,
        chunk: 1,
        sessionId: 2,
      },
    });
    expect(await control('toggle')).toBe(true);
    expect(apis.createDocument).toHaveBeenCalledTimes(1);
    expect(apis.played.find((m) => m.type === 'play')).toMatchObject({
      text: 'Resume me. Second.',
      startChunk: 1,
    });
  });
});

describe('background: mini-player lifecycle', () => {
  const HIDE = { target: 'ui', type: 'miniHide' };
  const session = (tabId: number | null, sessionId = 1) => ({
    text: 'Some text.',
    title: 'Saved',
    sourceUrl: null,
    tabId,
    chunk: 0,
    sessionId,
  });
  function mockTabMessages() {
    const sendMessage = vi.fn(async () => undefined);
    Object.assign(fakeBrowser.tabs, { sendMessage });
    return sendMessage;
  }

  it('stopping from the popup or a shortcut hides the mini-player of the tab being read', async () => {
    const apis = mockExtensionApis();
    const sendMessage = mockTabMessages();
    await fakeBrowser.storage.session.set({ 'tamber.lastSession': session(5) });
    await apis.createDocument();
    await handleCommand('stop-playback', TAB);
    expect(sendMessage).toHaveBeenCalledWith(5, HIDE);
    expect(await fakeBrowser.storage.session.get('tamber.lastSession')).toEqual({});
  });

  it('a new reading in another tab (or of pasted text) hides the previous mini-player', async () => {
    mockExtensionApis();
    const sendMessage = mockTabMessages();
    await fakeBrowser.storage.session.set({ 'tamber.lastSession': session(5) });
    await handleBackgroundMessage(
      { target: 'background', type: 'session', session: session(9, 2) },
      {} as never,
    );
    expect(sendMessage).toHaveBeenCalledWith(5, HIDE);

    sendMessage.mockClear();
    await handleBackgroundMessage(
      { target: 'background', type: 'session', session: session(9, 3) },
      {} as never,
    );
    expect(sendMessage).not.toHaveBeenCalled(); // same tab: its mini-player shows the new reading

    await handleBackgroundMessage(
      { target: 'background', type: 'session', session: session(null, 4) },
      {} as never,
    );
    expect(sendMessage).toHaveBeenCalledWith(9, HIDE);
  });
});

describe('background helpers', () => {
  it('badge text reflects the playback status', () => {
    expect(badgeTextFor({ status: 'playing', progress: 0.423 })).toBe('42%');
    expect(badgeTextFor({ status: 'loading', progress: 0 })).toBe('…');
    expect(badgeTextFor({ status: 'paused', progress: 0.5 })).toBe('II');
    expect(badgeTextFor({ status: 'idle', progress: 1 })).toBe('');
  });

  it('clampText cuts long text at a paragraph boundary', () => {
    const para = 'x'.repeat(60);
    const text = Array.from({ length: 10 }, () => para).join('\n\n');
    const out = clampText(text, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('x')).toBe(true);
    expect(clampText('  short  ')).toBe('short');
  });
});
