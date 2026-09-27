import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateSettings,
  DEFAULT_SETTINGS,
  normalizeBaseUrl,
  updateSettings,
  splitSecrets,
  buildTimeline,
  TimelineBuilder,
  wordIndexAt,
  chunkPositionAt,
  wordIndexAtChar,
  timeForCharOffset,
  parseVoiceSpec,
  canonicalVoiceSpec,
  normalizedWeights,
  concatWav,
  wavHeader,
  parseWav,
  langOfVoiceId,
  saveBlend,
  removeSavedBlend,
  findSavedBlend,
  MAX_SAVED_BLENDS,
} from '../dist/index.js';

test('migrateSettings returns defaults for garbage and validates fields', () => {
  assert.deepEqual(migrateSettings(null), {
    ...DEFAULT_SETTINGS,
    favoriteVoices: [],
    savedBlends: [],
  });
  const m = migrateSettings({
    version: 0,
    baseUrl: 'tts.example.com/v1/',
    theme: 'system',
    speed: 9,
    format: 'ogg',
    voice: 'nope!',
    lang: 'x',
    favoriteVoices: ['af_heart', 'af_heart', 'bad voice'],
    savedBlends: [
      { name: '  Warm  duet ', spec: 'af_heart(2) + af_bella(1)' },
      { name: 'warm duet', spec: 'af_sky+af_bella' }, // duplicate name (case-insensitive)
      { name: 'Solo', spec: 'af_heart' }, // not a blend
      { name: '', spec: 'af_heart+af_sky' }, // no name
      { name: 'Broken', spec: 'af_heart+' },
      'garbage',
    ],
    extra: 1,
  });
  assert.equal(m.apiBaseUrl, 'https://tts.example.com');
  assert.equal(m.theme, 'auto');
  assert.equal(m.speed, 2);
  assert.equal(m.format, 'wav');
  assert.equal(m.voice, 'af_heart');
  assert.equal(m.lang, null);
  assert.deepEqual(m.favoriteVoices, ['af_heart']);
  assert.deepEqual(m.savedBlends, [{ name: 'Warm duet', spec: 'af_heart(2)+af_bella(1)' }]);
  assert.equal('extra' in m, false);
  assert.equal(updateSettings(m, { voice: 'af_bella(2)+af_sky' }).voice, 'af_bella(2)+af_sky');
  assert.deepEqual(Object.keys(splitSecrets(m).secrets), ['apiKey']);
});

test('saved blends: save replaces by name or spec, remove, find', () => {
  let list = saveBlend([], { name: 'Duet', spec: 'af_heart(2)+af_bella(1)' });
  assert.deepEqual(list, [{ name: 'Duet', spec: 'af_heart(2)+af_bella(1)' }]);
  // Same spec under a new name replaces the old entry.
  list = saveBlend(list, { name: 'Warm', spec: 'af_heart(2)+af_bella(1)' });
  assert.deepEqual(list, [{ name: 'Warm', spec: 'af_heart(2)+af_bella(1)' }]);
  // Same name with a new spec updates it; a new blend goes first.
  list = saveBlend(list, { name: 'warm', spec: 'af_sky+af_bella' });
  list = saveBlend(list, { name: 'Trio', spec: 'af_heart+af_sky+af_bella' });
  assert.deepEqual(list, [
    { name: 'Trio', spec: 'af_heart+af_sky+af_bella' },
    { name: 'warm', spec: 'af_sky+af_bella' },
  ]);
  assert.equal(findSavedBlend(list, 'af_bella(1)+af_sky(1)'), undefined); // order matters
  assert.deepEqual(findSavedBlend(list, 'af_sky(1)+af_bella(1)'), {
    name: 'warm',
    spec: 'af_sky+af_bella',
  });
  assert.equal(findSavedBlend(list, 'af_heart'), undefined);
  // Single voices and empty names are ignored; invalid specs throw.
  assert.deepEqual(saveBlend(list, { name: 'Solo', spec: 'af_heart' }), list);
  assert.deepEqual(saveBlend(list, { name: '   ', spec: 'af_heart+af_sky' }), list);
  assert.throws(() => saveBlend(list, { name: 'Bad', spec: 'af_heart+' }));
  assert.deepEqual(removeSavedBlend(list, 'WARM'), [list[0]]);
  let many = [];
  for (let i = 0; i < MAX_SAVED_BLENDS + 3; i++) {
    many = saveBlend(many, { name: 'Blend ' + i, spec: 'af_heart(' + (i + 1) + ')+af_sky' });
  }
  assert.equal(many.length, MAX_SAVED_BLENDS);
  assert.equal(migrateSettings({ savedBlends: many }).savedBlends.length, MAX_SAVED_BLENDS);
});

