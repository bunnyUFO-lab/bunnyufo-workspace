// Beads copies: the pure merge, the copy id, and the reader over the stand-in bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyIdOf, LEGACY_COPY, MAX_COPIES, mergeCopies, normalizeRoot, parseJsonl } from '../hub-beads.mjs';
import { beadsIssue } from './hub-fixtures.mjs';

const issue = (id, updated, title = id) => ({ ...beadsIssue({ id, title }), updated_at: updated });
const copy = (name, pushedAt, issues, extra = {}) => ({ copy: name, meta: { pushedAt, host: 'test-pc', worktree: name, ...extra }, issues });

test('parseJsonl keeps issues, skips bad lines and other record types', () => {
  const text = [JSON.stringify({ _type: 'memory', id: 'm' }), 'not json', '', JSON.stringify({ id: 'a' }), JSON.stringify({ _type: 'issue', id: 'b' }), JSON.stringify({ title: 'no id' })].join('\n');
  assert.deepEqual(parseJsonl(text).map(row => row.id), ['a', 'b']);
});

test('copyIdOf: host, then 10 hex of the lower-cased, forward-slash root', () => {
  const id = copyIdOf('Test-PC', 'C:\\Work\\Probe\\');
  assert.match(id, /^test-pc-[0-9a-f]{10}$/);
  assert.equal(id, copyIdOf('test-pc', 'c:/work/probe'));
  assert.notEqual(id, copyIdOf('test-pc', 'c:/work/other'));
  assert.equal(normalizeRoot('C:\\Work\\Probe\\'), 'C:/Work/Probe');
  assert.doesNotMatch(id, /token|secret|password|credential/);
});

test('mergeCopies: the older push with a newer updated_at wins that issue; an issue only in the stale copy stays', () => {
  const fresh = copy('a', '2026-10-20T10:00:00Z', [issue('x-1', '2026-10-18T09:00:00Z', 'new push, old edit'), issue('x-2', '2026-10-20T09:00:00Z')]);
  const stale = copy('b', '2026-10-10T10:00:00Z', [issue('x-1', '2026-10-19T09:00:00Z', 'old push, newer edit'), issue('x-3', '2026-10-01T00:00:00Z')]);
  const { meta, issues } = mergeCopies([fresh, stale]);
  assert.equal(issues.find(row => row.id === 'x-1').title, 'old push, newer edit');
  assert.deepEqual(issues.map(row => row.id).sort(), ['x-1', 'x-2', 'x-3']);
  assert.equal(meta.pushedAt, '2026-10-20T10:00:00Z');
  assert.equal(meta.count, 3);
  assert.deepEqual(meta.copies.map(row => [row.copy, row.count]), [['a', 2], ['b', 2]]);
});

test('mergeCopies: a tie goes to the newer push; a missing or bad date is oldest', () => {
  const a = copy('a', '2026-10-02T00:00:00Z', [issue('x-1', '2026-10-01T00:00:00Z', 'a'), issue('x-2', 'garbage', 'a bad date')]);
  const b = copy('b', '2026-10-03T00:00:00Z', [issue('x-1', '2026-10-01T00:00:00Z', 'b'), { ...issue('x-2', undefined, 'b no date') }]);
  const merged = mergeCopies([a, b]).issues;
  assert.equal(merged.find(row => row.id === 'x-1').title, 'b');
  assert.equal(merged.find(row => row.id === 'x-2').title, 'b no date', 'Both undated: the newer push.');
  const dated = mergeCopies([copy('a', '2026-10-02T00:00:00Z', [issue('x-9', 'garbage', 'bad')]), copy('b', '2026-10-01T00:00:00Z', [issue('x-9', '2026-01-01T00:00:00Z', 'dated')])]);
  assert.equal(dated.issues[0].title, 'dated');
});

test('mergeCopies: the legacy copy merges with new ones; at most 30 copies are read, the newest by push', () => {
  const legacy = copy(LEGACY_COPY, '2026-09-01T00:00:00Z', [issue('x-1', '2026-09-01T00:00:00Z', 'legacy'), issue('old', '2026-09-01T00:00:00Z')]);
  const many = Array.from({ length: MAX_COPIES + 2 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    const at = new Date(Date.UTC(2026, 9, 1, index)).toISOString();
    return copy(`c${day}`, at, [issue(`only-${day}`, at)]);
  });
  const { meta, issues } = mergeCopies([legacy, ...many]);
  assert.equal(meta.copies.length, MAX_COPIES + 1);
  assert.ok(!issues.some(row => row.id === 'only-01' || row.id === 'only-02'), 'The two oldest copies are dropped.');
  assert.ok(issues.some(row => row.id === 'old'), 'The legacy copy always counts.');
  assert.equal(meta.pushedAt, new Date(Date.UTC(2026, 9, 1, MAX_COPIES + 1)).toISOString());
});

test('mergeCopies: nothing in, nothing out', () => {
  assert.deepEqual(mergeCopies([]), { meta: null, issues: [] });
});
