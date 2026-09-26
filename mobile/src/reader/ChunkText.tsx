/**
 * One chunk of the reader as nested <Text> spans. Memoised: while a chunk is not the active one its
 * props are stable, so a word change re-renders only the active chunk.
 */
import type { ChunkSpan, WordTiming } from '@tamber/client';
import { memo, type ReactNode } from 'react';
import { Text } from 'react-native';

export type ChunkPhase = 'spoken' | 'active' | 'upcoming';

export interface ChunkColors {
  text: string;
  spoken: string;
  wordBg: string;
  chunkBg: string;
  activeText: string;
}

export interface ChunkTextProps {
  text: string;
  chunk: ChunkSpan;
  /** Word timings for this chunk once its audio arrived (chunk-relative times, absolute offsets). */
  words: readonly WordTiming[] | undefined;
  phase: ChunkPhase;
  /** Index into `words` of the word being spoken (-1 = none, or chunk not active). */
  activeWord: number;
  /** Word-level karaoke on (settings.highlight && word_timestamps). */
  highlightWords: boolean;
  colors: ChunkColors;
  onSeek: (charOffset: number) => void;
}

function ChunkTextImpl({ text, chunk, words, phase, activeWord, highlightWords, colors, onSeek }: ChunkTextProps) {
  const base = {
    color: phase === 'spoken' ? colors.spoken : colors.text,
    backgroundColor: phase === 'active' ? colors.chunkBg : undefined,
  };
  const onChunkPress = () => onSeek(chunk.char_start);

  if (!words || words.length === 0) {
    return (
      <Text style={base} onPress={onChunkPress} suppressHighlighting>
        {text.slice(chunk.char_start, chunk.char_end)}
      </Text>
    );
  }

  const parts: ReactNode[] = [];
  let cursor = chunk.char_start;
  words.forEach((w, i) => {
    const ws = Math.max(w.char_start, cursor);
    if (ws > cursor) parts.push(text.slice(cursor, ws));
    const we = Math.min(Math.max(w.char_end, ws), chunk.char_end);
    const isActive = phase === 'active' && highlightWords && i === activeWord;
    parts.push(
      <Text
        key={w.char_start}
        onPress={() => onSeek(w.char_start)}
        suppressHighlighting
        accessibilityRole={isActive ? 'text' : undefined}
        style={
          isActive
            ? { backgroundColor: colors.wordBg, color: colors.activeText, fontWeight: '600' }
            : undefined
        }
      >
        {text.slice(ws, we)}
      </Text>,
    );
    cursor = we;
  });
  if (cursor < chunk.char_end) parts.push(text.slice(cursor, chunk.char_end));

  return (
    <Text style={base} onPress={onChunkPress} suppressHighlighting>
      {parts}
    </Text>
  );
}

export const ChunkText = memo(ChunkTextImpl);
