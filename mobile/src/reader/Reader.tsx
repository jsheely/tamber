/**
 * The karaoke reader: the exact submitted text as a virtualised FlatList of paragraphs built from
 * the chunk plan, each paragraph a <Text> of memoised ChunkText spans.
 *
 * - Active word: pill background (themeSpec.highlight word colours); active chunk: a soft wash;
 *   spoken text is dimmed (themeSpec.highlight.spokenOpacity).
 * - Tap any word to seek there; tap between words to seek to the chunk.
 * - Auto-scroll keeps the active chunk about a third of the way down the viewport, and pauses for
 *   4 s after the user drags the list.
 */
import type { ChunkSpan, WordTiming } from '@tamber/client';
import { memo, useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react';
import { FlatList, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { spacing, type, usePalette, useReduceMotion } from '@/theme';

import { ChunkText, type ChunkColors, type ChunkPhase } from './ChunkText';
import { buildParagraphs, paragraphIndexByChunk, withAlpha, type Paragraph } from './layout';

export const AUTOSCROLL_PAUSE_MS = 4000;

export interface ReaderProps {
  text: string;
  plan: readonly ChunkSpan[];
  chunkWords: Readonly<Record<number, readonly WordTiming[]>>;
  activeChunk: number;
  activeWord: number;
  /** settings.highlight && start.word_timestamps */
  highlightWords: boolean;
  autoScroll: boolean;
  /** Keep this stable (useCallback): it is passed to every memoised chunk. */
  onSeek: (charOffset: number) => void;
  header?: ReactElement | null;
  bottomInset?: number;
}

type ParaPhase = 'spoken' | 'current' | 'upcoming';

interface ParagraphViewProps {
  text: string;
  paragraph: Paragraph;
  phase: ParaPhase;
  /** Only meaningful when phase === 'current'. */
  activeChunk: number;
  activeWord: number;
  chunkWords: Readonly<Record<number, readonly WordTiming[]>>;
  highlightWords: boolean;
  colors: ChunkColors;
  onSeek: (charOffset: number) => void;
  onHeight: (key: string, h: number) => void;
}

function chunkPhase(p: ParaPhase, chunkIndex: number, activeChunk: number): ChunkPhase {
  if (p === 'spoken') return 'spoken';
  if (p === 'upcoming') return 'upcoming';
  if (chunkIndex < activeChunk) return 'spoken';
  return chunkIndex === activeChunk ? 'active' : 'upcoming';
}

const ParagraphView = memo(function ParagraphView({
  text,
  paragraph,
  phase,
  activeChunk,
  activeWord,
  chunkWords,
  highlightWords,
  colors,
  onSeek,
  onHeight,
}: ParagraphViewProps) {
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => onHeight(paragraph.key, e.nativeEvent.layout.height),
    [onHeight, paragraph.key],
  );
  const plain = paragraph.chunkIndices.length === 0;
  return (
    <View onLayout={onLayout} style={styles.paragraph}>
      <Text
        style={[type.reader, { color: plain ? colors.spoken : colors.text }]}
        selectable={false}
        testID={`para-${paragraph.key}`}
      >
        {paragraph.segments.map((seg) => {
          if (seg.kind === 'gap') {
            return <Text key={`g${seg.start}`}>{text.slice(seg.start, seg.end)}</Text>;
          }
          const c = seg.chunk;
          const cp = chunkPhase(phase, c.index, activeChunk);
          return (
            <ChunkText
              key={`c${c.index}`}
              text={text}
              chunk={c}
              words={chunkWords[c.index]}
              phase={cp}
              activeWord={cp === 'active' ? activeWord : -1}
              highlightWords={highlightWords}
              colors={colors}
              onSeek={onSeek}
            />
          );
        })}
      </Text>
    </View>
  );
});

function ReaderImpl({
  text,
  plan,
  chunkWords,
  activeChunk,
  activeWord,
  highlightWords,
  autoScroll,
  onSeek,
  header,
  bottomInset = 0,
}: ReaderProps) {
  const p = usePalette();
  const reduce = useReduceMotion();
  const listRef = useRef<FlatList<Paragraph>>(null);
  const lastDrag = useRef(0);
  const heights = useRef(new Map<string, number>());
  const viewport = useRef(0);
  const onHeight = useCallback((key: string, h: number) => {
    heights.current.set(key, h);
  }, []);

  const paragraphs = useMemo(() => buildParagraphs(text, plan), [text, plan]);
  const byChunk = useMemo(() => paragraphIndexByChunk(paragraphs), [paragraphs]);
  const activePara = activeChunk >= 0 ? (byChunk.get(activeChunk) ?? -1) : -1;

  const colors = useMemo<ChunkColors>(
    () => ({
      text: p.text,
      spoken: withAlpha(p.text, p.spokenOpacity),
      wordBg: p.wordBg,
      chunkBg: p.chunkBg,
      activeText: p.text,
    }),
    [p],
  );

  // Auto-scroll when the active chunk changes.
  useEffect(() => {
    if (!autoScroll || activePara < 0 || !listRef.current) return;
    if (Date.now() - lastDrag.current < AUTOSCROLL_PAUSE_MS) return;
    const para = paragraphs[activePara];
    if (!para) return;
    const chunk = plan.find((c) => c.index === activeChunk);
    const h = heights.current.get(para.key) ?? 0;
    const span = Math.max(1, para.end - para.start);
    const within = chunk ? ((chunk.char_start - para.start) / span) * h : 0;
    const target = viewport.current * 0.3;
    try {
      listRef.current.scrollToIndex({
        index: activePara,
        animated: !reduce,
        viewPosition: 0,
        viewOffset: target - within,
      });
    } catch {
      // onScrollToIndexFailed handles unmeasured rows.
    }
  }, [activePara, activeChunk, autoScroll, paragraphs, plan, reduce]);

  const renderItem = useCallback(
    ({ item, index }: { item: Paragraph; index: number }) => {
      const phase: ParaPhase =
        activePara < 0 ? 'upcoming' : index < activePara ? 'spoken' : index === activePara ? 'current' : 'upcoming';
      return (
        <ParagraphView
          text={text}
          paragraph={item}
          phase={phase}
          activeChunk={phase === 'current' ? activeChunk : -1}
          activeWord={phase === 'current' ? activeWord : -1}
          chunkWords={chunkWords}
          highlightWords={highlightWords}
          colors={colors}
          onSeek={onSeek}
          onHeight={onHeight}
        />
      );
    },
    [activePara, activeChunk, activeWord, chunkWords, highlightWords, colors, text, onSeek, onHeight],
  );

  return (
    <FlatList
      ref={listRef}
      data={paragraphs}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      extraData={renderItem}
      ListHeaderComponent={header}
      contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingBottom: bottomInset + spacing.xxl }}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.height;
      }}
      onScrollBeginDrag={() => {
        lastDrag.current = Date.now();
      }}
      onMomentumScrollEnd={() => {
        if (lastDrag.current) lastDrag.current = Date.now();
      }}
      onScrollToIndexFailed={(info) => {
        listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
        setTimeout(() => {
          try {
            listRef.current?.scrollToIndex({ index: info.index, animated: !reduce, viewPosition: 0.3 });
          } catch {
            // Still not measured; the next chunk change retries.
          }
        }, 120);
      }}
      initialNumToRender={12}
      windowSize={11}
      maxToRenderPerBatch={8}
      removeClippedSubviews={false}
      accessibilityLabel="Text being read"
    />
  );
}

export const Reader = memo(ReaderImpl);

const styles = StyleSheet.create({
  paragraph: { marginBottom: spacing.lg },
});
