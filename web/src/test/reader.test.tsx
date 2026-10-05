import { planChunks, type WordTiming } from '@tamber/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderPanel } from '../features/compose/ReaderPanel';
import { ChunkedPlayer } from '../player/ChunkedPlayer';
import { setPlayer } from '../player/instance';
import { noopAnchor } from '../player/silentAnchor';
import { usePlayerHotkeys } from '../player/usePlayerBindings';
import { Providers } from '../Providers';
import { useDraft } from '../store/draft';
import { useSession } from '../store/session';
import { buildBlocks } from '../reader/blocks';
import { Reader } from '../reader/Reader';
import type { FrameSource } from '../reader/highlightController';
import { chunkEvent, createFakeFetch, FakeAudioContext, startEvent } from './fakes';

const TEXT =
  'First paragraph opens here. It has two sentences.\n\n' +
  'Second paragraph, with an emoji \u{1F600} and "quotes".\n\n\n' +
  'Third one ends the text.';

function nextFrame(): Promise<void> {
  return act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

describe('Reader', () => {
  const plan = planChunks(TEXT, { mode: 'sentence' });
  const c1 = chunkEvent(TEXT, plan[1]!, 1.5);
  const words = new Map<number, WordTiming[]>([[1, c1.words]]);

  it('renders exactly the sent text, one span per planned chunk', () => {
    render(
      <Reader
        text={TEXT}
        plan={plan}
        version={0}
        getWords={() => null}
        wordsEnabled
        autoScroll={false}
        reducedMotion
        source={{ getFrame: () => ({ timeline: null, t: -1, activeChunk: -1 }) }}
        onSeekChar={() => undefined}
        onSeekChunk={() => undefined}
      />,
    );
    const root = screen.getByTestId('reader');
    expect(root.textContent).toBe(TEXT);
    const chunks = root.querySelectorAll<HTMLElement>('[data-chunk]');
    expect(chunks).toHaveLength(plan.length);
    chunks.forEach((el, i) => {
      expect(el.textContent).toBe(TEXT.slice(plan[i]!.char_start, plan[i]!.char_end));
    });
    // Paragraph blocks for content-visibility.
    expect(root.querySelectorAll('[data-block]').length).toBe(buildBlocks(TEXT, plan).length);
    expect(root.querySelectorAll('[data-block]').length).toBe(3);
  });

  it('adds word spans as chunk events arrive and seeks on tap', () => {
    const onSeekChar = vi.fn();
    const onSeekChunk = vi.fn();
    const props = {
      text: TEXT,
      plan,
      getWords: (i: number) => words.get(i) ?? null,
      wordsEnabled: true,
      autoScroll: false,
      reducedMotion: true,
      source: { getFrame: () => ({ timeline: null, t: -1, activeChunk: -1 }) } satisfies FrameSource,
      onSeekChar,
      onSeekChunk,
    };
    render(<Reader {...props} version={1} />);
    const root = screen.getByTestId('reader');
    const spans = root.querySelectorAll<HTMLElement>('[data-ws]');
    expect(spans).toHaveLength(c1.words.length);
    spans.forEach((s, i) => expect(s.textContent).toBe(c1.words[i]!.text));
    expect(root.textContent).toBe(TEXT);

    act(() => spans[1]!.click());
    expect(onSeekChar).toHaveBeenCalledWith(c1.words[1]!.char_start);
    act(() => root.querySelector<HTMLElement>('[data-chunk="2"]')!.click());
    expect(onSeekChunk).toHaveBeenCalledWith(2);
  });

  it('degraded mode: chunk wash only, no word pill', async () => {
    const source: FrameSource = { getFrame: () => ({ timeline: null, t: -1, activeChunk: 2 }) };
    render(
      <Reader
        text={TEXT}
        plan={plan}
        version={0}
        getWords={() => null}
        wordsEnabled={false}
        autoScroll={false}
        reducedMotion
        source={source}
        onSeekChar={() => undefined}
        onSeekChunk={() => undefined}
      />,
    );
    await nextFrame();
    const root = screen.getByTestId('reader');
    expect(root).toHaveAttribute('data-mode', 'chunk');
    expect(root.querySelector('[data-chunk="2"]')).toHaveAttribute('data-active');
    expect(root.querySelector('[data-chunk="0"]')).toHaveAttribute('data-spoken');
    expect(root.querySelectorAll('[data-ws]')).toHaveLength(0);
  });
});

describe('ReaderPanel degraded mode', () => {
  afterEach(() => setPlayer(null));

  it('disables the word-highlight toggle when the server has no word timings', async () => {
    const ctx = new FakeAudioContext();
    const player = new ChunkedPlayer({ createContext: () => ctx.asAudioContext(), anchor: noopAnchor });
    setPlayer(player);
    const net = createFakeFetch();
    const text = 'Hola a todos. Esto es una prueba.';
    const plan = planChunks(text, { mode: 'sentence' });
    player.unlock();
    player.play(
      { text, voice: 'ef_dora', speed: 1, format: 'wav', chunkMode: 'sentence', lang: null },
      { client: net.client },
    );
    await vi.waitFor(() => expect(net.ttsRequests()).toHaveLength(1));
    const stream = net.ttsRequests()[0]!.stream;
    stream.push(startEvent(text, plan, { word_timestamps: false, voice: 'ef_dora', lang: 'e' }));
    stream.push(chunkEvent(text, plan[0]!, 1, { words: false }));
    await vi.waitFor(() => expect(player.getSnapshot().wordTimestamps).toBe(false));

    render(
      <Providers>
        <ReaderPanel />
      </Providers>,
    );
    const toggle = screen.getByTestId('highlight-toggle');
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('degraded-badge')).toBeInTheDocument();
    expect(screen.getByTestId('reader')).toHaveAttribute('data-mode', 'chunk');
    expect(screen.getByTestId('reader').textContent).toBe(text);
  });
});

