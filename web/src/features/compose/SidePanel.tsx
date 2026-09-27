import { Group, SegmentedControl, Slider, Stack, Switch, Text } from '@mantine/core';
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, type AudioFormat } from '@tamber/client';
import { formatSpeed } from '../../lib/format';
import { usePlayerState } from '../../player/usePlayer';
import { useSettings } from '../../store/settings';
import { Orb } from '../../ui/Orb';
import { VoiceSummary } from '../voices/VoiceSummary';

const STATUS_LINE: Record<string, string> = {
  idle: 'Ready when you are',
  loading: 'Warming up the voice…',
  playing: 'Reading aloud',
  paused: 'Paused',
  ended: 'Finished',
  error: 'Stopped',
};

/** Desktop side column (and the phone sheet): the big orb, voice and quick playback settings. */
export function SidePanel() {
  const status = usePlayerState((s) => s.status);
  const speed = useSettings((s) => s.speed);
  const format = useSettings((s) => s.format);
  const highlight = useSettings((s) => s.highlight);
  const autoScroll = useSettings((s) => s.autoScroll);
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
        <SegmentedControl
          size="xs"
          value={format}
          onChange={(v) => update({ format: v as AudioFormat })}
          data={[
            { value: 'wav', label: 'WAV' },
            { value: 'mp3', label: 'MP3' },
          ]}
          aria-label="Audio format"
        />
        <Switch
          mt="xs"
          size="sm"
          label="Word highlight"
          checked={highlight}
          onChange={(e) => update({ highlight: e.currentTarget.checked })}
        />
        <Switch
          size="sm"
          label="Follow along"
          checked={autoScroll}
          onChange={(e) => update({ autoScroll: e.currentTarget.checked })}
        />
      </Stack>
    </Stack>
  );
}
