import { SETTINGS_STORAGE_KEY, type HealthResponse, type VoicesResponse } from '@tamber/client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ChunkedPlayer } from '../player/ChunkedPlayer';
import { setPlayer } from '../player/instance';
import { noopAnchor } from '../player/silentAnchor';
import { Providers } from '../Providers';
import { useDraft } from '../store/draft';
import { useSession } from '../store/session';
import { getSettings, useSettings } from '../store/settings';
import { FakeAudioContext, makeWav } from './fakes';

const HEALTH: HealthResponse = {
  status: 'ok',
  version: '0.1.0',
  api_version: 1,
  engine: 'fake',
  model: 'hexgrad/Kokoro-82M',
  device: 'cpu',
  model_loaded: true,
  auth_required: false,
  sample_rate: 24000,
  formats: ['wav', 'mp3'],
  default_voice: 'af_heart',
  default_format: 'wav',
  languages: [{ code: 'a', tag: 'en-US', name: 'American English', word_timestamps: true }],
  limits: {
    max_text_chars: 100000,
    max_upload_bytes: 26214400,
    max_extract_chars: 500000,
    chunk_target_chars: 280,
    chunk_max_chars: 400,
    rate_limit_per_minute: 60,
    speed_min: 0.25,
    speed_max: 4,
    max_blend_voices: 4,
  },
  features: {
    extract_url: true,
    extract_file: true,
    extract_html: true,
    openai_compat: true,
    voice_blending: true,
    voice_preview: true,
  },
};

const VOICES: VoicesResponse = {
  default_voice: 'af_heart',
  languages: HEALTH.languages,
  voices: [
    {
      id: 'af_heart',
      name: 'Heart',
      language: 'en-US',
      language_name: 'American English',
      lang_code: 'a',
      gender: 'female',
      grade: 'A',
      word_timestamps: true,
      preview_text: 'Hi.',
      tags: ['default', 'recommended'],
    },
    {
      id: 'af_bella',
      name: 'Bella',
      language: 'en-US',
      language_name: 'American English',
      lang_code: 'a',
      gender: 'female',
      grade: 'A-',
      word_timestamps: true,
      preview_text: 'Hi.',
      tags: [],
    },
  ],
};

