// The device's list of chats and jobs in progress: what is kept, when it leaves, and how it merges with the Hub's rows.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_LIMIT_MS, LIMIT_MS, MAX_BYTES, MAX_CHATS, MAX_JOBS, STORE_KEY, addJobIds, beginChat, cachedLines, clearInProgress, dismissChat, dismissKey, expired, flushReplies, getStore,
  judge, mergeChatJobs, mergeChats, mergeJobRows, noteJobRows, noteJobs, plainLine, reloadFromStorage, setChatId, setReply, settleChat, settleList, turnSaved,
} from '../../src/hub/inProgress.ts';

const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); }, removeItem: key => { data.delete(key); }, data }; };
let disk;
beforeEach(() => { disk = memory(); globalThis.localStorage = disk; clearInProgress(); });

const at = '2026-11-05T10:00:00.000Z';
const user = (text, when = at) => ({ role: 'user', text, at: when });
const bot = text => ({ role: 'assistant', text, at });
const begin = (extra = {}) => beginChat({ id: 'chat-1', title: 'Plan the level', persona: null, model: null, before: [], owner: user('Plan the level'), ...extra });
const job = (id, state = 'running', extra = {}) => ({ id, title: `Job ${id}`, text: 'Do it', project: 'proj', writer: 'hermes', verified: true, state, approvable: false, by: 'hermes', ...extra });
const row = (id, extra = {}) => ({ id, title: `Chat ${id}`, updated: at, count: 2, ...extra });

