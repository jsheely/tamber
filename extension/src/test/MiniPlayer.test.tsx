import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MiniPlayer } from '../entrypoints/mini-player.content/MiniPlayer';
import type { MiniState } from '../lib/messages';

const STATE: MiniState = {
  status: 'playing',
  sessionId: 1,
  title: 'Article',
  sentence: 'This is Tamber.',
  word: [8, 14],
  progress: 0.25,
  tabId: 4,
  error: null,
};

async function deliver(state: MiniState) {
  await act(async () => {
    await fakeBrowser.runtime.onMessage.trigger(
      { target: 'ui', type: 'miniState', state },
      {},
      () => {},
    );
  });
}

describe('mini-player', () => {
  it('renders relayed state with the active word highlighted, and sends controls', async () => {
    const sent: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener(
      (msg: unknown, _s: unknown, respond: (r: unknown) => void) => {
        const m = msg as { target?: string; type?: string };
        if (m.target !== 'background') return;
        sent.push(msg);
        respond(m.type === 'getMiniState' ? null : { ok: true });
        return true;
      },
    );
    const host = document.createElement('div');
    render(<MiniPlayer host={host} />);
    await deliver(STATE);

    expect(screen.getByRole('region', { name: 'Tamber mini-player' })).toBeInTheDocument();
    expect(screen.getByText('Tamber').tagName).toBe('MARK');

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await act(async () => {});
    expect(sent).toContainEqual({ target: 'background', type: 'control', command: 'toggle' });

    fireEvent.click(screen.getByRole('button', { name: 'Close mini-player' }));
    await act(async () => {});
    expect(sent).toContainEqual({ target: 'background', type: 'hideMiniPlayer' });
    expect(screen.queryByRole('region', { name: 'Tamber mini-player' })).toBeNull();
  });

  it('keeps a fixed layout: the status row is always rendered and errors use the sentence box', async () => {
    const host = document.createElement('div');
    const { container } = render(<MiniPlayer host={host} />);
    await deliver(STATE);
    // While playing the row shows the title instead of collapsing (no height change between states).
    expect(container.querySelector('.label')?.textContent).toBe('Article');
    expect(container.querySelector('.sentence')?.textContent).toBe('This is Tamber.');

    await deliver({ ...STATE, status: 'paused' });
    expect(container.querySelector('.label')?.textContent).toBe('Paused');

    await deliver({ ...STATE, status: 'error', error: 'Cannot reach the server.', word: null });
    expect(container.querySelector('.sentence.error')?.textContent).toBe('Cannot reach the server.');
    expect(container.querySelector('.label')?.textContent).toBe('Error');
  });

  it('shows errors and hides itself after reading finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const host = document.createElement('div');
      render(<MiniPlayer host={host} />);
      await deliver({ ...STATE, status: 'error', error: 'Cannot reach the server.', word: null });
      expect(screen.getByText('Cannot reach the server.')).toBeInTheDocument();
      await deliver({ ...STATE, status: 'idle', word: null, progress: 1 });
      expect(screen.getByText('Finished')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.queryByRole('region', { name: 'Tamber mini-player' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