test('normalizeBaseUrl', () => {
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(' https://tts.example.com/ '), 'https://tts.example.com');
  assert.equal(normalizeBaseUrl('localhost:8880'), 'http://localhost:8880');
  assert.equal(normalizeBaseUrl('https://x.io/tamber/v1?y=1'), 'https://x.io/tamber');
});

test('voice spec grammar', () => {
  assert.deepEqual(parseVoiceSpec(' af_bella (2) + af_sky '), [
    { id: 'af_bella', weight: 2 },
    { id: 'af_sky', weight: 1 },
  ]);
  assert.equal(canonicalVoiceSpec('af_bella+af_sky'), 'af_bella+af_sky');
  assert.equal(canonicalVoiceSpec('af_bella(2)+af_sky(1)'), 'af_bella(2)+af_sky(1)');
  assert.equal(canonicalVoiceSpec('af_bella+af_bella'), 'af_bella');
  assert.throws(() => parseVoiceSpec('af_bella++af_sky'));
  assert.throws(() => parseVoiceSpec('af_aa+af_bb+af_cc+af_dd+af_ee'));
  assert.throws(() => parseVoiceSpec('af_bella(0)'));
  assert.deepEqual(
    normalizedWeights(parseVoiceSpec('af_bella(3)+af_sky')).map((c) => c.weight),
    [0.75, 0.25],
  );
  assert.equal(langOfVoiceId('bm_george'), 'b');
});

test('timeline maps chunk-relative words to absolute time', () => {
  const chunks = [
    {
      index: 0,
      char_start: 0,
      char_end: 11,
      duration: 1.0,
      words: [
        { text: 'Hello', start: 0.1, end: 0.4, char_start: 0, char_end: 5 },
        { text: 'world', start: 0.5, end: 0.9, char_start: 6, char_end: 11 },
      ],
    },
    {
      index: 1,
      char_start: 12,
      char_end: 17,
      duration: 2.0,
      words: [{ text: 'Again', start: 0.2, end: 5.0, char_start: 12, char_end: 17 }],
    },
  ];
  const tl = buildTimeline(chunks, { durations: new Map([[0, 1.2]]) });
  assert.equal(tl.duration, 3.2);
  assert.equal(tl.words[2].start, 1.4);
  assert.equal(tl.words[2].end, 3.2); // clamped to its chunk's end
  assert.equal(wordIndexAt(tl, 0.05), -1);
  assert.equal(wordIndexAt(tl, 0.2), 0);
  assert.equal(wordIndexAt(tl, 0.45), 0); // held through the gap between words
  assert.equal(wordIndexAt(tl, 0.45, { holdThroughGaps: false }), -1);
  assert.equal(wordIndexAt(tl, 1.1), 1); // trailing pause of chunk 0: last word held
  assert.equal(wordIndexAt(tl, 1.3), -1); // chunk 1 started but its first word has not: no hold across chunks
  assert.equal(chunkPositionAt(tl, 1.3), 1);
  assert.equal(wordIndexAtChar(tl, 7), 1);
  assert.equal(timeForCharOffset(tl, 13), 1.4);
  const b = new TimelineBuilder(10);
  b.add(chunks[0]);
  assert.equal(b.timeline.words[0].start, 10.1);
});

test('concatWav joins PCM payloads', () => {
  const a = new Uint8Array([...wavHeader(4), 1, 2, 3, 4]);
  const b = new Uint8Array([...wavHeader(2), 5, 6]);
  const joined = concatWav([a, b]);
  const info = parseWav(joined);
  assert.equal(info.dataLength, 6);
  assert.deepEqual([...joined.subarray(44)], [1, 2, 3, 4, 5, 6]);
});
