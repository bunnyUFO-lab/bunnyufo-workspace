import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { maskSecrets } from '../hub-mask.mjs';
import cases from './fixtures/mask-vectors.mjs';

// The same vectors live in bunnyUFO-lab/workspace-skills at mods/hub-hooks/hooks/mask-vectors.mjs. When you change fixtures/mask-vectors.mjs,
// change that one and the hash in mods/hub-hooks/hooks/mask.test.ts too. The hash is of JSON.stringify(vectors), so line endings do not matter.
// Must be the same literal as MASK_VECTORS_SHA256 in mods/hub-hooks/hooks/mask.test.ts (workspace-skills): a change in one repo fails here until the other is mirrored.
const MASK_VECTORS_SHA256 = '684bb14db54925ad53976afc24e6375bcc853bd5d3e092a3b883dc5975a921f2';
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

test('a 200 KB run of dashed words is masked in under 200 ms', () => {
  for (const unit of ['a-', 'a.', 'eyJ', 'a-a:']) {
    const started = performance.now();
    maskSecrets(unit.repeat(Math.ceil(200000 / unit.length)));
    assert.ok(performance.now() - started < 200, `${unit} took ${Math.round(performance.now() - started)} ms`);
  }
});
