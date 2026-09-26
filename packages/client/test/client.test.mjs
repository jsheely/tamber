import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TamberClient,
  TamberApiError,
  TamberProtocolError,
  TamberStreamError,
  ttsRequestFromSettings,
  createDefaultSettings,
} from '../dist/index.js';
import { fakeResponse, recordingFetch } from './helpers.mjs';

const start = {
  type: 'start',
  request_id: 'r1',
  sample_rate: 24000,
  format: 'wav',
  voice: 'af_heart',
  lang: 'a',
  speed: 1,
  chunk_mode: 'balanced',
  total_chunks: 2,
  start_chunk: 0,
  word_timestamps: true,
  text_length: 25,
  chunks: [
    { index: 0, char_start: 0, char_end: 12 },
    { index: 1, char_start: 13, char_end: 25 },
  ],
};
const chunk = (index, a, b) => ({
  type: 'chunk',
  index,
  text: 'x',
  char_start: a,
  char_end: b,
  audio: 'UklGRg==',
  format: 'wav',
  sample_rate: 24000,
  duration: 1.5,
  words: [],
});
const done = (n) => ({
  type: 'done',
  total_duration: 1.5 * n,
  chunks_sent: n,
  chunks_failed: 0,
  elapsed_ms: 10,
});
const lines = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('synthesize streams typed events and sends auth + body', async () => {
  const f = recordingFetch(() =>
    fakeResponse({
      headers: { 'content-type': 'application/x-ndjson' },
      body: lines(
        start,
        { type: 'ping' },
        { type: 'mystery' },
        chunk(0, 0, 12),
        chunk(1, 13, 25),
        done(2),
      ),
    }),
  );
  const client = new TamberClient({
    baseUrl: 'https://tts.example.com/v1/',
    apiKey: ' k1 ',
    fetch: f,
  });
  const types = [];
  for await (const ev of client.synthesize({ text: 'Hello world. Hello again.' }))
    types.push(ev.type);
  assert.deepEqual(types, ['start', 'ping', 'chunk', 'chunk', 'done']);
  assert.equal(f.calls[0].url, 'https://tts.example.com/v1/tts');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer k1');
  assert.equal(JSON.parse(f.calls[0].init.body).stream, true);
});

test('synthesize falls back to text() when the runtime cannot stream bodies', async () => {
  const f = recordingFetch(() =>
    fakeResponse({ stream: false, body: lines(start, chunk(0, 0, 12), done(1)) }),
  );
  const client = new TamberClient({ baseUrl: 'http://localhost:8880', fetch: f });
  const types = [];
  for await (const ev of client.synthesize({ text: 'Hi.' })) types.push(ev.type);
  assert.deepEqual(types, ['start', 'chunk', 'done']);
});

test('non-fatal errors are yielded; fatal errors throw', async () => {
  const nonFatal = {
    type: 'error',
    code: 'synthesis_failed',
    message: 'chunk 0 failed',
    index: 0,
    fatal: false,
  };
  const fatal = {
    type: 'error',
    code: 'internal_error',
    message: 'boom',
    index: null,
    fatal: true,
  };
  const f = recordingFetch(() => fakeResponse({ body: lines(start, nonFatal, fatal) }));
  const client = new TamberClient({ baseUrl: 'http://x', fetch: f });
  const seen = [];
  await assert.rejects(async () => {
    for await (const ev of client.synthesize({ text: 'a' })) seen.push(ev.type);
  }, TamberStreamError);
  assert.deepEqual(seen, ['start', 'error']);
});

test('stream without done is a protocol error', async () => {
  const f = recordingFetch(() => fakeResponse({ body: lines(start, chunk(0, 0, 12)) }));
  const client = new TamberClient({ baseUrl: 'http://x', fetch: f });
  await assert.rejects(async () => {
    for await (const ev of client.synthesize({ text: 'a' })) void ev;
  }, TamberProtocolError);
});

test('HTTP errors become TamberApiError with envelope fields', async () => {
  const body = JSON.stringify({
    error: {
      code: 'unauthorized',
      message: 'Missing or invalid API key',
      type: 'authentication_error',
      param: null,
      request_id: 'req-9',
    },
  });
  const f = recordingFetch(() =>
    fakeResponse({ status: 401, body, headers: { 'retry-after': '3' } }),
  );
  const client = new TamberClient({ baseUrl: 'http://x', fetch: f });
  await assert.rejects(
    client.getVoices(),
    (e) =>
      e instanceof TamberApiError &&
      e.isAuthError &&
      e.code === 'unauthorized' &&
      e.requestId === 'req-9' &&
      e.retryAfter === 3,
  );
});

test('testConnection reports auth failure without throwing', async () => {
  const health = { status: 'ok', api_version: 1, auth_required: true };
  const f = recordingFetch((url) =>
    url.endsWith('/health')
      ? fakeResponse({ body: JSON.stringify(health) })
      : fakeResponse({ status: 401, body: '{}' }),
  );
  const r = await new TamberClient({ baseUrl: 'http://x', fetch: f }).testConnection();
  assert.equal(r.ok, false);
  assert.equal(r.authOk, false);
  assert.equal(r.compatible, true);
});

test('ttsRequestFromSettings maps the settings model', () => {
  const s = { ...createDefaultSettings(), voice: 'bf_emma', speed: 1.25, chunkMode: 'sentence' };
  assert.deepEqual(ttsRequestFromSettings(s, 'Hi.'), {
    text: 'Hi.',
    voice: 'bf_emma',
    speed: 1.25,
    format: 'wav',
    lang: null,
    chunk_mode: 'sentence',
    stream: true,
  });
});

test(
  'aborting the caller signal mid-stream aborts the fetch immediately',
  { timeout: 2000 },
  async () => {
    // A body that yields the start line, then hangs until the fetch signal aborts.
    let fetchSignal;
    const fetch = async (_url, init) => {
      fetchSignal = init.signal;
      const line = new TextEncoder().encode(JSON.stringify(start) + '\n');
      let sent = false;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              read() {
                if (!sent) {
                  sent = true;
                  return Promise.resolve({ done: false, value: line });
                }
                return new Promise((_resolve, reject) => {
                  const fail = () =>
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                  if (fetchSignal.aborted) fail();
                  else fetchSignal.addEventListener('abort', fail, { once: true });
                });
              },
              async cancel() {},
              releaseLock() {},
            };
          },
        },
      };
    };
    const client = new TamberClient({ baseUrl: 'http://x', fetch });
    const ctrl = new AbortController();
    const events = [];
    const run = (async () => {
      for await (const ev of client.synthesize({ text: 'Hi.' }, { signal: ctrl.signal })) {
        events.push(ev.type);
        if (ev.type === 'start') ctrl.abort();
      }
    })();
    await assert.rejects(run, (err) => err.name === 'AbortError');
    assert.deepEqual(events, ['start']);
    assert.equal(fetchSignal.aborted, true);
  },
);
