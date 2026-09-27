import type { ChunkSpan, WordTiming } from '@tamber/client';
import { themeSpec } from '@tamber/client/brand';
import { animate, motion, useMotionValue } from 'motion/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react';
import { onFrame } from '../lib/ticker';
import { buildBlocks, chunkPieces, type ReaderBlock } from './blocks';
import {
  HighlightController,
  type FrameSource,
  type HighlightOptions,
  type PillSink,
  type Viewport,
} from './highlightController';
import classes from './Reader.module.css';

export interface ReaderProps {
  /** Exactly the text sent to /v1/tts. */
  text: string;
  /** Chunk plan (from the `start` event, or the local planChunks() preview until it arrives). */
  plan: readonly ChunkSpan[];
  /** Changes whenever new chunk words may be available. */
  version: number;
  getWords: (index: number) => readonly WordTiming[] | null;
  /** Word-level highlight: settings.highlight && start.word_timestamps. */
  wordsEnabled: boolean;
  autoScroll: boolean;
  reducedMotion: boolean;
  source: FrameSource;
  onSeekChar: (offset: number) => void;
  onSeekChunk: (index: number) => void;
  getViewport?: () => Viewport;
}

function defaultViewport(): Viewport {
  // The app shell scrolls in its own element between the header and the dock (App.module.css).
  const scroller = document.querySelector<HTMLElement>('[data-app-scroller]');
  if (scroller) {
    const r = scroller.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, scroller };
  }
  const header = document.querySelector('[data-app-header]')?.getBoundingClientRect();
  const dock = document.querySelector('[data-player-dock]')?.getBoundingClientRect();
  return {
    top: header ? Math.max(0, header.bottom) : 0,
    bottom: dock && dock.top > 0 ? dock.top : window.innerHeight,
    scroller: null,
  };
}

type WordsList = readonly (readonly WordTiming[] | null)[];

interface BlockViewProps {
  text: string;
  block: ReaderBlock;
  words: WordsList;
}

function renderChunk(text: string, chunk: ChunkSpan, words: readonly WordTiming[] | null) {
  return (
    <span
      key={chunk.index}
      className={classes.chunk}
      data-chunk={chunk.index}
      data-cs={chunk.char_start}
    >
      {chunkPieces(chunk, words).map((p) =>
        p.kind === 'word' ? (
          <span key={p.start} className={classes.word} data-ws={p.start}>
            {text.slice(p.start, p.end)}
          </span>
        ) : (
          text.slice(p.start, p.end)
        ),
      )}
    </span>
  );
}

const BlockView = memo(
  function BlockView({ text, block, words }: BlockViewProps) {
    const out: (string | React.JSX.Element)[] = [];
    let cursor = block.start;
    block.chunks.forEach((chunk, i) => {
      const cs = Math.max(chunk.char_start, block.start);
      if (cs > cursor) out.push(text.slice(cursor, cs));
      out.push(renderChunk(text, chunk, words[i] ?? null));
      cursor = Math.max(cursor, chunk.char_end);
    });
    if (cursor < block.end) out.push(text.slice(cursor, block.end));
    return (
      <div className={classes.block} data-block={block.start}>
        {out}
      </div>
    );
  },
  (a, b) =>
    a.text === b.text &&
    a.block === b.block &&
    a.words.length === b.words.length &&
    a.words.every((w, i) => w === b.words[i]),
);

/**
 * The reading surface: the exact submitted text as chunk spans (plan) containing word spans
 * (added as chunk events arrive), with one absolutely positioned pill that glides to the active
 * word. All per-frame work happens in HighlightController, outside React.
 */
export function Reader(props: ReaderProps) {
  const { text, plan, version, getWords, onSeekChar, onSeekChunk } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HighlightOptions>({
    words: props.wordsEnabled,
    autoScroll: props.autoScroll,
    reducedMotion: props.reducedMotion,
  });
  const sourceRef = useRef(props.source);
  const viewportRef = useRef(props.getViewport ?? defaultViewport);
  const controllerRef = useRef<HighlightController | null>(null);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const opacity = useMotionValue(0);

  const pill = useMemo<PillSink>(() => {
    const spring = { type: 'spring' as const, ...themeSpec.motion.spring };
    return {
      move(rect, instant) {
        const tx = rect.x - 4;
        const ty = rect.y - 1;
        const tw = rect.width + 8;
        const th = rect.height + 2;
        if (instant) {
          x.jump(tx);
          y.jump(ty);
          width.jump(tw);
          height.jump(th);
        } else {
          animate(x, tx, spring);
          animate(y, ty, spring);
          animate(width, tw, spring);
          animate(height, th, spring);
        }
        animate(opacity, 1, { duration: instant ? 0 : themeSpec.motion.fast / 1000 });
      },
      hide() {
        animate(opacity, 0, { duration: themeSpec.motion.fast / 1000 });
      },
    };
  }, [x, y, width, height, opacity]);

  // Keep the latest props visible to the controller without re-creating it.
  useLayoutEffect(() => {
    optionsRef.current = {
      words: props.wordsEnabled,
      autoScroll: props.autoScroll,
      reducedMotion: props.reducedMotion,
    };
    sourceRef.current = props.source;
    viewportRef.current = props.getViewport ?? defaultViewport;
    controllerRef.current?.refresh();
  }, [props.wordsEnabled, props.autoScroll, props.reducedMotion, props.source, props.getViewport]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const controller = new HighlightController(
      root,
      pill,
      { getFrame: () => sourceRef.current.getFrame() },
      () => optionsRef.current,
      () => viewportRef.current(),
    );
    controllerRef.current = controller;
    const detach = controller.attach();
    const stop = onFrame(() => controller.update());
    const ro =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => controller.refresh()) : null;
    ro?.observe(root);
    return () => {
      detach();
      stop();
      ro?.disconnect();
      controllerRef.current = null;
    };
  }, [pill]);

  const blocks = useMemo(() => buildBlocks(text, plan), [text, plan]);
  // `version` is the change signal for getWords(): new words arrive without new props otherwise.
  const words = useMemo(
    () => blocks.map((b) => b.chunks.map((c) => getWords(c.index))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, getWords, version],
  );

  useLayoutEffect(() => {
    controllerRef.current?.invalidate();
  }, [words]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) return; // the user is selecting text, not seeking
    const target = e.target as HTMLElement;
    const w = target.closest<HTMLElement>('[data-ws]');
    if (w && rootRef.current?.contains(w)) {
      onSeekChar(Number(w.dataset.ws));
      return;
    }
    const c = target.closest<HTMLElement>('[data-chunk]');
    if (c && rootRef.current?.contains(c)) onSeekChunk(Number(c.dataset.chunk));
  };

  return (
    <div
      ref={rootRef}
      className={classes.root}
      data-mode={props.wordsEnabled ? 'word' : 'chunk'}
      data-testid="reader"
      aria-label="Text being read"
      onClick={onClick}
    >
      <motion.div
        className={classes.pill}
        aria-hidden
        style={{ x, y, width, height, opacity }}
        data-reader-pill
      />
      {blocks.map((block, i) => (
        <BlockView key={block.start} text={text} block={block} words={words[i] ?? []} />
      ))}
    </div>
  );
}
