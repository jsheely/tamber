import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  PasswordInput,
  SegmentedControl,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  isValidBaseUrl,
  normalizeBaseUrl,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  TamberClient,
  type AudioFormat,
  type ChunkMode,
  type ConnectionTestResult,
  type MotionPreference,
  type ThemePreference,
} from '@tamber/client';
import {
  IconAlertTriangle,
  IconCheck,
  IconPlugConnected,
  IconRefresh,
  IconRestore,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { describeError } from '../../api/errors';
import { useAppUpdate } from '../../lib/appUpdate';
import { formatSpeed } from '../../lib/format';
import { useSession } from '../../store/session';
import { useSettings } from '../../store/settings';
import { ResponsiveDrawer } from '../../ui/ResponsiveDrawer';
import { VoiceSelect } from '../voices/VoiceSelect';
import { voiceSelectData } from '../voices/voiceUtils';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Title order={3} size="h6" tt="uppercase" c="dimmed" lts={0.8}>
        {title}
      </Title>
      {children}
    </Stack>
  );
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  const row = (ok: boolean | null, label: string, detail?: string) => (
    <Group gap="xs" wrap="nowrap">
      {ok === true ? (
        <IconCheck size={16} color="var(--mantine-color-green-6)" />
      ) : ok === false ? (
        <IconX size={16} color="var(--mantine-color-red-6)" />
      ) : (
        <IconAlertTriangle size={16} color="var(--mantine-color-yellow-6)" />
      )}
      <Text size="sm">
        {label}
        {detail ? <Text span c="dimmed" size="sm">{` · ${detail}`}</Text> : null}
      </Text>
    </Group>
  );
  const h = result.health;
  return (
    <Alert
      color={result.ok ? 'green' : 'red'}
      variant="light"
      data-testid="connection-result"
      title={result.ok ? 'Connected' : 'Connection problem'}
    >
      <Stack gap={4}>
        {row(h !== null, 'Server reachable', h ? `Tamber ${h.version} (${h.engine}, ${h.device})` : result.error ? describeError(result.error).title : undefined)}
        {h &&
          row(
            result.authOk,
            h.auth_required ? 'API key accepted' : 'No API key required',
            result.authOk === false ? 'rejected' : undefined,
          )}
        {h && row(result.compatible, 'API version', `v${h.api_version}`)}
        {result.voiceCount !== null && row(true, `${result.voiceCount} voices available`)}
        {h?.status === 'loading' && row(null, 'The voice model is still loading')}
      </Stack>
    </Alert>
  );
}

