// "Not useful": the press is checked, the record is built from the server's own row, and its copy is bounded and masked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PRESETS, REASON_MAX, RECORD_MAX, capCopy, checkNotUseful, feedbackIdOf, feedbackKey, isRemoteQuestion, notUsefulRecord, reasonTextOf, recordPath, sourceOf } from '../hub-feedback.mjs';

const AT = new Date('2026-11-03T10:00:00.000Z');

test('checkNotUseful: each preset, a note, both, neither; a long note or an unknown preset is refused', () => {
  for (const preset of Object.keys(PRESETS)) assert.deepEqual(checkNotUseful({ preset }), { preset });
  assert.deepEqual(checkNotUseful({ note: '  Too   many\nwords  ' }), { note: 'Too many words' });
  assert.deepEqual(checkNotUseful({ preset: 'too-long', note: 'Ten pages' }), { preset: 'too-long', note: 'Ten pages' });
  assert.deepEqual(checkNotUseful({}), {});
  assert.deepEqual(checkNotUseful(undefined), {});
  assert.deepEqual(checkNotUseful({ preset: '', note: '   ' }), {}, 'empty strings are no reason');
  assert.deepEqual(checkNotUseful({ note: 'x'.repeat(REASON_MAX) }), { note: 'x'.repeat(REASON_MAX) });
  assert.throws(() => checkNotUseful({ note: 'x'.repeat(REASON_MAX + 1) }), /at most 200/);
  assert.throws(() => checkNotUseful({ preset: 'boring' }), /one of/);
  assert.throws(() => checkNotUseful({ preset: 'toString' }), /one of/, 'an inherited name is no preset');
  assert.throws(() => checkNotUseful({ note: 5 }), /text/);
  assert.throws(() => checkNotUseful([]), /Send/);
  assert.deepEqual(checkNotUseful({ note: 'pasted password: hunter2 by mistake' }), { note: 'pasted password: [masked] by mistake' }, 'the note is masked');
});

test('feedbackKey: 8 hex of the sha256 of project/kind/id, stable', () => {
  const want = createHash('sha256').update('proj/review/120000-pc-000001.json').digest('hex').slice(0, 8);
  assert.equal(feedbackKey('proj', 'review', '120000-pc-000001.json'), want);
  assert.match(want, /^[0-9a-f]{8}$/);
  assert.notEqual(feedbackKey('other', 'review', '120000-pc-000001.json'), want);
  assert.equal(recordPath('proj', 'ask', 'a-1'), 'feedback/proj/ask/a-1/not-useful.json');
});

test('reasonTextOf: the chip label, then the note', () => {
  assert.equal(reasonTextOf({ preset: 'too-long' }), 'Too long');
  assert.equal(reasonTextOf({ note: 'Just a log' }), 'Just a log');
  assert.equal(reasonTextOf({ preset: 'already-done', note: 'merged' }), 'Already done · merged');
  assert.equal(reasonTextOf({}), '');
});

const remoteAsk = { id: '20261103-q-ab12', project: 'ml', question: 'Which?', kind: 'decision', context: 'Header · asked by Claude in ml on pc\nmore', from: { host: 'pc', tool: 'claude-code', session: 's1' } };
const cliAsk = { id: '20261103-r-cd34', project: 'ml', question: 'Which?', context: 'Pick one.', from: { host: 'pc', tool: 'claude-code', session: 's2' } };

