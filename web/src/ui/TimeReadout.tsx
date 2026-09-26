import { Text } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { formatTime } from '../lib/format';
import { onFrame } from '../lib/ticker';
import { getPlayer } from '../player/instance';
import { usePlayerSnapshot } from '../player/usePlayer';

/** "0:42 / ~3:10": elapsed from the audio clock (per frame, via ref) over the known duration. */
export function TimeReadout() {
  const snap = usePlayerSnapshot();
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const live = snap.status === 'playing' || snap.status === 'loading';
  const total = snap.complete ? snap.knownDuration : snap.estimatedDuration;

  useEffect(() => {
    const el = elapsedRef.current;
    if (!el) return;
    const player = getPlayer();
    const paint = () => {
      const f = player.getFrame();
      const text = f.activeChunk >= 0 ? formatTime(f.elapsed) : snap.status === 'ended' ? formatTime(total) : '0:00';
      if (el.textContent !== text) el.textContent = text;
    };
    paint();
    if (!live) return;
    return onFrame(paint);
  }, [live, snap.status, snap.version, total]);

  return (
    <Text
      size="xs"
      ff="monospace"
      c="dimmed"
      style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', minWidth: 88 }}
      aria-label="Elapsed and total time"
    >
      <span ref={elapsedRef}>0:00</span>
      {' / '}
      {snap.hasSession ? `${snap.complete ? '' : '~'}${formatTime(total)}` : '0:00'}
    </Text>
  );
}
