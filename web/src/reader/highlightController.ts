/**
 * Karaoke highlight engine: DOM/ref driven, runs from the shared rAF ticker, never sets React
 * state per frame. It reads the player's clock + timeline, picks the active word with
 * wordIndexAt() (server word timestamps), and then only touches the DOM when the word or chunk
 * changes: data-active / data-spoken attributes, one moving pill, auto-scroll.
 */
import { chunkPositionAt, wordIndexAt, type Timeline, type TimelineWord } from '@tamber/client';

export interface FrameSource {
  getFrame(): { timeline: Timeline | null; t: number; activeChunk: number };
}

export interface ActivePick {
  /** Index in timeline.words, -1 = none. */
  wordIndex: number;
  word: TimelineWord | null;
  /** Plan index of the active chunk, -1 = none. */
  chunkIndex: number;
}

/** Pure: which word and chunk are active at timeline time t. */
export function pickActive(timeline: Timeline | null, t: number, fallbackChunk: number): ActivePick {
  if (fallbackChunk < 0) return { wordIndex: -1, word: null, chunkIndex: -1 };
  if (!timeline || t < 0) return { wordIndex: -1, word: null, chunkIndex: fallbackChunk };
  const wordIndex = wordIndexAt(timeline, t);
  const pos = chunkPositionAt(timeline, t);
  const chunkIndex = pos >= 0 ? timeline.chunks[pos]!.index : fallbackChunk;
  const word = wordIndex >= 0 ? (timeline.words[wordIndex] ?? null) : null;
  // A held word from another chunk (should not happen with holdThroughGaps) is dropped.
  if (word && word.chunkIndex !== chunkIndex) return { wordIndex: -1, word: null, chunkIndex };
  return { wordIndex, word, chunkIndex };
}

export interface PillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PillSink {
  move(rect: PillRect, instant: boolean): void;
  hide(): void;
}

export interface HighlightOptions {
  /** Word-level highlight (settings.highlight && word timestamps available). */
  words: boolean;
  autoScroll: boolean;
  reducedMotion: boolean;
}

export interface Viewport {
  /** Visible band of the window in client coordinates (below the header, above the dock). */
  top: number;
  bottom: number;
}

export const MANUAL_SCROLL_PAUSE_MS = 4000;

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);

export class HighlightController {
  private chunkEls: HTMLElement[] | null = null;
  private chunkByIndex = new Map<number, HTMLElement>();
  private activeChunk = -1;
  private activeWordStart = -1;
  private activeWordEl: HTMLElement | null = null;
  private activeChunkEl: HTMLElement | null = null;
  private lastUserScroll = -Infinity;
  private dirty = true;
  /**
   * Set by invalidate(): the previously active chunk/word elements. React may keep these nodes
   * (memoised blocks) with the attributes this class set, so the next update clears them first.
   * Word flags are only ever set inside the active chunk, so sweeping it is enough.
   */
  private staleChunkEl: HTMLElement | null = null;
  private staleWordEl: HTMLElement | null = null;
  private pillVisible = false;

  private readonly root: HTMLElement;
  private readonly pill: PillSink;
  private readonly source: FrameSource;
  private readonly getOptions: () => HighlightOptions;
  private readonly getViewport: () => Viewport;

  constructor(
    root: HTMLElement,
    pill: PillSink,
    source: FrameSource,
    getOptions: () => HighlightOptions,
    getViewport: () => Viewport = () => ({ top: 0, bottom: window.innerHeight }),
  ) {
    this.root = root;
    this.pill = pill;
    this.source = source;
    this.getOptions = getOptions;
    this.getViewport = getViewport;
  }

