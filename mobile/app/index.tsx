/**
 * Home / Compose: type or paste text, fetch a link, import a document, then Play.
 */
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTamberClient } from '@/api/client';
import {
  DOCUMENT_TYPES,
  extractFromFile,
  extractFromUrl,
  formatDuration,
  normalizeUrlInput,
  textStats,
} from '@/content/extract';
import { openContent } from '@/player/controller';
import { useLibrary, type LibrarySourceKind } from '@/store/library';
import { storage } from '@/store/mmkv';
import { isActive, usePlayback } from '@/store/playback';
import { useSettings } from '@/store/settings';
import { radius, spacing, type, usePalette, useReduceMotion } from '@/theme';
import { Glyph } from '@/ui/Glyph';
import { Icon } from '@/ui/Icon';
import { Orb } from '@/ui/Orb';
import { PlayerBar } from '@/ui/PlayerBar';
import { Button, Card, GradientButton, IconButton, Screen, SectionTitle, TextField } from '@/ui/primitives';

const DRAFT_KEY = 'tamber.draft';
const DRAFT_META_KEY = 'tamber.draftMeta';
const DRAFT_LIMIT = 1_000_000;

interface DraftMeta {
  title: string | null;
  source: string;
  kind: LibrarySourceKind;
}

function loadDraftMeta(): DraftMeta {
  try {
    const raw = storage.getString(DRAFT_META_KEY);
    if (raw) return JSON.parse(raw) as DraftMeta;
  } catch {
    // ignore
  }
  return { title: null, source: '', kind: 'text' };
}