function mockServer(health: Partial<HealthResponse> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/health')) return Response.json({ ...HEALTH, ...health });
    if (url.endsWith('/v1/voices')) return Response.json(VOICES);
    if (/\/v1\/voices\/[^/]+\/preview/.test(url)) {
      const wav = makeWav(0.5);
      return new Response(new Uint8Array(wav), { headers: { 'Content-Type': 'audio/wav' } });
    }
    return Response.json({ error: { code: 'not_found', message: 'no', type: 'x', param: null, request_id: null } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderApp() {
  return render(
    <Providers>
      <App />
    </Providers>,
  );
}

describe('App', () => {
  beforeEach(() => {
    useSettings.getState().reset();
    useSettings.getState().update({ apiBaseUrl: '', apiKey: '' });
    useSession.setState({ drawer: null, view: 'compose', connection: 'unknown', health: null, voices: null });
    useDraft.getState().clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setPlayer(null);
  });

  it('renders the shell, checks health and loads voices', async () => {
    const fetchMock = mockServer();
    useDraft.getState().setText('Hello from Tamber. This is a test.');
    renderApp();
    expect(screen.getAllByText('Tamber').length).toBeGreaterThan(0);
    expect(screen.getByTestId('composer')).toHaveValue('Hello from Tamber. This is a test.');
    expect(screen.getByTestId('composer-stats')).toHaveTextContent('7 words');
    expect(screen.getByTestId('composer-stats')).toHaveTextContent('2 chunks');
    expect(screen.getByTestId('play-button')).toBeInTheDocument();
    // The composer is the first thing in the scroller on phones; the voice lives in the header
    // button (avatar with the voice's initial) which opens the voice-and-playback sheet.
    expect(screen.getByTestId('header-voice')).toHaveTextContent('H');
    // App-shell scrolling: the composer lives inside the scroller; header and dock stay outside.
    const scroller = document.querySelector('[data-app-scroller]');
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(screen.getByTestId('composer'))).toBe(true);
    expect(scroller!.contains(document.querySelector('[data-app-header]'))).toBe(false);
    expect(scroller!.contains(document.querySelector('[data-player-dock]'))).toBe(false);
    await waitFor(() => expect(useSession.getState().connection).toBe('ok'));
    await waitFor(() => expect(useSession.getState().voices).toHaveLength(2));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining(['/v1/health', '/v1/voices']),
    );
  });

  it('header voice button opens the voice-and-playback sheet on phones', async () => {
    mockServer();
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(useSession.getState().voices).toHaveLength(2));
    await user.click(screen.getByTestId('header-voice'));
    expect(useSession.getState().drawer).toBe('panel');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Voice and playback');
    // Its voice card leads on to the voice picker.
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByTestId('voice-summary'));
    expect(useSession.getState().drawer).toBe('voices');
  });

  it('opens settings with the key focused when the server requires a key', async () => {
    mockServer({ auth_required: true });
    renderApp();
    await waitFor(() => expect(useSession.getState().drawer).toBe('settings'));
    expect(useSession.getState().focusApiKey).toBe(true);
    expect(await screen.findByTestId('settings-key')).toBeInTheDocument();
  });

  it('blend tab previews the mix, saves it under a name and uses it', async () => {
    const fetchMock = mockServer();
    const ctx = new FakeAudioContext();
    setPlayer(new ChunkedPlayer({ createContext: () => ctx.asAudioContext(), anchor: noopAnchor }));
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(useSession.getState().voices).toHaveLength(2));

    await user.click(screen.getAllByTestId('voice-summary')[0]!);
    await user.click(await screen.findByRole('tab', { name: /blend/i }));
    expect(await screen.findByTestId('blend-spec')).toHaveTextContent('af_heart+af_bella');

    // Preview fetches the blend's clip (URL-encoded spec) and plays it through the AudioContext.
    await user.click(screen.getByTestId('blend-preview'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
        '/v1/voices/af_heart%2Baf_bella/preview?format=wav',
      ),
    );
    await waitFor(() => expect(ctx.decodeCalls).toBe(1));

    // Save under a name: it appears in the saved list and in localStorage.
    expect(screen.getByTestId('blend-save')).toBeDisabled();
    await user.type(screen.getByTestId('blend-name'), '  Warm   duet ');
    await user.click(screen.getByTestId('blend-save'));
    expect(getSettings().savedBlends).toEqual([{ name: 'Warm duet', spec: 'af_heart+af_bella' }]);
    expect(screen.getByTestId('saved-blend')).toHaveTextContent('Warm duet');
    expect(screen.getByTestId('saved-blend')).toHaveTextContent('Heart 50% / Bella 50%');
    expect(screen.getByTestId('blend-save')).toHaveTextContent('Saved');
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(saved.state.savedBlends).toEqual([{ name: 'Warm duet', spec: 'af_heart+af_bella' }]);

    // Using the saved blend sets the voice; the summary card shows the saved name.
    await user.click(screen.getByRole('button', { name: /^Warm duet, / }));
    expect(getSettings().voice).toBe('af_heart+af_bella');
    expect(screen.getAllByTestId('voice-summary')[0]).toHaveTextContent('Warm duet');
    expect(screen.getByTestId('blend-use')).toHaveTextContent('This blend is in use');

    // Deleting removes it from settings (the voice itself stays).
    await user.click(screen.getByRole('button', { name: 'Delete Warm duet' }));
    expect(getSettings().savedBlends).toEqual([]);
    expect(getSettings().voice).toBe('af_heart+af_bella');
    expect(screen.queryByTestId('saved-blend')).not.toBeInTheDocument();
  });

  it('settings drawer saves the connection to localStorage', async () => {
    mockServer();
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByTestId('open-settings'));
    const url = await screen.findByTestId('settings-url');
    await user.type(url, 'tts.example.com/');
    await user.type(screen.getByTestId('settings-key'), 'secret-key');
    await user.click(screen.getByTestId('settings-save'));

    expect(getSettings().apiBaseUrl).toBe('https://tts.example.com');
    expect(getSettings().apiKey).toBe('secret-key');
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(saved.state.apiBaseUrl).toBe('https://tts.example.com');
    expect(saved.state.apiKey).toBe('secret-key');
  });
});