function Hotkeys() {
  usePlayerHotkeys();
  return <textarea data-testid="field" />;
}

describe('ReaderPanel "New"', () => {
  afterEach(() => {
    setPlayer(null);
    useDraft.getState().clear();
    useSession.setState({ view: 'compose', drawer: null });
  });

  const text = 'Read me once, then start over.';

  async function startReading(): Promise<ChunkedPlayer> {
    const ctx = new FakeAudioContext();
    const player = new ChunkedPlayer({ createContext: () => ctx.asAudioContext(), anchor: noopAnchor });
    setPlayer(player);
    const net = createFakeFetch();
    useDraft.getState().setText(text);
    useSession.getState().setView('read');
    player.unlock();
    player.play(
      { text, voice: 'af_heart', speed: 1, format: 'wav', chunkMode: 'sentence', lang: null },
      { client: net.client },
    );
    await vi.waitFor(() => expect(player.getSnapshot().hasSession).toBe(true));
    return player;
  }

  it('forgets the session, clears the draft and returns to the composer', async () => {
    const player = await startReading();

    render(
      <Providers>
        <ReaderPanel />
      </Providers>,
    );
    fireEvent.click(screen.getByTestId('reader-new'));

    expect(player.getSnapshot().hasSession).toBe(false);
    expect(useDraft.getState().text).toBe('');
    expect(useSession.getState().view).toBe('compose');
  });

  it('Shift+N does the same, but not while typing in a field or behind a drawer', async () => {
    const player = await startReading();
    const user = userEvent.setup();
    render(<Hotkeys />);

    // Typed into a field it is just a capital N.
    await user.click(screen.getByTestId('field'));
    await user.keyboard('{Shift>}N{/Shift}');
    expect(screen.getByTestId('field')).toHaveValue('N');
    expect(player.getSnapshot().hasSession).toBe(true);

    act(() => screen.getByTestId('field').blur());
    act(() => useSession.getState().openDrawer('settings'));
    await user.keyboard('{Shift>}N{/Shift}');
    expect(player.getSnapshot().hasSession).toBe(true);
    act(() => useSession.getState().closeDrawer());

    // Plain n is not the shortcut.
    await user.keyboard('n');
    expect(player.getSnapshot().hasSession).toBe(true);

    await user.keyboard('{Shift>}N{/Shift}');
    expect(player.getSnapshot().hasSession).toBe(false);
    expect(useDraft.getState().text).toBe('');
    expect(useSession.getState().view).toBe('compose');
  });

  it('Shift+N leaves a draft alone in the composer', async () => {
    const player = await startReading();
    useSession.getState().setView('compose');
    const user = userEvent.setup();
    render(<Hotkeys />);

    await user.keyboard('{Shift>}N{/Shift}');
    expect(player.getSnapshot().hasSession).toBe(true);
    expect(useDraft.getState().text).toBe(text);
  });
});
