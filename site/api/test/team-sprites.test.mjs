import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN, BUILTIN_KEYS, defaultSprite, genSprite, resolveSprite } from '../../../src/hub/team/sprites.ts';

// genSprite('Hermes', 1), checked against the mockup's original function when this was ported.
const SNAPSHOT = {
  label: 'blob with a sprout',
  rows: [
    '.........FF.....',
    '.....FF..F......',
    '......FGG.......',
    '.....bbbbbb.....',
    '...bllbbbbbbb...',
    '..blbbbbbbbbbb..',
    '..bbbkbbbbkbbb..',
    '.bbbbkbbbbkbbbb.',
    '.bbbpbbkkbbpbbb.',
    '.bbbbbbbbbbbbbb.',
    '.bbbbbbbbbbbbbb.',
    '..bbbbbbbbbbbb..',
    '..dddddddddddd..',
    '....dddddddd....',
    '.....dd..dd.....',
    '................',
  ],
};

test('every built-in has 16 rows of 16 characters and every letter in its palette', () => {
  assert.equal(BUILTIN_KEYS.length, 17);
  for (const key of BUILTIN_KEYS) {
    const { rows, palette } = BUILTIN[key];
    assert.equal(rows.length, 16, key);
    for (const row of rows) {
      assert.equal(row.length, 16, `${key}: ${row}`);
      for (const c of row) if (c !== '.') assert.ok(palette[c], `${key}: no colour for ${c}`);
    }
  }
});

test('genSprite is deterministic and well formed', () => {
  assert.deepEqual(genSprite('Hermes', 1), genSprite('Hermes', 1));
  assert.notDeepEqual(genSprite('Hermes', 1).rows, genSprite('Hermes', 2).rows);
  for (let salt = 0; salt < 200; salt++) {
    const g = genSprite('Claude Code', salt);
    assert.equal(g.rows.length, 16);
    for (const row of g.rows) {
      assert.equal(row.length, 16);
      for (const c of row) if (c !== '.') assert.ok(g.palette[c], `salt ${salt}: ${c}`);
    }
  }
});

test('genSprite(Hermes, 1) matches the stored snapshot', () => {
  const g = genSprite('Hermes', 1);
  assert.equal(g.label, SNAPSHOT.label);
  assert.deepEqual(g.rows, SNAPSHOT.rows);
});

test('defaultSprite and resolveSprite', () => {
  assert.deepEqual(defaultSprite('hermes', 'Hermes'), { kind: 'builtin', key: 'hermes' });
  assert.deepEqual(defaultSprite('claude', 'Claude Code'), { kind: 'random', salt: 0, name: 'Claude Code' });
  assert.deepEqual(defaultSprite('toString', 'Zed'), { kind: 'random', salt: 0, name: 'Zed' });
  assert.equal(resolveSprite({ kind: 'builtin', key: 'qa' }), BUILTIN.qa);
  assert.deepEqual(resolveSprite({ kind: 'builtin', key: 'nope', name: 'Zed' }), genSprite('Zed', 0));
  assert.deepEqual(resolveSprite({ kind: 'builtin', key: 'toString' }), genSprite('toString', 0));
  assert.deepEqual(resolveSprite({ kind: 'random', salt: 3, name: 'Zed' }), genSprite('Zed', 3));
});