  /** Listen for manual scrolling (pauses auto-scroll for 4 s). Returns a detach function. */
  attach(): () => void {
    const mark = () => {
      this.lastUserScroll = performance.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) mark();
    };
    window.addEventListener('wheel', mark, { passive: true });
    window.addEventListener('touchmove', mark, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', mark);
      window.removeEventListener('touchmove', mark);
      window.removeEventListener('keydown', onKey);
    };
  }

  /**
   * The reader re-rendered: element caches are stale, re-apply everything on the next update.
   * Memoised blocks keep their DOM nodes (and the attributes this class set on them), so the next
   * update first clears the flags of the previously active chunk and word before re-applying;
   * otherwise they would stay highlighted next to the new ones.
   */
  invalidate(): void {
    if (this.activeChunkEl) this.staleChunkEl = this.activeChunkEl;
    if (this.activeWordEl) this.staleWordEl = this.activeWordEl;
    this.chunkEls = null;
    this.chunkByIndex.clear();
    this.activeWordEl = null;
    this.activeChunkEl = null;
    this.dirty = true;
  }

  /** Force a re-apply (resize, option change). */
  refresh(): void {
    this.dirty = true;
  }

  /** Call every animation frame. Cheap when nothing changed. */
  update(): ActivePick {
    const frame = this.source.getFrame();
    const opts = this.getOptions();
    const pick = pickActive(frame.timeline, frame.t, frame.activeChunk);
    const wordStart = opts.words && pick.word ? pick.word.charStart : -1;
    const chunkChanged = pick.chunkIndex !== this.activeChunk;
    const force = this.dirty;
    this.dirty = false;
    if (this.staleChunkEl || this.staleWordEl) this.clearStale();
    if (chunkChanged || force) this.applyChunk(pick.chunkIndex);
    if (chunkChanged || force || wordStart !== this.activeWordStart) {
      this.applyWord(wordStart, opts, force || chunkChanged);
    }
    return pick;
  }

  /** Remove the highlight flags left on the previously active chunk/word (after a re-render). */
  private clearStale(): void {
    const chunk = this.staleChunkEl;
    const word = this.staleWordEl;
    this.staleChunkEl = null;
    this.staleWordEl = null;
    word?.removeAttribute('data-active');
    if (!chunk) return;
    chunk.removeAttribute('data-active');
    for (const w of chunk.querySelectorAll<HTMLElement>('[data-ws]')) {
      w.removeAttribute('data-active');
      w.removeAttribute('data-spoken');
    }
  }

  private chunks(): HTMLElement[] {
    if (!this.chunkEls) {
      this.chunkEls = Array.from(this.root.querySelectorAll<HTMLElement>('[data-chunk]'));
      this.chunkByIndex.clear();
      for (const el of this.chunkEls) this.chunkByIndex.set(Number(el.dataset.chunk), el);
    }
    return this.chunkEls;
  }

  private chunkEl(index: number): HTMLElement | null {
    this.chunks();
    return this.chunkByIndex.get(index) ?? null;
  }

  private applyChunk(index: number): void {
    const prev = this.activeChunkEl;
    if (prev) {
      prev.removeAttribute('data-active');
      for (const w of prev.querySelectorAll<HTMLElement>('[data-ws]')) {
        w.removeAttribute('data-spoken');
        w.removeAttribute('data-active');
      }
    }
    this.activeChunk = index;
    const el = index >= 0 ? this.chunkEl(index) : null;
    this.activeChunkEl = el;
    el?.setAttribute('data-active', '');
    for (const c of this.chunks()) {
      const i = Number(c.dataset.chunk);
      const spoken = index >= 0 && i < index;
      if (spoken !== c.hasAttribute('data-spoken')) c.toggleAttribute('data-spoken', spoken);
    }
  }

  private applyWord(charStart: number, opts: HighlightOptions, jump: boolean): void {
    this.activeWordEl?.removeAttribute('data-active');
    this.activeWordEl = null;
    this.activeWordStart = charStart;
    const chunkEl = this.activeChunkEl;
    let wordEl: HTMLElement | null = null;
    if (charStart >= 0 && chunkEl) {
      for (const w of chunkEl.querySelectorAll<HTMLElement>('[data-ws]')) {
        const ws = Number(w.dataset.ws);
        if (ws === charStart) wordEl = w;
        const spoken = ws < charStart;
        if (spoken !== w.hasAttribute('data-spoken')) w.toggleAttribute('data-spoken', spoken);
      }
    }
    if (wordEl) {
      wordEl.setAttribute('data-active', '');
      this.activeWordEl = wordEl;
      this.movePill(wordEl, opts.reducedMotion || jump || !this.pillVisible);
      this.scrollIntoBand(wordEl, opts);
    } else {
      if (this.pillVisible) {
        this.pill.hide();
        this.pillVisible = false;
      }
      if (chunkEl && charStart < 0) this.scrollIntoBand(chunkEl, opts);
    }
  }

  private movePill(el: HTMLElement, instant: boolean): void {
    const r = el.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    this.pill.move(
      { x: r.left - root.left, y: r.top - root.top, width: r.width, height: r.height },
      instant,
    );
    this.pillVisible = true;
  }

  private scrollIntoBand(el: HTMLElement, opts: HighlightOptions): void {
    if (!opts.autoScroll) return;
    if (performance.now() - this.lastUserScroll < MANUAL_SCROLL_PAUSE_MS) return;
    const rect = el.getClientRects()[0] ?? el.getBoundingClientRect();
    const vp = this.getViewport();
    const h = Math.max(1, vp.bottom - vp.top);
    const lo = vp.top + h / 3;
    const hi = vp.top + (2 * h) / 3;
    if (rect.top >= lo && rect.bottom <= hi) return;
    const target = window.scrollY + rect.top + rect.height / 2 - (vp.top + h / 2);
    window.scrollTo({ top: Math.max(0, target), behavior: opts.reducedMotion ? 'auto' : 'smooth' });
  }
}
