/**
 * The word-highlighting reader (side panel). Renders exactly the text that was sent to the API as
 * chunk spans (from the plan) containing word spans (as chunk events arrive). Highlight state comes
 * only from the offscreen engine's state (activeChunk / activeWord); nothing here derives timing.
 *
 * Performance: the text renders once per chunk arrival (each chunk is a memoised component), and
 * the moving highlight is applied with direct DOM attribute updates plus one animated pill, so a
 * word change never re-renders the text.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useAnimate, useReducedMotion } from 'motion/react';
import type { ChunkSpan } from '@tamber/client';
import type { CharSpan } from '../lib/messages';
import type { WordMap } from '../hooks/usePlayer';
import { motionSpec } from '../lib/theme';

export interface ReaderProps {
  text: string;
  plan: readonly ChunkSpan[];
  words: WordMap;
  activeChunk: number;
  activeWord: CharSpan | null;
  /** Word-level highlight (false: the active chunk wash only). */
  highlight: boolean;
  autoScroll: boolean;
  onSeekChar?: (offset: number) => void;
  className?: string;
  style?: CSSProperties;
}

/** Pause auto-scroll this long after the user scrolls by hand. */
const USER_SCROLL_PAUSE_MS = 4000;

const ChunkView = memo(function ChunkView({
  text,
  chunk,
  words,
}: {
  text: string;
  chunk: ChunkSpan;
  words: ReadonlyArray<readonly [number, number]> | undefined;
}) {
  const inner: Array<string | React.JSX.Element> = [];
  if (words && words.length) {
    let p = chunk.char_start;
    for (const [a, b] of words) {
      if (a < p || b > chunk.char_end || b <= a) continue;
      if (a > p) inner.push(text.slice(p, a));
      inner.push(
        <span key={a} className="tamber-word" data-w={a} data-we={b}>
          {text.slice(a, b)}
        </span>,
      );
      p = b;
    }
    if (p < chunk.char_end) inner.push(text.slice(p, chunk.char_end));
  } else {
    inner.push(text.slice(chunk.char_start, chunk.char_end));
  }
  return (
    <span className="tamber-chunk" data-chunk={chunk.index} data-start={chunk.char_start}>
      {inner}
    </span>
  );
});

function setFlag(el: Element, name: string, on: boolean) {
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
}

