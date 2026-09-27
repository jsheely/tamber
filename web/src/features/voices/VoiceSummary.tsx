import { Avatar, Group, Text, UnstyledButton } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useSession } from '../../store/session';
import { useSettings } from '../../store/settings';
import { describeVoice } from './voiceUtils';
import classes from './VoiceSummary.module.css';

/** The current voice as a tappable card; opens the voice drawer. */
export function VoiceSummary() {
  const voice = useSettings((s) => s.voice);
  const voices = useSession((s) => s.voices);
  const savedBlends = useSettings((s) => s.savedBlends);
  const openDrawer = useSession((s) => s.openDrawer);
  const d = describeVoice(voice, voices, savedBlends);
  return (
    <UnstyledButton
      className={classes.card}
      onClick={() => openDrawer('voices', { voiceTab: d.blend ? 'blend' : 'voices' })}
      aria-label={`Voice: ${d.title}. Change voice`}
      data-testid="voice-summary"
    >
      <Group wrap="nowrap" gap="sm">
        <Avatar radius="xl" size={42} variant="gradient" gradient={{ from: 'tamber.5', to: 'tamberCyan.4', deg: 62 }}>
          {d.initials}
        </Avatar>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} lts={0.6}>
            Voice
          </Text>
          <Text fw={650} truncate>
            {d.title}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {d.subtitle}
          </Text>
        </div>
        <IconChevronRight size={18} opacity={0.6} />
      </Group>
    </UnstyledButton>
  );
}
