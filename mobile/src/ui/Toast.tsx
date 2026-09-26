/** Transient, non-blocking notice (e.g. "Couldn't read part 7; skipping it."). */
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePlayback } from '@/store/playback';
import { radius, spacing, type, usePalette, useReduceMotion } from '@/theme';

import { Icon } from './Icon';

const DURATION_MS = 4500;

export function ToastHost() {
  const toast = usePlayback((s) => s.toast);
  const dismiss = usePlayback((s) => s.dismissToast);
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismiss, toast.tone === 'error' ? DURATION_MS * 1.5 : DURATION_MS);
    return () => clearTimeout(t);
  }, [toast, dismiss]);

  if (!toast) return null;
  const color =
    toast.tone === 'error' ? p.danger : toast.tone === 'warning' ? p.warning : toast.tone === 'success' ? p.success : p.accent;
  return (
    <Animated.View
      key={toast.id}
      entering={reduce ? undefined : FadeInDown.springify().damping(18)}
      exiting={reduce ? undefined : FadeOutDown}
      style={[styles.wrap, { bottom: insets.bottom + spacing.xl }]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={dismiss}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[styles.toast, { backgroundColor: p.surface, borderColor: color }]}
      >
        <Icon name={toast.tone === 'success' ? 'check' : 'alert'} color={color} size={18} />
        <Text style={[type.small, { color: p.text, flex: 1 }]}>{toast.message}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    maxWidth: 520,
    width: '100%',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
});
