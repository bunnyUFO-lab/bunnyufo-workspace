import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_KEYS, genSprite } from '../../../src/hub/team/sprites.ts';
import { choiceOf, nextSalt, quickTiles, randomLabel, rosterCounts, sameSprite, sheetNote, startSalt } from '../../../src/hub/team/teamModel.ts';

const dev = { kind: 'builtin', key: 'developer' };
const claude0 = { kind: 'random', salt: 0, name: 'Claude Code' };

test('roster counts: online is everything not offline, working is working only', () => {
  const counts = rosterCounts([{ status: 'working' }, { status: 'needs-you' }, { status: 'idle' }, { status: 'offline' }]);
  assert.deepEqual(counts, { total: 4, online: 3, working: 1 });
});

test('the POST body drops the name and keeps only what the route accepts', () => {
  assert.deepEqual(choiceOf(dev), { kind: 'builtin', key: 'developer' });
  assert.deepEqual(choiceOf(claude0), { kind: 'random', salt: 0 });
});

test('Randomize starts from the current salt and counts up', () => {
  assert.equal(startSalt(dev), 0);
  assert.equal(startSalt({ kind: 'random', salt: 7, name: 'x' }), 7);
  assert.equal(nextSalt(0), 1);
  assert.equal(nextSalt(9999), 1, 'The salt stays inside 0 to 9999, which the route checks.');
});

test('the label is the one genSprite gives', () => {
  assert.equal(randomLabel('Hermes', 1), `Randomized from the name: ${genSprite('Hermes', 1).label}`);
});

test('quick tiles: current first, then the randomized one, then every built-in once', () => {
  const rand = { kind: 'random', salt: 2, name: 'Claude Code' };
  const tiles = quickTiles(dev, rand);
  assert.ok(sameSprite(tiles[0], dev));
  assert.ok(sameSprite(tiles[1], rand));
  assert.equal(tiles.length, 2 + BUILTIN_KEYS.length - 1, 'developer is shown once');
  assert.equal(quickTiles(claude0, null).length, 1 + BUILTIN_KEYS.length);
  assert.equal(quickTiles(rand, rand).length, 1 + BUILTIN_KEYS.length, 'a randomized sprite equal to the current one is not shown twice');
});

test('the note under the preview', () => {
  assert.equal(sheetNote('X', dev, dev), 'This is the current sprite');
  assert.match(sheetNote('X', dev, { kind: 'builtin', key: 'qa' }), /^Built in/);
  assert.match(sheetNote('X', dev, { kind: 'random', salt: 3, name: 'X' }), /^Randomized from the name: /);
});
