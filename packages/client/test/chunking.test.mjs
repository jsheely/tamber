import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planChunks, chunkIndexForOffset } from '../dist/index.js';

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/chunking.json', import.meta.url), 'utf8'),
);

test('planChunks matches every conformance fixture', () => {
  for (const c of fixtures.cases) {
    const plan = planChunks(c.text, c.options);
    assert.deepEqual(
      plan.map((p) => [p.char_start, p.char_end]),
      c.expected,
      c.name,
    );
    plan.forEach((p, i) => assert.equal(p.index, i));
  }
});

test('chunks are trimmed, ordered, non-overlapping and within maxChars', () => {
  for (const c of fixtures.cases) {
    let prev = -1;
    for (const p of planChunks(c.text, c.options)) {
      const slice = c.text.slice(p.char_start, p.char_end);
      assert.ok(p.char_start >= prev, c.name);
      assert.ok(p.char_end - p.char_start <= c.options.maxChars, c.name);
      assert.ok(!/^\s/.test(slice), c.name);
      assert.ok(!/\s$/.test(slice), c.name);
      prev = p.char_end;
    }
  }
});

test('chunkIndexForOffset', () => {
  const plan = planChunks('Hello world. This is Tamber.', { mode: 'sentence' });
  assert.equal(chunkIndexForOffset(plan, 0), 0);
  assert.equal(chunkIndexForOffset(plan, 12), 1); // the gap between chunks maps to the next chunk
  assert.equal(chunkIndexForOffset(plan, 20), 1);
  assert.equal(chunkIndexForOffset(plan, 999), -1);
});
