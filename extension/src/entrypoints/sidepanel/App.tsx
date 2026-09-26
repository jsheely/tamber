/**
 * Side panel: the rich reader (same experience as web's reader). Renders only from the offscreen
 * engine's state: exact text, chunk spans, word spans, moving highlight pill, active-chunk wash,
 * dimmed spoken text, auto-scroll, click-to-seek, controls, progress segments, voice/speed chips.
 */
import { useCallback } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Card,
  Chip,
  Group,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconSettings } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { browser } from 'wxt/browser';
import { Brand } from '../../components/Brand';
import { Controls } from '../../components/Controls';
import { Orb } from '../../components/Orb';
import { PasteBox } from '../../components/PasteBox';
import { Reader } from '../../components/Reader';
import { StatusLine } from '../../components/StatusLine';
import { VoiceSelect } from '../../components/VoicePicker';
import { player, usePlayer } from '../../hooks/usePlayer';
import { useSettings } from '../../hooks/useSettings';
import { useVoices } from '../../hooks/useVoices';

const SPEED_CHIPS = [0.75, 1, 1.25, 1.5, 2];

function EmptyState({ configured }: { configured: boolean }) {
  return (
    <Stack gap="md" p="md" justify="center" style={{ flex: 1 }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        style={{ display: 'flex', justifyContent: 'center' }}
      >
        <Orb status="idle" size={72} />
      </motion.div>
      <Text ta="center" fw={700}>
        Nothing is being read
      </Text>
      <Text ta="center" size="sm" c="dimmed">
        Select text on any page and choose <b>Read with Tamber</b> from the right-click menu, press{' '}
        <b>Alt+Shift+R</b>, or paste text below.
      </Text>
      {configured ? (
        <PasteBox minRows={4} maxRows={10} />
      ) : (
        <Alert color="tamber" radius="lg" icon={<IconInfoCircle size={18} />}>
          Connect your Tamber server first.{' '}
          <Anchor component="button" onClick={() => void browser.runtime.openOptionsPage()}>
            Open settings
          </Anchor>
        </Alert>
      )}
    </Stack>
  );
}

export function App() {
  const { settings, save } = useSettings();
  const { state, words } = usePlayer();
  const voices = useVoices(settings);
  const hasText = state.text.length > 0;
  const onSeekChar = useCallback((offset: number) => void player.seekToChar(offset), []);

  return (
    <Stack h="100vh" gap={0} style={{ overflow: 'hidden' }}>
      <Group
        justify="space-between"
        px="md"
        py="sm"
        wrap="nowrap"
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Brand size={22} />
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box style={{ minWidth: 0 }} visibleFrom="xs">
            <StatusLine state={state} />
          </Box>
          <Orb status={state.status} size={28} />
          <Tooltip label="Settings" openDelay={300}>
            <ActionIcon
              variant="subtle"
              radius="xl"
              aria-label="Settings"
              onClick={() => void browser.runtime.openOptionsPage()}
            >
              <IconSettings size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {!hasText ? (
        <ScrollArea style={{ flex: 1 }}>
          <EmptyState configured={!!settings.apiBaseUrl} />
        </ScrollArea>
      ) : (
        <>
          <Box px="md" pt="sm">
            {state.title && (
              <Text fw={700} size="lg" lineClamp={2}>
                {state.title}
              </Text>
            )}
            {state.sourceUrl && /^https?:/.test(state.sourceUrl) && (
              <Anchor href={state.sourceUrl} target="_blank" size="xs" c="dimmed" lineClamp={1}>
                {state.sourceUrl}
              </Anchor>
            )}
            {!state.wordTimestamps && (
              <Text size="xs" c="dimmed">
                Word timing isn't available for this language: the current sentence is highlighted.
              </Text>
            )}
          </Box>
          <Reader
            text={state.text}
            plan={state.plan}
            words={words}
            activeChunk={state.activeChunk}
            activeWord={state.activeWord}
            highlight={settings.highlight && state.wordTimestamps}
            autoScroll={settings.autoScroll}
            onSeekChar={onSeekChar}
            style={{ flex: 1, minHeight: 0, padding: '12px 16px 24px' }}
          />
        </>
      )}

      <Card
        radius={0}
        padding="md"
        style={{ borderTop: '1px solid var(--mantine-color-default-border)', flex: 'none' }}
      >
        <Stack gap="sm">
          <AnimatePresence>
            {state.status === 'error' && state.error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                <Alert color="red" radius="lg" p="xs" icon={<IconAlertTriangle size={16} />}>
                  <Text size="sm">{state.error}</Text>
                </Alert>
              </motion.div>
            )}
          </AnimatePresence>
          {state.notice && state.status !== 'error' && (
            <Text size="xs" c="dimmed">
              {state.notice}
            </Text>
          )}
          <Controls state={state} size="lg" />
          <Group gap={6} wrap="wrap" justify="center">
            <Chip.Group
              multiple={false}
              value={String(settings.speed)}
              onChange={(v) => {
                const speed = Number(v);
                void player.setSpeed(speed);
                void save({ speed });
              }}
            >
              {SPEED_CHIPS.map((s) => (
                <Chip key={s} value={String(s)} size="xs" variant="light">
                  {s}×
                </Chip>
              ))}
            </Chip.Group>
          </Group>
          <VoiceSelect
            settings={settings}
            voices={voices.voices}
            loading={voices.loading}
            onChange={(voice) => void save({ voice })}
            size="xs"
          />
        </Stack>
      </Card>
    </Stack>
  );
}
