/**
 * First run: explain self-hosting, collect the server URL and optional API key, test, save.
 * A share that arrived before setup (pendingShare) starts playing right after Continue.
 */
import { router } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { startSharedPlayback, usePendingShare } from '@/share/useShareIntentRouting';
import { useSettings } from '@/store/settings';
import { spacing, type, usePalette, useReduceMotion } from '@/theme';
import { ConnectionFields, useConnectionForm } from '@/ui/ConnectionForm';
import { Glyph } from '@/ui/Glyph';
import { Orb } from '@/ui/Orb';
import { Card, GradientButton, Screen } from '@/ui/primitives';

export default function Onboarding() {
  const p = usePalette();
  const reduce = useReduceMotion();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const setApiKey = useSettings((s) => s.setApiKey);
  const pending = usePendingShare((s) => s.pending);
  const form = useConnectionForm({ apiBaseUrl: settings.apiBaseUrl, apiKey: settings.apiKey });

  const onContinue = async () => {
    if (!form.valid) return;
    update({ apiBaseUrl: form.values.apiBaseUrl });
    await setApiKey(form.values.apiKey);
    const share = usePendingShare.getState().pending;
    usePendingShare.getState().set(null);
    router.replace('/');
    if (share) startSharedPlayback(share);
  };

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Animated.View entering={reduce ? undefined : FadeInDown.duration(500)} style={styles.hero}>
            <Orb size={200} state="idle" />
            <View style={styles.brandRow}>
              <Glyph size={32} />
              <Text style={[type.display, { color: p.text }]}>Tamber</Text>
            </View>
            <Text style={[type.body, { color: p.textDim, textAlign: 'center' }]}>
              Listen to anything, and follow along word by word.
            </Text>
          </Animated.View>

          <Card>
            <Text style={[type.heading, { color: p.text }]}>Connect your server</Text>
            <Text style={[type.small, { color: p.textDim }]}>
              Tamber is self-hosted: the voice runs on your own Tamber server (one Docker container with
              the Kokoro model), and this app streams speech from it. Nothing is sent anywhere else. Enter
              the address you reach it at, for example the HTTPS URL of your reverse proxy, plus the API
              key if you set TAMBER_API_KEY.
            </Text>
            <ConnectionFields form={form} onSubmit={() => void onContinue()} />
          </Card>

          {pending && (
            <Text style={[type.small, { color: p.link, textAlign: 'center' }]}>
              Your shared {pending.kind === 'file' ? 'document' : pending.kind === 'url' ? 'page' : 'text'} will start
              playing as soon as you continue.
            </Text>
          )}

          <GradientButton label="Continue" icon="chevronRight" disabled={!form.valid} onPress={() => void onContinue()} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xl, gap: spacing.xl, flexGrow: 1, justifyContent: 'center' },
  hero: { alignItems: 'center', gap: spacing.md },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
