/**
 * Settings: every TamberSettings field, persisted through the settings store (MMKV + secure-store).
 */
import { SPEED_MAX, SPEED_MIN, SPEED_STEP } from '@tamber/client';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useHealth } from '@/api/client';
import { useSettings } from '@/store/settings';
import { radius, spacing, type, usePalette } from '@/theme';
import { ConnectionFields, useConnectionForm } from '@/ui/ConnectionForm';
import { Icon } from '@/ui/Icon';
import {
  Button,
  Card,
  Divider,
  Screen,
  ScreenHeader,
  SectionTitle,
  Segmented,
  Stepper,
  SwitchRow,
} from '@/ui/primitives';

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2];

function ServerCard() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const setApiKey = useSettings((s) => s.setApiKey);
  const form = useConnectionForm({ apiBaseUrl: settings.apiBaseUrl, apiKey: settings.apiKey });
  const dirty = form.values.apiBaseUrl !== settings.apiBaseUrl || form.values.apiKey !== settings.apiKey;
  const save = async () => {
    update({ apiBaseUrl: form.values.apiBaseUrl });
    await setApiKey(form.values.apiKey);
  };
  return (
    <Card>
      <SectionTitle>Server</SectionTitle>
      <ConnectionFields form={form} onSubmit={() => void save()} />
      <Button label="Save server" icon="check" tone="primary" disabled={!dirty || !form.valid} onPress={() => void save()} />
    </Card>
  );
}

export default function SettingsScreen() {
  const p = usePalette();
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const reset = useSettings((st) => st.reset);
  const health = useHealth();

  const confirmReset = () =>
    Alert.alert('Reset settings?', 'This restores every setting to its default and removes the saved API key.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          void reset().then(() => router.replace('/onboarding'));
        },
      },
    ]);

  return (
    <Screen>
      <ScreenHeader title="Settings" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ServerCard />

          <Card>
            <SectionTitle>Voice</SectionTitle>
            <Pressable
              onPress={() => router.push('/voices')}
              accessibilityRole="button"
              accessibilityLabel={`Voice ${s.voice}. Change voice`}
              style={[styles.linkRow, { borderColor: p.border }]}
            >
              <Icon name="wave" color={p.link} size={20} />
              <Text style={[type.body, { color: p.text, flex: 1 }]} numberOfLines={1}>
                {s.voice}
              </Text>
              <Icon name="chevronRight" color={p.textDim} size={20} />
            </Pressable>
            <Stepper
              label="Speed"
              value={s.speed}
              display={`${s.speed.toFixed(2)}x`}
              step={SPEED_STEP}
              min={SPEED_MIN}
              max={SPEED_MAX}
              onChange={(speed) => update({ speed })}
            />
            <View style={styles.presets}>
              {SPEED_PRESETS.map((v) => (
                <Pressable
                  key={v}
                  onPress={() => update({ speed: v })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: Math.abs(s.speed - v) < 0.001 }}
                  style={[
                    styles.preset,
                    {
                      borderColor: Math.abs(s.speed - v) < 0.001 ? p.primary : p.border,
                      backgroundColor: Math.abs(s.speed - v) < 0.001 ? p.surfaceAlt : 'transparent',
                    },
                  ]}
                >
                  <Text style={[type.small, { color: p.text, fontWeight: '700' }]}>{v}x</Text>
                </Pressable>
              ))}
            </View>
            <Stepper
              label="Volume"
              value={s.volume}
              display={`${Math.round(s.volume * 100)}%`}
              step={0.1}
              min={0}
              max={1}
              onChange={(volume) => update({ volume: Math.round(volume * 10) / 10 })}
            />
          </Card>

          <Card>
            <SectionTitle>Audio</SectionTitle>
            <Segmented
              label="Format"
              value={s.format}
              onChange={(format) => update({ format })}
              options={[
                { value: 'wav', label: 'WAV (gapless)' },
                { value: 'mp3', label: 'MP3 (smaller)' },
              ]}
            />
            <Segmented
              label="Chunking"
              value={s.chunkMode}
              onChange={(chunkMode) => update({ chunkMode })}
              options={[
                { value: 'balanced', label: 'Balanced' },
                { value: 'sentence', label: 'Sentence' },
              ]}
            />
            <Text style={[type.small, { color: p.textFaint }]}>
              Balanced starts fast with the first sentence, then reads in paragraph-sized parts. Sentence
              mode makes every sentence its own part (finer skipping).
            </Text>
          </Card>

          <Card>
            <SectionTitle>Reading</SectionTitle>
            <SwitchRow
              label="Highlight words"
              description="Karaoke-style highlight of each word as it is spoken."
              value={s.highlight}
              onChange={(highlight) => update({ highlight })}
            />
            <Divider />
            <SwitchRow
              label="Auto-scroll"
              description="Keep the current sentence in view (pauses 4 s after you scroll)."
              value={s.autoScroll}
              onChange={(autoScroll) => update({ autoScroll })}
            />
          </Card>

          <Card>
            <SectionTitle>Appearance</SectionTitle>
            <Segmented
              label="Theme"
              value={s.theme}
              onChange={(theme) => update({ theme })}
              options={[
                { value: 'auto', label: 'System' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
            />
            <Segmented
              label="Motion"
              value={s.motion}
              onChange={(motion) => update({ motion })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'full', label: 'Full' },
                { value: 'reduced', label: 'Reduced' },
              ]}
            />
          </Card>

          <Card>
            <SectionTitle>About</SectionTitle>
            <Text style={[type.small, { color: p.textDim }]}>
              Tamber {Constants.expoConfig?.version ?? ''} for {Platform.OS === 'ios' ? 'iOS' : 'Android'}
            </Text>
            {health.data && (
              <Text style={[type.small, { color: p.textDim }]}>
                Server {health.data.version} · {health.data.engine} on {health.data.device} · {health.data.status}
              </Text>
            )}
            <Button label="Reset all settings" icon="trash" tone="danger" onPress={confirmReset} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl * 2 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  presets: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  preset: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
});