export default function Home() {
  const p = usePalette();
  const reduce = useReduceMotion();
  const apiBaseUrl = useSettings((s) => s.settings.apiBaseUrl);
  const speed = useSettings((s) => s.settings.speed);
  const client = useTamberClient();
  const recent = useLibrary((s) => s.items);
  const sessionActive = usePlayback((s) => s.doc !== null && (isActive(s.status) || s.status === 'ended'));
  const showToast = usePlayback((s) => s.showToast);
  const insets = useSafeAreaInsets();

  const [text, setText] = useState(() => storage.getString(DRAFT_KEY) ?? '');
  const [meta, setMeta] = useState<DraftMeta>(loadDraftMeta);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<null | 'url' | 'file' | 'paste'>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist the draft (debounced 500 ms, capped at 1 MB) like the web client.
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (text.length <= DRAFT_LIMIT) storage.set(DRAFT_KEY, text);
      storage.set(DRAFT_META_KEY, JSON.stringify(meta));
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [text, meta]);

  if (!apiBaseUrl) return <Redirect href="/onboarding" />;

  const stats = textStats(text, speed);
  const canPlay = text.trim().length > 0;

  const replaceText = (next: string, m: DraftMeta) => {
    setText(next);
    setMeta(m);
  };

  const onPaste = async () => {
    setBusy('paste');
    try {
      const clip = await Clipboard.getStringAsync();
      if (!clip.trim()) {
        showToast('The clipboard is empty.', 'info');
        return;
      }
      const link = normalizeUrlInput(clip);
      if (link && !/\s/.test(clip.trim())) {
        // A pasted link: offer it in the link field instead of reading the URL aloud.
        setUrl(link);
        setUrlOpen(true);
        return;
      }
      replaceText(clip, { title: null, source: '', kind: 'text' });
    } catch (err) {
      showToast(`Couldn't read the clipboard: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const onFetchUrl = async () => {
    const target = normalizeUrlInput(url);
    if (!target) {
      showToast('That does not look like a web address.', 'warning');
      return;
    }
    if (!client) return;
    setBusy('url');
    try {
      const c = await extractFromUrl(client, target);
      replaceText(c.text, { title: c.title, source: c.source || target, kind: 'url' });
      setUrlOpen(false);
      setUrl('');
      if (c.truncated) showToast('Long page: only the first part was extracted.', 'info');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const onImport = async () => {
    if (!client) return;
    let res: DocumentPicker.DocumentPickerResult;
    try {
      res = await DocumentPicker.getDocumentAsync({
        type: DOCUMENT_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch (err) {
      showToast(`Couldn't open the document picker: ${(err as Error).message}`, 'error');
      return;
    }
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    setBusy('file');
    try {
      const c = await extractFromFile(client, { uri: asset.uri, name: asset.name, mimeType: asset.mimeType });
      replaceText(c.text, { title: c.title ?? asset.name, source: asset.name, kind: 'file' });
      if (c.truncated) showToast('Long document: only the first part was extracted.', 'info');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const onPlay = () => {
    if (!canPlay) return;
    router.push('/player');
    void openContent(
      { kind: 'text', text, title: meta.title, source: meta.source, libraryKind: meta.kind },
      { autoStart: true },
    );
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.topBar}>
          <Glyph size={30} />
          <Text style={[type.title, { color: p.text, flex: 1 }]}>Tamber</Text>
          <IconButton icon="history" label="Library" onPress={() => router.push('/library')} />
          <IconButton icon="wave" label="Voices" onPress={() => router.push('/voices')} />
          <IconButton icon="settings" label="Settings" onPress={() => router.push('/settings')} />
        </View>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Animated.View entering={reduce ? undefined : FadeIn.duration(420)} style={styles.hero}>
            <Orb size={120} state={busy ? 'busy' : 'idle'} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[type.heading, { color: p.text }]}>What should I read?</Text>
              <Text style={[type.small, { color: p.textDim }]}>
                Type, paste, open a link or import a document. You can also share pages and files to
                Tamber from any app.
              </Text>
            </View>
          </Animated.View>

          <Card style={{ padding: 0, gap: 0 }}>
            {meta.title ? (
              <View style={[styles.docTitle, { borderBottomColor: p.border }]}>
                <Icon name={meta.kind === 'url' ? 'link' : meta.kind === 'file' ? 'file' : 'type'} color={p.link} size={16} />
                <Text style={[type.small, { color: p.textDim, flex: 1 }]} numberOfLines={1}>
                  {meta.title}
                </Text>
              </View>
            ) : null}
            <TextInput
              value={text}
              onChangeText={(t) => {
                setText(t);
                if (!t) setMeta({ title: null, source: '', kind: 'text' });
              }}
              multiline
              placeholder="Start typing, or paste an article..."
              placeholderTextColor={p.textFaint}
              selectionColor={p.link}
              textAlignVertical="top"
              style={[styles.editor, { color: p.text }]}
              accessibilityLabel="Text to read"
            />
            <View style={[styles.statsRow, { borderTopColor: p.border }]}>
              <Text style={[type.small, { color: p.textFaint, flex: 1 }]}>
                {stats.chars.toLocaleString()} chars · {stats.words.toLocaleString()} words · ~
                {formatDuration(stats.minutes)}
              </Text>
              {text.length > 0 && (
                <Pressable
                  onPress={() => replaceText('', { title: null, source: '', kind: 'text' })}
                  accessibilityRole="button"
                  accessibilityLabel="Clear text"
                  hitSlop={8}
                >
                  <Text style={[type.small, { color: p.link, fontWeight: '700' }]}>Clear</Text>
                </Pressable>
              )}
            </View>
          </Card>

          <View style={styles.actions}>
            <Button label="Paste" icon="clipboard" compact loading={busy === 'paste'} onPress={() => void onPaste()} />
            <Button
              label="Open link"
              icon="link"
              compact
              onPress={() => setUrlOpen((o) => !o)}
              loading={busy === 'url'}
            />
            <Button label="Import" icon="file" compact loading={busy === 'file'} onPress={() => void onImport()} />
          </View>

          {urlOpen && (
            <Animated.View entering={reduce ? undefined : FadeInDown.duration(220)} layout={reduce ? undefined : LinearTransition}>
              <Card>
                <TextField
                  label="Web page or document link"
                  value={url}
                  onChangeText={setUrl}
                  placeholder="https://example.com/article"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="go"
                  onSubmitEditing={() => void onFetchUrl()}
                  autoFocus
                />
                <Button
                  label="Fetch text"
                  icon="link"
                  tone="primary"
                  loading={busy === 'url'}
                  disabled={!url.trim()}
                  onPress={() => void onFetchUrl()}
                />
              </Card>
            </Animated.View>
          )}

          <GradientButton label="Play" icon="play" size="xl" disabled={!canPlay} onPress={onPlay} />

          {recent.length > 0 && (
            <View style={{ gap: spacing.sm }}>
              <View style={styles.sectionHead}>
                <SectionTitle>Recent</SectionTitle>
                <Pressable onPress={() => router.push('/library')} hitSlop={8} accessibilityRole="button">
                  <Text style={[type.small, { color: p.link, fontWeight: '700' }]}>See all</Text>
                </Pressable>
              </View>
              {recent.slice(0, 4).map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Read ${item.title} again`}
                  onPress={() => {
                    router.push('/player');
                    void openContent({ kind: 'library', id: item.id }, { autoStart: true });
                  }}
                  style={({ pressed }) => [
                    styles.recent,
                    { backgroundColor: pressed ? p.surfaceAlt : p.surface, borderColor: p.border },
                  ]}
                >
                  <Icon
                    name={item.kind === 'url' ? 'link' : item.kind === 'file' ? 'file' : item.kind === 'share' ? 'share' : 'type'}
                    color={p.link}
                    size={18}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[type.body, { color: p.text }]} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={[type.small, { color: p.textFaint }]} numberOfLines={1}>
                      {item.source || 'Typed text'} · {formatDuration(item.charCount / 5.5 / 160)}
                    </Text>
                  </View>
                  <Icon name="play" color={p.textDim} size={16} />
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
        {sessionActive && (
          <View style={[styles.mini, { bottom: insets.bottom + spacing.md }]}>
            <PlayerBar variant="mini" />
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  scroll: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  docTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editor: {
    minHeight: 200,
    maxHeight: 360,
    padding: spacing.lg,
    fontSize: 17,
    lineHeight: 25,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mini: { position: 'absolute', left: spacing.md, right: spacing.md },
});
