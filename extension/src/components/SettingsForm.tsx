import { useEffect, useState, type ReactNode } from 'react';
import {
  Accordion,
  Anchor,
  Button,
  Card,
  Group,
  Kbd,
  PasswordInput,
  SegmentedControl,
  Slider,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconDeviceFloppy,
  IconKeyboard,
  IconPlugConnected,
  IconRefresh,
  IconRestore,
  IconWorldWww,
} from '@tabler/icons-react';
import { motion } from 'motion/react';
import { browser } from 'wxt/browser';
import {
  normalizeBaseUrl,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  type TamberSettings,
} from '@tamber/client';
import { useSettings } from '../hooks/useSettings';
import { useVoices } from '../hooks/useVoices';
import { createClient } from '../lib/client';
import {
  describePatternError,
  hasApiPermission,
  originPatternFor,
  requestApiPermission,
} from '../lib/permissions';
import { ConnectionStatus, type ConnectionView } from './ConnectionStatus';
import { BlendEditor, VoiceLibrary } from './VoicePicker';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Card withBorder radius="lg" padding="lg">
        <Stack gap="md">
          <div>
            <Title order={3} fz="lg">
              {title}
            </Title>
            {description && (
              <Text size="sm" c="dimmed">
                {description}
              </Text>
            )}
          </div>
          {children}
        </Stack>
      </Card>
    </motion.section>
  );
}

/** Server address + API key, with the runtime host-permission request and a connection test. */
export function ServerSettings({ autoFocus = false }: { autoFocus?: boolean }) {
  const { settings, save, ready } = useSettings();
  const [url, setUrl] = useState(settings.apiBaseUrl);
  const [key, setKey] = useState(settings.apiKey);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [view, setView] = useState<ConnectionView>({ kind: 'idle' });
  const [syncedFrom, setSyncedFrom] = useState<string | null>(null);

  // Adopt stored values once they load (or change in another context) unless the user is editing.
  const storedKey = `${settings.apiBaseUrl}\u0000${settings.apiKey}`;
  if (ready && syncedFrom !== storedKey) {
    setSyncedFrom(storedKey);
    setUrl(settings.apiBaseUrl);
    setKey(settings.apiKey);
  }

  // Show the current permission state for a configured server.
  useEffect(() => {
    if (!settings.apiBaseUrl) return;
    let alive = true;
    void hasApiPermission(settings.apiBaseUrl).then((ok) => {
      const r = originPatternFor(settings.apiBaseUrl);
      if (alive && !ok && r.ok) setView({ kind: 'no-permission', origin: r.origin });
    });
    return () => {
      alive = false;
    };
  }, [settings.apiBaseUrl]);

  const runTest = async (baseUrl: string, apiKey: string) => {
    setView({ kind: 'testing' });
    const result = await createClient({ apiBaseUrl: baseUrl, apiKey }).testConnection();
    setView({ kind: 'result', result });
  };

  /**
   * Save / Test click handler. chrome.permissions.request() must be the first thing that happens
   * in the gesture (no await before it), so everything it needs is computed synchronously.
   */
  const onSave = (testOnly: boolean) => {
    const normalized = normalizeBaseUrl(url);
    const pattern = originPatternFor(normalized);
    if (!pattern.ok) {
      setUrlError(describePatternError(pattern.reason));
      return;
    }
    const granted = requestApiPermission(normalized); // synchronous call inside the click
    setUrlError(null);
    setUrl(normalized);
    void (async () => {
      const ok = await granted.catch(() => false);
      if (!testOnly) await save({ apiBaseUrl: normalized, apiKey: key.trim() });
      if (!ok) {
        setView({ kind: 'no-permission', origin: pattern.origin });
        return;
      }
      await runTest(normalized, key.trim());
    })();
  };

  return (
    <Stack gap="sm">
      <TextInput
        label="Server address"
        description="The HTTPS address of your Tamber server, e.g. https://tts.example.com"
        placeholder="https://tts.example.com"
        leftSection={<IconWorldWww size={16} />}
        value={url}
        error={urlError}
        autoFocus={autoFocus}
        onChange={(e) => {
          setUrl(e.currentTarget.value);
          setUrlError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(false);
        }}
        spellCheck={false}
        autoComplete="url"
      />
      <PasswordInput
        label="API key"
        description="Only needed when the server sets TAMBER_API_KEY. Stored on this device only (never synced)."
        placeholder="optional"
        value={key}
        onChange={(e) => setKey(e.currentTarget.value)}
        autoComplete="off"
      />
      <Group gap="sm">
        <Button
          variant="gradient"
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={() => onSave(false)}
        >
          Save
        </Button>
        <Button
          variant="default"
          leftSection={<IconPlugConnected size={16} />}
          onClick={() => onSave(true)}
          disabled={!url.trim()}
        >
          Test connection
        </Button>
      </Group>
      <ConnectionStatus view={view} />
    </Stack>
  );
}

