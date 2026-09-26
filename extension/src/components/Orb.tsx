/**
 * The Tamber orb: the glyph on the brand gradient, with sound ripples while speaking, a slow
 * breathing glow while loading and a still, dimmed look when paused. Reduced motion shows it static.
 */
import { motion, useReducedMotion } from 'motion/react';
import type { PlayerStatus } from '../lib/messages';

export function Orb({ status, size = 44 }: { status: PlayerStatus; size?: number }) {
  const reduce = useReducedMotion();
  const speaking = status === 'playing';
  const busy = status === 'loading' || status === 'queued';
  const dim = status === 'paused' || status === 'idle' || status === 'error';
  const ripple = (delay: number) => (
    <motion.span
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: '50%',
        border: '2px solid var(--tamber-cyan)',
      }}
      initial={{ scale: 1, opacity: 0.55 }}
      animate={{ scale: 1.75, opacity: 0 }}
      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut', delay }}
    />
  );
  return (
    <span
      role="img"
      aria-label={`Tamber ${status}`}
      data-status={status}
      style={{
        position: 'relative',
        display: 'inline-flex',
        width: size,
        height: size,
        flex: 'none',
      }}
    >
      {speaking && !reduce && (
        <>
          {ripple(0)}
          {ripple(0.8)}
        </>
      )}
      <motion.span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #1A1631 0%, #07070D 100%)',
          boxShadow: dim
            ? '0 0 0 1px rgba(168,85,247,0.25)'
            : '0 0 18px rgba(124,58,237,0.55), 0 0 0 1px rgba(168,85,247,0.45)',
        }}
        animate={
          reduce
            ? undefined
            : busy
              ? { scale: [1, 1.06, 1], opacity: [0.8, 1, 0.8] }
              : speaking
                ? { scale: [1, 1.04, 1] }
                : { scale: 1, opacity: dim ? 0.8 : 1 }
        }
        transition={
          busy || speaking
            ? { duration: busy ? 1.4 : 0.9, repeat: Infinity, ease: 'easeInOut' }
            : { duration: 0.2 }
        }
      >
        <span className="tamber-mark" style={{ width: size * 0.56 }} />
      </motion.span>
    </span>
  );
}
