import { Group, Slider, Stack, Text } from '@mantine/core';
import { SPEED_MAX, SPEED_MIN, SPEED_STEP } from '@tamber/client';
import { formatSpeed } from '../../lib/format';
import { usePlayerState } from '../../player/usePlayer';
import { useSettings } from '../../store/settings';
import { Orb } from '../../ui/Orb';
import { SpeedPresets } from '../../ui/SpeedPresets';
import { VoiceSummary } from '../voices/VoiceSummary';

const STATUS_LINE: Record<string, string> = {
  idle: 'Ready when you are',
  loading: 'Warming up the voice…',
  playing: 'Reading aloud',
  paused: 'Paused',
  ended: 'Finished',
  error: 'Stopped',
};

/** Desktop side column (and the phone sheet): the big orb, the voice and the speed. Everything else is in Settings. */
export function SidePanel() {
  const status = usePlayerState((s) => s.status);
  const speed = useSettings((s) => s.speed);
  const update = useSettings((s) => s.update);

  return (
    <Stack gap="lg">
      <Stack align="center" gap={4} py="sm">
        <Orb size={220} />
        <Text size="sm" c="dimmed" fw={500}>
          {STATUS_LINE[status]}
        </Text>
      </Stack>
      <VoiceSummary />
      <Stack gap={6} className="tamber-surface" p="md" style={{ borderRadius: 'var(--mantine-radius-lg)' }}>
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
          label={formatSpeed}
          mb="xs"
        />
        <SpeedPresets />
      </Stack>
    </Stack>
  );
}
