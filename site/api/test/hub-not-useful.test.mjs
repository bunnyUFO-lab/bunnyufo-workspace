// POST /hub/needs/:kind/:id/not-useful: who may press it, what the Hub finds and writes, and that a second press writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, checklistJson, eventJson, minutesAgo, seeder } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const SITE = 'https://site.example';
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const ASK = `${day}-pick-the-arc-a1b2`;
const REMOTE_ASK = `${day}-which-way-c3d4`;
const LIST = `${day}-finish-setup-e5f6`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-nu-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const post = async (route, data, headers = { 'Remote-User': 'owner' }) => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data ?? {}) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const seed = seeder(fake);
  seed.ask(askJson({ id: ASK, project: 'ml', bead: 'ml-1', now: minutesAgo(NOW, 10) }), { writer: 'agent' });
  seed.ask({ ...askJson({ id: REMOTE_ASK, project: 'ml', now: minutesAgo(NOW, 9), context: 'Header · asked by Claude in ml on pc\nmore' }), kind: 'decision', from: { host: 'pc.example.test', tool: 'claude-code', session: 'sess-rq' } });
  seed.checklist(checklistJson({ id: LIST, project: 'sp', now: minutesAgo(NOW, 8) }));
  const reviewFile = seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 20), project: 'ml', bead: 'ml-2', title: 'PR ready for review: arcs', url: 'https://example.test/pr/9', source: 'dev-sprint' }));
  const blockedFile = seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 15), project: 'sp', session: 'sess-stuck', title: 'Waiting for a permission', source: 'hub-hooks' }));
  const loneFile = seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 12), project: '', title: 'A review with no project' }));
  const keys = prefix => [...fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/${prefix}`)).sort();
  const records = () => keys('feedback/');
  const notUsefulEvents = () => keys('events/').filter(key => /-hub-/.test(key)).map(key => JSON.parse(fake.text(key))).filter(event => event.kind === 'not-useful');
  const needs = async () => (await get('/hub/inbox?filter=all')).body.items.map(item => `${item.kind}:${item.id}`);
  const press = (kind, id, body, headers) => post(`/hub/needs/${kind}/${encodeURIComponent(id)}/not-useful`, body, headers);
  return { fake, get, post, press, records, keys, notUsefulEvents, needs, reviewFile, blockedFile, loneFile, close: async () => { server.close(); await fake.close(); } };
}

test('refusals: signed out is 401; an unknown kind, a bad id and a row that is not in Needs you are 404; a bad body is 400; nothing is written', async () => {
  const { press, records, notUsefulEvents, reviewFile, close } = await fixture();
  try {
    assert.deepEqual([(await press('review', reviewFile, {}, {})).status, (await press('review', reviewFile, {}, {})).body.error], [401, 'Sign in to mark this.']);
    assert.equal((await press('approval', 'req-1', {})).status, 404, 'approvals keep Decline');
    assert.equal((await press('hermes-approval', 'x', {})).status, 404);
    assert.equal((await press('run-question', 'x', {})).status, 404);
    assert.equal((await press('review', 'a/b.json', {})).status, 404, 'a bad id');
    assert.equal((await press('review', '.hidden', {})).status, 404);
    assert.equal((await press('ask', '20261103-ghost-ab12', {})).body.error, 'This is no longer in Needs you.');
    assert.equal((await press('review', 'not-an-event.json', {})).status, 404);
    assert.equal((await press('ask', REMOTE_ASK.replace('c3d4', 'zzzz'), {})).status, 404);
    assert.equal((await press('review', reviewFile, { note: 'x'.repeat(201) })).status, 400);
    assert.equal((await press('review', reviewFile, { preset: 'boring' })).status, 400);
    assert.deepEqual(records(), []);
    assert.deepEqual(notUsefulEvents(), []);
  } finally { await close(); }
});

test('a press files one record, closes the item the way its own close does and posts one event, for each kind', async () => {
  const { press, records, keys, fake, notUsefulEvents, needs, get, reviewFile, blockedFile, loneFile, close } = await fixture();
  try {
    assert.equal((await needs()).length, 6, 'six items wait');
    const rows = [
      ['ask', ASK, 'ml', { preset: 'too-long' }, 'agent'],
      ['ask', REMOTE_ASK, 'ml', { note: 'Claude asked what the code says' }, 'session'],
      ['checklist', LIST, 'sp', { preset: 'nothing-to-decide', note: 'steps are done' }, 'agent'],
      ['review', reviewFile, 'ml', { preset: 'already-done' }, 'hook'],
      ['blocked', blockedFile, 'sp', {}, 'session'],
    ];
    for (const [kind, id, project, body, by] of rows) {
      const answer = await press(kind, id, body);
      assert.equal(answer.status, 201, `${kind} ${JSON.stringify(answer.body)}`);
      assert.deepEqual([answer.body.state, answer.body.project], ['filed', project]);
      const path = `sections/inbox/feedback/${project}/${kind}/${id}/not-useful.json`;
      const record = JSON.parse(fake.text(path));
      assert.deepEqual([record.v, record.project, record.item, record.by, record.source.by, record.key], [1, project, { kind, id }, 'owner', by, answer.body.key]);
      assert.equal(fake.objects.get(path).metadata?.writer, undefined, 'the Hub writes it with no writer mark');
      assert.ok(record.copy.row && record.copy.raw, 'a copy of the row and of its source');
      assert.deepEqual(Object.keys(record.reason), Object.keys(body));
    }
    assert.equal(records().length, 5, 'exactly one record each');
    assert.equal(notUsefulEvents().length, 5, 'one event each');
    const sample = notUsefulEvents().find(event => event.item.kind === 'ask' && event.item.id === ASK);
    assert.deepEqual([sample.title, sample.project, sample.reason, sample.bead, sample.host, sample.by], ['Not useful: Which jump arc feels right?', 'ml', 'Too long', 'ml-1', 'hub', 'owner']);
    assert.equal(sample.record, `feedback/ml/ask/${ASK}/not-useful.json`);
    // The close: an Ask and a list are cancelled, a review and a session are marked done.
    assert.ok(fake.text(`sections/inbox/asks/${ASK}/cancel.json`));
    assert.ok(fake.text(`sections/inbox/asks/${REMOTE_ASK}/cancel.json`));
    assert.equal(JSON.parse(fake.text(`sections/inbox/checklists/${LIST}/cancel.json`)).notUseful, true);
    const done = keys('events/').map(key => JSON.parse(fake.text(key))).filter(event => event.kind === 'review-done').map(event => event.review).sort();
    assert.deepEqual(done, [blockedFile, reviewFile].sort());
    // Gone from Needs you everywhere; only the item with no project is left.
    assert.deepEqual(await needs(), [`review:${loneFile}`]);
    const today = (await get('/hub/today')).body;
    assert.equal(today.counts.needsYou, 1);
    assert.equal(today.needsYou.length, 1);
  } finally { await close(); }
});

test('a second press is 200 filed-before and writes no second record, event or close, even after the item left Needs you', async () => {
  const { press, records, keys, notUsefulEvents, reviewFile, close } = await fixture();
  try {
    for (const [kind, id] of [['review', reviewFile], ['ask', ASK], ['checklist', LIST]]) {
      const first = await press(kind, id, { preset: 'unclear' });
      assert.equal(first.status, 201, `${kind} ${JSON.stringify(first.body)}`);
      const filesBefore = keys('').length;
      const again = await press(kind, id, { preset: 'too-long' });
      assert.deepEqual([again.status, again.body.state, again.body.key], [200, 'filed-before', first.body.key], kind);
      assert.equal(keys('').length, filesBefore, `${kind}: nothing new is written`);
    }
    assert.equal(records().length, 3);
    assert.equal(notUsefulEvents().length, 3);
  } finally { await close(); }
});

test('a record that already exists closes an item that is still waiting, and a project in the body is ignored', async () => {
  const { press, fake, records, needs, reviewFile, close } = await fixture();
  try {
    // A record filed before whose close never happened: the second press finishes the close and writes nothing else.
    fake.seed(`sections/inbox/feedback/ml/review/${reviewFile}/not-useful.json`, JSON.stringify({ v: 1, project: 'ml', item: { kind: 'review', id: reviewFile }, key: 'abcd1234', title: 'PR ready' }), 'application/json');
    assert.ok((await needs()).includes(`review:${reviewFile}`));
    const again = await press('review', reviewFile, {});
    assert.deepEqual([again.status, again.body.state, again.body.key], [200, 'filed-before', 'abcd1234']);
    assert.ok(!(await needs()).includes(`review:${reviewFile}`), 'the item left');
    assert.equal(records().length, 1);
    // The project comes from the server's row.
    const answer = await press('ask', ASK, { project: 'workspace-app', preset: 'too-long' });
    assert.equal(answer.body.project, 'ml');
    assert.ok(fake.text(`sections/inbox/feedback/ml/ask/${ASK}/not-useful.json`));
    assert.equal(fake.text(`sections/inbox/feedback/workspace-app/ask/${ASK}/not-useful.json`), null);
  } finally { await close(); }
});

test('a row with no project is filed under workspace-app', async () => {
  const { press, fake, loneFile, close } = await fixture();
  try {
    const answer = await press('review', loneFile, { note: 'No idea where this came from' });
    assert.deepEqual([answer.status, answer.body.project], [201, 'workspace-app']);
    const record = JSON.parse(fake.text(`sections/inbox/feedback/workspace-app/review/${loneFile}/not-useful.json`));
    assert.deepEqual([record.project, record.reasonText, record.reason], ['workspace-app', 'No idea where this came from', { note: 'No idea where this came from' }]);
  } finally { await close(); }
});

test('a record put through the card API (a writer mark) is never taken for the owner\'s', async () => {
  const { press, fake, reviewFile, close } = await fixture();
  try {
    fake.seed(`sections/inbox/feedback/ml/review/${reviewFile}/not-useful.json`, '{"v":1}', 'application/json', { writer: 'card-api' });
    const answer = await press('review', reviewFile, {});
    assert.equal(answer.status, 409);
  } finally { await close(); }
});
