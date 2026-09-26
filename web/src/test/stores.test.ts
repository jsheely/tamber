import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '@tamber/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_DEBOUNCE_MS, DRAFT_STORAGE_KEY, useDraft } from '../store/draft';
import { addHistoryEntry, HISTORY_MAX_ENTRIES, titleFromText, type HistoryEntry } from '../store/history';
import { getSettings, useSettings } from '../store/settings';

function persisted(key: string): { state: Record<string, unknown>; version: number } {
  return JSON.parse(window.localStorage.getItem(key) ?? 'null');
}

describe('settings store', () => {
  beforeEach(() => {
    useSettings.getState().reset();
    useSettings.getState().update({ apiBaseUrl: '', apiKey: '' });
  });

  it('persists every update to localStorage["tamber.settings"] (version 1, no actions)', () => {
    useSettings.getState().update({ voice: 'bm_george', speed: 1.25, theme: 'dark', format: 'mp3' });
    const saved = persisted(SETTINGS_STORAGE_KEY);
    expect(saved.version).toBe(1);
    expect(saved.state).toMatchObject({ voice: 'bm_george', speed: 1.25, theme: 'dark', format: 'mp3' });
    expect(saved.state).not.toHaveProperty('update');
    expect(getSettings().voice).toBe('bm_george');
  });

  it('validates through updateSettings(): clamps, normalises, rejects bad values', () => {
    useSettings.getState().update({ speed: 9, apiBaseUrl: 'tts.example.com/v1/', voice: 'not a voice!' });
    const s = getSettings();
    expect(s.speed).toBe(2);
    expect(s.apiBaseUrl).toBe('https://tts.example.com');
    expect(s.voice).toBe(DEFAULT_SETTINGS.voice);
  });

  it('migrates garbage from storage on rehydrate', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        state: { speed: 'fast', voice: 42, theme: 'purple', baseUrl: 'http://localhost:8880/', volume: 7, junk: true },
        version: 0,
      }),
    );
    await useSettings.persist.rehydrate();
    const s = getSettings();
    expect(s.speed).toBe(1);
    expect(s.voice).toBe('af_heart');
    expect(s.theme).toBe('auto');
    expect(s.apiBaseUrl).toBe('http://localhost:8880'); // pre-v1 "baseUrl" upgraded
    expect(s.volume).toBe(1);
    expect(s).not.toHaveProperty('junk');
    expect(typeof useSettings.getState().update).toBe('function');
  });

  it('survives unparseable storage', async () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    await useSettings.persist.rehydrate();
    expect(getSettings().voice).toBe('af_heart');
  });

  it('toggles favourites most-recent-first', () => {
    useSettings.getState().toggleFavorite('af_bella');
    useSettings.getState().toggleFavorite('am_adam');
    expect(getSettings().favoriteVoices).toEqual(['am_adam', 'af_bella']);
    useSettings.getState().toggleFavorite('af_bella');
    expect(getSettings().favoriteVoices).toEqual(['am_adam']);
  });
});

describe('draft store', () => {
  afterEach(() => useDraft.getState().clear());

  it('persists the draft debounced (500 ms)', () => {
    vi.useFakeTimers();
    useDraft.getState().setText('Hello there.');
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 10);
    expect(persisted(DRAFT_STORAGE_KEY).state.text).toBe('Hello there.');
  });

  it('refuses to persist more than about 1 MB', () => {
    vi.useFakeTimers();
    useDraft.getState().setText('x'.repeat(1_100_000));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 10);
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(useDraft.getState().tooLargeToSave).toBe(true);
  });
});

describe('history', () => {
  const entry = (i: number, text = `Text ${i}`): HistoryEntry => ({
    id: String(i),
    title: titleFromText(text),
    text,
    chars: text.length,
    voice: 'af_heart',
    createdAt: i,
  });

  it('keeps newest first, de-duplicates and caps the count', () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 5; i++) list = addHistoryEntry(list, entry(i));
    expect(list).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(list[0]!.text).toBe(`Text ${HISTORY_MAX_ENTRIES + 4}`);
    list = addHistoryEntry(list, entry(99, `Text ${HISTORY_MAX_ENTRIES}`));
    expect(list.filter((e) => e.text === `Text ${HISTORY_MAX_ENTRIES}`)).toHaveLength(1);
    expect(list[0]!.id).toBe('99');
  });

  it('titles come from the first line', () => {
    expect(titleFromText('  Chapter One\n\nIt was a dark night.')).toBe('Chapter One');
    expect(titleFromText('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});
