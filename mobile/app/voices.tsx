/**
 * Voices: browse by language, search, filter by gender, favourite, preview, and blend 2-4 voices.
 */
import {
  canonicalVoiceSpec,
  formatVoiceSpec,
  isBlend,
  parseVoiceSpec,
  type Voice,
  type VoiceComponent,
} from '@tamber/client';
import { useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { memo, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { useTamberClient, useVoices } from '@/api/client';
import { ensureAudioMode } from '@/player/audioSession';
import { writeCacheAudio } from '@/player/chunkFiles';
import { usePlayback } from '@/store/playback';
import { useSettings } from '@/store/settings';
import { radius, spacing, type, usePalette, useReduceMotion } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Badge, Button, Card, IconButton, Screen, ScreenHeader, Segmented, TextField } from '@/ui/primitives';

type GenderFilter = 'all' | 'female' | 'male';

const MAX_BLEND = 4;
const WEIGHT_STEP = 0.5;

interface VoiceRowProps {
  voice: Voice;
  selected: boolean;
  favourite: boolean;
  previewing: boolean;
  blendMode: boolean;
  inBlend: boolean;
  onSelect: (id: string) => void;
  onFavourite: (id: string) => void;
  onPreview: (v: Voice) => void;
}

const VoiceRow = memo(function VoiceRow({
  voice,
  selected,
  favourite,
  previewing,
  blendMode,
  inBlend,
  onSelect,
  onFavourite,
  onPreview,
}: VoiceRowProps) {
  const p = usePalette();
  return (
    <Pressable
      onPress={() => onSelect(voice.id)}
      accessibilityRole="button"
      accessibilityState={{ selected: blendMode ? inBlend : selected }}
      accessibilityLabel={`${voice.name}, ${voice.language_name}, ${voice.gender}${voice.grade ? `, grade ${voice.grade}` : ''}`}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: selected || inBlend ? p.surfaceAlt : pressed ? p.surface : 'transparent',
          borderColor: selected || inBlend ? p.primary : 'transparent',
        },
      ]}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <View style={styles.rowTitle}>
          <Text style={[type.body, { color: p.text, fontWeight: '700' }]}>{voice.name}</Text>
          <Text style={[type.small, { color: p.textFaint }]}>{voice.id}</Text>
        </View>
        <View style={styles.badges}>
          <Badge label={voice.gender === 'female' ? 'Female' : 'Male'} />
          {voice.grade && <Badge label={`Grade ${voice.grade}`} tone={voice.tags.includes('recommended') ? 'accent' : 'default'} />}
          {!voice.word_timestamps && <Badge label="No word highlighting" tone="warning" />}
        </View>
      </View>
      {previewing ? (
        <ActivityIndicator color={p.link} style={{ width: 40 }} />
      ) : (
        <IconButton icon="play" label={`Preview ${voice.name}`} size={40} onPress={() => onPreview(voice)} />
      )}
      <IconButton
        icon={favourite ? 'starFilled' : 'star'}
        label={favourite ? `Unfavourite ${voice.name}` : `Favourite ${voice.name}`}
        color={favourite ? '#FBBF24' : p.textDim}
        size={40}
        onPress={() => onFavourite(voice.id)}
      />
      {blendMode ? (
        <Icon name={inBlend ? 'check' : 'plus'} color={inBlend ? p.success : p.textDim} size={20} />
      ) : selected ? (
        <Icon name="check" color={p.success} size={20} />
      ) : null}
    </Pressable>
  );
});

