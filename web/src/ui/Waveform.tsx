import { brand } from '@tamber/client/brand';
import { useEffect, useRef } from 'react';
import { useReducedMotionPref } from '../lib/motion';
import { onFrame } from '../lib/ticker';
import { getPlayer } from '../player/instance';
import { usePlayerState } from '../player/usePlayer';

/**
 * Compact live bars from the output AnalyserNode (speech band). Drawn on a canvas from the shared
 * rAF loop only while playing; a calm resting line otherwise.
 */
export function Waveform({ bars = 28, height = 28 }: { bars?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const status = usePlayerState((s) => s.status);
  const reduced = useReducedMotionPref();
  const playing = status === 'playing';

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const levels = new Float32Array(bars);
    let freq: Uint8Array<ArrayBuffer> | null = null;

    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const gap = 3;
      const bw = Math.max(2, (w - gap * (bars - 1)) / bars);
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, brand.violet);
      grad.addColorStop(1, brand.cyan);
      g.fillStyle = grad;
      for (let i = 0; i < bars; i++) {
        const v = levels[i]!;
        const bh = Math.max(3, v * h);
        const x = i * (bw + gap);
        const y = (h - bh) / 2;
        const r = Math.min(bw / 2, bh / 2);
        g.globalAlpha = 0.45 + 0.55 * v;
        g.beginPath();
        if (typeof g.roundRect === 'function') g.roundRect(x, y, bw, bh, r);
        else g.rect(x, y, bw, bh);
        g.fill();
      }
      g.globalAlpha = 1;
    };

    if (!playing || reduced) {
      levels.fill(0);
      draw();
      if (!playing) return;
    }

    const player = getPlayer();
    return onFrame(() => {
      const analyser = player.analyserNode;
      if (!analyser) return;
      if (!freq || freq.length !== analyser.frequencyBinCount) {
        freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      }
      analyser.getByteFrequencyData(freq);
      const sampleRate = player.context?.sampleRate ?? 48000;
      const hzPerBin = sampleRate / 2 / freq.length;
      // Log-spaced bands from 90 Hz to 5 kHz (where speech lives).
      const lo = Math.log(90);
      const hi = Math.log(5000);
      for (let i = 0; i < bars; i++) {
        const f0 = Math.exp(lo + ((hi - lo) * i) / bars);
        const f1 = Math.exp(lo + ((hi - lo) * (i + 1)) / bars);
        const b0 = Math.max(1, Math.floor(f0 / hzPerBin));
        const b1 = Math.max(b0 + 1, Math.ceil(f1 / hzPerBin));
        let peak = 0;
        for (let b = b0; b < b1 && b < freq.length; b++) peak = Math.max(peak, freq[b]!);
        const target = reduced ? 0 : Math.pow(peak / 255, 1.6);
        const cur = levels[i]!;
        levels[i] = cur + (target - cur) * (target > cur ? 0.55 : 0.18);
      }
      draw();
    });
  }, [playing, reduced, bars]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ width: '100%', height, display: 'block' }}
      data-testid="waveform"
    />
  );
}
