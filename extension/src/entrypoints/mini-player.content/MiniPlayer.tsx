import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { browser } from 'wxt/browser';
import {
  isUiMessage,
  type BackgroundMessage,
  type ControlCommand,
  type MiniState,
} from '../../lib/messages';

export const SHOW_EVENT = 'tamber:mini-player-show';
const POS_KEY = 'tamber.miniPlayerOffset';
/** Hide this long after reading finished. */
const HIDE_AFTER_END_MS = 5000;
/**
 * The sentence box is a fixed number of lines (see --lines in style.css) so the pill never
 * resizes when a new chunk arrives. Chunks longer than the box scroll to keep the active word on
 * this line (0-based) of the box.
 */
const ACTIVE_LINE = 1;

function send(msg: BackgroundMessage) {
  return browser.runtime.sendMessage(msg).catch(() => undefined);
}

const control = (command: ControlCommand) =>
  send({ target: 'background', type: 'control', command });

/** The Tamber glyph (assets/brand/glyph.svg path) filled with the brand gradient. */
function Glyph() {
  return (
    <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden="true">
      <defs>
        <linearGradient id="tamber-mini-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#A855F7" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      <path
        fill="url(#tamber-mini-g)"
        d="M4.2 32A14.1 14.1 0 1 1 18.4 46.1H7.6A3.4 3.4 0 0 1 4.2 42.8ZM36.8 10.8A28.1 28.1 0 0 1 36.8 53.2A4.4 4.4 0 0 1 31.1 46.6A19.4 19.4 0 0 0 31.1 17.4A4.4 4.4 0 0 1 36.8 10.8ZM48.2 3.2A41.4 41.4 0 0 1 48.2 60.8A4 4 0 0 1 42.3 55.2A33.3 33.3 0 0 0 42.3 8.8A4 4 0 0 1 48.2 3.2Z"
      />
    </svg>
  );
}

const Icon = {
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />,
  pause: (
    <>
      <rect x="6" y="4" width="4.5" height="16" rx="1.2" />
      <rect x="13.5" y="4" width="4.5" height="16" rx="1.2" />
    </>
  ),
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2" />,
  close: (
    <path
      d="M6 6l12 12M18 6L6 18"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      fill="none"
    />
  ),
};

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

function statusLabel(s: MiniState): string {
  switch (s.status) {
    case 'loading':
      return 'Preparing audio…';
    case 'queued':
      return 'Waiting for the server…';
    case 'paused':
      return 'Paused';
    case 'needs-gesture':
      return 'Open the Tamber popup and click “Click to start audio”';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Finished';
    case 'playing':
      return s.title ?? 'Reading';
    default:
      return '';
  }
}

export function MiniPlayer({ host }: { host: HTMLElement }) {
  const [state, setState] = useState<MiniState | null>(null);
  const [visible, setVisible] = useState(true);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const boxRef = useRef<HTMLParagraphElement>(null);
  const markRef = useRef<HTMLElement>(null);

  // State relayed by the background (tabs.sendMessage) and the initial snapshot.
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if (!isUiMessage(msg)) return;
      if (msg.type === 'miniState') {
        setState(msg.state);
        if (msg.state.status !== 'idle') setVisible(true);
      } else if (msg.type === 'miniHide') {
        setVisible(false);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    void send({ target: 'background', type: 'getMiniState' }).then((s) => {
      if (s && typeof s === 'object' && 'status' in s) setState(s as MiniState);
    });
    const onShow = () => setVisible(true);
    window.addEventListener(SHOW_EVENT, onShow);
    void browser.storage.local
      .get(POS_KEY)
      .then((r) => {
        const p = r[POS_KEY] as { x: number; y: number } | undefined;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) setOffset(p);
      })
      .catch(() => undefined);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener(SHOW_EVENT, onShow);
    };
  }, []);

  // Auto-hide a few seconds after reading finished.
  const ended = state?.status === 'idle';
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => setVisible(false), HIDE_AFTER_END_MS);
    return () => clearTimeout(t);
  }, [ended, state?.sessionId]);

  useEffect(() => {
    host.style.setProperty('transform', `translate(${offset.x}px, ${offset.y}px)`, 'important');
  }, [host, offset]);

  // Keep the active word visible inside the fixed-height sentence box. A new chunk (no word yet,
  // or a word on the first lines) rests at the top; as reading moves down a long chunk, the box
  // scrolls one line at a time so the active word stays on ACTIVE_LINE.
  const sentence = state?.sentence ?? '';
  const word = state?.word ?? null;
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof box.scrollTo !== 'function') return;
    const mark = markRef.current;
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight) || 0;
    const wanted = mark ? Math.max(0, mark.offsetTop - ACTIVE_LINE * lineHeight) : 0;
    const top = Math.min(wanted, Math.max(0, box.scrollHeight - box.clientHeight));
    if (Math.abs(top - box.scrollTop) < 1) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    box.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
  }, [sentence, word]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('button')) return;
      drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [offset],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const maxX = 16;
    const maxY = 16;
    const minX = -(window.innerWidth - 120);
    const minY = -(window.innerHeight - 60);
    setOffset({
      x: Math.min(maxX, Math.max(minX, d.ox + e.clientX - d.px)),
      y: Math.min(maxY, Math.max(minY, d.oy + e.clientY - d.py)),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setOffset((o) => {
      void browser.storage.local.set({ [POS_KEY]: o }).catch(() => undefined);
      return o;
    });
  }, []);

  if (!visible || !state) return null;

  const playing =
    state.status === 'playing' || state.status === 'loading' || state.status === 'queued';
  const label = statusLabel(state);
  const w = word;
  // The error message takes the sentence box (multi-line); the label row says "Error".
  const body = state.status === 'error' ? (state.error ?? 'Something went wrong') : sentence;

  return (
    <div
      className="pill"
      data-status={state.status}
      role="region"
      aria-label="Tamber mini-player"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="orb" aria-hidden="true">
        <span className="ring" />
        <Glyph />
      </div>
      <div className="text" aria-live="polite">
        <p className={state.status === 'error' ? 'sentence error' : 'sentence'} ref={boxRef}>
          {w && state.status !== 'error' ? (
            <>
              <span className="spoken">{sentence.slice(0, w[0])}</span>
              <mark ref={markRef}>{sentence.slice(w[0], w[1])}</mark>
              {sentence.slice(w[1])}
            </>
          ) : (
            body
          )}
        </p>
        <p className="label">{label || ' '}</p>
      </div>
      <div className="buttons">
        {state.status !== 'error' && (
          <button
            type="button"
            className="primary"
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Alt+Shift+P)' : 'Play (Alt+Shift+P)'}
            onClick={() => void control('toggle')}
          >
            <Svg>{playing ? Icon.pause : Icon.play}</Svg>
          </button>
        )}
        <button
          type="button"
          aria-label="Stop"
          title="Stop (Alt+Shift+S)"
          onClick={() => {
            void control('stop');
            setVisible(false);
          }}
        >
          <Svg>{Icon.stop}</Svg>
        </button>
        <button
          type="button"
          aria-label="Close mini-player"
          title="Close (keeps reading)"
          onClick={() => {
            setVisible(false);
            void send({ target: 'background', type: 'hideMiniPlayer' });
          }}
        >
          <Svg>{Icon.close}</Svg>
        </button>
      </div>
      <div className="progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, state.progress))})` }} />
      </div>
    </div>
  );
}
