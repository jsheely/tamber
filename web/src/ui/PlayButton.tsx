import { IconPlayerPauseFilled, IconPlayerPlayFilled, IconRotateClockwise } from '@tabler/icons-react';
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'motion/react';
import { useEffect } from 'react';
import { useReducedMotionPref } from '../lib/motion';
import { onFrame } from '../lib/ticker';
import { playPause } from '../player/actions';
import { getPlayer } from '../player/instance';
import { usePlayerState } from '../player/usePlayer';
import classes from './PlayButton.module.css';

/** The big animated Play/Pause: a gradient orb whose halo follows the output level. */
export function PlayButton({ size = 68 }: { size?: number }) {
  const status = usePlayerState((s) => s.status);
  const reduced = useReducedMotionPref();
  const busy = status === 'playing' || status === 'loading';
  const energy = useMotionValue(0);
  const smooth = useSpring(energy, { stiffness: 300, damping: 24 });
  const haloScale = useTransform(smooth, [0, 1], [1, 1.35]);
  const haloOpacity = useTransform(smooth, [0, 1], [0.35, 0.9]);

  useEffect(() => {
    if (status !== 'playing' || reduced) {
      energy.set(0);
      return;
    }
    const player = getPlayer();
    return onFrame(() => energy.set(Math.min(1, Math.max(0, player.getLevel() * 5))));
  }, [status, reduced, energy]);

  const label = busy ? 'Pause' : status === 'ended' ? 'Play again' : status === 'paused' ? 'Resume' : 'Play';
  const icon = busy ? 'pause' : status === 'ended' ? 'again' : 'play';

  return (
    <div className={classes.wrap} style={{ width: size, height: size }}>
      <motion.div
        className={classes.halo}
        aria-hidden
        style={{ scale: haloScale, opacity: haloOpacity }}
      />
      {status === 'loading' && <div className={classes.spinner} aria-hidden />}
      <motion.button
        type="button"
        className={classes.button}
        aria-label={label}
        title={`${label} (Space)`}
        onClick={playPause}
        whileTap={reduced ? undefined : { scale: 0.9 }}
        whileHover={reduced ? undefined : { scale: 1.04 }}
        transition={{ type: 'spring', stiffness: 500, damping: 26 }}
        data-testid="play-button"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={icon}
            className={classes.icon}
            initial={{ scale: 0.4, opacity: 0, rotate: -30 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.4, opacity: 0, rotate: 30 }}
            transition={{ duration: 0.18 }}
          >
            {icon === 'pause' ? (
              <IconPlayerPauseFilled size={size * 0.4} />
            ) : icon === 'again' ? (
              <IconRotateClockwise size={size * 0.4} stroke={2.4} />
            ) : (
              <IconPlayerPlayFilled size={size * 0.4} style={{ marginLeft: size * 0.04 }} />
            )}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </div>
  );
}