test('notUsefulRecord: source.by per kind, and the key is stable', () => {
  const make = (row, raw, writer) => notUsefulRecord({ row, raw, writer, project: row.project ?? 'workspace-app', preset: 'too-long', user: 'owner', at: AT });
  const review = make({ kind: 'review', id: 'a.json', project: 'ml', title: 'PR ready', host: 'pc' }, { source: 'dev-sprint', file: 'a.json' });
  assert.equal(review.source.by, 'hook');
  assert.equal(review.source.eventSource, 'dev-sprint');
  assert.equal(make({ kind: 'review', id: 'b.json', project: 'ml', title: 't' }, { source: 'my-hooks' }).source.by, 'hook');
  assert.equal(make({ kind: 'review', id: 'c.json', project: 'ml', title: 't' }, { source: 'cards-event' }).source.by, 'agent');
  assert.equal(make({ kind: 'review', id: 'c.json', project: 'ml', title: 't' }, {}).source.by, 'agent');
  const blocked = make({ kind: 'blocked', id: 'sess-1', file: 'x.json', project: 'ml', title: 'Blocked' }, { source: 'hub-hooks' });
  assert.equal(blocked.source.by, 'session');
  assert.deepEqual(blocked.item, { kind: 'blocked', id: 'x.json' }, 'a blocked row is filed under its event file');
  assert.equal(make({ kind: 'ask', id: remoteAsk.id, project: 'ml', title: 'Which?' }, remoteAsk).source.by, 'session');
  const agentAsk = make({ kind: 'ask', id: cliAsk.id, project: 'ml', title: 'Which?', host: 'pc', session: 's2', tool: 'claude-code' }, cliAsk, 'agent');
  assert.deepEqual([agentAsk.source.by, agentAsk.source.writer, agentAsk.source.session, agentAsk.source.host], ['agent', 'agent', 's2', 'pc']);
  assert.equal(make({ kind: 'checklist', id: 'c-1', project: 'ml', title: 'List' }, { id: 'c-1' }).source.by, 'agent');
  assert.equal(sourceOf({ kind: 'weird' }, {}).by, 'unknown');
  assert.equal(isRemoteQuestion(cliAsk), false);
  assert.equal(isRemoteQuestion(remoteAsk), true);
  assert.equal(review.key, feedbackKey('ml', 'review', 'a.json'));
  assert.equal(review.key, make({ kind: 'review', id: 'a.json', project: 'ml', title: 'again' }, {}).key, 'the key does not depend on the title');
  assert.deepEqual([review.v, review.at, review.by, review.reasonText, review.reason], [1, AT.toISOString(), 'owner', 'Too long', { preset: 'too-long' }]);
  assert.equal(feedbackIdOf({ kind: 'blocked', id: 's', file: 'f.json' }), 'f.json');
});

test('capCopy and the size cap: a 100 KiB Ask is cut, a secret is masked, no answer or picture or signed URL is copied', () => {
  const big = { id: '20261103-big-ab12', project: 'ml', question: 'q', context: 'c'.repeat(100 * 1024), options: Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, label: 'l'.repeat(3000), image: 'x.png' })), image: 'big.png' };
  const record = notUsefulRecord({ row: { kind: 'ask', id: big.id, project: 'ml', title: 'q' }, raw: big, project: 'ml', user: 'owner', at: AT });
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= RECORD_MAX, `${Buffer.byteLength(JSON.stringify(record))} bytes`);
  assert.equal(record.truncated, true, 'a 100 KiB Ask is cut');
  const small = notUsefulRecord({ row: { kind: 'ask', id: big.id, project: 'ml', title: 'q' }, raw: { id: big.id, question: 'q' }, project: 'ml', user: 'owner', at: AT });
  assert.equal(small.truncated, undefined);
  assert.deepEqual(small.copy.raw, { id: big.id, question: 'q' });

  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const copy = capCopy({ note: `use ${key} now`, nested: { a: { b: { c: { d: { e: { f: 'deep' } } } } } }, list: Array.from({ length: 30 }, (_, i) => i), answer: { choice: 'A' }, image: 'x.png', screenshots: ['a.png'], url: 'https://s3.example.test/b/k?X-Amz-Signature=abc', inline: 'data:image/png;base64,AAAA' });
  assert.equal(copy.note, 'use [masked] now');
  assert.equal(copy.list.length, 20);
  assert.equal(copy.nested.a.b.c.d, '[cut]', 'depth 5');
  for (const dropped of ['answer', 'image', 'screenshots']) assert.equal(dropped in copy, false, dropped);
  assert.equal(copy.url, '[removed]');
  assert.equal(copy.inline, '[removed]');
  assert.equal(capCopy('y'.repeat(5000)).length, 2000);
});
