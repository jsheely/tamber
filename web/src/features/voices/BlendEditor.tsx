import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Group,
  Paper,
  Select,
  Slider,
  Stack,
  Text,
} from '@mantine/core';
import {
  canonicalVoiceSpec,
  DEFAULT_MAX_BLEND_VOICES,
  formatVoiceSpec,
  isBlend,
  normalizedWeights,
  parseVoiceSpec,
  VoiceSpecError,
  type VoiceComponent,
} from '@tamber/client';
import { IconCheck, IconPlus, IconTrash } from '@tabler/icons-react';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useSession } from '../../store/session';
import { useSettings } from '../../store/settings';
import { voiceById, voiceSelectData } from './voiceUtils';

const BAR_COLORS = ['#A855F7', '#22D3EE', '#6594F2', '#C084FC'];

function initialRows(spec: string, fallback: string[]): VoiceComponent[] {
  try {
    const parts = parseVoiceSpec(spec, 16);
    if (isBlend(spec) && parts.length > 1) return parts;
    const first = parts[0]?.id ?? fallback[0] ?? 'af_heart';
    const second = fallback.find((id) => id !== first) ?? 'af_bella';
    return [
      { id: first, weight: 1 },
      { id: second, weight: 1 },
    ];
  } catch {
    return [
      { id: 'af_heart', weight: 1 },
      { id: 'af_bella', weight: 1 },
    ];
  }
}

/** Mix up to `max_blend_voices` voices with weights; shows the canonical spec sent to the API. */
export function BlendEditor({ onApplied }: { onApplied?: () => void }) {
  const voices = useSession((s) => s.voices);
  const maxVoices = useSession(
    (s) => s.health?.limits.max_blend_voices ?? DEFAULT_MAX_BLEND_VOICES,
  );
  const blendingEnabled = useSession((s) => s.health?.features.voice_blending ?? true);
  const current = useSettings((s) => s.voice);
  const update = useSettings((s) => s.update);
  const [rows, setRows] = useState<VoiceComponent[]>(() =>
    initialRows(current, (voices ?? []).map((v) => v.id)),
  );

  const data = useMemo(() => voiceSelectData(voices ?? []), [voices]);
  const result = useMemo((): { spec: string | null; error: string | null } => {
    try {
      const spec = canonicalVoiceSpec(formatVoiceSpec(rows), maxVoices);
      return { spec, error: null };
    } catch (err) {
      return { spec: null, error: err instanceof VoiceSpecError ? err.message : String(err) };
    }
  }, [rows, maxVoices]);
  const shares = useMemo(() => {
    try {
      return normalizedWeights(parseVoiceSpec(formatVoiceSpec(rows), 16));
    } catch {
      return [];
    }
  }, [rows]);
  const firstLang = voiceById(voices, rows[0]?.id ?? '')?.language_name;

  const setRow = (i: number, patch: Partial<VoiceComponent>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  if (!blendingEnabled) {
    return (
      <Alert color="gray" variant="light" title="Blending is off">
        This server does not allow voice blending.
      </Alert>
    );
  }

  const applied = result.spec !== null && result.spec === current;

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Blend voices by mixing their styles. Weights are relative: 2 and 1 means two thirds and one
        third. The language comes from the first voice{firstLang ? ` (${firstLang})` : ''}.
      </Text>
      {rows.map((row, i) => (
        <Paper key={i} p="sm" radius="lg" withBorder>
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <Select
              style={{ flex: 1 }}
              label={i === 0 ? 'Voice (sets the language)' : `Voice ${i + 1}`}
              data={data}
              value={row.id}
              searchable
              allowDeselect={false}
              nothingFoundMessage="No voice"
              onChange={(v) => v && setRow(i, { id: v })}
              comboboxProps={{ withinPortal: true, zIndex: 1000 }}
            />
            <ActionIcon
              size={44}
              radius="xl"
              variant="subtle"
              color="red"
              aria-label={`Remove voice ${i + 1}`}
              disabled={rows.length <= 2}
              onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Group>
          <Group gap="sm" mt="sm" wrap="nowrap">
            <Text size="xs" c="dimmed" w={48}>
              Weight
            </Text>
            <Slider
              style={{ flex: 1 }}
              min={0.5}
              max={10}
              step={0.5}
              value={row.weight}
              onChange={(w) => setRow(i, { weight: w })}
              label={(w) => `${w}`}
              aria-label={`Weight of voice ${i + 1}`}
              color={i % 2 ? 'tamberCyan' : 'tamber'}
            />
            <Text size="sm" ff="monospace" w={44} ta="right">
              {Math.round((shares[i]?.weight ?? 0) * 100)}%
            </Text>
          </Group>
        </Paper>
      ))}
      <Button
        variant="light"
        leftSection={<IconPlus size={16} />}
        disabled={rows.length >= maxVoices || !voices?.length}
        onClick={() =>
          setRows((rs) => [
            ...rs,
            { id: voices?.find((v) => !rs.some((r) => r.id === v.id))?.id ?? 'af_heart', weight: 1 },
          ])
        }
      >
        Add voice ({rows.length}/{maxVoices})
      </Button>

      <div
        aria-hidden
        style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', gap: 2 }}
      >
        {shares.map((s, i) => (
          <motion.div
            key={s.id}
            animate={{ flexGrow: Math.max(0.001, s.weight) }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            style={{ flexBasis: 0, background: BAR_COLORS[i % BAR_COLORS.length] }}
          />
        ))}
      </div>

      {result.error ? (
        <Alert color="red" variant="light">
          {result.error}
        </Alert>
      ) : (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Voice spec
          </Text>
          <Code block data-testid="blend-spec">
            {result.spec}
          </Code>
        </Stack>
      )}
      <Button
        variant="gradient"
        size="md"
        leftSection={<IconCheck size={18} />}
        disabled={!result.spec || applied}
        onClick={() => {
          if (!result.spec) return;
          update({ voice: result.spec });
          onApplied?.();
        }}
      >
        {applied ? 'This blend is in use' : 'Use this blend'}
      </Button>
      <Text size="xs" c="dimmed">
        Previews play single voices only. Changes apply to the next play.
      </Text>
    </Stack>
  );
}