function VoiceSettings() {
  const { settings, save } = useSettings();
  const voices = useVoices(settings);
  const onFavorites = (list: string[]) => void save({ favoriteVoices: list });
  return (
    <Stack gap="md">
      {!settings.apiBaseUrl ? (
        <Text size="sm" c="dimmed">
          Connect a server to browse its voices.
        </Text>
      ) : (
        <>
          <Group justify="space-between">
            <Text size="sm">
              Current voice: <b>{settings.voice}</b>
            </Text>
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconRefresh size={14} />}
              loading={voices.loading}
              onClick={voices.reload}
            >
              Refresh
            </Button>
          </Group>
          <VoiceLibrary
            settings={settings}
            voices={voices.voices}
            languages={voices.languages}
            loading={voices.loading}
            error={voices.error}
            onSelect={(voice) => void save({ voice })}
            onFavorites={onFavorites}
          />
          <Accordion variant="separated" radius="lg">
            <Accordion.Item value="blend">
              <Accordion.Control>Blend voices</Accordion.Control>
              <Accordion.Panel>
                <BlendEditor
                  key={settings.voice}
                  voices={voices.voices}
                  current={settings.voice}
                  onApply={(voice) => void save({ voice })}
                  onFavorite={(spec) =>
                    onFavorites(
                      settings.favoriteVoices.includes(spec)
                        ? settings.favoriteVoices
                        : [spec, ...settings.favoriteVoices],
                    )
                  }
                />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </>
      )}
    </Stack>
  );
}

function SpeedSlider({ value, onCommit }: { value: number; onCommit: (speed: number) => void }) {
  const [local, setLocal] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setLocal(value);
  }
  return (
    <Slider
      aria-label="Speed"
      min={SPEED_MIN}
      max={SPEED_MAX}
      step={SPEED_STEP}
      value={local}
      onChange={setLocal}
      onChangeEnd={onCommit}
      label={(v) => `${v.toFixed(2)}×`}
      marks={[
        { value: 0.5, label: '0.5×' },
        { value: 1, label: '1×' },
        { value: 1.5, label: '1.5×' },
        { value: 2, label: '2×' },
      ]}
      mb="md"
    />
  );
}

function PlaybackSettings() {
  const { settings, save } = useSettings();
  const [volume, setVolume] = useState(settings.volume);
  const [syncedVolume, setSyncedVolume] = useState(settings.volume);
  if (syncedVolume !== settings.volume) {
    setSyncedVolume(settings.volume);
    setVolume(settings.volume);
  }
  return (
    <Stack gap="lg">
      <div>
        <Text size="sm" fw={500} mb={4}>
          Speed
        </Text>
        <SpeedSlider value={settings.speed} onCommit={(speed) => void save({ speed })} />
      </div>
      <div>
        <Text size="sm" fw={500} mb={4}>
          Volume
        </Text>
        <Slider
          aria-label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={setVolume}
          onChangeEnd={(v) => void save({ volume: v })}
          label={(v) => `${Math.round(v * 100)}%`}
        />
      </div>
      <Group grow align="flex-start">
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Audio format
          </Text>
          <SegmentedControl
            aria-label="Audio format"
            value={settings.format}
            onChange={(v) => void save({ format: v as TamberSettings['format'] })}
            data={[
              { value: 'wav', label: 'WAV (gapless)' },
              { value: 'mp3', label: 'MP3 (smaller)' },
            ]}
          />
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Chunking
          </Text>
          <SegmentedControl
            aria-label="Chunk mode"
            value={settings.chunkMode}
            onChange={(v) => void save({ chunkMode: v as TamberSettings['chunkMode'] })}
            data={[
              { value: 'balanced', label: 'Balanced' },
              { value: 'sentence', label: 'Sentence' },
            ]}
          />
        </Stack>
      </Group>
    </Stack>
  );
}