function BlendEditor({
  components,
  voices,
  onChange,
  onApply,
}: {
  components: VoiceComponent[];
  voices: Map<string, Voice>;
  onChange: (c: VoiceComponent[]) => void;
  onApply: () => void;
}) {
  const p = usePalette();
  const total = components.reduce((s, c) => s + c.weight, 0) || 1;
  const valid = components.length >= 2;
  let preview = '';
  try {
    preview = components.length ? formatVoiceSpec(components) : '';
  } catch {
    preview = '';
  }
  return (
    <Card>
      <Text style={[type.heading, { color: p.text }]}>Blend voices</Text>
      <Text style={[type.small, { color: p.textDim }]}>
        Tap 2-4 voices below, then set their weights. The blend speaks in the first voice&apos;s language.
      </Text>
      {components.map((c, i) => (
        <View key={c.id} style={styles.blendRow}>
          <Text style={[type.body, { color: p.text, flex: 1 }]} numberOfLines={1}>
            {voices.get(c.id)?.name ?? c.id}
            <Text style={{ color: p.textFaint }}>  {Math.round((c.weight / total) * 100)}%</Text>
          </Text>
          <IconButton
            icon="minus"
            label={`Less ${c.id}`}
            size={34}
            filled
            disabled={c.weight <= WEIGHT_STEP}
            onPress={() => onChange(components.map((x, j) => (j === i ? { ...x, weight: Math.max(WEIGHT_STEP, x.weight - WEIGHT_STEP) } : x)))}
          />
          <Text style={[type.body, { color: p.text, minWidth: 34, textAlign: 'center' }]}>{c.weight}</Text>
          <IconButton
            icon="plus"
            label={`More ${c.id}`}
            size={34}
            filled
            disabled={c.weight >= 10}
            onPress={() => onChange(components.map((x, j) => (j === i ? { ...x, weight: Math.min(10, x.weight + WEIGHT_STEP) } : x)))}
          />
          <IconButton icon="close" label={`Remove ${c.id}`} size={34} onPress={() => onChange(components.filter((_, j) => j !== i))} />
        </View>
      ))}
      {preview ? <Text style={[type.small, { color: p.textFaint, fontFamily: undefined }]}>{preview}</Text> : null}
      <Button label="Use this blend" icon="blend" tone="primary" disabled={!valid} onPress={onApply} />
    </Card>
  );
}

