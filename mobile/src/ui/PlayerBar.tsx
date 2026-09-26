/**
 * Transport controls + progress. `full` sits under the reader on the player screen; `mini` is the
 * compact bar on the home screen while a session is active.
 */
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { memo, useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { formatClock } from '@/content/extract';
import { playerActions } from '@/player/controller';
import { isBusy, usePlayback } from '@/store/playback';
import { useSettings } from '@/store/settings';
import { brandGradient, radius, spacing, type, usePalette } from '@/theme';

import { Bars } from './Bars';
import { Icon } from './Icon';
import { IconButton, PressableScale } from './primitives';

const MAX_SEGMENTS = 48;

type SegState = 'played' | 'active' | 'received' | 'failed' | 'pending' | 'skipped';

/** received/total progress as up to MAX_SEGMENTS buckets. */
export const ProgressSegments = memo(function ProgressSegments() {
  const p = usePalette();
  const { plan, received, failed, activeChunk, startChunk } = usePlayback(
    useShallow((s) => ({
      plan: s.plan,
      received: s.received,
      failed: s.failed,
      activeChunk: s.activeChunk,
      startChunk: s.startChunk,
    })),
  );
  const segments = useMemo(() => {
    const n = plan.length;
    if (n === 0) return [] as SegState[];
    const buckets = Math.min(n, MAX_SEGMENTS);
    const rec = new Set(received);
    const fail = new Set(failed);
    const out: SegState[] = [];
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor((b * n) / buckets);
      const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
      let state: SegState = 'pending';
      const idxs = plan.slice(from, to).map((c) => c.index);
      if (activeChunk >= 0 && idxs.includes(activeChunk)) state = 'active';
      else if (activeChunk >= 0 && idxs[idxs.length - 1]! < activeChunk) state = 'played';
      else if (idxs.some((i) => fail.has(i))) state = 'failed';
      else if (idxs.every((i) => rec.has(i))) state = 'received';
      else if (idxs[idxs.length - 1]! < startChunk) state = 'skipped';
      out.push(state);
    }
    return out;
  }, [plan, received, failed, activeChunk, startChunk]);

  const colors: Record<SegState, string> = {
    played: p.primary,
    active: p.accent,
    received: p.scheme === 'dark' ? '#5B21B6' : '#D8B4FE',
    failed: p.danger,
    pending: p.border,
    skipped: p.surfaceAlt,
  };
  return (
    <View
      style={styles.segments}
      accessibilityRole="progressbar"
      accessibilityLabel={`Received ${received.length} of ${plan.length} parts`}
    >
      {segments.map((s, i) => (
        <View key={i} style={[styles.segment, { backgroundColor: colors[s] }]} />
      ))}
    </View>
  );
});

function StatusLine() {
  const p = usePalette();
  const { status, queuePosition, received, totalChunks, clock, bufferedDuration, error } = usePlayback(
    useShallow((s) => ({
      status: s.status,
      queuePosition: s.queuePosition,
      received: s.received.length,
      totalChunks: s.totalChunks,
      clock: s.clock,
      bufferedDuration: s.bufferedDuration,
      error: s.error,
    })),
  );
  let text: string;
  switch (status) {
    case 'connecting':
      text = 'Connecting...';
      break;
    case 'queued':
      text = queuePosition ? `Waiting in line (#${queuePosition})` : 'Waiting for the server...';
      break;
    case 'buffering':
      text = 'Preparing the next part...';
      break;
    case 'extracting':
      text = 'Extracting text...';
      break;
    case 'ended':
      text = 'Finished';
      break;
    case 'error':
      text = error ?? 'Something went wrong';
      break;
    default:
      text = `${formatClock(clock)} / ${formatClock(bufferedDuration)}  ·  ${received}/${totalChunks} parts`;
  }
  return (
    <Text style={[type.small, { color: status === 'error' ? p.danger : p.textDim }]} numberOfLines={1}>
      {text}
    </Text>
  );
}

function PlayPauseButton({ size }: { size: number }) {
  const status = usePlayback((s) => s.status);
  const playing = status === 'playing';
  const busy = isBusy(status) || status === 'extracting';
  const label = playing ? 'Pause' : 'Play';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Loading, tap to pause' : label}
      scaleTo={0.9}
      disabled={status === 'extracting'}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        void playerActions.toggle();
      }}
      style={{ borderRadius: size / 2 }}
    >
      <LinearGradient
        colors={brandGradient.colors}
        start={brandGradient.start}
        end={brandGradient.end}
        style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}
      >
        {busy && status !== 'buffering' ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Icon name={playing || status === 'buffering' ? 'pause' : 'play'} color="#FFFFFF" size={size * 0.42} />
        )}
      </LinearGradient>
    </PressableScale>
  );
}

export function PlayerBar({ variant = 'full' }: { variant?: 'full' | 'mini' }) {
  const p = usePalette();
  const status = usePlayback((s) => s.status);
  const title = usePlayback((s) => s.doc?.title ?? '');
  const speed = useSettings((s) => s.settings.speed);

  if (variant === 'mini') {
    return (
      <Pressable
        onPress={() => router.push('/player')}
        accessibilityRole="button"
        accessibilityLabel={`Now reading ${title}. Open player`}
        style={[styles.mini, { backgroundColor: p.surface, borderColor: p.border }]}
      >
        <Bars active={status === 'playing'} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { color: p.text, fontWeight: '700' }]} numberOfLines={1}>
            {title || 'Tamber'}
          </Text>
          <StatusLine />
        </View>
        <PlayPauseButton size={44} />
      </Pressable>
    );
  }

  return (
    <View style={[styles.full, { backgroundColor: p.surface, borderColor: p.border }]}>
      <ProgressSegments />
      <View style={styles.statusRow}>
        <Bars active={status === 'playing'} height={14} />
        <View style={{ flex: 1 }}>
          <StatusLine />
        </View>
        <Pressable
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityLabel={`Speed ${speed.toFixed(2)}x. Open settings`}
          style={[styles.speedChip, { borderColor: p.border }]}
        >
          <Text style={[type.small, { color: p.link, fontWeight: '800' }]}>{speed.toFixed(2).replace(/0$/, '')}x</Text>
        </Pressable>
      </View>
      <View style={styles.controls}>
        <IconButton icon="stop" label="Stop" onPress={() => playerActions.stop()} />
        <IconButton icon="skipPrev" label="Previous sentence" size={52} onPress={() => playerActions.previous()} />
        <PlayPauseButton size={72} />
        <IconButton icon="skipNext" label="Next sentence" size={52} onPress={() => playerActions.next()} />
        <IconButton icon="wave" label="Choose voice" onPress={() => router.push('/voices')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  segments: { flexDirection: 'row', gap: 2, height: 6 },
  segment: { flex: 1, borderRadius: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  speedChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
  },
  full: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  mini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
