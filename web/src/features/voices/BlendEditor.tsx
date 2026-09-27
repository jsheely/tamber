import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  Slider,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  canonicalVoiceSpec,
  DEFAULT_MAX_BLEND_VOICES,
  findSavedBlend,
  formatVoiceSpec,
  isBlend,
  MAX_BLEND_NAME_CHARS,
  MAX_SAVED_BLENDS,
  normalizeBlendName,
  normalizedWeights,
  parseVoiceSpec,
  VoiceSpecError,
  type SavedBlend,
  type VoiceComponent,
} from '@tamber/client';
import {
  IconCheck,
  IconDeviceFloppy,
  IconPencil,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { previewVoice, stopPreview } from '../../player/actions';
import { useSession } from '../../store/session';
import { useSettings } from '../../store/settings';
import { VoiceSelect } from './VoiceSelect';
import { blendMixLabel, voiceById, voiceSelectData } from './voiceUtils';
import classes from './VoicePicker.module.css';

const BAR_COLORS = ['#A855F7', '#22D3EE', '#6594F2', '#C084FC'];

function rowsFromSpec(spec: string): VoiceComponent[] | null {
  try {
    const parts = parseVoiceSpec(spec, 16);
    return isBlend(spec) && parts.length > 1 ? parts : null;
  } catch {
    return null;
  }
}

function initialRows(spec: string, fallback: string[]): VoiceComponent[] {
  const fromSpec = rowsFromSpec(spec);
  if (fromSpec) return fromSpec;
  let first = 'af_heart';
  try {
    first = parseVoiceSpec(spec, 16)[0]?.id ?? fallback[0] ?? 'af_heart';
  } catch {
    first = fallback[0] ?? 'af_heart';
  }
  const second = fallback.find((id) => id !== first) ?? 'af_bella';
  return [
    { id: first, weight: 1 },
    { id: second, weight: 1 },
  ];
}

interface SavedRowProps {
  blend: SavedBlend;
  mix: string;
  inUse: boolean;
  previewing: boolean;
  canPreview: boolean;
  onUse: () => void;
  onEdit: () => void;
  onPreview: () => void;
  onDelete: () => void;
}

function SavedBlendRow(p: SavedRowProps) {
  const initials = p.blend.name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <div className={classes.row} data-selected={p.inUse || undefined} data-testid="saved-blend">
      <UnstyledButton
        className={classes.main}
        onClick={p.onUse}
        aria-pressed={p.inUse}
        aria-label={`${p.blend.name}, ${p.mix}${p.inUse ? ', in use' : ''}`}
      >
        <Avatar
          radius="xl"
          size={40}
          variant={p.inUse ? 'gradient' : 'light'}
          gradient={{ from: 'tamber.5', to: 'tamberCyan.4', deg: 62 }}
          color="tamber"
        >
          {p.inUse ? <IconCheck size={20} /> : initials}
        </Avatar>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text fw={600} truncate>
            {p.blend.name}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {p.mix}
          </Text>
        </div>
      </UnstyledButton>
      <Tooltip label={p.previewing ? 'Stop preview' : 'Preview'}>
        <ActionIcon
          size={44}
          radius="xl"
          variant="subtle"
          color="tamber"
          aria-label={p.previewing ? `Stop preview of ${p.blend.name}` : `Preview ${p.blend.name}`}
          disabled={!p.canPreview}
          onClick={p.onPreview}
        >
          {p.previewing ? <IconPlayerStopFilled size={18} /> : <IconPlayerPlayFilled size={18} />}
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Edit">
        <ActionIcon
          size={44}
          radius="xl"
          variant="subtle"
          color="gray"
          aria-label={`Edit ${p.blend.name}`}
          onClick={p.onEdit}
        >
          <IconPencil size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Delete">
        <ActionIcon
          size={44}
          radius="xl"
          variant="subtle"
          color="red"
          aria-label={`Delete ${p.blend.name}`}
          onClick={p.onDelete}
        >
          <IconTrash size={18} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}

/**
 * Blend tab: the saved blends (use, preview, edit, delete) and an editor that mixes up to
 * `max_blend_voices` voices with weights, previews the mix, saves it under a name and shows the
 * canonical spec sent to the API.
 */
export function BlendEditor({ onApplied }: { onApplied?: () => void }) {
  const voices = useSession((s) => s.voices);
  const maxVoices = useSession(
    (s) => s.health?.limits.max_blend_voices ?? DEFAULT_MAX_BLEND_VOICES,
  );
  const blendingEnabled = useSession((s) => s.health?.features.voice_blending ?? true);
  const previewFeature = useSession((s) => s.health?.features.voice_preview ?? true);
  const current = useSettings((s) => s.voice);
  const savedBlends = useSettings((s) => s.savedBlends);
  const update = useSettings((s) => s.update);
  const saveBlend = useSettings((s) => s.saveBlend);
  const removeBlend = useSettings((s) => s.removeBlend);

  const [rows, setRows] = useState<VoiceComponent[]>(() =>
    initialRows(current, (voices ?? []).map((v) => v.id)),
  );
  const [name, setName] = useState(() => findSavedBlend(savedBlends, current)?.name ?? '');
  const [nameTouched, setNameTouched] = useState(false);
  /** Spec being auditioned: the editor's ('editor') or a saved blend's (its spec). */
  const [previewing, setPreviewing] = useState<string | null>(null);

  // Leaving the tab (or remounting after "Use") ends a running audition.
  useEffect(() => () => stopPreview(), []);

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

  // The saved blend the editor currently reproduces (if any) and the name it would save under.
  const editingSaved = result.spec ? findSavedBlend(savedBlends, result.spec) : undefined;
  const nameValue = nameTouched ? name : (editingSaved?.name ?? name);
  const cleanName = normalizeBlendName(nameValue);
  const sameName = savedBlends.find(
    (b) => b.name.toLowerCase() === cleanName.toLowerCase() && b.spec !== result.spec,
  );
  const alreadySaved = !!editingSaved && editingSaved.name === cleanName;
  const full = savedBlends.length >= MAX_SAVED_BLENDS && !editingSaved && !sameName;

  const setRow = (i: number, patch: Partial<VoiceComponent>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const loadIntoEditor = (blend: SavedBlend) => {
    const parts = rowsFromSpec(blend.spec);
    if (!parts) return;
    setRows(parts);
    setName(blend.name);
    setNameTouched(true);
  };

  const togglePreview = (key: string, spec: string) => {
    if (previewing === key) {
      stopPreview();
      setPreviewing(null);
      return;
    }
    setPreviewing(key);
    // previewVoice() unlocks audio synchronously, inside this tap.
    void previewVoice(spec).finally(() => setPreviewing((p) => (p === key ? null : p)));
  };

  const onSave = () => {
    if (!result.spec || !cleanName) return;
    try {
      saveBlend({ name: cleanName, spec: result.spec });
      setName(cleanName);
      setNameTouched(true);
    } catch {
      // The spec was validated above; nothing to do.
    }
  };

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
      {savedBlends.length > 0 && (
        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed" lts={0.6}>
              Saved blends
            </Text>
            <Text size="xs" c="dimmed">
              {savedBlends.length}/{MAX_SAVED_BLENDS}
            </Text>
          </Group>
          <AnimatePresence initial={false}>
            {savedBlends.map((b) => (
              <motion.div
                key={b.spec}
                layout="position"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                <SavedBlendRow
                  blend={b}
                  mix={blendMixLabel(b.spec, voices)}
                  inUse={current === b.spec}
                  previewing={previewing === b.spec}
                  canPreview={previewFeature}
                  onUse={() => {
                    loadIntoEditor(b);
                    update({ voice: b.spec });
                  }}
                  onEdit={() => loadIntoEditor(b)}
                  onPreview={() => togglePreview(b.spec, b.spec)}
                  onDelete={() => {
                    if (previewing === b.spec) {
                      stopPreview();
                      setPreviewing(null);
                    }
                    removeBlend(b.name);
                  }}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </Stack>
      )}

      <Text size="xs" tt="uppercase" fw={700} c="dimmed" lts={0.6}>
        {editingSaved ? `Editing "${editingSaved.name}"` : 'New blend'}
      </Text>
      <Text size="sm" c="dimmed">
        Blend voices by mixing their styles. Weights are relative: 2 and 1 means two thirds and one
        third. The language comes from the first voice{firstLang ? ` (${firstLang})` : ''}.
      </Text>
      {rows.map((row, i) => (
        <Paper key={i} p="sm" radius="lg" withBorder>
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <VoiceSelect
              style={{ flex: 1 }}
              label={i === 0 ? 'Voice (sets the language)' : `Voice ${i + 1}`}
              data={data}
              value={row.id}
              allowDeselect={false}
              nothingFoundMessage="No voice"
              onChange={(v) => v && setRow(i, { id: v })}
              data-testid={`blend-voice-${i}`}
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

      <Group gap="xs" wrap="nowrap">
        <Button
          variant="light"
          size="md"
          style={{ flexShrink: 0 }}
          leftSection={
            previewing === 'editor' ? (
              <IconPlayerStopFilled size={18} />
            ) : (
              <IconPlayerPlayFilled size={18} />
            )
          }
          disabled={!result.spec || !previewFeature}
          onClick={() => result.spec && togglePreview('editor', result.spec)}
          data-testid="blend-preview"
        >
          {previewing === 'editor' ? 'Stop' : 'Preview'}
        </Button>
        <Button
          variant="gradient"
          size="md"
          style={{ flex: 1 }}
          leftSection={<IconCheck size={18} />}
          disabled={!result.spec || applied}
          onClick={() => {
            if (!result.spec) return;
            update({ voice: result.spec });
            onApplied?.();
          }}
          data-testid="blend-use"
        >
          {applied ? 'This blend is in use' : 'Use this blend'}
        </Button>
      </Group>
      {previewing === 'editor' && (
        <Group gap="xs" justify="center" c="dimmed">
          <Loader size="xs" type="dots" />
          <Text size="xs">Previewing the blend…</Text>
        </Group>
      )}

      <Group gap="xs" wrap="nowrap" align="flex-end">
        <TextInput
          style={{ flex: 1 }}
          label="Save as"
          placeholder="Name this blend"
          value={nameValue}
          maxLength={MAX_BLEND_NAME_CHARS}
          onChange={(e) => {
            setName(e.currentTarget.value);
            setNameTouched(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
          }}
          description={sameName ? `Replaces "${sameName.name}"` : undefined}
          error={
            full ? `You can keep up to ${MAX_SAVED_BLENDS} blends. Delete one first.` : undefined
          }
          data-testid="blend-name"
        />
        <Button
          size="md"
          variant="default"
          leftSection={<IconDeviceFloppy size={18} />}
          disabled={!result.spec || !cleanName || alreadySaved || full}
          onClick={onSave}
          data-testid="blend-save"
        >
          {alreadySaved ? 'Saved' : editingSaved || sameName ? 'Update' : 'Save'}
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Saved blends stay on this device. Changes to the voice apply to the next play.
      </Text>
    </Stack>
  );
}