function ReadingSettings() {
  const { settings, save, ext, saveExt } = useSettings();
  return (
    <Stack gap="sm">
      <Switch
        label="Highlight each word as it is spoken"
        description="Off: only the current sentence is highlighted."
        checked={settings.highlight}
        onChange={(e) => void save({ highlight: e.currentTarget.checked })}
      />
      <Switch
        label="Auto-scroll the reader"
        description="Keeps the current line in view (pauses for a few seconds when you scroll)."
        checked={settings.autoScroll}
        onChange={(e) => void save({ autoScroll: e.currentTarget.checked })}
      />
      <Switch
        label="Show the floating mini-player on the page"
        description="A small player in the corner of the page you are reading."
        checked={ext.showMiniPlayer}
        onChange={(e) => void saveExt({ showMiniPlayer: e.currentTarget.checked })}
      />
      <Switch
        label="Open the side panel reader when reading starts"
        description="From the context menu or keyboard shortcut."
        checked={ext.openSidePanelOnPlay}
        onChange={(e) => void saveExt({ openSidePanelOnPlay: e.currentTarget.checked })}
      />
    </Stack>
  );
}

function AppearanceSettings() {
  const { settings, save } = useSettings();
  return (
    <Group grow align="flex-start">
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Theme
        </Text>
        <SegmentedControl
          aria-label="Theme"
          value={settings.theme}
          onChange={(v) => void save({ theme: v as TamberSettings['theme'] })}
          data={[
            { value: 'auto', label: 'Auto' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Motion
        </Text>
        <SegmentedControl
          aria-label="Motion"
          value={settings.motion}
          onChange={(v) => void save({ motion: v as TamberSettings['motion'] })}
          data={[
            { value: 'system', label: 'System' },
            { value: 'full', label: 'Full' },
            { value: 'reduced', label: 'Reduced' },
          ]}
        />
      </Stack>
    </Group>
  );
}

interface CommandRow {
  name: string;
  description: string;
  shortcut: string;
}

function Shortcuts() {
  const [rows, setRows] = useState<CommandRow[]>([]);
  useEffect(() => {
    let alive = true;
    browser.commands
      .getAll()
      .then((cmds) => {
        if (!alive) return;
        setRows(
          cmds
            .filter((c) => c.name && !c.name.startsWith('_') && !c.name.startsWith('wxt:'))
            .map((c) => ({
              name: c.name ?? '',
              description: c.description ?? c.name ?? '',
              shortcut: c.shortcut ?? '',
            })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Stack gap="sm">
      <Table verticalSpacing={6}>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.name}>
              <Table.Td>{r.description}</Table.Td>
              <Table.Td ta="right">
                {r.shortcut ? (
                  <Kbd>{r.shortcut}</Kbd>
                ) : (
                  <Text size="sm" c="dimmed">
                    not set
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="sm" c="dimmed">
        Right-click selected text and choose <b>Read with Tamber</b>, or use the shortcut. With
        nothing selected, the shortcut reads the whole page.
      </Text>
      <Group>
        <Button
          variant="default"
          leftSection={<IconKeyboard size={16} />}
          onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          Change shortcuts
        </Button>
      </Group>
    </Stack>
  );
}

function ResetSection() {
  const { reset } = useSettings();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Group justify="space-between">
      <Text size="sm" c="dimmed">
        Restore every setting to its default, including the server address and API key.
      </Text>
      <Button
        color="red"
        variant={armed ? 'filled' : 'light'}
        leftSection={<IconRestore size={16} />}
        onClick={() => {
          if (!armed) setArmed(true);
          else {
            setArmed(false);
            void reset();
          }
        }}
      >
        {armed ? 'Click again to reset' : 'Reset settings'}
      </Button>
    </Group>
  );
}

/** Every setting, grouped in cards (options page). */
export function SettingsForm({ focusServer = false }: { focusServer?: boolean }) {
  return (
    <Stack gap="lg">
      <Section title="Server" description="Where your Tamber voice server lives.">
        <ServerSettings autoFocus={focusServer} />
      </Section>
      <Section title="Voice" description="Pick, preview, favourite or blend voices.">
        <VoiceSettings />
      </Section>
      <Section title="Playback">
        <PlaybackSettings />
      </Section>
      <Section title="Reading">
        <ReadingSettings />
      </Section>
      <Section title="Appearance">
        <AppearanceSettings />
      </Section>
      <Section title="Keyboard shortcuts">
        <Shortcuts />
      </Section>
      <Section title="Reset">
        <ResetSection />
      </Section>
      <Text size="xs" c="dimmed" ta="center">
        Settings sync across your Chrome browsers (the API key stays on this device).{' '}
        <Anchor href="https://huggingface.co/hexgrad/Kokoro-82M" target="_blank" size="xs">
          Kokoro
        </Anchor>{' '}
        voices by hexgrad.
      </Text>
    </Stack>
  );
}
