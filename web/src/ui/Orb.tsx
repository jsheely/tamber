import { motion, useMotionValue, useSpring, useTransform } from 'motion/react';
import { useEffect } from 'react';
import { useReducedMotionPref } from '../lib/motion';
import { onFrame } from '../lib/ticker';
import { getPlayer } from '../player/instance';
import { usePlayerState } from '../player/usePlayer';
import classes from './Orb.module.css';

export type OrbState = 'idle' | 'loading' | 'playing' | 'paused';

/** Map RMS (speech is roughly 0.02-0.3) to 0..1. */
function levelToEnergy(rms: number): number {
  return Math.min(1, Math.max(0, (rms - 0.004) * 5));
}

/**
 * The brand orb: a violet-to-cyan speech bubble with two expanding ripples. Breathes when idle,
 * shimmers while waiting for the first chunk and pulses with the output RMS while playing.
 * Everything per-frame goes through motion values; React renders only on status changes.
 */
export function Orb({ size = 200, label }: { size?: number; label?: string }) {
  const status = usePlayerState((s) => s.status);
  const reduced = useReducedMotionPref();
  const state: OrbState =
    status === 'playing' ? 'playing' : status === 'loading' ? 'loading' : status === 'paused' ? 'paused' : 'idle';

  const energy = useMotionValue(0);
  const smooth = useSpring(energy, { stiffness: 260, damping: 22, mass: 0.6 });
  const coreScale = useTransform(smooth, [0, 1], [1, 1.16]);
  const glowOpacity = useTransform(smooth, [0, 1], [0.45, 0.95]);
  const glowScale = useTransform(smooth, [0, 1], [1, 1.25]);

  useEffect(() => {
    if (state !== 'playing' || reduced) {
      energy.set(0);
      return;
    }
    const player = getPlayer();
    return onFrame(() => energy.set(levelToEnergy(player.getLevel())));
  }, [state, reduced, energy]);

  return (
    <div
      className={classes.root}
      style={{ width: size, height: size }}
      data-state={state}
      data-reduced={reduced || undefined}
      role="img"
      aria-label={label ?? `Tamber orb, ${state}`}
    >
      <motion.div className={classes.glow} style={{ opacity: glowOpacity, scale: glowScale }} />
      <div className={classes.ripple} data-ring="1" />
      <div className={classes.ripple} data-ring="2" />
      <div className={classes.breath}>
        <motion.div className={classes.core} style={{ scale: coreScale }}>
          <div className={classes.shine} />
          <div className={classes.shimmer} />
        </motion.div>
      </div>
    </div>
  );
}
