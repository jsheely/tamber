import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Chip,
  Group,
  Loader,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import type { Gender, LangCode, Voice } from '@tamber/client';
import {
  IconCheck,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconSearch,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useMemo, useState } from 'react';
import { previewVoice, stopPreview } from '../../player/actions';
import { useSession } from '../../store/session';
import { useSettings } from '../../store/settings';
import { filterVoices, voiceLanguages } from './voiceUtils';
import classes from './VoicePicker.module.css';

interface RowProps {
  voice: Voice;
  selected: boolean;
  favorite: boolean;
  previewing: boolean;
  canPreview: boolean;
  onSelect: (id: string) => void;
  onFavorite: (id: string) => void;
  onPreview: (id: string) => void;
}

const VoiceRow = memo(function VoiceRow(p: RowProps) {
  const v = p.voice;
  return (
    <div className={classes.row} data-selected={p.selected || undefined}>
      <UnstyledButton
        className={classes.main}
        onClick={() => p.onSelect(v.id)}
        aria-pressed={p.selected}
        aria-label={`${v.name}, ${v.language_name}, ${v.gender}${v.grade ? `, grade ${v.grade}` : ''}`}
      >
        <Avatar
          radius="xl"
          size={40}
          variant={p.selected ? 'gradient' : 'light'}
          gradient={{ from: 'tamber.5', to: 'tamberCyan.4', deg: 62 }}
          color="tamber"
        >
          {p.selected ? <IconCheck size={20} /> : v.name.slice(0, 1)}
        </Avatar>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="nowrap">
            <Text fw={600} truncate>
              {v.name}
            </Text>
            {v.grade && (
              <Badge size="xs" variant="light" color={v.grade.startsWith('A') ? 'teal' : v.grade.startsWith('B') ? 'tamber' : 'gray'}>
                {v.grade}
              </Badge>
            )}
            {v.tags.includes('default') && (
              <Badge size="xs" variant="outline" color="gray">
                default
              </Badge>
            )}
          </Group>
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" ff="monospace">
              {v.id}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {v.language}
            </Text>
            {!v.word_timestamps && (
              <Tooltip label="Word timing isn't available for this language: sentences are highlighted instead">
                <Badge size="xs" variant="light" color="gray">
                  no word highlighting
                </Badge>
              </Tooltip>
            )}
          </Group>
        </div>
      </UnstyledButton>
      <Tooltip label={p.previewing ? 'Stop preview' : 'Preview'}>
        <ActionIcon
          size={44}
          radius="xl"
          variant="subtle"
          color="tamber"
          aria-label={p.previewing ? `Stop preview of ${v.name}` : `Preview ${v.name}`}
          disabled={!p.canPreview}
          onClick={() => p.onPreview(v.id)}
        >
          {p.previewing ? <IconPlayerStopFilled size={18} /> : <IconPlayerPlayFilled size={18} />}
        </ActionIcon>
      </Tooltip>
      <ActionIcon
        size={44}
        radius="xl"
        variant="subtle"
        color={p.favorite ? 'yellow' : 'gray'}
        aria-label={p.favorite ? `Unpin ${v.name}` : `Pin ${v.name}`}
        aria-pressed={p.favorite}
        onClick={() => p.onFavorite(v.id)}
      >
        {p.favorite ? <IconStarFilled size={18} /> : <IconStar size={18} />}
      </ActionIcon>
    </div>
  );
});

