import { ActionIcon, Badge, Box, Button, Group, Popover, Slider, Stack, Text, Tooltip } from '@mantine/core';
import { SPEED_MAX, SPEED_MIN, SPEED_STEP } from '@tamber/client';
import {
  IconDownload,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconPlayerStopFilled,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';
import { formatSpeed } from '../lib/format';
import { saveAudio, seekFromReader, stopPlayback } from '../player/actions';
import { getPlayer } from '../player/instance';
import { usePlayerSnapshot } from '../player/usePlayer';
import { useSettings } from '../store/settings';
import classes from './PlayerDock.module.css';
import { PlayButton } from './PlayButton';
import { ProgressSegments } from './ProgressSegments';
import { SpeedPresets } from './SpeedPresets';
import { TimeReadout } from './TimeReadout';
import { Waveform } from './Waveform';

const STATUS_TEXT: Record<string, string> = {
  idle: '',
  loading: 'Loading audio',
  playing: 'Playing',
  paused: 'Paused',
  ended: 'Finished reading',
  error: 'Playback stopped by an error',
};

function SpeedControl() {
  const speed = useSettings((s) => s.speed);
  const update = useSettings((s) => s.update);
  const marks = useMemo(
    () => [0.5, 1, 1.5, 2].map((v) => ({ value: v, label: formatSpeed(v) })),
    [],
  );
  return (
    <Popover position="top" withArrow shadow="md" radius="lg" trapFocus>
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-md"
          h={44}
          miw={56}
          aria-label={`Speed ${formatSpeed(speed)}`}
          ff="monospace"
        >
          {formatSpeed(speed)}
        </Button>
      </Popover.Target>
      <Popover.Dropdown w={320}>
        <Stack gap="xs" pb="md">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              Speed
            </Text>
            <Text size="sm" ff="monospace">
              {formatSpeed(speed)}
            </Text>
          </Group>
          <Slider
            aria-label="Speed"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={speed}
            onChange={(v) => update({ speed: v })}
            marks={marks}
            label={formatSpeed}
            mb="md"
          />
          <SpeedPresets />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function StatusChip() {
  const snap = usePlayerSnapshot();
  if (!snap.hasSession) return <Box miw={88} />;
  let label: string | null = null;
  let color = 'gray';
  if (snap.queuedPosition) {
    label = `Queued #${snap.queuedPosition}`;
    color = 'yellow';
  } else if (snap.status === 'error') {
    label = 'Stopped';
    color = 'red';
  } else if (snap.status === 'loading' && snap.receivedCount === 0) {
    label = 'Warming up';
    color = 'tamber';
  } else if (!snap.complete) {
    label = `${snap.receivedCount}/${snap.totalChunks} ready`;
    color = 'tamber';
  } else if (snap.failedCount > 0) {
    label = `${snap.failedCount} skipped`;
    color = 'orange';
  }
  return (
    <Box miw={88} style={{ display: 'flex', justifyContent: 'flex-end' }}>
      {label && (
        <Badge variant="light" color={color} size="sm" radius="sm">
          {label}
        </Badge>
      )}
    </Box>
  );
}

/** Fixed bottom transport: segments, time, live bars and the big play button. */
export function PlayerDock() {
  const snap = usePlayerSnapshot();
  const has = snap.hasSession && snap.totalChunks > 0;
  const statusText = STATUS_TEXT[snap.status] ?? '';

  return (
    <Box component="footer" className={classes.dock} data-player-dock>
      <div className={classes.inner}>
        <ProgressSegments onSeekChunk={(i) => seekFromReader({ chunk: i })} />
        <Group justify="space-between" gap="sm" wrap="nowrap" className={classes.meta}>
          <TimeReadout />
          <Box className={classes.wave}>
            <Waveform />
          </Box>
          <StatusChip />
        </Group>
        <Group justify="center" gap="xs" wrap="nowrap" className={classes.controls}>
          <Box className={classes.side}>
            <SpeedControl />
          </Box>
          <Tooltip label="Previous sentence (←)">
            <ActionIcon
              size={48}
              radius="xl"
              color="gray"
              variant="subtle"
              aria-label="Previous sentence"
              disabled={!has}
              onClick={() => {
                getPlayer().unlock();
                getPlayer().previous();
              }}
            >
              <IconPlayerSkipBackFilled size={22} />
            </ActionIcon>
          </Tooltip>
          <PlayButton />
          <Tooltip label="Next sentence (→)">
            <ActionIcon
              size={48}
              radius="xl"
              color="gray"
              variant="subtle"
              aria-label="Next sentence"
              disabled={!has}
              onClick={() => {
                getPlayer().unlock();
                getPlayer().next();
              }}
            >
              <IconPlayerSkipForwardFilled size={22} />
            </ActionIcon>
          </Tooltip>
          <Box className={classes.side} style={{ justifyContent: 'flex-end' }}>
            <Tooltip label="Stop (Esc)">
              <ActionIcon
                size={44}
                radius="xl"
                color="gray"
                variant="subtle"
                aria-label="Stop"
                disabled={!has || snap.status === 'idle'}
                onClick={stopPlayback}
              >
                <IconPlayerStopFilled size={18} />
              </ActionIcon>
            </Tooltip>
            <AnimatePresence>
              {snap.canSave && (
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                >
                  <Tooltip label="Save audio (.wav)">
                    <ActionIcon
                      size={44}
                      radius="xl"
                      variant="light"
                      aria-label="Save audio"
                      onClick={saveAudio}
                    >
                      <IconDownload size={20} />
                    </ActionIcon>
                  </Tooltip>
                </motion.div>
              )}
            </AnimatePresence>
          </Box>
        </Group>
      </div>
      <div className="tamber-sr-only" aria-live="polite" role="status">
        {statusText}
      </div>
    </Box>
  );
}
