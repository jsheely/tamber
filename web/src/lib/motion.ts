import type { MotionPreference } from '@tamber/client';
import { useReducedMotion } from 'motion/react';
import { useSettings } from '../store/settings';

/** True when animations should be minimal (settings.motion, or the OS preference for "system"). */
export function useReducedMotionPref(): boolean {
  const pref = useSettings((s) => s.motion);
  const system = useReducedMotion() ?? false;
  return pref === 'reduced' || (pref === 'system' && system);
}

/** Same decision outside React. */
export function prefersReducedMotion(pref: MotionPreference): boolean {
  if (pref === 'reduced') return true;
  if (pref === 'full') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** MotionConfig reducedMotion value for a preference. */
export function motionConfigValue(pref: MotionPreference): 'user' | 'always' | 'never' {
  return pref === 'system' ? 'user' : pref === 'reduced' ? 'always' : 'never';
}