export function Reader({
  text,
  plan,
  words,
  activeChunk,
  activeWord,
  highlight,
  autoScroll,
  onSeekChar,
  className,
  style,
}: ReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastUserScroll = useRef(0);
  const [pillScope, animatePill] = useAnimate<HTMLDivElement>();
  const reduce = useReducedMotion();

  const content = useMemo(() => {
    if (!plan.length) return [text];
    const out: Array<string | React.JSX.Element> = [];
    let pos = 0;
    for (const c of plan) {
      if (c.char_start > pos) out.push(text.slice(pos, c.char_start));
      out.push(<ChunkView key={c.index} text={text} chunk={c} words={words.get(c.index)} />);
      pos = Math.max(pos, c.char_end);
    }
    if (pos < text.length) out.push(text.slice(pos));
    return out;
  }, [text, plan, words]);

  // Active chunk wash + dim spoken chunks.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-chunk]').forEach((el) => {
      const i = Number(el.dataset.chunk);
      setFlag(el, 'data-active', i === activeChunk);
      setFlag(el, 'data-spoken', activeChunk >= 0 && i < activeChunk);
    });
  }, [activeChunk, content]);

  // Active word: flag it, dim the words before it in its chunk, move the pill, auto-scroll.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const pill = pillScope.current;
    if (!root) return;
    root.querySelectorAll('.tamber-word[data-active], .tamber-word[data-spoken]').forEach((el) => {
      el.removeAttribute('data-active');
      el.removeAttribute('data-spoken');
    });

    const chunkEl =
      activeChunk >= 0 ? root.querySelector<HTMLElement>(`[data-chunk="${activeChunk}"]`) : null;
    let target: HTMLElement | null = chunkEl;
    const wordEl =
      highlight && activeWord
        ? root.querySelector<HTMLElement>(`[data-w="${activeWord.charStart}"]`)
        : null;

    if (wordEl) {
      target = wordEl;
      setFlag(wordEl, 'data-active', true);
      const chunk = wordEl.closest<HTMLElement>('[data-chunk]');
      if (chunk) {
        for (const w of chunk.querySelectorAll<HTMLElement>('.tamber-word')) {
          if (w === wordEl) break;
          setFlag(w, 'data-spoken', true);
        }
      }
      if (pill) {
        const box = {
          x: wordEl.offsetLeft - 3,
          y: wordEl.offsetTop - 1,
          width: wordEl.offsetWidth + 6,
          height: wordEl.offsetHeight + 2,
          opacity: 1,
        };
        void animatePill(
          pill,
          box,
          reduce ? { duration: 0 } : { type: 'spring', ...motionSpec.spring },
        );
      }
    } else if (pill) {
      void animatePill(pill, { opacity: 0 }, { duration: reduce ? 0 : 0.15 });
    }

    // Keep the active line in the middle third of the viewport.
    const sc = scrollRef.current;
    if (
      autoScroll &&
      target &&
      sc &&
      Date.now() - lastUserScroll.current > USER_SCROLL_PAUSE_MS &&
      typeof sc.scrollTo === 'function'
    ) {
      const scRect = sc.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const y = r.top - scRect.top + sc.scrollTop;
      const h = sc.clientHeight;
      if (h > 0 && (y < sc.scrollTop + h / 3 || y + r.height > sc.scrollTop + (2 * h) / 3)) {
        sc.scrollTo({
          top: Math.max(0, y - h / 2 + r.height / 2),
          behavior: reduce ? 'auto' : 'smooth',
        });
      }
    }
  }, [activeWord, activeChunk, highlight, autoScroll, content, animatePill, pillScope, reduce]);

  const markUserScroll = useCallback(() => {
    lastUserScroll.current = Date.now();
  }, []);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onSeekChar) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return; // the user is selecting text, not seeking
      const t = e.target as HTMLElement;
      const w = t.closest<HTMLElement>('[data-w]');
      if (w) {
        onSeekChar(Number(w.dataset.w));
        return;
      }
      const c = t.closest<HTMLElement>('[data-chunk]');
      if (c) onSeekChar(Number(c.dataset.start));
    },
    [onSeekChar],
  );

  return (
    <div
      ref={scrollRef}
      className={`tamber-reader-scroll${className ? ` ${className}` : ''}`}
      style={style}
      onWheel={markUserScroll}
      onTouchMove={markUserScroll}
      onKeyDown={markUserScroll}
    >
      <div
        ref={rootRef}
        className="tamber-reader"
        data-highlight={highlight ? 'on' : 'off'}
        onClick={onClick}
        role="document"
        aria-label="Text being read"
      >
        <div ref={pillScope} className="tamber-pill" style={{ opacity: 0 }} aria-hidden />
        {content}
      </div>
    </div>
  );
}

/**
 * One sentence with its active word highlighted (popup "now playing").
 */
export function SentenceView({
  sentence,
  word,
  style,
}: {
  sentence: string;
  word: readonly [number, number] | null;
  style?: CSSProperties;
}) {
  if (!sentence) return null;
  if (!word) return <span style={style}>{sentence}</span>;
  const [a, b] = word;
  return (
    <span style={style}>
      <span style={{ opacity: 0.6 }}>{sentence.slice(0, a)}</span>
      <mark
        style={{
          background: 'var(--tamber-word-bg)',
          color: 'inherit',
          borderRadius: 5,
          padding: '0 2px',
          margin: '0 -2px',
          transition: 'background 120ms',
        }}
      >
        {sentence.slice(a, b)}
      </mark>
      {sentence.slice(b)}
    </span>
  );
}
