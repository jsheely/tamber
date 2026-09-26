/**
 * Shared UI primitives in the Tamber visual language (dark #0F0D1C canvas, violet->cyan gradient,
 * themeSpec radii, springy press feedback).
 */
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { memo, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { brandGradient, motion, radius, spacing, type, usePalette, useReduceMotion } from '@/theme';

import { Icon, type IconName } from './Icon';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Pressable with a spring scale-down on press (disabled under reduced motion). */
export function PressableScale({
  children,
  style,
  scaleTo = 0.96,
  ...rest
}: PressableProps & { style?: StyleProp<ViewStyle>; scaleTo?: number; children?: ReactNode }) {
  const reduce = useReduceMotion();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        if (!reduce) scale.set(withSpring(scaleTo, motion.spring));
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withSpring(1, motion.spring));
        rest.onPressOut?.(e);
      }}
      style={[style, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}

export function Screen({
  children,
  edges = ['top', 'left', 'right'],
  style,
}: {
  children: ReactNode;
  edges?: Edge[];
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: p.background }, style]}>
      {children}
    </SafeAreaView>
  );
}

export function ScreenHeader({
  title,
  right,
  onBack,
}: {
  title: string;
  right?: ReactNode;
  onBack?: () => void;
}) {
  const p = usePalette();
  return (
    <View style={styles.header}>
      <IconButton
        icon="back"
        label="Back"
        onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
      />
      <Text style={[type.title, { color: p.text, flex: 1 }]} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {right}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: p.surface, borderColor: p.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const p = usePalette();
  return (
    <Text style={[type.tiny, { color: p.textFaint, textTransform: 'uppercase', marginBottom: spacing.sm }]}>
      {children}
    </Text>
  );
}

export function GradientButton({
  label,
  icon,
  onPress,
  disabled,
  loading,
  size = 'lg',
  haptic = true,
  style,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  size?: 'md' | 'lg' | 'xl';
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const height = size === 'xl' ? 64 : size === 'lg' ? 54 : 44;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={disabled || loading}
      onPress={() => {
        if (haptic) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onPress();
      }}
      style={[{ borderRadius: radius.xl, opacity: disabled ? 0.5 : 1 }, style]}
    >
      <LinearGradient
        colors={brandGradient.colors}
        locations={brandGradient.locations}
        start={brandGradient.start}
        end={brandGradient.end}
        style={[styles.gradientButton, { height, borderRadius: radius.xl }]}
      >
        {loading ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <>
            {icon && <Icon name={icon} color="#FFFFFF" size={size === 'xl' ? 26 : 22} />}
            <Text style={[styles.gradientLabel, size === 'xl' && { fontSize: 19 }]}>{label}</Text>
          </>
        )}
      </LinearGradient>
    </PressableScale>
  );
}

export function Button({
  label,
  icon,
  onPress,
  disabled,
  loading,
  tone = 'default',
  style,
  compact,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'default' | 'danger' | 'primary';
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const p = usePalette();
  const color = tone === 'danger' ? p.danger : tone === 'primary' ? p.onPrimary : p.text;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={[
        styles.button,
        compact && styles.buttonCompact,
        {
          backgroundColor: tone === 'primary' ? p.primary : p.surfaceAlt,
          borderColor: tone === 'danger' ? p.danger : p.border,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={color} size="small" />
      ) : (
        icon && <Icon name={icon} color={color} size={compact ? 18 : 20} />
      )}
      <Text style={[type.small, { color, fontWeight: '700' }]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

export const IconButton = memo(function IconButton({
  icon,
  label,
  onPress,
  size = 44,
  color,
  filled,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  size?: number;
  color?: string;
  filled?: boolean;
  disabled?: boolean;
}) {
  const p = usePalette();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={8}
      disabled={disabled}
      onPress={onPress}
      scaleTo={0.9}
      style={[
        styles.iconButton,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: filled ? p.surfaceAlt : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Icon name={icon} color={color ?? p.text} size={Math.round(size * 0.5)} />
    </PressableScale>
  );
});

export function TextField({
  label,
  hint,
  error,
  style,
  ...props
}: TextInputProps & { label?: string; hint?: string; error?: string | null }) {
  const p = usePalette();
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={[type.small, { color: p.textDim }]}>{label}</Text>}
      <TextInput
        placeholderTextColor={p.textFaint}
        selectionColor={p.link}
        {...props}
        style={[
          styles.input,
          { backgroundColor: p.surfaceAlt, borderColor: error ? p.danger : p.border, color: p.text },
          style,
        ]}
      />
      {error ? (
        <Text style={[type.small, { color: p.danger }]}>{error}</Text>
      ) : hint ? (
        <Text style={[type.small, { color: p.textFaint }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  const p = usePalette();
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={[type.small, { color: p.textDim }]}>{label}</Text>}
      <View
        style={[styles.segmented, { backgroundColor: p.surfaceAlt, borderColor: p.border }]}
        accessibilityRole="radiogroup"
      >
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={o.label}
              onPress={() => {
                void Haptics.selectionAsync();
                onChange(o.value);
              }}
              style={[
                styles.segment,
                selected && { backgroundColor: p.primary },
              ]}
            >
              <Text
                style={[type.small, { color: selected ? p.onPrimary : p.textDim, fontWeight: '700' }]}
                numberOfLines={1}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SwitchRow({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const p = usePalette();
  return (
    <View style={[styles.row, { opacity: disabled ? 0.5 : 1 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { color: p.text }]}>{label}</Text>
        {description && <Text style={[type.small, { color: p.textFaint }]}>{description}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: p.primary, false: p.border }}
        thumbColor="#FFFFFF"
        accessibilityLabel={label}
      />
    </View>
  );
}

export function Stepper({
  label,
  value,
  display,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  value: number;
  display: string;
  onChange: (v: number) => void;
  step: number;
  min: number;
  max: number;
}) {
  const p = usePalette();
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <View style={styles.row} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: display }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(clamp(value + (e.nativeEvent.actionName === 'increment' ? step : -step)))}
    >
      <Text style={[type.body, { color: p.text, flex: 1 }]}>{label}</Text>
      <IconButton icon="minus" label={`Decrease ${label}`} filled size={36} disabled={value <= min} onPress={() => onChange(clamp(value - step))} />
      <Text style={[type.heading, { color: p.text, minWidth: 64, textAlign: 'center' }]}>{display}</Text>
      <IconButton icon="plus" label={`Increase ${label}`} filled size={36} disabled={value >= max} onPress={() => onChange(clamp(value + step))} />
    </View>
  );
}

export function Badge({ label, tone = 'default' }: { label: string; tone?: 'default' | 'accent' | 'warning' }) {
  const p = usePalette();
  const color = tone === 'accent' ? p.accent : tone === 'warning' ? p.warning : p.textDim;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[type.tiny, { color }]}>{label}</Text>
    </View>
  );
}

export function Divider() {
  const p = usePalette();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginVertical: spacing.sm }} />;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  gradientButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  gradientLabel: { color: '#FFFFFF', fontSize: 17, fontWeight: '800', letterSpacing: 0.2 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonCompact: { height: 36, paddingHorizontal: spacing.md },
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48 },
  badge: {
    borderWidth: 1,
    borderRadius: radius.xs,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
});
