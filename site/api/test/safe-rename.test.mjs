// A rename that a Windows indexer or antivirus holds off for a moment is retried; a lasting one fails cleanly.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rename as realRename } from 'node:fs/promises';
import { folderStore } from '../card-writes.mjs';
import { BUSY_CODES, TRIES, renameOver } from '../safe-rename.mjs';

const test = (name, fn) => baseTest(name, { timeout: 30_000 }, fn);
const busy = code => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test('a rename that is busy a few times then works succeeds, and waits between tries', async () => {
  const waits = [];
  let calls = 0;
  await renameOver('a.tmp', 'a', { rename: async () => { calls += 1; if (calls < 4) throw busy(['EPERM', 'EBUSY', 'EACCES'][calls - 1]); }, sleep: async ms => { waits.push(ms); } });
  assert.equal(calls, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits.every(ms => ms >= 25 && ms <= 50), `waits between 25 and 50 ms (${waits})`);
  assert.ok(waits.length * 50 < 500 && (TRIES - 1) * 50 < 500, 'the whole wait stays under half a second');
});

test('other errors are not retried', async () => {
  let calls = 0;
  const removed = [];
  await assert.rejects(renameOver('a.tmp', 'a', { rename: async () => { calls += 1; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, sleep: async () => {}, remove: async file => { removed.push(file); } }), { code: 'ENOENT' });
  assert.equal(calls, 1);
  assert.deepEqual(removed, ['a.tmp']);
  assert.deepEqual([...BUSY_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM']);
});

test('a folder store write survives a busy rename and is still atomic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-busy-'));
  let calls = 0;
  const store = folderStore(root, { fs: { rename: async (from, to) => { calls += 1; if (calls <= 2) throw busy('EPERM'); return realRename(from, to); }, sleep: async () => {} } });
  await store.write('workspace.json', '{"a":1}');
  assert.equal(calls, 3);
  assert.equal(await readFile(path.join(root, 'workspace.json'), 'utf8'), '{"a":1}');
  assert.deepEqual(await readdir(root), ['workspace.json'], 'no temp file is left');
});

test('a rename that is busy every time throws the original error and removes the temp file; the old file is untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-busy-'));
  let calls = 0;
  const first = folderStore(root);
  await first.write('workspace.json', '{"old":true}');
  const error = busy('EBUSY');
  const store = folderStore(root, { fs: { rename: async () => { calls += 1; throw error; }, sleep: async () => {} } });
  await assert.rejects(store.write('workspace.json', '{"new":true}'), thrown => thrown === error);
  assert.equal(calls, TRIES);
  assert.equal(await readFile(path.join(root, 'workspace.json'), 'utf8'), '{"old":true}');
  assert.deepEqual(await readdir(root), ['workspace.json'], 'the temp file was removed');
  // And the store keeps working afterwards.
  await store.write('other.json', 'x').catch(() => {});
  await first.write('workspace.json', '{"again":true}');
});
