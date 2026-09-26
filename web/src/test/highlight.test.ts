import { buildTimeline, wordIndexAt, type Timeline } from '@tamber/client';
import { describe, expect, it, vi } from 'vitest';
import { HighlightController, pickActive, type PillSink } from '../reader/highlightController';
import { chunkEvent, SAMPLE_TEXT, samplePlan } from './fakes';

function fixture() {
  const plan = samplePlan().slice(0, 2);
  const c0 = chunkEvent(SAMPLE_TEXT, plan[0]!, 2);
  const c1 = chunkEvent(SAMPLE_TEXT, plan[1]!, 3);
  const timeline = buildTimeline([c0, c1]);
  // Minimal DOM in the Reader's shape: chunk spans containing word spans.
  const root = document.createElement('div');
  for (const c of [c0, c1]) {
    const chunk = document.createElement('span');
    chunk.dataset.chunk = String(c.index);
    for (const w of c.words) {
      const span = document.createElement('span');
      span.dataset.ws = String(w.char_start);
      span.textContent = w.text;
      chunk.append(span, ' ');
    }
    root.append(chunk);
  }
  document.body.append(root);
  return { plan, c0, c1, timeline, root };
}

describe('pickActive / wordIndexAt', () => {
  it('picks the word being spoken at time t, across chunks', () => {
    const { timeline, c0, c1 } = fixture();
    // Middle of the 2nd word of chunk 0.
    const w1 = c0.words[1]!;
    const t0 = (w1.start + w1.end) / 2;
    const p0 = pickActive(timeline, t0, 0);
    expect(p0.wordIndex).toBe(wordIndexAt(timeline, t0));
    expect(p0.word?.charStart).toBe(w1.char_start);
    expect(p0.chunkIndex).toBe(0);

    // Chunk 1 starts at the decoded duration of chunk 0 (2 s).
    const w = c1.words[2]!;
    const t1 = 2 + (w.start + w.end) / 2;
    const p1 = pickActive(timeline, t1, 1);
    expect(p1.chunkIndex).toBe(1);
    expect(p1.word?.charStart).toBe(w.char_start);
    expect(p1.word?.text).toBe(SAMPLE_TEXT.slice(w.char_start, w.char_end));
  });

  it('returns no word before playback and no chunk when stopped', () => {
    const { timeline } = fixture();
    expect(pickActive(timeline, -1, 0)).toEqual({ wordIndex: -1, word: null, chunkIndex: 0 });
    expect(pickActive(timeline, 1, -1).chunkIndex).toBe(-1);
    expect(pickActive(null, 1, 3)).toEqual({ wordIndex: -1, word: null, chunkIndex: 3 });
  });
});

describe('HighlightController', () => {
  function run(timeline: Timeline, root: HTMLElement, words = true) {
    let t = 0;
    let chunk = 0;
    const pill: PillSink = { move: vi.fn(), hide: vi.fn() };
    const ctrl = new HighlightController(
      root,
      pill,
      { getFrame: () => ({ timeline, t, activeChunk: chunk }) },
      () => ({ words, autoScroll: false, reducedMotion: true }),
    );
    return {
      ctrl,
      pill,
      at(time: number, activeChunk: number) {
        t = time;
        chunk = activeChunk;
        return ctrl.update();
      },
    };
  }

  it('marks the active word and chunk, dims spoken text and moves one pill', () => {
    const { timeline, root, c0, c1 } = fixture();
    const h = run(timeline, root);
    const w2 = c0.words[2]!;
    h.at((w2.start + w2.end) / 2, 0);

    const active = root.querySelectorAll('[data-ws][data-active]');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.ws).toBe(String(w2.char_start));
    expect(root.querySelector('[data-chunk="0"]')).toHaveAttribute('data-active');
    const spoken = [...root.querySelectorAll<HTMLElement>('[data-chunk="0"] [data-spoken]')].map((e) => e.dataset.ws);
    expect(spoken).toEqual([String(c0.words[0]!.char_start), String(c0.words[1]!.char_start)]);
    expect(h.pill.move).toHaveBeenCalledTimes(1);

    // Same word on the next frame: nothing touched.
    h.at((w2.start + w2.end) / 2 + 0.001, 0);
    expect(h.pill.move).toHaveBeenCalledTimes(1);

    // Into chunk 1: chunk 0 becomes spoken, its word flags are cleared.
    const w = c1.words[0]!;
    h.at(2 + (w.start + w.end) / 2, 0);
    expect(root.querySelector('[data-chunk="0"]')).toHaveAttribute('data-spoken');
    expect(root.querySelector('[data-chunk="0"]')).not.toHaveAttribute('data-active');
    expect(root.querySelector('[data-chunk="1"]')).toHaveAttribute('data-active');
    expect(root.querySelectorAll('[data-chunk="0"] [data-ws][data-spoken]')).toHaveLength(0);
    expect(root.querySelector(`[data-ws="${w.char_start}"]`)).toHaveAttribute('data-active');
    root.remove();
  });

  it('leaves exactly one active chunk and word after a re-render (invalidate) and a seek', () => {
    const { timeline, root, c0, c1 } = fixture();
    const h = run(timeline, root);
    const w0 = c0.words[1]!;
    h.at((w0.start + w0.end) / 2, 0);
    expect(root.querySelector('[data-chunk="0"]')).toHaveAttribute('data-active');

    // The Reader re-renders (new chunk words arrived) but React keeps the same DOM nodes.
    h.ctrl.invalidate();
    const w1 = c1.words[1]!;
    h.at(2 + (w1.start + w1.end) / 2, 1);
    expect([...root.querySelectorAll<HTMLElement>('[data-chunk][data-active]')].map((e) => e.dataset.chunk)).toEqual(['1']);
    expect([...root.querySelectorAll<HTMLElement>('[data-ws][data-active]')].map((e) => e.dataset.ws)).toEqual([
      String(w1.char_start),
    ]);
    expect(root.querySelectorAll('[data-chunk="0"] [data-ws][data-spoken]')).toHaveLength(0);

    // Seek back to chunk 0 after another re-render: chunk 1 loses its wash and word flags.
    h.ctrl.invalidate();
    h.at((w0.start + w0.end) / 2, 0);
    expect([...root.querySelectorAll<HTMLElement>('[data-chunk][data-active]')].map((e) => e.dataset.chunk)).toEqual(['0']);
    expect(root.querySelectorAll('[data-chunk="1"] [data-ws][data-spoken], [data-chunk="1"] [data-ws][data-active]')).toHaveLength(0);
    expect(root.querySelector('[data-chunk="1"]')).not.toHaveAttribute('data-spoken');
    root.remove();
  });

  it('chunk wash only when word highlighting is off (degraded)', () => {
    const { timeline, root, c1 } = fixture();
    const h = run(timeline, root, false);
    const w = c1.words[1]!;
    h.at(2 + (w.start + w.end) / 2, 1);
    expect(root.querySelector('[data-chunk="1"]')).toHaveAttribute('data-active');
    expect(root.querySelectorAll('[data-ws][data-active]')).toHaveLength(0);
    expect(h.pill.move).not.toHaveBeenCalled();
    root.remove();
  });
});