export default function VoicesScreen() {
  const p = usePalette();
  const reduce = useReduceMotion();
  const client = useTamberClient();
  const { data, error, loading, reload } = useVoices();
  const currentVoice = useSettings((s) => s.settings.voice);
  const favourites = useSettings((s) => s.settings.favoriteVoices);
  const update = useSettings((s) => s.update);
  const toggleFavorite = useSettings((s) => s.toggleFavorite);
  const showToast = usePlayback((s) => s.showToast);
  const previewPlayer = useAudioPlayer(null);

  const [query, setQuery] = useState('');
  const [gender, setGender] = useState<GenderFilter>('all');
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [blendMode, setBlendMode] = useState(false);
  const [blend, setBlend] = useState<VoiceComponent[]>(() => {
    if (!isBlend(currentVoice)) return [];
    try {
      return parseVoiceSpec(currentVoice);
    } catch {
      return [];
    }
  });

  const byId = useMemo(() => new Map((data?.voices ?? []).map((v) => [v.id, v])), [data]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (v: Voice) =>
      (gender === 'all' || v.gender === gender) &&
      (!q || v.name.toLowerCase().includes(q) || v.id.includes(q) || v.language_name.toLowerCase().includes(q));
    const voices = (data?.voices ?? []).filter(matches);
    const out: { title: string; key: string; data: Voice[] }[] = [];
    const favs = favourites.map((f) => byId.get(f)).filter((v): v is Voice => !!v && matches(v));
    if (favs.length) out.push({ title: 'Favourites', key: 'fav', data: favs });
    const groups = new Map<string, Voice[]>();
    for (const v of voices) {
      const list = groups.get(v.language_name) ?? [];
      list.push(v);
      groups.set(v.language_name, list);
    }
    for (const [lang, list] of groups) out.push({ title: lang, key: lang, data: list });
    return out;
  }, [data, query, gender, favourites, byId]);

  const onSelect = useCallback(
    (id: string) => {
      void Haptics.selectionAsync();
      if (blendMode) {
        setBlend((b) => {
          if (b.some((c) => c.id === id)) return b.filter((c) => c.id !== id);
          if (b.length >= MAX_BLEND) {
            showToast(`A blend can use at most ${MAX_BLEND} voices.`, 'info');
            return b;
          }
          return [...b, { id, weight: 1 }];
        });
        return;
      }
      update({ voice: id });
    },
    [blendMode, update, showToast],
  );

  const onPreview = useCallback(
    async (v: Voice) => {
      if (!client) return;
      setPreviewing(v.id);
      try {
        await ensureAudioMode();
        const bytes = await client.voicePreview(v.id, 'wav');
        const uri = writeCacheAudio(`${v.id}.wav`, bytes);
        previewPlayer.replace({ uri });
        previewPlayer.play();
      } catch (err) {
        showToast(`Preview failed: ${(err as Error).message}`, 'error');
      } finally {
        setPreviewing(null);
      }
    },
    [client, previewPlayer, showToast],
  );

  const applyBlend = () => {
    try {
      const spec = canonicalVoiceSpec(formatVoiceSpec(blend), MAX_BLEND);
      update({ voice: spec });
      setBlendMode(false);
      showToast(`Voice set to ${spec}`, 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const favSet = useMemo(() => new Set(favourites), [favourites]);
  const blendSet = useMemo(() => new Set(blend.map((b) => b.id)), [blend]);

  return (
    <Screen>
      <ScreenHeader
        title="Voices"
        right={
          <Button
            label={blendMode ? 'Done' : 'Blend'}
            icon={blendMode ? 'check' : 'blend'}
            compact
            onPress={() => setBlendMode((m) => !m)}
          />
        }
      />
      <View style={styles.filters}>
        <View style={[styles.current, { backgroundColor: p.surface, borderColor: p.border }]}>
          <Icon name="wave" color={p.link} size={18} />
          <Text style={[type.small, { color: p.textDim }]}>Current voice</Text>
          <Text style={[type.body, { color: p.text, fontWeight: '700', flex: 1 }]} numberOfLines={1}>
            {currentVoice}
          </Text>
        </View>
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="Search voices or languages"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="Search voices"
        />
        <Segmented<GenderFilter>
          value={gender}
          onChange={setGender}
          options={[
            { value: 'all', label: 'All' },
            { value: 'female', label: 'Female' },
            { value: 'male', label: 'Male' },
          ]}
        />
        {blendMode && (
          <Animated.View entering={reduce ? undefined : FadeInDown.duration(200)}>
            <BlendEditor components={blend} voices={byId} onChange={setBlend} onApply={applyBlend} />
          </Animated.View>
        )}
      </View>
      {loading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator color={p.link} size="large" />
        </View>
      ) : error && !data ? (
        <View style={styles.center}>
          <Text style={[type.body, { color: p.danger, textAlign: 'center' }]}>{error.message}</Text>
          <Button label="Try again" onPress={reload} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item, index) => `${item.id}-${index}`}
          stickySectionHeadersEnabled
          contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xxl }}
          renderSectionHeader={({ section }) => (
            <Text style={[type.tiny, styles.sectionHeader, { color: p.textFaint, backgroundColor: p.background }]}>
              {section.title.toUpperCase()}
            </Text>
          )}
          renderItem={({ item }) => (
            <VoiceRow
              voice={item}
              selected={item.id === currentVoice}
              favourite={favSet.has(item.id)}
              previewing={previewing === item.id}
              blendMode={blendMode}
              inBlend={blendSet.has(item.id)}
              onSelect={onSelect}
              onFavourite={toggleFavorite}
              onPreview={(v) => void onPreview(v)}
            />
          )}
          ListEmptyComponent={
            <Text style={[type.body, { color: p.textDim, textAlign: 'center', marginTop: spacing.xl }]}>
              No voices match.
            </Text>
          }
          refreshing={loading}
          onRefresh={reload}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.sm },
  current: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: 2,
  },
  rowTitle: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  badges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  blendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  sectionHeader: { paddingVertical: spacing.sm, paddingHorizontal: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
});
