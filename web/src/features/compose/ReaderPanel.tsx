import { Badge, Button, Group, Stack, Switch, Text, Title, Tooltip } from '@mantine/core';
import { IconPencil, IconPlus } from '@tabler/icons-react';
import { motion } from 'motion/react';
import { useCallback } from 'react';
import { useReducedMotionPref } from '../../lib/motion';
import { seekFromReader, startNew } from '../../player/actions';
import { mediaTitle } from '../../player/mediaSession';
import { getPlayer } from '../../player/instance';
import { usePlayerSnapshot } from '../../player/usePlayer';
import { Reader } from '../../reader/Reader';
import { useSession } from '../../store/session';
import { useSettings } from '../../store/settings';
import classes from './ReaderPanel.module.css';

export const NO_WORD_TIMING_TOOLTIP = "Word timing isn't available for this language";

/** The reading view: title, highlight toggle and the karaoke Reader over the exact sent text. */
export function ReaderPanel() {
  const snap = usePlayerSnapshot();
  const highlight = useSettings((s) => s.highlight);
  const autoScroll = useSettings((s) => s.autoScroll);
  const update = useSettings((s) => s.update);
  const setView = useSession((s) => s.setView);
  const reduced = useReducedMotionPref();
  const player = getPlayer();
  const getWords = useCallback((i: number) => player.getChunkWords(i), [player]);
  const onSeekChar = useCallback((offset: number) => seekFromReader({ char: offset }), []);
  const onSeekChunk = useCallback((index: number) => seekFromReader({ chunk: index }), []);

  const degraded = !snap.wordTimestamps;
  const wordsEnabled = highlight && !degraded;

  return (
    <motion.section
      layoutId="tamber-surface"
      className={`tamber-surface ${classes.card}`}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      aria-labelledby="reader-title"
    >
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div style={{ minWidth: 0 }}>
            <Text size="xs" tt="uppercase" fw={700} c="dimmed" lts={0.8}>
              Now reading
            </Text>
            <Title order={2} id="reader-title" size="h4" lineClamp={2}>
              {mediaTitle(snap)}
            </Title>
          </div>
          <Group gap={4} wrap="nowrap">
            <Tooltip label="Edit this text">
              <Button
                variant="subtle"
                color="gray"
                size="compact-md"
                h={40}
                px={10}
                aria-label="Edit this text"
                onClick={() => {
                  if (snap.status === 'playing' || snap.status === 'loading') player.pause();
                  setView('compose');
                }}
              >
                <IconPencil size={18} />
              </Button>
            </Tooltip>
            <Tooltip label="New (Shift+N)">
              <Button
                variant="light"
                size="compact-md"
                h={40}
                leftSection={<IconPlus size={16} />}
                onClick={startNew}
                aria-keyshortcuts="Shift+N"
                data-testid="reader-new"
              >
                New
              </Button>
            </Tooltip>
          </Group>
        </Group>
        <Group gap="xs" wrap="wrap" justify="space-between">
          <Group gap={6}>
            <Badge variant="light" radius="sm" style={{ textTransform: 'none' }}>
              {snap.voice}
            </Badge>
            {degraded && (
              <Tooltip label={NO_WORD_TIMING_TOOLTIP}>
                <Badge variant="outline" color="gray" radius="sm" data-testid="degraded-badge">
                  sentence highlight
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Tooltip label={NO_WORD_TIMING_TOOLTIP} disabled={!degraded}>
            <div>
              <Switch
                size="sm"
                label="Word highlight"
                checked={wordsEnabled}
                disabled={degraded}
                onChange={(e) => update({ highlight: e.currentTarget.checked })}
                data-testid="highlight-toggle"
              />
            </div>
          </Tooltip>
        </Group>
        <div className={classes.text}>
          <Reader
            text={snap.text}
            plan={snap.plan}
            version={snap.version}
            getWords={getWords}
            wordsEnabled={wordsEnabled}
            autoScroll={autoScroll}
            reducedMotion={reduced}
            source={player}
            onSeekChar={onSeekChar}
            onSeekChunk={onSeekChunk}
          />
        </div>
      </Stack>
    </motion.section>
  );
}
