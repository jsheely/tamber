import { brand } from '@tamber/client/brand';
import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { onFrame } from '../lib/ticker';
import type { ChunkState } from '../player/ChunkedPlayer';
import { getPlayer } from '../player/instance';
import { usePlayerSnapshot } from '../player/usePlayer';

interface Layout {
  x: Float64Array;
  w: Float64Array;
}

function readVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * One segment per chunk (width proportional to its text length): planned / received / played /
 * failed, plus the playhead inside the active chunk, redrawn per frame on a canvas. Tap to seek.
 */
export function ProgressSegments({
  onSeekChunk,
  height = 8,
}: {
  onSeekChunk: (index: number) => void;
  height?: number;
}) {
  const snap = usePlayerSnapshot();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { plan, chunkStates, activeChunk, totalChunks, status } = snap;

  const weights = useMemo(() => {
    const total = plan.reduce((sum, c) => sum + Math.max(1, c.char_end - c.char_start), 0) || 1;
    return plan.map((c) => Math.max(1, c.char_end - c.char_start) / total);
  }, [plan]);

  const layoutRef = useRef<Layout | null>(null);
  const statesRef = useRef<readonly ChunkState[]>(chunkStates);
  const activeRef = useRef(activeChunk);

  useEffect(() => {
    statesRef.current = chunkStates;
    activeRef.current = activeChunk;
  }, [chunkStates, activeChunk]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const player = getPlayer();

    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const n = weights.length;
      const planned = readVar(canvas, '--tamber-segment-planned', 'rgba(128,128,128,0.2)');
      const received = readVar(canvas, '--tamber-segment-received', 'rgba(168,85,247,0.4)');
      const failed = readVar(canvas, '--tamber-segment-failed', 'rgba(250,82,82,0.6)');
      const played = g.createLinearGradient(0, 0, w, 0);
      played.addColorStop(0, brand.violet);
      played.addColorStop(1, brand.cyan);
      if (n === 0) {
        g.fillStyle = planned;
        g.beginPath();
        g.roundRect?.(0, 0, w, h, h / 2);
        g.fill();
        return;
      }
      const gap = w / n > 7 ? 2 : 0;
      const xs = new Float64Array(n);
      const ws = new Float64Array(n);
      let x = 0;
      for (let i = 0; i < n; i++) {
        const sw = weights[i]! * (w - gap * (n - 1));
        xs[i] = x;
        ws[i] = sw;
        x += sw + gap;
      }
      layoutRef.current = { x: xs, w: ws };
      const states = statesRef.current;
      const active = activeRef.current;
      const frame = player.getFrame();
      const fraction =
        frame.activeDuration > 0 ? Math.min(1, Math.max(0, frame.offset / frame.activeDuration)) : 0;
      const r = Math.min(h / 2, 3);
      for (let i = 0; i < n; i++) {
        const st = states[i] ?? 'planned';
        const sx = xs[i]!;
        const sw = Math.max(0.5, ws[i]!);
        g.fillStyle = st === 'failed' ? failed : st === 'played' ? played : st === 'received' ? received : planned;
        g.beginPath();
        if (gap && typeof g.roundRect === 'function') g.roundRect(sx, 0, sw, h, r);
        else g.rect(sx, 0, sw, h);
        g.fill();
        if (i === active && st !== 'failed') {
          g.fillStyle = played;
          g.beginPath();
          const pw = Math.max(r * 2, sw * fraction);
          if (typeof g.roundRect === 'function') g.roundRect(sx, 0, pw, h, r);
          else g.rect(sx, 0, pw, h);
          g.fill();
        }
      }
    };

    draw();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    ro?.observe(canvas);
    const live = status === 'playing' || status === 'loading';
    const stop = live ? onFrame(draw) : null;
    return () => {
      ro?.disconnect();
      stop?.();
    };
  }, [weights, status, chunkStates, activeChunk]);

  const indexAtX = (clientX: number): number => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout || layout.x.length === 0) return -1;
    const px = clientX - canvas.getBoundingClientRect().left;
    for (let i = layout.x.length - 1; i >= 0; i--) if (px >= layout.x[i]!) return i;
    return 0;
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const i = indexAtX(e.clientX);
    if (i >= 0) onSeekChunk(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!totalChunks) return;
    const cur = Math.max(0, activeChunk);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      onSeekChunk(Math.min(totalChunks - 1, cur + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      onSeekChunk(Math.max(0, cur - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSeekChunk(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSeekChunk(totalChunks - 1);
    }
  };

  const position = activeChunk >= 0 ? activeChunk + 1 : 0;
  return (
    <div
      role="slider"
      tabIndex={totalChunks ? 0 : -1}
      aria-label="Position (sentences)"
      aria-valuemin={0}
      aria-valuemax={totalChunks}
      aria-valuenow={position}
      aria-valuetext={totalChunks ? `Sentence ${position} of ${totalChunks}` : 'Nothing playing'}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      style={{ padding: '10px 0', cursor: totalChunks ? 'pointer' : 'default', touchAction: 'manipulation' }}
      data-testid="progress-segments"
    >
      <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block' }} />
    </div>
  );
}