/** Search, language chips, gender filter, favourites, grades, previews. */
export function VoicePicker({ onRetry }: { onRetry: () => void }) {
  const voices = useSession((s) => s.voices);
  const loading = useSession((s) => s.voicesLoading);
  const error = useSession((s) => s.voicesError);
  const previewFeature = useSession((s) => s.health?.features.voice_preview ?? true);
  const current = useSettings((s) => s.voice);
  const favorites = useSettings((s) => s.favoriteVoices);
  const update = useSettings((s) => s.update);
  const toggleFavorite = useSettings((s) => s.toggleFavorite);

  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<LangCode | 'all'>('all');
  const [gender, setGender] = useState<Gender | 'all'>('all');
  const [previewing, setPreviewing] = useState<string | null>(null);

  const languages = useMemo(() => voiceLanguages(voices ?? []), [voices]);
  const filtered = useMemo(
    () => filterVoices(voices ?? [], { query, lang, gender }),
    [voices, query, lang, gender],
  );
  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const pinned = filtered.filter((v) => favSet.has(v.id));
  const rest = filtered.filter((v) => !favSet.has(v.id));

  const onPreview = (id: string) => {
    if (previewing === id) {
      stopPreview();
      setPreviewing(null);
      return;
    }
    setPreviewing(id);
    // previewVoice() unlocks audio synchronously, inside this tap.
    void previewVoice(id).finally(() => setPreviewing((p) => (p === id ? null : p)));
  };

  const renderRows = (list: Voice[]) => (
    <AnimatePresence initial={false}>
      {list.map((v) => (
        <motion.div
          key={v.id}
          layout="position"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <VoiceRow
            voice={v}
            selected={current === v.id}
            favorite={favSet.has(v.id)}
            previewing={previewing === v.id}
            canPreview={previewFeature}
            onSelect={(id) => update({ voice: id })}
            onFavorite={toggleFavorite}
            onPreview={onPreview}
          />
        </motion.div>
      ))}
    </AnimatePresence>
  );

  return (
    <Stack gap="sm">
      <TextInput
        placeholder="Search voices"
        aria-label="Search voices"
        leftSection={<IconSearch size={16} />}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        size="md"
      />
      <Group gap="xs" wrap="wrap">
        <Chip.Group multiple={false} value={lang} onChange={(v) => setLang(v as LangCode | 'all')}>
          <Chip value="all" size="sm" radius="xl">
            All
          </Chip>
          {languages.map((l) => (
            <Chip key={l.code} value={l.code} size="sm" radius="xl">
              {l.name}
            </Chip>
          ))}
        </Chip.Group>
      </Group>
      <SegmentedControl
        fullWidth
        value={gender}
        onChange={(v) => setGender(v as Gender | 'all')}
        data={[
          { value: 'all', label: 'Any' },
          { value: 'female', label: 'Female' },
          { value: 'male', label: 'Male' },
        ]}
        aria-label="Gender"
      />
      {loading && !voices && (
        <Stack gap={8}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={58} radius="lg" />
          ))}
        </Stack>
      )}
      {error && !voices && (
        <Alert color="red" title="Could not load voices" variant="light">
          <Group justify="space-between">
            <Text size="sm">{error}</Text>
            <Button size="xs" variant="light" onClick={onRetry}>
              Retry
            </Button>
          </Group>
        </Alert>
      )}
      {pinned.length > 0 && (
        <>
          <Text size="xs" tt="uppercase" fw={700} c="dimmed" lts={0.6}>
            Pinned
          </Text>
          <Stack gap={4}>{renderRows(pinned)}</Stack>
        </>
      )}
      {voices && (
        <>
          <Group justify="space-between">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed" lts={0.6}>
              {pinned.length ? 'All voices' : 'Voices'}
            </Text>
            <Text size="xs" c="dimmed">
              {filtered.length} of {voices.length}
            </Text>
          </Group>
          <Stack gap={4}>{renderRows(rest)}</Stack>
          {filtered.length === 0 && (
            <Text c="dimmed" ta="center" py="lg">
              No voice matches these filters.
            </Text>
          )}
        </>
      )}
      {previewing && (
        <Group gap="xs" justify="center" c="dimmed">
          <Loader size="xs" type="dots" />
          <Text size="xs">Previewing…</Text>
        </Group>
      )}
    </Stack>
  );
}