/** Version, build date and the update controls (the installed app has no reload button). */
function AppSection() {
  const needRefresh = useAppUpdate((s) => s.needRefresh);
  const checking = useAppUpdate((s) => s.checking);
  const applying = useAppUpdate((s) => s.applying);
  const lastChecked = useAppUpdate((s) => s.lastChecked);
  const check = useAppUpdate((s) => s.check);
  const apply = useAppUpdate((s) => s.apply);
  const reloadPage = useAppUpdate((s) => s.reload);
  const built = new Date(__BUILD_TIME__);
  const builtLabel = Number.isNaN(built.getTime())
    ? __BUILD_TIME__
    : built.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  // Short form for the one-line row (the full timestamp goes in the "up to date" notice).
  const builtShort = Number.isNaN(built.getTime())
    ? ''
    : built.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const onCheck = async () => {
    const result = await check();
    if (result === 'update') return; // the button turns into "Update now"
    if (result === 'unsupported') {
      notifications.show({
        id: 'tamber-update',
        color: 'gray',
        title: 'Reloading',
        message: 'Updates are not managed here (no service worker); reloading the page instead.',
      });
      reloadPage();
      return;
    }
    notifications.show({
      id: 'tamber-update',
      color: result === 'none' ? 'tamber' : 'yellow',
      title: result === 'none' ? "You're up to date" : 'Could not check for updates',
      message:
        result === 'none'
          ? `Tamber ${__APP_VERSION__}, built ${builtLabel}.`
          : 'The server could not be reached. Try again later or reload the app.',
    });
  };

  return (
    <Section title="App">
      <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={500} truncate data-testid="app-version">
            Tamber {__APP_VERSION__}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {builtShort ? `Built ${builtShort}` : ''}
            {lastChecked
              ? ` · checked ${new Date(lastChecked).toLocaleTimeString(undefined, { timeStyle: 'short' })}`
              : ''}
          </Text>
        </div>
        {needRefresh ? (
          <Button
            variant="gradient"
            style={{ flexShrink: 0 }}
            leftSection={<IconRefresh size={16} />}
            loading={applying}
            onClick={() => void apply()}
            data-testid="app-update"
          >
            Update now
          </Button>
        ) : (
          <Button
            variant="light"
            style={{ flexShrink: 0 }}
            leftSection={<IconRefresh size={16} />}
            loading={checking}
            onClick={() => void onCheck()}
            data-testid="app-check-updates"
          >
            Check for updates
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        The app checks for a new version when it comes back to the foreground and once an hour.
        If it ever looks stuck,{' '}
        <Text component="button" type="button" size="xs" c="tamber" td="underline" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={reloadPage} data-testid="app-reload">
          reload the app
        </Text>
        .
      </Text>
    </Section>
  );
}

function SettingsBody() {
  const settings = useSettings();
  const update = settings.update;
  const focusApiKey = useSession((s) => s.focusApiKey);
  const voices = useSession((s) => s.voices);
  const health = useSession((s) => s.health);

  const [url, setUrl] = useState(settings.apiBaseUrl);
  const [key, setKey] = useState(settings.apiKey);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const normalized = normalizeBaseUrl(url);
  const urlError = normalized && !isValidBaseUrl(normalized) ? 'Enter a full address, like https://tts.example.com' : null;
  const dirty = normalized !== settings.apiBaseUrl || key.trim() !== settings.apiKey;

  const voiceData = useMemo(() => {
    const data = voiceSelectData(voices ?? []);
    const known = voices?.some((v) => v.id === settings.voice);
    return known ? data : [{ group: 'Current', items: [{ value: settings.voice, label: settings.voice }] }, ...data];
  }, [voices, settings.voice]);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const client = TamberClient.fromSettings({ apiBaseUrl: normalized, apiKey: key });
      setResult(await client.testConnection({ timeoutMs: 10_000 }));
    } finally {
      setTesting(false);
    }
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (urlError) return;
    update({ apiBaseUrl: normalized, apiKey: key });
    setUrl(normalized); // show what was stored (scheme added, trailing / and /v1 removed)
    setKey(key.trim());
    notifications.show({ color: 'tamber', title: 'Connection saved', message: normalized || 'Using this server' });
  };

  return (
    <Stack gap="xl" pb="xl">
      <Section title="Connection">
        <form onSubmit={save} noValidate>
          <Stack gap="sm">
            <TextInput
              label="API base URL"
              description="Leave empty when this page is served by your Tamber server."
              placeholder="https://tts.example.com"
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              error={urlError}
              data-testid="settings-url"
            />
            <PasswordInput
              label="API key"
              description="Only needed when the server sets TAMBER_API_KEY. Stored on this device."
              placeholder="Paste your key"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
              data-autofocus={focusApiKey || undefined}
              autoFocus={focusApiKey}
              data-testid="settings-key"
            />
            <Group gap="xs">
              <Button type="submit" disabled={!dirty || Boolean(urlError)} data-testid="settings-save">
                Save
              </Button>
              <Button
                variant="light"
                leftSection={<IconPlugConnected size={16} />}
                loading={testing}
                onClick={() => void test()}
                disabled={Boolean(urlError)}
              >
                Test connection
              </Button>
            </Group>
            {result && <TestResult result={result} />}
          </Stack>
        </form>
      </Section>

      <Divider />

      <Section title="Voice and playback">
        <VoiceSelect
          label="Default voice"
          data={voiceData}
          value={settings.voice}
          allowDeselect={false}
          onChange={(v) => v && update({ voice: v })}
          nothingFoundMessage="No voice"
        />
        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              Speed
            </Text>
            <Text size="sm" ff="monospace">
              {formatSpeed(settings.speed)}
            </Text>
          </Group>
          <Slider
            aria-label="Default speed"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={settings.speed}
            onChange={(v) => update({ speed: v })}
            label={formatSpeed}
            marks={[{ value: 1 }, { value: 1.5 }]}
          />
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Audio format
          </Text>
          <SegmentedControl
            value={settings.format}
            onChange={(v) => update({ format: v as AudioFormat })}
            data={[
              { value: 'wav', label: 'WAV (recommended)' },
              { value: 'mp3', label: 'MP3' },
            ]}
            aria-label="Audio format"
          />
          {settings.format === 'mp3' && (
            <Text size="xs" c="yellow.7">
              MP3 uses less data but may have tiny gaps between sentences, and Save audio needs WAV.
            </Text>
          )}
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Chunking
          </Text>
          <SegmentedControl
            value={settings.chunkMode}
            onChange={(v) => update({ chunkMode: v as ChunkMode })}
            data={[
              { value: 'balanced', label: 'Balanced' },
              { value: 'sentence', label: 'Sentence' },
            ]}
            aria-label="Chunk mode"
          />
          <Text size="xs" c="dimmed">
            Balanced groups short sentences (fewer requests); Sentence sends one sentence at a time.
          </Text>
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Volume
          </Text>
          <Slider
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            onChange={(v) => update({ volume: v })}
            label={(v) => `${Math.round(v * 100)}%`}
          />
        </Stack>
      </Section>

      <Divider />

      <Section title="Reading">
        <Switch
          label="Word-by-word highlight"
          description="Off: only the current sentence is highlighted."
          checked={settings.highlight}
          onChange={(e) => update({ highlight: e.currentTarget.checked })}
        />
        <Switch
          label="Follow along (auto-scroll)"
          description="Pauses for a few seconds when you scroll yourself."
          checked={settings.autoScroll}
          onChange={(e) => update({ autoScroll: e.currentTarget.checked })}
        />
      </Section>

      <Divider />

      <Section title="Appearance">
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Theme
          </Text>
          <SegmentedControl
            value={settings.theme}
            onChange={(v) => update({ theme: v as ThemePreference })}
            data={[
              { value: 'auto', label: 'Auto' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            aria-label="Theme"
          />
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Motion
          </Text>
          <SegmentedControl
            value={settings.motion}
            onChange={(v) => update({ motion: v as MotionPreference })}
            data={[
              { value: 'system', label: 'System' },
              { value: 'full', label: 'Full' },
              { value: 'reduced', label: 'Reduced' },
            ]}
            aria-label="Motion"
          />
        </Stack>
      </Section>

      <Divider />

      <AppSection />

      <Divider />

      <Group justify="space-between" align="center">
        <Button
          variant={confirmReset ? 'filled' : 'subtle'}
          color="red"
          leftSection={<IconRestore size={16} />}
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true);
              return;
            }
            settings.reset();
            setConfirmReset(false);
            notifications.show({ title: 'Settings reset', message: 'Preferences are back to their defaults.' });
          }}
          onBlur={() => setConfirmReset(false)}
        >
          {confirmReset ? 'Tap again to reset' : 'Reset to defaults'}
        </Button>
        {health && (
          <Badge variant="light" color="gray">
            Server {health.version}
          </Badge>
        )}
      </Group>
    </Stack>
  );
}

/** Settings (persisted to localStorage "tamber.settings"). */
export default function SettingsDrawer() {
  const opened = useSession((s) => s.drawer === 'settings');
  const close = useSession((s) => s.closeDrawer);
  return (
    <ResponsiveDrawer opened={opened} onClose={close} title="Settings">
      <SettingsBody />
    </ResponsiveDrawer>
  );
}
