import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconGenderFemale,
  IconGenderMale,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconPlus,
  IconSearch,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  formatVoiceSpec,
  parseVoiceSpec,
  toggleFavoriteVoice,
  type TamberSettings,
  type Voice,
  type VoiceComponent,
} from '@tamber/client';
import { createClient, describeError } from '../lib/client';
import { voiceSelectData } from '../lib/format';

/** Compact voice select (popup, side panel). */
export function VoiceSelect({
  settings,
  voices,
  loading,
  onChange,
  size = 'sm',
  label,
}: {
  settings: Pick<TamberSettings, 'voice' | 'favoriteVoices'>;
  voices: readonly Voice[];
  loading?: boolean;
  onChange: (voice: string) => void;
  size?: 'xs' | 'sm' | 'md';
  label?: string;
}) {
  const data = useMemo(
    () => voiceSelectData(voices, settings.favoriteVoices, settings.voice),
    [voices, settings.favoriteVoices, settings.voice],
  );
  return (
    <Select
      label={label}
      aria-label="Voice"
      size={size}
      data={data}
      value={settings.voice}
      onChange={(v) => v && onChange(v)}
      searchable
      allowDeselect={false}
      nothingFoundMessage="No matching voice"
      rightSection={loading ? <Loader size={14} /> : undefined}
      comboboxProps={{ withinPortal: true, transitionProps: { transition: 'pop', duration: 120 } }}
      maxDropdownHeight={260}
    />
  );
}

/** Plays /v1/voices/{id}/preview in this page (an <audio> element with a blob URL). */
function usePreview(settings: Pick<TamberSettings, 'apiBaseUrl' | 'apiKey' | 'format' | 'volume'>) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const stop = () => {
    audioRef.current?.pause();
    setPlaying(null);
  };

  const play = async (id: string) => {
    if (playing === id) return stop();
    audioRef.current?.pause();
    audioRef.current ??= new Audio();
    const audio = audioRef.current;
    audio.volume = settings.volume;
    setError(null);
    setLoadingId(id);
    try {
      const bytes = await createClient(settings).voicePreview(id, settings.format);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const blob = new Blob([bytes as BlobPart], {
        type: settings.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      });
      urlRef.current = URL.createObjectURL(blob);
      audio.src = urlRef.current;
      audio.onended = () => setPlaying(null);
      await audio.play();
      setPlaying(id);
    } catch (err) {
      setError(describeError(err));
      setPlaying(null);
    } finally {
      setLoadingId(null);
    }
  };

  return { play, stop, playing, loadingId, error };
}