test('a turn is kept at once, with the owner message and no pictures', () => {
  const key = begin({ owner: { ...user('Look'), previews: ['blob:x'] }, before: [{ ...bot('Earlier'), images: [{ file: 'a.png' }] }] });
  const [entry] = getStore().chats;
  assert.equal(entry.key, key);
  assert.equal(entry.base, 1);
  assert.match(entry.lines[0].text, /Picture not kept/);
  assert.match(entry.lines[1].text, /Look\n\[Picture not kept/);
  assert.equal(entry.ask.text, 'Look', 'the original words are kept for matching');
  assert.ok(JSON.parse(disk.getItem(STORE_KEY)).chats.length === 1, 'and written to storage');
});

test('a turn begun twice is one entry; a new turn in the same chat replaces it', () => {
  const key = begin();
  assert.equal(begin(), key);
  begin({ owner: user('Next', '2026-11-05T10:05:00.000Z') });
  assert.equal(getStore().chats.length, 1);
  assert.equal(getStore().chats[0].ask.text, 'Next');
});

test('a chat with no id yet is kept, and takes its id', () => {
  const key = begin({ id: null });
  assert.equal(getStore().chats[0].id, null);
  setChatId(key, '20261105-abc123');
  assert.equal(getStore().chats[0].id, '20261105-abc123');
});

test('the reply is written at most about once a second, and at once on a flush', async () => {
  const key = begin();
  setReply(key, 'One');
  setReply(key, 'One two');
  assert.equal(getStore().chats[0].reply, '', 'not yet');
  flushReplies();
  assert.equal(getStore().chats[0].reply, 'One two');
  setReply(key, 'Final', true);
  assert.equal(JSON.parse(disk.getItem(STORE_KEY)).chats[0].reply, 'Final');
  assert.deepEqual(cachedLines(getStore().chats[0]).map(line => line.text), ['Plan the level', 'Final']);
});

test('a reply for an entry that is gone is ignored', () => {
  const key = begin();
  dismissKey(key);
  setReply(key, 'Late', true);
  assert.equal(getStore().chats.length, 0);
});

test('the turn is saved only when the owner message is answered where it was added', () => {
  const entry = { base: 2, ask: { text: 'Go', at } };
  const old = [user('a'), bot('b')];
  assert.equal(turnSaved([...old, user('Go'), bot('Done')], entry), true);
  assert.equal(turnSaved([...old, user('Go')], entry), false, 'asked, not answered');
  assert.equal(turnSaved([...old, { ...user('Go'), stopped: true }], entry), true, 'stopped before a reply');
  assert.equal(turnSaved(old, entry), false);
  assert.equal(turnSaved([user('Go'), bot('x'), user('a'), bot('b')], entry), false, 'an earlier identical message is not this turn');
  assert.equal(turnSaved([{ role: 'context', text: 'about', at }, ...old, user('Go'), bot('Done')], entry), true, 'the context line is not counted');
});

test('judge: running follows the stream, fewer lines keep the device lines, saved settles', () => {
  begin();
  const entry = getStore().chats[0];
  assert.equal(judge(entry, { messages: [], running: true }).kind, 'live');
  assert.equal(judge(entry, { messages: [] }).kind, 'keep');
  assert.equal(judge(entry, { messages: [user('Plan the level'), bot('Done')] }).kind, 'saved');
  setReply(entry.key, 'Partly', true);
  const kept = judge(getStore().chats[0], { messages: [user('Plan the level')] });
  assert.equal(kept.kind, 'keep');
  assert.deepEqual(kept.lines.map(line => line.text), ['Plan the level', 'Partly'], 'the owner message and the reply so far');
  assert.equal(judge(getStore().chats[0], { messages: [user('Other'), bot('a'), user('b')] }).kind, 'server', 'the Hub holds as much or more: its lines win');
});

test('settleChat removes a saved entry and keeps an unsaved one', () => {
  begin();
  assert.equal(settleChat('chat-1', { messages: [] }).kind, 'keep');
  assert.equal(getStore().chats.length, 1);
  assert.equal(settleChat('chat-1', { messages: [user('Plan the level'), bot('Done')] }).kind, 'saved');
  assert.equal(getStore().chats.length, 0);
  assert.equal(settleChat('nope', { messages: [] }), null);
});

test('deleting or archiving a chat removes its entry and a late reply does not bring it back', () => {
  const key = begin();
  dismissChat('chat-1');
  setReply(key, 'More', true);
  addJobIds(key, ['j1']);
  assert.equal(getStore().chats.length, 0);
  assert.equal(getStore().jobs.length, 0);
});

test('an entry past two hours is unconfirmed, not dropped', () => {
  beginChat({ id: 'old', title: 'Old', persona: null, model: null, before: [], owner: user('Old'), now: Date.now() - LIMIT_MS - 1000 });
  const [entry] = getStore().chats;
  assert.equal(expired(entry), true);
  const [shown] = mergeChats([], getStore());
  assert.equal(shown.local, 'unconfirmed');
  assert.equal(getStore().chats.length, 1);
  dismissKey(entry.key);
  assert.equal(getStore().chats.length, 0);
});

test('merge: an entry the Hub does not list gets a Replying row at the top; the Hub row wins and keeps a running mark', () => {
  begin({ id: 'chat-new', title: 'Brand new' });
  begin({ id: 'chat-old', title: 'Old chat', owner: user('More'), before: [user('a'), bot('b')] });
  const merged = mergeChats([row('x'), row('chat-old', { title: 'Server title', count: 2 })], getStore());
  assert.deepEqual(merged.map(entry => entry.id), ['chat-new', 'x', 'chat-old']);
  assert.equal(merged[0].local, 'replying');
  assert.equal(merged[0].running, true);
  assert.equal(merged[2].title, 'Server title', 'the Hub row wins');
  assert.equal(merged[2].running, true, 'and keeps the running mark: it does not show the turn saved');
  assert.equal(merged[1].running, undefined);
  const saved = mergeChats([row('chat-old', { count: 4 })], getStore()).find(entry => entry.id === 'chat-old');
  assert.equal(saved.running, undefined, 'the Hub shows it saved: an ordinary row');
});

test('merge: a Hub row that still says running stays running; an entry with no id yet is a sending row', () => {
  begin({ id: 'chat-1' });
  assert.equal(mergeChats([row('chat-1', { count: 9, running: true })], getStore())[0].running, true);
  begin({ id: null, owner: user('No name yet') });
  const sending = mergeChats([], getStore()).find(entry => entry.local === 'sending');
  assert.equal(sending.id, '');
  assert.equal(sending.title, 'Plan the level');
});

test('merge: the haystack holds the lines and the reply, for the search', () => {
  const key = begin();
  setReply(key, 'The dragon sleeps', true);
  assert.match(mergeChats([], getStore())[0].haystack, /dragon sleeps/);
});

test('settleList: a saved chat leaves; one with no id takes the id of the row it became', () => {
  begin({ id: 'chat-1' });
  begin({ id: null, owner: user('Name the boss'), title: 'Name the boss' });
  settleList([row('chat-1', { count: 1 }), row('20261105-zzz', { title: 'Name the boss', updated: new Date().toISOString(), running: true, count: 1 })]);
  assert.deepEqual(getStore().chats.map(entry => entry.id), ['chat-1', '20261105-zzz']);
  settleList([row('chat-1', { count: 2 }), row('20261105-zzz', { count: 2, title: 'Name the boss' })]);
  assert.equal(getStore().chats.length, 0);
});

test('jobs: named ids are kept at once; a read gives details; a finished read removes them', () => {
  const key = begin();
  addJobIds(key, ['j1', 'j2']);
  assert.equal(getStore().jobs.length, 2);
  assert.equal(getStore().jobs[0].job.state, 'proposed');
  noteJobs('chat-1', [job('j1', 'running'), job('j2', 'done')]);
  assert.deepEqual(getStore().jobs.map(entry => entry.job.id), ['j1']);
  assert.equal(getStore().jobs[0].job.title, 'Job j1', 'the details replaced the plain row');
  noteJobs('chat-1', [job('j1', 'failed')]);
  assert.equal(getStore().jobs.length, 0);
});

test('jobs: a job seen running is kept; one seen only waiting in a chat with no entry is not', () => {
  noteJobs('other', [job('a', 'running'), job('b', 'proposed')]);
  assert.deepEqual(getStore().jobs.map(entry => entry.job.id), ['a']);
});

test('jobs: the Jobs view settles finished ones, and merges the rest by id', () => {
  noteJobs('c', [job('a', 'running'), job('b', 'running', { project: 'other' })]);
  const server = [{ id: 'a', title: 'Server A', project: 'proj', preset: '', state: 'running', at, deliverables: [], pills: [] }];
  const { rows, local } = mergeJobRows(server, getStore());
  assert.deepEqual(rows.map(entry => [entry.id, entry.title]), [['a', 'Server A'], ['b', 'Job b']]);
  assert.deepEqual([...local], ['b']);
  assert.deepEqual(mergeJobRows([], getStore(), 'proj').rows.map(entry => entry.id), ['a'], 'the project filter applies');
  noteJobRows([{ id: 'a', state: 'done' }]);
  assert.deepEqual(getStore().jobs.map(entry => entry.job.id), ['b']);
});

test('jobs: a chat\'s rows are the Hub rows plus what only the device holds', () => {
  noteJobs('c', [job('a', 'running'), job('b', 'running')]);
  const merged = mergeChatJobs([job('a', 'running', { title: 'Server A' })], getStore(), 'c');
  assert.deepEqual(merged.map(entry => entry.title), ['Server A', 'Job b']);
  assert.deepEqual(mergeChatJobs([], getStore(), 'zzz'), []);
});

test('a job entry older than the limit is dropped', () => {
  noteJobs('c', [job('a', 'running')]);
  const store = getStore();
  const aged = { ...store, jobs: [{ ...store.jobs[0], addedAt: new Date(Date.now() - JOB_LIMIT_MS - 1000).toISOString() }] };
  assert.deepEqual(mergeChatJobs([], aged, 'c'), []);
  assert.equal(mergeJobRows([], aged).rows.length, 0);
});

test('caps: at most 20 chats and 50 jobs, the oldest go first', () => {
  for (let index = 0; index < MAX_CHATS + 3; index += 1) begin({ id: `c${index}`, now: Date.now() - (MAX_CHATS + 3 - index) * 1000, owner: user(`m${index}`) });
  assert.equal(getStore().chats.length, MAX_CHATS);
  assert.equal(getStore().chats[0].id, 'c3');
  noteJobs('c', Array.from({ length: MAX_JOBS + 4 }, (_, index) => job(`j${index}`)));
  assert.equal(getStore().jobs.length, MAX_JOBS);
});

test('caps: about 64 KB of text per chat, the owner message stays', () => {
  const before = Array.from({ length: 40 }, (_, index) => bot(`${index} ${'x'.repeat(4000)}`));
  const key = begin({ before });
  setReply(key, 'y'.repeat(100_000), true);
  const [entry] = getStore().chats;
  assert.ok(JSON.stringify([entry.lines, entry.reply]).length <= MAX_BYTES);
  assert.equal(entry.lines.at(-1).text, 'Plan the level');
  assert.ok(entry.reply.length > 0);
});

test('plainLine keeps a line without pictures untouched', () => {
  assert.deepEqual(plainLine(user('Hi')), user('Hi'));
});

test('another tab writing the list is read again', () => {
  begin();
  disk.setItem(STORE_KEY, JSON.stringify({ chats: [], jobs: [] }));
  reloadFromStorage();
  assert.equal(getStore().chats.length, 0);
});

test('blocked storage: the list lives in memory and nothing throws', () => {
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  begin({ id: 'mem' });
  assert.equal(getStore().chats.length, 1);
  assert.equal(mergeChats([], getStore())[0].id, 'mem');
});

test('full storage: the newest half is kept', () => {
  let calls = 0;
  globalThis.localStorage = { getItem: () => null, setItem() { calls += 1; if (calls === 1) throw new Error('quota'); } };
  begin({ id: 'a', owner: user('a') });
  begin({ id: 'b', owner: user('b') });
  assert.ok(getStore().chats.length >= 1);
});
