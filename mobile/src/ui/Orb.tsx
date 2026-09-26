/**
 * The Tamber orb: the brand's speech orb with two sound ripples, animated on the UI thread.
 *
 * - idle/paused: slow breathing, lazy ripples
 * - busy (connecting / buffering): quicker ripples
 * - playing: pulsing core, fast ripples, plus a small "kick" on every spoken word (`beat`)
 *
 * Reduced motion (settings.motion or the OS setting) renders a still orb.
 */
import { brand, themeSpec } from '@tamber/client/brand';
import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';

import { gradientPoints, useReduceMotion } from '@/theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export type OrbState = 'idle' | 'busy' | 'playing';

export interface OrbProps {
  size?: number;
  state: OrbState;
  /** Changes on every spoken word; each change gives the core a small kick. */
  beat?: number;
}

const PERIOD: Record<OrbState, number> = { idle: 3600, busy: 1100, playing: 1500 };
const BREATH: Record<OrbState, number> = { idle: 2400, busy: 900, playing: 650 };
const AMPLITUDE: Record<OrbState, number> = { idle: 0.035, busy: 0.05, playing: 0.07 };

export const Orb = memo(function Orb({ size = 220, state, beat = 0 }: OrbProps) {
  const reduce = useReduceMotion();
  const phase = useSharedValue(0.3);
  const breath = useSharedValue(0.5);
  const amplitude = useSharedValue(AMPLITUDE[state]);
  const kick = useSharedValue(1);

  useEffect(() => {
    cancelAnimation(phase);
    cancelAnimation(breath);
    amplitude.value = withTiming(AMPLITUDE[state], { duration: themeSpec.motion.slow });
    if (reduce) {
      phase.value = 0.3;
      breath.value = 0.5;
      return;
    }
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, { duration: PERIOD[state], easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    breath.value = withRepeat(
      withTiming(1, { duration: BREATH[state], easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [state, reduce, phase, breath, amplitude]);

  useEffect(() => {
    if (reduce || !beat) return;
    kick.value = withSequence(
      withTiming(1.06, { duration: 90, easing: Easing.out(Easing.quad) }),
      withSpring(1, themeSpec.motion.spring),
    );
  }, [beat, reduce, kick]);

  const c = size / 2;
  const core = size * 0.24;

  const ripple1 = useAnimatedProps(() => {
    const p = phase.value;
    return { r: core * (1.2 + 0.85 * p), strokeOpacity: 0.7 * (1 - p) };
  });
  const ripple2 = useAnimatedProps(() => {
    const p = (phase.value + 0.5) % 1;
    return { r: core * (1.2 + 0.85 * p), strokeOpacity: 0.7 * (1 - p) };
  });
  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scale: kick.value * (1 + amplitude.value * (breath.value * 2 - 1)) }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + 0.35 * breath.value,
    transform: [{ scale: 1 + amplitude.value * breath.value }],
  }));

  const { start, end } = gradientPoints();

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityRole="image"
      accessibilityLabel={state === 'playing' ? 'Speaking' : state === 'busy' ? 'Preparing audio' : 'Idle'}
    >
      <Animated.View style={[StyleSheet.absoluteFill, glowStyle]}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="orbGlow" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={brand.deepViolet} stopOpacity={0.55} />
              <Stop offset="0.55" stopColor={brand.deepViolet} stopOpacity={0.16} />
              <Stop offset="1" stopColor={brand.deepViolet} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={c} cy={c} r={c} fill="url(#orbGlow)" />
        </Svg>
      </Animated.View>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="rippleGrad" x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
            <Stop offset="0" stopColor={brand.violet} />
            <Stop offset="1" stopColor={brand.cyan} />
          </LinearGradient>
        </Defs>
        <AnimatedCircle
          cx={c}
          cy={c}
          fill="none"
          stroke="url(#rippleGrad)"
          strokeWidth={size * 0.022}
          animatedProps={ripple1}
        />
        <AnimatedCircle
          cx={c}
          cy={c}
          fill="none"
          stroke="url(#rippleGrad)"
          strokeWidth={size * 0.016}
          animatedProps={ripple2}
        />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, styles.center, coreStyle]}>
        <Svg width={core * 2} height={core * 2}>
          <Defs>
            <LinearGradient id="coreGrad" x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
              <Stop offset="0" stopColor={brand.violet} />
              <Stop offset="1" stopColor={brand.cyan} />
            </LinearGradient>
            <RadialGradient id="coreShine" cx="35%" cy="30%" r="55%">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.55} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={core} cy={core} r={core} fill="url(#coreGrad)" />
          <Circle cx={core} cy={core} r={core} fill="url(#coreShine)" />
        </Svg>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