/** Full voice library for the options page: search, language filter, preview, favourites. */
export function VoiceLibrary({
  settings,
  voices,
  languages,
  loading,
  error,
  onSelect,
  onFavorites,
}: {
  settings: TamberSettings;
  voices: readonly Voice[];
  languages: readonly { code: string; name: string }[];
  loading: boolean;
  error: string | null;
  onSelect: (voice: string) => void;
  onFavorites: (list: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<string>('all');
  const preview = usePreview(settings);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return voices.filter(
      (v) =>
        (lang === 'all' || v.lang_code === lang) &&
        (!q ||
          v.name.toLowerCase().includes(q) ||
          v.id.includes(q) ||
          v.language_name.toLowerCase().includes(q) ||
          v.tags.some((t) => t.includes(q))),
    );
  }, [voices, query, lang]);

  return (
    <Stack gap="sm">
      <Group gap="sm" grow>
        <TextInput
          placeholder="Search voices"
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search voices"
        />
        <Select
          aria-label="Language"
          data={[
            { value: 'all', label: 'All languages' },
            ...languages.map((l) => ({ value: l.code, label: l.name })),
          ]}
          value={lang}
          onChange={(v) => setLang(v ?? 'all')}
          allowDeselect={false}
        />
      </Group>
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
      {preview.error && (
        <Text size="sm" c="red">
          Preview failed: {preview.error}
        </Text>
      )}
      {loading && !voices.length ? (
        <Group justify="center" p="lg">
          <Loader size="sm" />
        </Group>
      ) : (
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm">
          <AnimatePresence initial={false}>
            {filtered.map((v) => {
              const selected = settings.voice === v.id;
              const fav = settings.favoriteVoices.includes(v.id);
              return (
                <motion.div
                  key={v.id}
                  layout
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.18 }}
                >
                  <Card
                    withBorder
                    padding="sm"
                    radius="lg"
                    style={{
                      borderColor: selected ? 'var(--mantine-color-tamber-5)' : undefined,
                      boxShadow: selected ? '0 0 0 1px var(--mantine-color-tamber-5)' : undefined,
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap" gap={6}>
                      <Stack gap={2} style={{ minWidth: 0 }}>
                        <Group gap={6} wrap="nowrap">
                          {v.gender === 'female' ? (
                            <IconGenderFemale size={14} aria-label="female" />
                          ) : (
                            <IconGenderMale size={14} aria-label="male" />
                          )}
                          <Text fw={600} truncate>
                            {v.name}
                          </Text>
                          {v.grade && (
                            <Badge size="xs" variant="light">
                              {v.grade}
                            </Badge>
                          )}
                        </Group>
                        <Text size="xs" c="dimmed" truncate>
                          {v.language_name} · {v.id}
                        </Text>
                      </Stack>
                      <Group gap={2} wrap="nowrap">
                        <Tooltip label={preview.playing === v.id ? 'Stop' : 'Preview'}>
                          <ActionIcon
                            variant="light"
                            radius="xl"
                            aria-label={`Preview ${v.name}`}
                            loading={preview.loadingId === v.id}
                            onClick={() => void preview.play(v.id)}
                          >
                            {preview.playing === v.id ? (
                              <IconPlayerStopFilled size={14} />
                            ) : (
                              <IconPlayerPlayFilled size={14} />
                            )}
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={fav ? 'Remove from favourites' : 'Add to favourites'}>
                          <ActionIcon
                            variant="subtle"
                            radius="xl"
                            color="yellow"
                            aria-label={fav ? `Unfavourite ${v.name}` : `Favourite ${v.name}`}
                            onClick={() =>
                              onFavorites(toggleFavoriteVoice(settings.favoriteVoices, v.id))
                            }
                          >
                            {fav ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                    <Button
                      mt="xs"
                      size="xs"
                      fullWidth
                      variant={selected ? 'gradient' : 'default'}
                      onClick={() => onSelect(v.id)}
                    >
                      {selected ? 'Selected' : 'Use this voice'}
                    </Button>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </SimpleGrid>
      )}
      {!loading && voices.length > 0 && filtered.length === 0 && (
        <Text size="sm" c="dimmed" ta="center">
          No voice matches “{query}”.
        </Text>
      )}
    </Stack>
  );
}

/** Mix up to `max` voices with weights (docs/API.md "Voices and blends"). */
export function BlendEditor({
  voices,
  current,
  max = 4,
  onApply,
  onFavorite,
}: {
  voices: readonly Voice[];
  current: string;
  max?: number;
  onApply: (spec: string) => void;
  onFavorite: (spec: string) => void;
}) {
  const initial = useMemo<VoiceComponent[]>(() => {
    try {
      const parsed = parseVoiceSpec(current, max);
      return parsed.length > 1 ? parsed : [...parsed, { id: '', weight: 1 }];
    } catch {
      return [
        { id: '', weight: 1 },
        { id: '', weight: 1 },
      ];
    }
  }, [current, max]);
  // Re-key this component (key={current}) to reset the rows when the current voice changes.
  const [rows, setRows] = useState<VoiceComponent[]>(initial);

  const options = useMemo(
    () => voices.map((v) => ({ value: v.id, label: `${v.name} · ${v.language_name}` })),
    [voices],
  );
  const valid = rows.filter((r) => r.id && r.weight > 0);
  let spec = '';
  let specError: string | null = null;
  try {
    spec = valid.length ? formatVoiceSpec(parseVoiceSpec(formatVoiceSpec(valid), max)) : '';
  } catch (err) {
    specError = (err as Error).message;
  }
  const total = valid.reduce((s, r) => s + r.weight, 0);

  return (
    <Stack gap="xs">
      {rows.map((row, i) => (
        <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
          <Select
            style={{ flex: 1 }}
            label={i === 0 ? 'Voice' : undefined}
            aria-label={`Blend voice ${i + 1}`}
            placeholder="Pick a voice"
            data={options}
            value={row.id || null}
            searchable
            onChange={(v) =>
              setRows((rs) => rs.map((r, j) => (j === i ? { ...r, id: v ?? '' } : r)))
            }
          />
          <NumberInput
            w={96}
            label={i === 0 ? 'Weight' : undefined}
            aria-label={`Blend weight ${i + 1}`}
            min={0.1}
            max={100}
            step={0.5}
            decimalScale={2}
            value={row.weight}
            onChange={(v) =>
              setRows((rs) =>
                rs.map((r, j) => (j === i ? { ...r, weight: typeof v === 'number' ? v : 1 } : r)),
              )
            }
          />
          <Text size="xs" c="dimmed" w={40} ta="right" pb={8}>
            {row.id && total > 0 ? `${Math.round((row.weight / total) * 100)}%` : ''}
          </Text>
          <ActionIcon
            variant="subtle"
            color="gray"
            mb={4}
            aria-label={`Remove blend voice ${i + 1}`}
            disabled={rows.length <= 1}
            onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Group justify="space-between">
        <Button
          variant="subtle"
          size="xs"
          leftSection={<IconPlus size={14} />}
          disabled={rows.length >= max}
          onClick={() => setRows((rs) => [...rs, { id: '', weight: 1 }])}
        >
          Add voice
        </Button>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            disabled={!spec || !!specError}
            onClick={() => onFavorite(spec)}
          >
            Save as favourite
          </Button>
          <Button
            size="xs"
            variant="gradient"
            disabled={!spec || !!specError}
            onClick={() => onApply(spec)}
          >
            Use blend
          </Button>
        </Group>
      </Group>
      <Text size="xs" c={specError ? 'red' : 'dimmed'} ff="monospace">
        {specError ?? (spec || 'Pick at least one voice')}
      </Text>
    </Stack>
  );
}
