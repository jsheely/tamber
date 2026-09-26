import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { planChunks } from '@tamber/client';
import { Reader, SentenceView } from '../components/Reader';
import type { WordMap } from '../hooks/usePlayer';
import { reducePortMessage } from '../hooks/usePlayer';
import { createIdleState } from '../lib/messages';

const TEXT = 'Hello world. This is Tamber.\n\nA new paragraph here.';
const PLAN = planChunks(TEXT, { mode: 'sentence' });

function wordsOf(index: number): Array<[number, number]> {
  const c = PLAN[index]!;
  return [...TEXT.slice(c.char_start, c.char_end).matchAll(/\S+/g)].map((m) => [
    c.char_start + m.index!,
    c.char_start + m.index! + m[0].length,
  ]);
}

function renderReader(props: Partial<Parameters<typeof Reader>[0]> = {}) {
  const words: WordMap = new Map([
    [0, wordsOf(0)],
    [1, wordsOf(1)],
  ]);
  const onSeekChar = vi.fn();
  const utils = render(
    <MantineProvider>
      <Reader
        text={TEXT}
        plan={PLAN}
        words={words}
        activeChunk={1}
        activeWord={{ charStart: TEXT.indexOf(' is ') + 1, charEnd: TEXT.indexOf(' is ') + 3 }}
        highlight
        autoScroll
        onSeekChar={onSeekChar}
        {...props}
      />
    </MantineProvider>,
  );
  return { ...utils, onSeekChar };
}

describe('Reader', () => {
  it('renders exactly the submitted text', () => {
    renderReader();
    const doc = screen.getByRole('document');
    expect(doc.textContent).toBe(TEXT);
  });

  it('renders chunk spans from the plan and word spans for received chunks', () => {
    const { container } = renderReader();
    expect(container.querySelectorAll('[data-chunk]')).toHaveLength(PLAN.length);
    expect(container.querySelectorAll('[data-chunk="0"] .tamber-word')).toHaveLength(2);
    expect(container.querySelectorAll('[data-chunk="2"] .tamber-word')).toHaveLength(0);
  });

  it('marks the active chunk, the active word and the spoken text', () => {
    const { container } = renderReader();
    expect(container.querySelector('[data-chunk="1"]')).toHaveAttribute('data-active');
    expect(container.querySelector('[data-chunk="0"]')).toHaveAttribute('data-spoken');
    expect(container.querySelector('[data-chunk="2"]')).not.toHaveAttribute('data-spoken');
    const active = container.querySelector('.tamber-word[data-active]');
    expect(active?.textContent).toBe('is');
    const spoken = [...container.querySelectorAll('[data-chunk="1"] .tamber-word[data-spoken]')];
    expect(spoken.map((e) => e.textContent)).toEqual(['This']);
  });

  it('shows only the chunk wash when word highlighting is off', () => {
    const { container } = renderReader({ highlight: false });
    expect(container.querySelector('.tamber-word[data-active]')).toBeNull();
    expect(container.querySelector('[data-chunk="1"]')).toHaveAttribute('data-active');
  });

  it('clicking a word seeks to its offset; clicking an untimed chunk seeks to its start', () => {
    const { container, onSeekChar } = renderReader();
    fireEvent.click(screen.getByText('Tamber.'));
    expect(onSeekChar).toHaveBeenCalledWith(TEXT.indexOf('Tamber.'));
    fireEvent.click(container.querySelector('[data-chunk="2"]')!);
    expect(onSeekChar).toHaveBeenLastCalledWith(PLAN[2]!.char_start);
  });

  it('moves the highlight when the active word changes (no re-derived timing)', () => {
    const { container, rerender } = renderReader();
    const words: WordMap = new Map([
      [0, wordsOf(0)],
      [1, wordsOf(1)],
    ]);
    rerender(
      <MantineProvider>
        <Reader
          text={TEXT}
          plan={PLAN}
          words={words}
          activeChunk={1}
          activeWord={{ charStart: TEXT.indexOf('Tamber'), charEnd: TEXT.indexOf('Tamber') + 7 }}
          highlight
          autoScroll={false}
        />
      </MantineProvider>,
    );
    expect(container.querySelectorAll('.tamber-word[data-active]')).toHaveLength(1);
    expect(container.querySelector('.tamber-word[data-active]')?.textContent).toBe('Tamber.');
  });
});

describe('SentenceView', () => {
  it('highlights the active word inside the sentence', () => {
    render(<SentenceView sentence="This is Tamber." word={[8, 14]} />);
    expect(screen.getByText('Tamber').tagName).toBe('MARK');
  });
});

describe('reducePortMessage', () => {
  it('applies snapshot, chunk and patch messages', () => {
    let view = { state: createIdleState(), words: new Map() as WordMap };
    view = reducePortMessage(view, {
      type: 'snapshot',
      state: createIdleState({ text: TEXT, status: 'loading' }),
      words: [{ index: 0, words: wordsOf(0) }],
    });
    expect(view.state.text).toBe(TEXT);
    expect(view.words.get(0)).toHaveLength(2);
    const before = view.words;
    view = reducePortMessage(view, { type: 'chunk', chunk: { index: 1, words: wordsOf(1) } });
    expect(view.words).not.toBe(before);
    expect(view.words.get(1)).toHaveLength(3);
    view = reducePortMessage(view, { type: 'patch', patch: { status: 'playing', activeChunk: 1 } });
    expect(view.state).toMatchObject({ status: 'playing', activeChunk: 1, text: TEXT });
  });
});
