import { Button, Group } from '@mantine/core';
import { formatSpeed } from '../lib/format';
import { useSettings } from '../store/settings';

/** One-tap speed jumps shown under the speed sliders. */
const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2] as const;

/** A row of preset speed buttons; the one matching the current speed is filled. */
export function SpeedPresets() {
  const speed = useSettings((s) => s.speed);
  const update = useSettings((s) => s.update);
  return (
    <Group gap={4} grow wrap="nowrap" role="group" aria-label="Speed presets">
      {SPEED_PRESETS.map((v) => {
        const active = Math.abs(speed - v) < 0.005;
        return (
          <Button
            key={v}
            size="compact-sm"
            h={36}
            px={4}
            miw={0}
            fz={13}
            radius="md"
            variant={active ? 'filled' : 'light'}
            color={active ? 'tamber' : 'gray'}
            aria-pressed={active}
            aria-label={`Speed ${formatSpeed(v)}`}
            onClick={() => update({ speed: v })}
            data-testid={`speed-preset-${v}`}
          >
            {formatSpeed(v)}
          </Button>
        );
      })}
    </Group>
  );
}
