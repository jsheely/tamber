import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NdjsonLineSplitter,
  readNdjson,
  Utf8StreamDecoder,
  toTtsEvent,
  base64ToBytes,
  bytesToBase64,
} from '../dist/index.js';
import { streamOf } from './helpers.mjs';

test('line splitter handles partial lines, CRLF and blank lines', () => {
  const s = new NdjsonLineSplitter();
  assert.deepEqual(s.push('{"a":1}\r\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(':2}\n\n'), ['{"b":2}']);
  assert.deepEqual(s.push('{"c":3}'), []);
  assert.deepEqual(s.flush(), ['{"c":3}']);
});

test('readNdjson survives multi-byte UTF-8 split across reads', async () => {
  const text = '{"t":"héllo — 😀"}\n{"t":"日本"}';
  const bytes = new TextEncoder().encode(text);
  for (const size of [1, 2, 3, 5, 64]) {
    const out = [];
    for await (const v of readNdjson(streamOf(bytes, size))) out.push(v);
    assert.deepEqual(out, [{ t: 'héllo — 😀' }, { t: '日本' }], `size ${size}`);
  }
});

test('readNdjson cancels the reader when the consumer stops early', async () => {
  const stream = streamOf(new TextEncoder().encode('{"a":1}\n{"a":2}\n{"a":3}\n'), 4);
  for await (const v of readNdjson(stream)) {
    assert.deepEqual(v, { a: 1 });
    break;
  }
  assert.equal(stream.cancelled(), true);
});

test('pure UTF-8 decoder equals TextDecoder byte-by-byte', () => {
  const text = 'aé—😀z日';
  const bytes = new TextEncoder().encode(text);
  const d = new Utf8StreamDecoder();
  let s = '';
  for (const b of bytes) s += d.decode(Uint8Array.of(b), { stream: true });
  s += d.decode();
  assert.equal(s, text);
  assert.equal(new Utf8StreamDecoder().decode(Uint8Array.of(0xff, 0x41)), '�A');
  assert.equal(new Utf8StreamDecoder().decode(Uint8Array.of(0xe2, 0x80)), '�');
});

test('toTtsEvent validates known types and ignores unknown ones', () => {
  assert.equal(toTtsEvent({ type: 'future_thing', x: 1 }), null);
  assert.throws(() => toTtsEvent({ type: 'chunk', index: 0 }));
  const err = toTtsEvent({ type: 'error', message: 'x' });
  assert.equal(err.fatal, true);
  assert.equal(err.index, null);
});

test('base64 round trip matches Node Buffer', () => {
  for (let n = 0; n < 20; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
    const b64 = bytesToBase64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString('base64'));
    assert.deepEqual(base64ToBytes(b64), bytes);
  }
});
