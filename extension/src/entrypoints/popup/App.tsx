/**
 * Toolbar popup (~360x520): connection status, now playing with the active word, transport
 * controls, quick speed / voice, "read this tab", "paste text & read", and "Open reader".
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Slider,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconFileText,
  IconLayoutSidebarRight,
  IconSettings,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { browser } from 'wxt/browser';
import { SPEED_MAX, SPEED_MIN, SPEED_STEP } from '@tamber/client';
import { Brand } from '../../components/Brand';
import { Controls } from '../../components/Controls';
import { Orb } from '../../components/Orb';
import { PasteBox } from '../../components/PasteBox';
import { SentenceView } from '../../components/Reader';
import { StatusLine } from '../../components/StatusLine';
import { VoiceSelect } from '../../components/VoicePicker';
import { player, usePlayer } from '../../hooks/usePlayer';
import { useSettings } from '../../hooks/useSettings';
import { useVoices } from '../../hooks/useVoices';
import { toMiniState } from '../../lib/messages';
import { hasApiPermission } from '../../lib/permissions';

interface ActiveTab {
  id: number;
  windowId: number;
  scriptable: boolean;
}

function openOptions() {
  void browser.runtime.openOptionsPage();
  window.close();
}

function Onboarding({ reason }: { reason: 'setup' | 'permission' }) {
  return (
    <Card withBorder radius="lg" padding="lg">
      <Stack gap="sm" align="center" ta="center">
        <Orb status="idle" size={56} />
        <Text fw={700}>
          {reason === 'setup' ? 'Connect your Tamber server' : 'Allow server access'}
        </Text>
        <Text size="sm" c="dimmed">
          {reason === 'setup'
            ? 'Tamber reads text aloud with your self-hosted voice server. Add its address to get started.'
            : 'Chrome has not granted access to your Tamber server yet. Open settings and click Save.'}
        </Text>
        <Button variant="gradient" onClick={openOptions} leftSection={<IconSettings size={16} />}>
          Open settings
        </Button>
      </Stack>
    </Card>
  );
}

export function App() {
  const { settings, save, ready } = useSettings();
  const { state } = usePlayer();
  const voices = useVoices(settings);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [permission, setPermission] = useState<boolean | null>(null);
  const [speed, setSpeed] = useState(settings.speed);
  const [syncedSpeed, setSyncedSpeed] = useState(settings.speed);
  if (syncedSpeed !== settings.speed) {
    setSyncedSpeed(settings.speed);
    setSpeed(settings.speed);
  }

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (t?.id === undefined) return;
      setTab({
        id: t.id,
        windowId: t.windowId,
        scriptable: !!t.url && /^(https?|file):/.test(t.url),
      });
    });
  }, []);

  useEffect(() => {
    if (!settings.apiBaseUrl) return;
    let alive = true;
    void hasApiPermission(settings.apiBaseUrl).then((ok) => alive && setPermission(ok));
    return () => {
      alive = false;
    };
  }, [settings.apiBaseUrl]);

  const mini = useMemo(() => toMiniState(state), [state]);
  const onboarding = !settings.apiBaseUrl ? 'setup' : permission === false ? 'permission' : null;

  /** chrome.sidePanel.open() must be called synchronously inside the click. */
  const openReader = () => {
    if (!tab) return;
    browser.sidePanel
      .open({ windowId: tab.windowId })
      .then(() => window.close())
      .catch((err: unknown) => console.warn('[tamber] side panel', err));
  };

  return (
    <Box p="md">
      <motion.div
        initial={{ opacity: 0, y: 6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap">
            <Brand size={24} />
            <Group gap={4} wrap="nowrap">
              <Tooltip label="Open reader" openDelay={300}>
                <ActionIcon
                  variant="subtle"
                  radius="xl"
                  aria-label="Open reader"
                  onClick={openReader}
                  disabled={!tab}
                >
                  <IconLayoutSidebarRight size={18} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Settings" openDelay={300}>
                <ActionIcon
                  variant="subtle"
                  radius="xl"
                  aria-label="Settings"
                  onClick={openOptions}
                >
                  <IconSettings size={18} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>

          {ready && onboarding ? (
            <Onboarding reason={onboarding} />
          ) : (
            <>
              <Card withBorder radius="lg" padding="md">
                <Stack gap="sm">
                  <Group gap="sm" wrap="nowrap">
                    <Orb status={state.status} size={40} />
                    <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                      <Text fw={600} size="sm" truncate>
                        {state.title || (state.text ? 'Now playing' : 'Ready when you are')}
                      </Text>
                      <StatusLine state={state} />
                    </Stack>
                  </Group>
                  <AnimatePresence mode="wait" initial={false}>
                    {mini.sentence && (
                      <motion.div
                        key={state.activeChunk}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.18 }}
                      >
                        <Text size="sm" lh={1.6} lineClamp={4}>
                          <SentenceView
                            sentence={mini.sentence}
                            word={settings.highlight ? mini.word : null}
                          />
                        </Text>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <Controls state={state} size="md" />
                  {state.notice && (
                    <Text size="xs" c="dimmed">
                      {state.notice}
                    </Text>
                  )}
                </Stack>
              </Card>

              {state.status === 'error' && state.error && (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} radius="lg" p="xs">
                  <Text size="xs">{state.error}</Text>
                </Alert>
              )}

              <Stack gap={6}>
                <Group justify="space-between">
                  <Text size="xs" fw={600}>
                    Speed
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {speed.toFixed(2)}×
                  </Text>
                </Group>
                <Slider
                  aria-label="Speed"
                  size="sm"
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={SPEED_STEP}
                  value={speed}
                  onChange={setSpeed}
                  onChangeEnd={(v) => {
                    void player.setSpeed(v);
                    void save({ speed: v });
                  }}
                  label={null}
                />
                <VoiceSelect
                  settings={settings}
                  voices={voices.voices}
                  loading={voices.loading}
                  onChange={(voice) => void save({ voice })}
                />
                {voices.error && (
                  <Text size="xs" c="red">
                    {voices.error}
                  </Text>
                )}
              </Stack>

              <Button
                variant="light"
                leftSection={<IconFileText size={16} />}
                disabled={!tab?.scriptable}
                onClick={() => {
                  if (tab) void player.readTab(tab.id);
                }}
              >
                Read selection or page
              </Button>

              <Divider label="or paste text" labelPosition="center" />
              <PasteBox minRows={2} maxRows={5} />
            </>
          )}
        </Stack>
      </motion.div>
    </Box>
  );
}
