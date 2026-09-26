import { memo, useMemo } from 'react';
import { ActionIcon, Button, Group, Progress, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconPlayerStopFilled,
  IconVolume,
} from '@tabler/icons-react';
import { motion } from 'motion/react';
import type { PlayerState } from '../lib/messages';
import { player, useToggle } from '../hooks/usePlayer';
import { formatTime } from '../lib/format';

/** One segment per planned chunk (played / active / buffered / pending); click to jump. */
export const ProgressSegments = memo(function ProgressSegments({
  state,
}: {
  state: Pick<PlayerState, 'plan' | 'activeChunk' | 'receivedChunks' | 'progress' | 'ended'>;
}) {
  const received = useMemo(() => new Set(state.receivedChunks), [state.receivedChunks]);
  if (state.plan.length === 0)
    return <Progress value={0} size={6} radius="xl" aria-label="Progress" />;
  if (state.plan.length > 120) {
    const buffered = (received.size / state.plan.length) * 100;
    return (
      <Progress.Root size={6} radius="xl" aria-label="Progress">
        <Progress.Section value={state.ended ? 100 : state.progress * 100} color="tamber.5" />
        <Progress.Section value={Math.max(0, buffered - state.progress * 100)} color="tamber.2" />
      </Progress.Root>
    );
  }
  return (
    <div className="tamber-segments" role="group" aria-label="Sentences">
      {state.plan.map((c) => {
        const st = state.ended
          ? 'played'
          : c.index === state.activeChunk
            ? 'active'
            : state.activeChunk >= 0 && c.index < state.activeChunk
              ? 'played'
              : received.has(c.index)
                ? 'buffered'
                : 'pending';
        return (
          <button
            key={c.index}
            type="button"
            className="tamber-segment"
            data-state={st}
            aria-label={`Sentence ${c.index + 1}`}
            onClick={() => void player.seekChunk(c.index)}
          />
        );
      })}
    </div>
  );
});

export function Controls({
  state,
  size = 'md',
  showStop = true,
}: {
  state: PlayerState;
  size?: 'sm' | 'md' | 'lg';
  showStop?: boolean;
}) {
  const toggle = useToggle(state);
  const hasSession = state.text.length > 0;
  const playing =
    state.status === 'playing' || state.status === 'loading' || state.status === 'queued';
  const big = size === 'lg' ? 64 : size === 'md' ? 52 : 42;
  const small = size === 'lg' ? 'xl' : size === 'md' ? 'lg' : 'md';
  const elapsed = state.estimatedDuration * state.progress;

  return (
    <Stack gap={8}>
      <ProgressSegments state={state} />
      <Group justify="space-between" gap={4}>
        <Text size="xs" c="dimmed" ff="monospace">
          {formatTime(elapsed)}
        </Text>
        <Text size="xs" c="dimmed" ff="monospace">
          {state.estimatedDuration > 0 ? `~${formatTime(state.estimatedDuration)}` : '--:--'}
        </Text>
      </Group>
      {state.status === 'needs-gesture' ? (
        <Button
          variant="gradient"
          leftSection={<IconVolume size={18} />}
          onClick={() => void player.resumeAudio()}
          fullWidth
        >
          Click to start audio
        </Button>
      ) : (
        <Group justify="center" gap="md" wrap="nowrap">
          <Tooltip label="Previous sentence" openDelay={400}>
            <ActionIcon
              variant="subtle"
              size={small}
              radius="xl"
              aria-label="Previous sentence"
              disabled={!hasSession}
              onClick={() => void player.control('previous')}
            >
              <IconPlayerSkipBackFilled size={18} />
            </ActionIcon>
          </Tooltip>
          <motion.div
            whileTap={hasSession ? { scale: 0.9 } : undefined}
            whileHover={hasSession ? { scale: 1.05 } : undefined}
            style={{ borderRadius: '50%', display: 'inline-flex' }}
          >
            <ActionIcon
              variant="gradient"
              size={big}
              radius="xl"
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!hasSession}
              onClick={toggle}
              style={{ boxShadow: hasSession ? '0 6px 22px rgba(124,58,237,0.35)' : undefined }}
            >
              {playing ? (
                <IconPlayerPauseFilled size={big * 0.42} />
              ) : (
                <IconPlayerPlayFilled size={big * 0.42} />
              )}
            </ActionIcon>
          </motion.div>
          <Tooltip label="Next sentence" openDelay={400}>
            <ActionIcon
              variant="subtle"
              size={small}
              radius="xl"
              aria-label="Next sentence"
              disabled={!hasSession}
              onClick={() => void player.control('next')}
            >
              <IconPlayerSkipForwardFilled size={18} />
            </ActionIcon>
          </Tooltip>
          {showStop && (
            <Tooltip label="Stop" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={small}
                radius="xl"
                aria-label="Stop"
                disabled={!hasSession}
                onClick={() => void player.control('stop')}
              >
                <IconPlayerStopFilled size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      )}
    </Stack>
  );
}
