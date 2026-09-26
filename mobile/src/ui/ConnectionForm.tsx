/**
 * Server URL + API key + "Test connection", shared by onboarding and settings.
 * Values are local until `onSave` (normalizeBaseUrl + isValidBaseUrl validation).
 */
import { isValidBaseUrl, normalizeBaseUrl } from '@tamber/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useConnectionTest } from '@/api/client';
import { spacing, type, usePalette, useReduceMotion } from '@/theme';

import { Icon } from './Icon';
import { Button, TextField } from './primitives';

export interface ConnectionValues {
  apiBaseUrl: string;
  apiKey: string;
}

export function useConnectionForm(initial: ConnectionValues) {
  const [url, setUrl] = useState(initial.apiBaseUrl);
  const [key, setKey] = useState(initial.apiKey);
  const normalized = normalizeBaseUrl(url);
  const urlError = url.trim() && !isValidBaseUrl(normalized) ? 'Enter an address like https://tts.example.com' : null;
  return {
    url,
    setUrl,
    key,
    setKey,
    normalized,
    urlError,
    valid: !!normalized && !urlError,
    values: { apiBaseUrl: normalized, apiKey: key.trim() } as ConnectionValues,
  };
}

export function ConnectionFields({
  form,
  onSubmit,
}: {
  form: ReturnType<typeof useConnectionForm>;
  onSubmit?: () => void;
}) {
  const p = usePalette();
  const reduce = useReduceMotion();
  const { state, run } = useConnectionTest();
  return (
    <View style={{ gap: spacing.md }}>
      <TextField
        label="Server address"
        value={form.url}
        onChangeText={form.setUrl}
        placeholder="https://tts.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textContentType="URL"
        returnKeyType="next"
        error={form.urlError}
        hint={form.normalized && !form.urlError ? `Tamber will call ${form.normalized}/v1/...` : 'The HTTPS address of your Tamber server.'}
      />
      <TextField
        label="API key (if your server has one)"
        value={form.key}
        onChangeText={form.setKey}
        placeholder="Leave empty if TAMBER_API_KEY is not set"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        textContentType="password"
        returnKeyType="done"
        onSubmitEditing={onSubmit}
        hint="Stored in the device keychain, never synced."
      />
      <Button
        label={state.phase === 'testing' ? 'Testing...' : 'Test connection'}
        icon="plug"
        loading={state.phase === 'testing'}
        disabled={!form.valid}
        onPress={() => void run(form.values)}
      />
      {state.phase === 'done' && (
        <Animated.View
          entering={reduce ? undefined : FadeIn.duration(200)}
          style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}
          accessibilityLiveRegion="polite"
        >
          <Icon name={state.ok ? 'check' : 'alert'} color={state.ok ? p.success : p.danger} size={18} />
          <Text style={[type.small, { color: state.ok ? p.success : p.danger, flex: 1 }]}>{state.summary}</Text>
        </Animated.View>
      )}
    </View>
  );
}
