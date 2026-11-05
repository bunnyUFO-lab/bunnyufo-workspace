// Which plans are paused by a usage limit: what counts as evidence, when a pause ends, and what the chat list says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAUSE_MS, createPlanPauses, pausesForClient, pausesFrom, resetOf } from '../plan-pauses.mjs';
import { CHAT_MODELS } from '../chat-models.mjs';

const at = new Date('2026-11-01T13:00:00.000Z');
const ago = minutes => new Date(at.getTime() - minutes * 60_000).toISOString();

test('a reset time the error carries is read; anything doubtful is null', () => {
  assert.equal(resetOf('You hit your usage limit. Try again in 1 hour 20 minutes.', at), '2026-11-01T14:20:00.000Z');
  assert.equal(resetOf('429 usage limit, resets in 45 min', at), '2026-11-01T13:45:00.000Z');
  assert.equal(resetOf('429 usage limit; retry in 2h 5m', at), '2026-11-01T15:05:00.000Z');
  assert.equal(resetOf('quota exhausted, resets at 2026-11-01T16:00:00Z', at), '2026-11-01T16:00:00.000Z');
  assert.equal(resetOf('429 usage limit reached', at), null);
  assert.equal(resetOf('Codex provider quota exhausted (429)', at), null);
  assert.equal(resetOf('resets in 400 days', at), null, 'a reset further than a week away is not believed');
  assert.equal(resetOf('resets at 2026-11-01T12:00:00Z', at), null, 'a reset in the past is no reset');
  assert.equal(resetOf(undefined, at), null);
});

test('a pause lasts until its reset time, else an hour from when it was seen, then it expires by itself', () => {
  const [known] = pausesFrom([{ provider: 'openai-codex', seen: ago(10), until: '2026-11-01T14:20:00.000Z' }], at);
  assert.deepEqual(known, { provider: 'openai-codex', seen: ago(10), until: '2026-11-01T14:20:00.000Z', reported: true });
  const [guess] = pausesFrom([{ provider: 'openai-codex', seen: ago(10) }], at);
  assert.equal(guess.until, new Date(at.getTime() - 10 * 60_000 + PAUSE_MS).toISOString());
  assert.equal(guess.reported, false);
  assert.deepEqual(pausesFrom([{ provider: 'openai-codex', seen: ago(61) }], at), [], 'an hour on, with no reset time, it is over');
  assert.deepEqual(pausesFrom([{ provider: 'openai-codex', seen: ago(300), until: ago(5) }], at), [], 'a reset time that has passed ends it');
  assert.deepEqual(pausesFrom([{ provider: 'openai-codex', seen: new Date(at.getTime() + 3600_000).toISOString() }], at), [], 'evidence from the future is ignored');
});

test('the newest evidence per provider decides', () => {
  const pauses = pausesFrom([
    { provider: 'openai-codex', seen: ago(50), until: '2026-11-01T13:30:00.000Z' },
    { provider: 'openai-codex', seen: ago(5) },
    { provider: 'anthropic', seen: ago(20) },
  ], at);
  assert.deepEqual(pauses.map(pause => [pause.provider, pause.reported]), [['openai-codex', false], ['anthropic', false]]);
});

const folders = files => async () => new Map(Object.entries(files).map(([id, names]) => [id, new Set(Object.keys(names))]));
const reader = files => async rel => { const [, id, name] = rel.split('/'); return files[id]?.[name] ?? null; };

test('a request retried on quota pauses Codex; the read follows the request files and takes no call to a provider', async () => {
  const files = {
    '20261101-old-aaaa': { 'request.json': {}, 'hermes-retry.json': { at: ago(200), reason: 'quota', provider: 'anthropic' } },
    '20261101-new-bbbb': { 'request.json': {}, 'hermes-retry.json': { at: ago(15), reason: 'quota', provider: 'anthropic', until: '2026-11-01T14:20:00.000Z' } },
    '20261101-none-cccc': { 'request.json': {} },
  };
  const pauses = createPlanPauses({ listFolders: folders(files), cached: reader(files) });
  const [pause] = await pauses.read(at);
  assert.equal(pause.provider, 'openai-codex');
  assert.equal(pause.until, '2026-11-01T14:20:00.000Z');
  assert.equal(pause.reported, true);
  assert.deepEqual(await pauses.read(new Date(at.getTime() + 2 * 3600_000)), [], 'it expires by itself');
});

test('a chat turn that failed on quota pauses the plan it ran on; other failures do not', async () => {
  const pauses = createPlanPauses({ listFolders: folders({}), cached: async () => null });
  assert.equal(pauses.note('anthropic', 'boom', at), false);
  assert.equal(pauses.note('anthropic', '429 usage limit reached', at), true);
  assert.deepEqual((await pauses.read(at)).map(pause => pause.provider), ['anthropic']);
  assert.equal(pauses.note('openai-codex', 'Try again in 30 minutes, usage limit 429', at), true);
  const both = await pauses.read(at);
  assert.equal(both.find(pause => pause.provider === 'openai-codex').until, '2026-11-01T13:30:00.000Z');
});

test('an unreadable folder is no pause, not an error', async () => {
  const pauses = createPlanPauses({ listFolders: async () => { throw new Error('bucket down'); }, cached: async () => null });
  assert.deepEqual(await pauses.read(at), []);
});

test('the page gets model ids, not providers: a provider pause covers each of its models', () => {
  const rows = pausesForClient(pausesFrom([{ provider: 'anthropic', seen: ago(5) }, { provider: 'openai-codex', seen: ago(5), until: '2026-11-01T14:20:00.000Z' }], at), CHAT_MODELS);
  assert.deepEqual(rows.map(row => row.model).sort(), ['codex', 'codex-6-1-sol', 'codex-6-1-terra', 'codex-6-astra', 'codex-6-luna', 'haiku', 'opus', 'sonnet']);
  assert.ok(rows.every(row => !('provider' in row)));
});

test('a stored reset time further than a week from when it was seen is not believed', () => {
  const [far] = pausesFrom([{ provider: 'openai-codex', seen: ago(10), until: '2026-12-25T00:00:00.000Z' }], at);
  assert.equal(far.reported, false);
  assert.equal(far.until, new Date(at.getTime() - 10 * 60_000 + PAUSE_MS).toISOString());
});
