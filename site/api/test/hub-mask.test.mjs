import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { maskSecrets } from '../hub-mask.mjs';
import cases from './fixtures/mask-vectors.mjs';

// The same vectors live in bunnyUFO-lab/workspace-skills at mods/hub-hooks/hooks/mask-vectors.mjs. When you change fixtures/mask-vectors.mjs,
// change that one and the hash in mods/hub-hooks/hooks/mask.test.ts too. The hash is of JSON.stringify(vectors), so line endings do not matter.
const MASK_VECTORS_SHA256 = '77c17ab7eb1b40d86d3725f54b4b40ca2ddd955e631f3478a2b835509ad44fb5';
const join = value => (Array.isArray(value) ? value.join('') : value);

test('the shared mask vectors match the copy in the skills repository', () => {
  assert.equal(createHash('sha256').update(JSON.stringify(cases)).digest('hex'), MASK_VECTORS_SHA256);
});

for (const vector of cases) {
  test(`mask vector: ${vector.name}`, () => {
    assert.equal(maskSecrets(join(vector.input)), join(vector.expected));
  });
}

test('masking is idempotent', () => {
  for (const vector of cases) assert.equal(maskSecrets(join(vector.expected)), join(vector.expected));
});
