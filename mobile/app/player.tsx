/**
 * Player: orb + karaoke reader + transport controls. Works for typed text, library items and
 * share-sheet payloads (which arrive here already auto-starting).
 */
import { router } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import { getPlayer, playerActions } from '@/player/controller';
import { usePlaybackClock } from '@/player/usePlaybackClock';
import { Reader } from '@/reader/Reader';
import { isBusy, usePlayback } from '@/store/playback';
import { useSettings } from '@/store/settings';
import { spacing, type, usePalette, useReduceMotion } from '@/theme';
import { Orb, type OrbState } from '@/ui/Orb';
import { PlayerBar } from '@/ui/PlayerBar';
import { Badge, GradientButton, IconButton, Screen } from '@/ui/primitives';

function PlayerHeader() {
  const p = usePalette();
  const { status, activeChunk, activeWord, title, extracting, voice, wordTimestamps, error } = usePlayback(
    useShallow((s) => ({
      status: s.status,
      activeChunk: s.activeChunk,
      activeWord: s.activeWord,
      title: s.doc?.title ?? '',
      extracting: s.extracting,
      voice: s.voice,
      wordTimestamps: s.wordTimestamps,
      error: s.error,
    })),
  );
  const highlight = useSettings((s) => s.settings.highlight);
  const orbState: OrbState =
    status === 'playing' ? 'playing' : isBusy(status) || status === 'extracting' ? 'busy' : 'idle';
  return (
    <View style={styles.header}>
      <Orb size={170} state={orbState} beat={activeChunk * 10_000 + activeWord + 1} />
      {extracting ? (
        <Text style={[type.body, { color: p.textDim }]}>{extracting}</Text>
      ) : (
        <Text style={[type.title, { color: p.text, textAlign: 'center' }]} numberOfLines={3}>
          {title}
        </Text>
      )}
      <View style={styles.badges}>
        {!!voice && <Badge label={voice} tone="accent" />}
        {!wordTimestamps && <Badge label="Sentence highlighting only" tone="warning" />}
        {wordTimestamps && !highlight && <Badge label="Word highlight off" />}
      </View>
      {status === 'error' && error ? (
        <Text style={[type.small, { color: p.danger, textAlign: 'center' }]}>{error}</Text>
      ) : null}
    </View>
  );
}

export default function PlayerScreen() {
  const p = usePalette();
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { doc, plan, chunkWords, activeChunk, activeWord, wordTimestamps, status } = usePlayback(
    useShallow((s) => ({
      doc: s.doc,
      plan: s.plan,
      chunkWords: s.chunkWords,
      activeChunk: s.activeChunk,
      activeWord: s.activeWord,
      wordTimestamps: s.wordTimestamps,
      status: s.status,
    })),
  );
  const extracting = usePlayback((s) => s.extracting);
  const highlight = useSettings((s) => s.settings.highlight);
  const autoScroll = useSettings((s) => s.settings.autoScroll);

  usePlaybackClock(getPlayer, status === 'playing' || status === 'buffering');

  const onSeek = useCallback((offset: number) => playerActions.seekToChar(offset), []);

  const topBar = (
    <View style={styles.topBar}>
      <IconButton icon="back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={{ flex: 1 }} />
      <IconButton icon="wave" label="Voices" onPress={() => router.push('/voices')} />
      <IconButton icon="settings" label="Settings" onPress={() => router.push('/settings')} />
    </View>
  );

  if (!doc && !extracting && status !== 'error') {
    return (
      <Screen>
        {topBar}
        <View style={styles.empty}>
          <Orb size={180} state="idle" />
          <Text style={[type.title, { color: p.text }]}>Nothing is playing</Text>
          <Text style={[type.body, { color: p.textDim, textAlign: 'center' }]}>
            Pick something to read on the home screen, or share a page to Tamber from any app.
          </Text>
          <GradientButton label="Go home" icon="type" onPress={() => router.replace('/')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'left', 'right']}>
      {topBar}
      <Animated.View style={{ flex: 1 }} entering={reduce ? undefined : FadeIn.duration(300)}>
        <Reader
          text={doc?.text ?? ''}
          plan={doc ? plan : []}
          chunkWords={chunkWords}
          activeChunk={activeChunk}
          activeWord={activeWord}
          highlightWords={highlight && wordTimestamps}
          autoScroll={autoScroll}
          onSeek={onSeek}
          header={<PlayerHeader />}
        />
      </Animated.View>
      <View style={{ paddingBottom: insets.bottom, backgroundColor: p.surface }}>
        <PlayerBar variant="full" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  header: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  badges: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
});
