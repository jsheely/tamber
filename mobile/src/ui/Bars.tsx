/** Small animated equaliser bars (brand gradient colours) shown while speech plays. */
import { brand } from '@tamber/client/brand';
import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useReduceMotion } from '@/theme';

const COLORS = [brand.violet, '#9166F5', brand.midpoint, '#44B4F0', brand.cyan];
const DURATIONS = [420, 560, 380, 500, 460];

function Bar({ index, active, height }: { index: number; active: boolean; height: number }) {
  const reduce = useReduceMotion();
  const level = useSharedValue(0.3);
  useEffect(() => {
    cancelAnimation(level);
    if (!active || reduce) {
      level.value = withTiming(active ? 0.6 : 0.25, { duration: 200 });
      return;
    }
    level.value = withDelay(
      index * 70,
      withRepeat(
        withTiming(1, { duration: DURATIONS[index % DURATIONS.length], easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      ),
    );
  }, [active, reduce, index, level]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: 0.2 + 0.8 * level.value }] }));
  return (
    <Animated.View
      style={[styles.bar, { height, backgroundColor: COLORS[index % COLORS.length] }, style]}
    />
  );
}

export const Bars = memo(function Bars({ active, height = 18 }: { active: boolean; height?: number }) {
  return (
    <View style={[styles.row, { height }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {COLORS.map((_, i) => (
        <Bar key={i} index={i} active={active} height={height} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  bar: { width: 3, borderRadius: 2 },
});
