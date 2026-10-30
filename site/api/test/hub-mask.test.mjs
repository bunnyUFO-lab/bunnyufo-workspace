import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { maskSecrets } from '../hub-mask.mjs';

// The same vectors live in bunnyUFO-lab/workspace-skills at mods/hub-hooks/hooks/mask-vectors.json. When you change this file, change
// that one and the hash in mods/hub-hooks/hooks/mask.test.ts too.
const MASK_VECTORS_SHA256 = 'c41c7d378b080fcca0ce2ac06888d20d10aafa0bab72b457cd16b54eb3d1cf23';
const raw = readFileSync(new URL('./fixtures/mask-vectors.json', import.meta.url), 'utf8');
const { cases } = JSON.parse(raw);
const join = value => (Array.isArray(value) ? value.join('') : value);

test('the shared mask vectors match the copy in the skills repository', () => {
  assert.equal(createHash('sha256').update(raw.replace(/\r/g, '')).digest('hex'), MASK_VECTORS_SHA256);
});

for (const vector of cases) {
  test(`mask vector: ${vector.name}`, () => {
    assert.equal(maskSecrets(join(vector.input)), join(vector.expected));
  });
}

test('masking is idempotent', () => {
  for (const vector of cases) assert.equal(maskSecrets(join(vector.expected)), join(vector.expected));
});
