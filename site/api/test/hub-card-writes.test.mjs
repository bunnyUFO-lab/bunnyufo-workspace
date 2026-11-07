// The Hub's side of agent cards in a project section: the rows (who wrote what), Revert, and the setting. Records are made by
// the real card API handler over the stand-in S3, so the Hub reads exactly what it will read live. The `inbox` keys are
// fixtures in that fake, never the real bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub, inboxKey } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';
import { createCardApi, parseTokens } from '../../card-api/handler.mjs';
import { checkRecord, groupRows, settingOf } from '../hub-card-writes.mjs';

const SITE = 'https://site.example';
const sha = text => createHash('sha256').update(text).digest('hex');
const md5 = text => createHash('md5').update(text).digest('hex');
const WHO = { 'x-card-agent': 'Researcher', 'x-card-why': encodeURIComponent('Notes for the owner') };
const CREATE = (batch = 'batch0001') => ({ 'if-none-match': '*', 'x-card-batch': batch, ...WHO });
const EDIT = (etag, batch = 'batch0002') => ({ 'if-match': `"${etag}"`, 'x-card-context': 'job:20261105-x-a1b2', 'x-card-batch': batch, ...WHO });

const owned = { id: 'owner-card', folder: '2026-11-01_owner', title: 'Owner card', description: 'Mine.', category: 'plan', created: '2026-11-01', status: 'active', type: 'standalone', steps: [{ name: 'Notes', path: 'index.md' }] };

async function world({ env = {}, sections = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-card-writes-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const list = (id, body) => fake.seed(`sections/${id}/workspace.json`, JSON.stringify(body), 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  list('magic-loops', { name: 'Magic Loops', entities: [owned] });
  fake.seed(`sections/magic-loops/${owned.folder}/index.md`, '# Owner', 'text/markdown');
  list('assistant', { name: 'Assistant', entities: [] });
  list('hidden-sec', { name: 'Hidden', hidden: true, entities: [] });
  list('archived-sec', { name: 'Archived', archived: true, entities: [] });
  list('inbox', { name: 'Inbox', hidden: true, entities: [] });
  list('dev-x', { name: 'Dev x', entities: [owned] });
  fake.seed(`sections/dev-x/${owned.folder}/index.md`, '# Owner', 'text/markdown');
  for (const [id, body] of Object.entries(sections)) list(id, body);
  const clock = { at: 1_800_000_000_000 };
  const tokens = parseTokens([`all=${sha('tok-all')}`, `lib=${sha('tok-lib')}:read=*;write=inbox|assistant|@library`].join(', '));
  const api = createCardApi({ bucket, tokens, today: () => '2026-11-05', now: () => clock.at });
  const hub = createHub({ bucket, enabled: true, env, inbox: env.BUW_DEV === '1' ? 'inbox-dev' : 'inbox', now: () => new Date(clock.at) });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`, { headers: { 'Remote-User': 'owner' } }); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const post = async (route, data, user = 'owner') => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', ...(user ? { 'Remote-User': user } : {}) }, body: JSON.stringify(data) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const agent = async (method, rawPath, { body, headers = {} } = {}) => {
    clock.at += 1000;
    const response = await api({ requestContext: { http: { method } }, rawPath, headers: { Authorization: 'Bearer tok-lib', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.statusCode, data: JSON.parse(response.body) };
  };
  const put = (section, file, text, headers = CREATE()) => agent('PUT', `/sections/${section}/files/${file}`, { body: text, headers: { 'content-type': 'text/plain', ...headers } });
  const entry = (section, id, body, headers = { ...WHO, 'x-card-batch': 'batch0001' }) => agent('PUT', `/sections/${section}/cards/${id}`, { body, headers });
  const listOf = section => fake.json(`sections/${section}/workspace.json`);
  const reverts = () => [...fake.objects.keys()].filter(key => key.endsWith('-revert.json'));
  return { fake, get, post, put, entry, agent, listOf, reverts, clock, seed: (key, body, type, meta) => fake.seed(key, body, type, meta), close: async () => { server.close(); await fake.close(); } };
}

/** The agent adds a new tab to the owner's card, edits its index.md, and makes a card of its own. */
async function seedWrites(w) {
  assert.equal((await w.put('magic-loops', `${owned.folder}/notes.md`, '# Agent notes', CREATE('tabbatch1'))).status, 200);
  const tab = await w.entry('magic-loops', owned.id, { ...owned, steps: [...owned.steps, { name: 'Agent notes', path: 'notes.md' }] }, { ...WHO, 'x-card-batch': 'tabbatch1' });
  assert.equal(tab.status, 200, JSON.stringify(tab.data));
  assert.equal((await w.put('magic-loops', `${owned.folder}/index.md`, '# Owner, edited', EDIT(md5('# Owner'), 'editbatch1'))).status, 200);
  assert.equal((await w.put('magic-loops', '2026-11-05_agent/index.md', '# New', CREATE('cardbatch1'))).status, 200);
  const card = await w.entry('magic-loops', 'agent-card', { id: 'agent-card', title: 'Agent card', folder: '2026-11-05_agent', steps: [{ name: 'Notes', path: 'index.md' }] }, { ...WHO, 'x-card-batch': 'cardbatch1' });
  assert.equal(card.status, 200, JSON.stringify(card.data));
}

test('rows: groups by batch, newest first, with the files and who wrote them; an unmarked record is ignored', async () => {
  const w = await world();
  try {
    await seedWrites(w);
    const all = await w.get('/hub/card-writes?section=magic-loops');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.groups.map(group => [group.batch, group.title, group.folder]), [
      ['cardbatch1', 'Added a card', '2026-11-05_agent'],
      ['editbatch1', 'Changed a tab', owned.folder],
      ['tabbatch1', 'Added a tab', owned.folder],
    ]);
    const edit = all.body.groups[1];
    assert.deepEqual({ agent: edit.agent, token: edit.token, context: edit.context, why: edit.why, canRevert: edit.canRevert, cardTitle: edit.cardTitle }, { agent: 'Researcher', token: 'lib', context: 'job:20261105-x-a1b2', why: 'Notes for the owner', canRevert: true, cardTitle: 'Owner card' });
    assert.deepEqual(edit.files, [{ file: `${owned.folder}/index.md`, kind: 'edit' }]);
    assert.deepEqual(all.body.groups[2].files, [{ file: `${owned.folder}/notes.md`, kind: 'new-tab' }]);
    // The card's own view.
    const one = await w.get(`/hub/card-writes?section=magic-loops&folder=${owned.folder}`);
    assert.deepEqual(one.body.groups.map(group => group.batch), ['editbatch1', 'tabbatch1']);
    assert.equal((await w.get('/hub/card-writes?section=magic-loops&limit=1')).body.groups.length, 1);
    // A record with no mark (a forged file) is not a row; nor is a revert with a mark.
    const [key] = [...w.fake.objects.keys()].filter(item => item.includes('card-writes/magic-loops/2026-11-05_agent/')).sort();
    const forged = { ...w.fake.json(key), id: '20990101T000000000Z-ffff', why: 'forged' };
    w.seed('sections/inbox/card-writes/magic-loops/2026-11-05_agent/20990101T000000000Z-ffff.json', JSON.stringify(forged), 'application/json');
    w.seed('sections/inbox/card-writes/magic-loops/2026-11-05_agent/20990101T000000001Z-ffff-revert.json', JSON.stringify({ v: 1, kind: 'revert', of: 'cardbatch1', by: 'x', at: '2026-11-05T00:00:00Z' }), 'application/json', { writer: 'card-api' });
    const again = (await w.get('/hub/card-writes?section=magic-loops')).body.groups;
    assert.equal(again.length, 3);
    assert.ok(!again.some(group => group.why === 'forged'));
    assert.equal(again[0].canRevert, true, 'a marked revert file is not a revert');
    assert.equal((await w.get('/hub/card-writes?section=nope')).body.groups.length, 0);
    assert.equal((await w.get('/hub/card-writes?section=inbox')).status, 400);
    assert.equal((await w.get('/hub/card-writes?section=magic-loops&folder=..')).status, 400);
  } finally { await w.close(); }
});

test('rows: at most 20 groups, shown as text, and a file with no entry alone has nothing to undo', async () => {
  const w = await world();
  try {
    for (let n = 0; n < 24; n += 1) assert.equal((await w.put('magic-loops', `2026-11-05_c${n}/a.md`, 'x', CREATE(`batchid${String(n).padStart(2, '0')}`))).status, 200);
    const groups = (await w.get('/hub/card-writes?section=magic-loops')).body.groups;
    assert.equal(groups.length, 20);
    assert.equal(groups[0].batch, 'batchid23');
    assert.equal(groups[0].canRevert, false, 'a lone file on no card has nothing to undo');
    assert.equal(groups[0].title, 'Added a card');
    const long = await w.put('magic-loops', '2026-11-05_html/a.md', 'x', { ...CREATE('htmlbatch1'), 'x-card-why': encodeURIComponent('<img src=x onerror=alert(1)> then some') });
    assert.equal(long.status, 200);
    const row = (await w.get('/hub/card-writes?section=magic-loops&folder=2026-11-05_html')).body.groups[0];
    assert.equal(row.why, '<img src=x onerror=alert(1)> then some', 'the text is data: the page escapes it');
  } finally { await w.close(); }
});

test('Revert an edit: the old bytes come back as a new version, conditional on the current one', async () => {
  const w = await world();
  try {
    await seedWrites(w);
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const before = w.fake.objects.get(key);
    assert.equal(before.body.toString(), '# Owner, edited');
    const answer = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.restored, [`${owned.folder}/index.md`]);
    assert.equal(answer.body.recorded, true);
    const after = w.fake.objects.get(key);
    assert.equal(after.body.toString(), '# Owner');
    assert.notEqual(after.versionId, before.versionId, 'a new current version, not the old one moved');
    assert.equal(after.metadata.writer, undefined, 'the owner wrote it: no agent mark');
    assert.equal(after.contentType, 'text/markdown', 'the old version keeps its type');
    const put = w.fake.log.filter(item => item.method === 'PUT' && item.key === key).at(-1);
    assert.equal(put.headers['if-match'], `"${md5('# Owner, edited')}"`);
    assert.ok(!w.fake.log.some(item => item.method === 'DELETE'), 'no object is removed');
    assert.equal(w.reverts().length, 1);
    const rows = (await w.get('/hub/card-writes?section=magic-loops')).body.groups;
    const row = rows.find(group => group.batch === 'editbatch1');
    assert.equal(row.canRevert, false);
    assert.equal(row.reverted.by, 'owner');
    // A second Revert.
    const twice = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' });
    assert.deepEqual([twice.status, twice.body.error], [409, 'Already reverted.']);
  } finally { await w.close(); }
});

test('Revert an edit after a later write: 409 and nothing changes; a missing earlier version, and one that cannot be read', async () => {
  const w = await world();
  try {
    await seedWrites(w);
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const newer = await w.put('magic-loops', `${owned.folder}/index.md`, '# Owner, edited again', EDIT(md5('# Owner, edited'), 'editbatch2'));
    assert.equal(newer.status, 200);
    const stale = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /Revert the newer write first/);
    assert.equal(w.fake.text(key), '# Owner, edited again');
    assert.equal(w.reverts().length, 0);
    // The newest write goes back, then the older one.
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch2' })).status, 200);
    assert.equal(w.fake.text(key), '# Owner, edited');
    // Before the permission is in place the Hub gets 403 for an old version.
    w.fake.fail = (_key, method, query) => method === 'GET' && query.has('versionId') && 403;
    const denied = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' });
    assert.deepEqual([denied.status, denied.body.error], [503, 'The Hub cannot read older versions yet.']);
    assert.equal(w.fake.text(key), '# Owner, edited', 'nothing changed');
    w.fake.fail = null;
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' })).status, 200);
    assert.equal(w.fake.text(key), '# Owner');
    // An edit whose record saw no earlier version cannot go back.
    assert.equal((await w.put('magic-loops', `${owned.folder}/index.md`, '# third', EDIT(md5('# Owner'), 'editbatch3'))).status, 200);
    const record = [...w.fake.objects.keys()].find(item => item.includes('card-writes/magic-loops/') && w.fake.json(item).batch === 'editbatch3');
    w.seed(record, JSON.stringify({ ...w.fake.json(record), previousVersionId: null }), 'application/json', { writer: 'card-api' });
    const none = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch3' });
    assert.equal(none.status, 409);
    assert.match(none.body.error, /No earlier version/);
  } finally { await w.close(); }
});

test('Revert with several files: one that cannot go back changes none; a race midway is partial and says what went back', async () => {
  const w = await world();
  try {
    const folder = owned.folder;
    for (const name of ['a.md', 'b.md']) assert.equal((await w.put('magic-loops', `${folder}/${name}`, `# ${name} v1`, CREATE(`seed${name[0]}00001`))).status, 200);
    const batch = { ...EDIT(md5('# a.md v1'), 'multibatch1') };
    assert.equal((await w.put('magic-loops', `${folder}/a.md`, '# a.md v2', batch)).status, 200);
    assert.equal((await w.put('magic-loops', `${folder}/b.md`, '# b.md v2', { ...EDIT(md5('# b.md v1'), 'multibatch1') })).status, 200);
    // Put b.md back to what the batch wrote, then make the second put lose a race.
    w.seed(`sections/magic-loops/${folder}/b.md`, '# b.md v2', 'text/markdown');
    const bKey = `sections/magic-loops/${folder}/b.md`;
    const records = [...w.fake.objects.keys()].filter(item => item.includes('card-writes/magic-loops/') && w.fake.json(item).batch === 'multibatch1');
    const b = records.find(item => w.fake.json(item).file.endsWith('b.md'));
    w.seed(b, JSON.stringify({ ...w.fake.json(b), etag: md5('# b.md v2') }), 'application/json', { writer: 'card-api' });
    let raced = false;
    const original = w.fake.objects.get(bKey);
    w.fake.fail = (key, method) => { if (!raced && method === 'PUT' && key === bKey) { raced = true; w.fake.seed(bKey, '# b.md owner again', 'text/markdown'); } return false; };
    const partial = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'multibatch1' });
    w.fake.fail = null;
    assert.ok(original);
    assert.equal(partial.status, 409);
    assert.equal(partial.body.partial, true);
    assert.deepEqual(partial.body.restored, [`${folder}/a.md`]);
    assert.match(partial.body.error, /Only part of this went back/);
    assert.equal(w.fake.text(`sections/magic-loops/${folder}/a.md`), '# a.md v1');
    assert.equal(w.fake.text(bKey), '# b.md owner again', 'the owner\'s newer write is not overwritten');
    const row = w.fake.json(w.reverts()[0]);
    assert.deepEqual({ of: row.of, partial: row.partial, restored: row.restored }, { of: 'multibatch1', partial: true, restored: [`${folder}/a.md`] });
  } finally { await w.close(); }
});

test('Revert a new tab and a new card: the tab goes to removedTabs, the card to the Trash, and no object is removed', async () => {
  const w = await world();
  try {
    await seedWrites(w);
    const tab = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'tabbatch1' });
    assert.equal(tab.status, 200, JSON.stringify(tab.body));
    assert.deepEqual(tab.body.removedTabs, ['notes.md']);
    const afterTab = w.listOf('magic-loops').entities.find(item => item.id === owned.id);
    assert.deepEqual(afterTab.steps.map(step => step.path), ['index.md']);
    assert.deepEqual(afterTab.removedTabs.map(step => step.path), ['notes.md']);
    assert.equal(afterTab.removedTabs[0].agentTab, true, 'the "+" form brings it back as it was');
    assert.ok(w.fake.objects.has(`sections/magic-loops/${owned.folder}/notes.md`), 'the file stays in the folder');
    const card = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: '2026-11-05_agent', batch: 'cardbatch1' });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    assert.deepEqual(card.body.trashed, ['agent-card']);
    const list = w.listOf('magic-loops');
    assert.deepEqual(list.entities.map(item => item.id), ['owner-card']);
    assert.equal(list.retired['agent-card'].kind, 'deleted');
    assert.ok(w.fake.objects.has('sections/magic-loops/2026-11-05_agent/index.md'));
    assert.ok(!w.fake.log.some(item => item.method === 'DELETE'));
    // The owner already took the tab off by hand: nothing to do, and the Revert is still recorded.
    await w.put('magic-loops', `${owned.folder}/more.md`, 'x', CREATE('moretab001'));
    await w.entry('magic-loops', owned.id, { ...owned, steps: [...owned.steps, { name: 'More', path: 'more.md' }] }, { ...WHO, 'x-card-batch': 'moretab001' });
    const edited = w.listOf('magic-loops');
    edited.entities[0].steps = edited.entities[0].steps.filter(step => step.path !== 'more.md');
    w.seed('sections/magic-loops/workspace.json', JSON.stringify(edited), 'application/json');
    const gone = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'moretab001' });
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body.removedTabs, []);
  } finally { await w.close(); }
});

test('Revert: a file with no entry stays and is skipped; a group of files alone has nothing to undo', async () => {
  const w = await world();
  try {
    await w.put('magic-loops', `${owned.folder}/pic.png`, 'png', CREATE('assetbatch'));
    await w.put('magic-loops', `${owned.folder}/tab.md`, 'x', CREATE('assetbatch'));
    await w.entry('magic-loops', owned.id, { ...owned, steps: [...owned.steps, { name: 'Tab', path: 'tab.md' }] }, { ...WHO, 'x-card-batch': 'assetbatch' });
    const answer = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'assetbatch' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.skipped, [`${owned.folder}/pic.png`]);
    assert.ok(w.fake.objects.has(`sections/magic-loops/${owned.folder}/pic.png`));
    await w.put('magic-loops', '2026-11-05_lone/a.md', 'x', CREATE('lonebatch1'));
    const lone = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: '2026-11-05_lone', batch: 'lonebatch1' });
    assert.equal(lone.status, 409);
  } finally { await w.close(); }
});

test('Revert: sign-in is needed, bad ids are refused, an unknown write is 404, and the development copy touches only dev- sections', async () => {
  const w = await world();
  const dev = await world({ env: { BUW_DEV: '1' } });
  try {
    await seedWrites(w);
    const body = { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' };
    assert.equal((await w.post('/hub/card-writes/revert', body, null)).status, 401);
    assert.equal((await w.post('/hub/card-writes/revert', { ...body, batch: '../x' })).status, 400);
    assert.equal((await w.post('/hub/card-writes/revert', { ...body, folder: '../x' })).status, 400);
    assert.equal((await w.post('/hub/card-writes/revert', { ...body, section: 'inbox' })).status, 400);
    assert.equal((await w.post('/hub/card-writes/revert', { ...body, batch: 'nosuchbatch' })).status, 404);
    // Even with records in place, the development copy refuses a real section before it reads them.
    await seedWrites(dev);
    const refused = await dev.post('/hub/card-writes/revert', body);
    assert.deepEqual([refused.status, refused.body.error], [403, 'The development copy writes only dev-… sections.']);
    assert.equal(dev.fake.text(`sections/magic-loops/${owned.folder}/index.md`), '# Owner, edited');
    assert.equal((await dev.post('/hub/card-write-sections', { section: 'magic-loops', on: false })).status, 403);
  } finally { await w.close(); await dev.close(); }
});

test('the setting: an explicit list is saved, conditionally; assistant and non-Library sections are refused; real and development lists differ', async () => {
  const w = await world();
  const dev = await world({ env: { BUW_DEV: '1' } });
  try {
    const first = await w.get('/hub/card-write-sections');
    assert.deepEqual(first.body.sections.map(item => [item.id, item.on, item.locked ?? false]), [['assistant', true, true], ['magic-loops', true, false]]);
    assert.equal(first.body.saved, false);
    assert.equal(w.fake.text('sections/inbox/library-writes.json'), null, 'reading writes nothing');
    assert.equal((await w.post('/hub/card-write-sections', { section: 'magic-loops', on: true }, null)).status, 401);
    // Saving with nothing off still writes the file, so the card API never reads a missing key.
    const saved = await w.post('/hub/card-write-sections', { save: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.saved, true);
    const file = w.fake.json('sections/inbox/library-writes.json');
    assert.deepEqual({ v: file.v, off: file.off, by: file.by }, { v: 1, off: [], by: 'owner' });
    assert.equal(w.fake.objects.get('sections/inbox/library-writes.json').metadata.writer, undefined, 'the Hub writes it with no mark');
    const off = await w.post('/hub/card-write-sections', { section: 'magic-loops', on: false });
    assert.equal(off.body.sections.find(item => item.id === 'magic-loops').on, false);
    assert.deepEqual(w.fake.json('sections/inbox/library-writes.json').off, ['magic-loops']);
    const put = w.fake.log.filter(item => item.method === 'PUT' && item.key === 'sections/inbox/library-writes.json');
    assert.equal(put[0].headers['if-none-match'], '*');
    assert.equal(put[1].headers['if-match'], `"${md5(JSON.stringify({ v: 1, off: [], at: file.at, by: 'owner' }, null, 2) + '\n')}"`);
    // Every refusal.
    for (const data of [{ section: 'assistant', on: false }, { section: 'hidden-sec', on: false }, { section: 'archived-sec', on: false }, { section: 'inbox', on: false }, { section: 'dev-x', on: false }, { section: 'nope', on: false }, { section: 'magic-loops' }, {}]) {
      assert.equal((await w.post('/hub/card-write-sections', data)).status, 400, JSON.stringify(data));
    }
    // The development copy lists only dev- sections and has its own file.
    const devList = await dev.get('/hub/card-write-sections');
    assert.deepEqual(devList.body.sections.map(item => item.id), ['assistant', 'dev-x']);
    assert.equal((await dev.post('/hub/card-write-sections', { section: 'dev-x', on: false })).status, 200);
    assert.deepEqual(dev.fake.json('sections/inbox-dev/library-writes.json').off, ['dev-x']);
    assert.equal(dev.fake.text('sections/inbox/library-writes.json'), null);
    // On again.
    const back = await w.post('/hub/card-write-sections', { section: 'magic-loops', on: true });
    assert.equal(back.body.sections.find(item => item.id === 'magic-loops').on, true);
  } finally { await w.close(); await dev.close(); }
});

test('the setting: a lost race is tried again; a file the card API cannot read has everything off, and saving keeps that', async () => {
  const w = await world({ sections: { other: { name: 'Other', entities: [] } } });
  try {
    await w.post('/hub/card-write-sections', { save: true });
    // Someone else turns `other` off between the read and the write: the retry keeps both.
    let raced = false;
    w.fake.fail = (key, method) => {
      if (!raced && method === 'PUT' && key === 'sections/inbox/library-writes.json') { raced = true; w.fake.seed(key, JSON.stringify({ v: 1, off: ['other'], at: 'x', by: 'y' }), 'application/json'); }
      return false;
    };
    const answer = await w.post('/hub/card-write-sections', { section: 'magic-loops', on: false });
    w.fake.fail = null;
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(w.fake.json('sections/inbox/library-writes.json').off, ['magic-loops', 'other']);
    // A marked file counts as everything off.
    w.seed('sections/inbox/library-writes.json', JSON.stringify({ v: 1, off: [] }), 'application/json', { writer: 'card-api' });
    const view = await w.get('/hub/card-write-sections');
    assert.equal(view.body.unreadable, true);
    assert.deepEqual(view.body.sections.map(item => item.on), [true, false, false]);
    const fixed = await w.post('/hub/card-write-sections', { section: 'other', on: true });
    assert.equal(fixed.body.unreadable, undefined);
    assert.deepEqual(w.fake.json('sections/inbox/library-writes.json').off, ['magic-loops']);
    assert.equal(w.fake.objects.get('sections/inbox/library-writes.json').metadata.writer, undefined);
  } finally { await w.close(); }
});

test('project-cards says whether agents may write there', async () => {
  const w = await world();
  try {
    assert.equal((await w.get('/hub/project-cards?project=magic-loops')).body.agents, true);
    await w.post('/hub/card-write-sections', { section: 'magic-loops', on: false });
    assert.equal((await w.get('/hub/project-cards?project=magic-loops')).body.agents, false);
    assert.equal((await w.get('/hub/project-cards?project=hidden-sec')).body.agents, false);
  } finally { await w.close(); }
});

test('inboxKey reaches library-writes.json as that exact name only, and card-writes/ as a folder', () => {
  assert.equal(inboxKey('library-writes.json'), 'sections/inbox/library-writes.json');
  assert.equal(inboxKey('library-writes.json', 'sections', 'inbox-dev'), 'sections/inbox-dev/library-writes.json');
  assert.equal(inboxKey('presence.json'), 'sections/inbox/presence.json');
  for (const bad of ['library-writes.json/x', 'Library-writes.json', 'library-writes.jsonx', 'other.json', 'a/../library-writes.json', 'card-writes', 'card-writes/']) {
    assert.throws(() => inboxKey(bad), /not in the inbox/, bad);
  }
  assert.equal(inboxKey('card-writes/magic-loops/f/x.json'), 'sections/inbox/card-writes/magic-loops/f/x.json');
});

test('helpers: a record that is not the card API\'s shape is dropped, and a file the card API cannot read is bad', () => {
  const ok = { v: 1, id: '20261105T000000000Z-abcd', section: 's', folder: 'f', file: 'f/a.md', kind: 'edit', entry: false, agent: 'A', token: 't', why: 'w', at: '2026-11-05T00:00:00.000Z' };
  assert.ok(checkRecord(ok, { section: 's', folder: 'f' }));
  for (const bad of [{ ...ok, v: 2 }, { ...ok, id: 'x' }, { ...ok, section: 'z' }, { ...ok, folder: 'z' }, { ...ok, kind: 'delete' }, { ...ok, entry: true }, null, []]) assert.equal(checkRecord(bad, { section: 's', folder: 'f' }), null);
  assert.equal(checkRecord({ ...ok, context: '<b>' }, { section: 's', folder: 'f' }).context, null);
  assert.equal(groupRows([], []).length, 0);
  assert.equal(settingOf(null).state, 'missing');
  assert.equal(settingOf({ text: '{"v":1,"off":["a"]}', etag: 'e', metadata: {} }).state, 'ok');
  assert.equal(settingOf({ text: '{"v":1,"off":["a"]}', etag: 'e', metadata: { writer: 'card-api' } }).state, 'bad');
  assert.equal(settingOf({ text: '{"v":1,"off":"a"}', etag: 'e', metadata: {} }).state, 'bad');
  assert.equal(settingOf({ text: 'nope', etag: 'e', metadata: {} }).state, 'bad');
});

const htmlCard = { id: 'page-card', folder: '2026-11-01_page', title: 'Page card', description: 'Has a page.', category: 'plan', created: '2026-11-01', status: 'active', type: 'standalone', steps: [{ name: 'Page', path: 'page.html' }, { name: 'Notes', path: 'index.md' }] };

test('Revert of an edit to an HTML tab puts the text back and clears the agentTab mark, so the bridge comes back', async () => {
  const w = await world({ sections: { html: { name: 'Html', entities: [htmlCard] } } });
  try {
    w.seed(`sections/html/${htmlCard.folder}/page.html`, '<p>owner</p>', 'text/html');
    w.seed(`sections/html/${htmlCard.folder}/index.md`, '# owner', 'text/markdown');
    const edit = await w.put('html', `${htmlCard.folder}/page.html`, '<p>agent</p>', EDIT(md5('<p>owner</p>'), 'htmledit001'));
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    assert.equal(w.listOf('html').entities[0].steps[0].agentTab, true, 'the edit marked the step');
    // A second edit of the Markdown tab never marks it.
    const answer = await w.post('/hub/card-writes/revert', { section: 'html', folder: htmlCard.folder, batch: 'htmledit001' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(w.fake.text(`sections/html/${htmlCard.folder}/page.html`), '<p>owner</p>');
    const steps = w.listOf('html').entities[0].steps;
    assert.deepEqual(steps[0], { name: 'Page', path: 'page.html' }, 'the mark is gone');
    assert.deepEqual(steps[1], { name: 'Notes', path: 'index.md' });
    assert.deepEqual(answer.body.clearedMarks, ['page.html']);
  } finally { await w.close(); }
});

test('Revert of a new HTML tab leaves the tab off and does not touch other tabs\' marks', async () => {
  const w = await world({ sections: { html: { name: 'Html', entities: [{ ...htmlCard, steps: [{ name: 'Page', path: 'page.html', agentTab: true }] }] } } });
  try {
    w.seed(`sections/html/${htmlCard.folder}/page.html`, '<p>owner</p>', 'text/html');
    await w.put('html', `${htmlCard.folder}/more.html`, '<p>more</p>', CREATE('htmlnew0001'));
    await w.entry('html', htmlCard.id, { ...htmlCard, steps: [{ name: 'Page', path: 'page.html' }, { name: 'More', path: 'more.html' }] }, { ...WHO, 'x-card-batch': 'htmlnew0001' });
    const answer = await w.post('/hub/card-writes/revert', { section: 'html', folder: htmlCard.folder, batch: 'htmlnew0001' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const card = w.listOf('html').entities[0];
    assert.deepEqual(card.steps.map(step => [step.path, step.agentTab ?? false]), [['page.html', true]]);
    assert.deepEqual(card.removedTabs.map(step => [step.path, step.agentTab]), [['more.html', true]], 'the "+" form brings it back marked');
  } finally { await w.close(); }
});

test('a batch id reused after a Revert: the later write has its own row and its own Revert, whatever it is labelled', async () => {
  const w = await world();
  try {
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const same = { 'x-card-batch': 'reuse000001' };
    const first = await w.put('magic-loops', `${owned.folder}/index.md`, '# first edit', { ...EDIT(md5('# Owner')), ...same });
    assert.equal(first.status, 200);
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'reuse000001' })).status, 200);
    assert.equal(w.fake.text(key), '# Owner');
    const later = await w.put('magic-loops', `${owned.folder}/index.md`, '# bad later edit', { ...EDIT(md5('# Owner')), ...same, 'x-card-why': encodeURIComponent('A different reason') });
    assert.equal(later.status, 200);
    const rows = (await w.get(`/hub/card-writes?section=magic-loops&folder=${owned.folder}`)).body.groups;
    assert.equal(rows.length, 2, 'two rows, not one');
    assert.deepEqual(rows.map(row => [row.why, row.canRevert, Boolean(row.reverted)]), [['A different reason', true, false], ['Notes for the owner', false, true]]);
    const again = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'reuse000001' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(w.fake.text(key), '# Owner', 'the later edit goes back too');
    const after = (await w.get(`/hub/card-writes?section=magic-loops&folder=${owned.folder}`)).body.groups;
    assert.deepEqual(after.map(row => Boolean(row.reverted)), [true, true]);
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'reuse000001' })).body.error, 'Already reverted.');
  } finally { await w.close(); }
});

test('a Revert that loses a race with nothing yet put back says the file changed, not that the storage is down', async () => {
  const w = await world();
  try {
    await seedWrites(w);
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    let raced = false;
    w.fake.fail = (k, method) => { if (!raced && method === 'PUT' && k === key) { raced = true; w.fake.seed(key, '# owner again', 'text/markdown'); } return false; };
    const lost = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' });
    w.fake.fail = null;
    assert.equal(lost.status, 409);
    assert.match(lost.body.error, /index\.md changed while it was being put back/);
    assert.doesNotMatch(lost.body.error, /inbox|pre-condition/);
    assert.equal(w.fake.text(key), '# owner again', 'nothing was overwritten');
    assert.equal(w.reverts().length, 0, 'nothing went back, so no revert record');
    // The list write: it keeps losing.
    const real = w.fake.json('sections/magic-loops/workspace.json');
    let n = 0;
    w.fake.fail = (k, method) => { if (method === 'PUT' && k === 'sections/magic-loops/workspace.json') { n += 1; w.fake.seed(k, JSON.stringify({ ...real, name: `Magic ${n}` }), 'application/json'); } return false; };
    const list = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'tabbatch1' });
    w.fake.fail = null;
    assert.equal(list.status, 409);
    assert.match(list.body.error, /changed while it was being put back/);
  } finally { await w.close(); }
});

test('rows are cheap: a record is read once for good, a repeat or a poll lists and reads nothing more, and reads are pooled', async () => {
  const w = await world();
  try {
    for (let n = 0; n < 30; n += 1) assert.equal((await w.put('magic-loops', `2026-11-05_c${n}/a.md`, 'x', CREATE(`cheapbat${String(n).padStart(2, '0')}`))).status, 200);
    const reads = () => w.fake.log.filter(item => item.method === 'GET' && item.key.includes('card-writes/')).length;
    const first = (await w.get('/hub/card-writes?section=magic-loops')).body.groups;
    assert.equal(first.length, 20);
    const afterFirst = reads();
    assert.equal(afterFirst, 30, 'each of the 30 records read once');
    // Poll again, and a card view and a smaller limit.
    await w.get('/hub/card-writes?section=magic-loops');
    await w.get('/hub/card-writes?section=magic-loops&limit=10');
    await w.get('/hub/card-writes?section=magic-loops&folder=2026-11-05_c3');
    assert.equal(reads(), 30, 'no record was read twice');
    // A record overwritten with other bytes (same key, new etag) is read again, not served from memory.
    const key = [...w.fake.objects.keys()].find(item => item.includes('card-writes/magic-loops/2026-11-05_c3/'));
    w.seed(key, JSON.stringify({ ...w.fake.json(key), why: 'rewritten' }), 'application/json', { writer: 'card-api' });
    const row = (await w.get('/hub/card-writes?section=magic-loops&folder=2026-11-05_c3')).body.groups[0];
    assert.equal(row.why, 'rewritten');
  } finally { await w.close(); }
});

test('Revert never undoes a change it does not own: an owner edit between two writes under one label, or another agent\'s write, stays', async () => {
  const w = await world();
  try {
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const folder = owned.folder;
    const label = { 'x-card-batch': 'labelxxxx' };
    // Agent v0 -> v1, the owner v1 -> v2 (no record), the agent v2 -> v3, all under one label.
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# v1 agent', { ...EDIT(md5('# Owner')), ...label })).status, 200);
    w.seed(key, '# v2 OWNER', 'text/markdown');
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# v3 agent', { ...EDIT(md5('# v2 OWNER')), ...label })).status, 200);
    const rows = (await w.get(`/hub/card-writes?section=magic-loops&folder=${folder}`)).body.groups;
    assert.equal(rows.length, 1);
    const answer = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'labelxxxx' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(w.fake.text(key), '# v2 OWNER', 'the owner\'s edit is still there');
    assert.deepEqual(answer.body.leftAlone, [{ file: `${folder}/index.md`, why: 'changed by someone else after the first write of this batch' }]);

    // Another agent's write between the two.
    w.seed(key, '# Owner', 'text/markdown');
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# a1', { ...EDIT(md5('# Owner')), 'x-card-batch': 'batchalpha1' })).status, 200);
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# other', { ...EDIT(md5('# a1')), 'x-card-batch': 'otherbatch1' })).status, 200);
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# a3', { ...EDIT(md5('# other')), 'x-card-batch': 'batchalpha1' })).status, 200);
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'batchalpha1' })).status, 200);
    assert.equal(w.fake.text(key), '# other', 'the other agent\'s write stays');
    const other = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'otherbatch1' });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(w.fake.text(key), '# a1');
    assert.equal(other.body.leftAlone, undefined, 'an unbroken chain leaves nothing out');
    // The agent's first write was left alone, so it is still a live row with its own Revert, and it goes back to the owner's text.
    const after = (await w.get(`/hub/card-writes?section=magic-loops&folder=${folder}`)).body.groups;
    const live = after.filter(row => row.batch === 'batchalpha1' && !row.reverted);
    assert.equal(live.length, 1);
    assert.equal(live[0].canRevert, true);
    assert.deepEqual(live[0].files, [{ file: `${folder}/index.md`, kind: 'edit' }]);
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'batchalpha1' })).status, 200);
    assert.equal(w.fake.text(key), '# Owner', 'nothing of the agent is left on the page');
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'batchalpha1' })).body.error, 'Already reverted.');
  } finally { await w.close(); }
});

test('rows: a flood of small writes does not hide an older one, which "older" reaches', async () => {
  const w = await world();
  try {
    await seedWrites(w);
    for (let n = 0; n < 25; n += 1) assert.equal((await w.put('magic-loops', `2026-11-05_f${n}/a.md`, 'x', CREATE(`flood${String(n).padStart(3, '0')}`))).status, 200);
    const recent = (await w.get('/hub/card-writes?section=magic-loops')).body;
    assert.equal(recent.groups.length, 20);
    assert.equal(recent.more, true);
    assert.ok(!recent.groups.some(group => group.batch === 'editbatch1'), 'the first edit is off the short list');
    const older = (await w.get('/hub/card-writes?section=magic-loops&older=1')).body;
    assert.equal(older.groups.length, 28);
    assert.equal(older.more, false);
    assert.equal(older.groups.find(group => group.batch === 'editbatch1').canRevert, true);
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'editbatch1' })).status, 200);
    assert.equal((await w.get(`/hub/card-writes?section=magic-loops&folder=${owned.folder}`)).body.more, false);
  } finally { await w.close(); }
});

test('Revert says a refusal as it is, and only a lost race as a race', async () => {
  const w = await world();
  try {
    await seedWrites(w);
    // The owner takes the first tab off, so the agent's tab is the card's last one.
    const list = w.listOf('magic-loops');
    list.entities[0].steps = list.entities[0].steps.filter(step => step.path !== 'index.md');
    w.seed('sections/magic-loops/workspace.json', JSON.stringify(list), 'application/json');
    const refused = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder: owned.folder, batch: 'tabbatch1' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /at least one section/);
    assert.doesNotMatch(refused.body.error, /changed while/);
  } finally { await w.close(); }
});

const pageCard = { ...htmlCard, steps: [{ name: 'Page', path: 'page.html' }] };

test('an HTML page keeps its mark while any agent text stays on it, whichever Revert comes first', async () => {
  const w = await world({ sections: { html: { name: 'Html', entities: [pageCard] } } });
  try {
    const key = `sections/html/${pageCard.folder}/page.html`;
    const step = () => w.listOf('html').entities[0].steps[0];
    w.seed(key, '<p>owner</p>', 'text/html');
    const X = { 'x-card-batch': 'labelxxxx' };
    assert.equal((await w.put('html', `${pageCard.folder}/page.html`, '<script>one</script>', { ...EDIT(md5('<p>owner</p>')), ...X })).status, 200);
    assert.equal(step().agentTab, true);
    assert.equal((await w.put('html', `${pageCard.folder}/page.html`, '<script>two</script>', { ...EDIT(md5('<script>one</script>')), 'x-card-batch': 'otherbatch1' })).status, 200);
    assert.equal((await w.put('html', `${pageCard.folder}/page.html`, '<script>three</script>', { ...EDIT(md5('<script>two</script>')), ...X })).status, 200);
    const first = await w.post('/hub/card-writes/revert', { section: 'html', folder: pageCard.folder, batch: 'labelxxxx' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(w.fake.text(key), '<script>two</script>');
    assert.equal(step().agentTab, true, 'agent code is on the page: no bridge');
    assert.deepEqual(first.body.clearedMarks, []);
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'html', folder: pageCard.folder, batch: 'otherbatch1' })).status, 200);
    assert.equal(w.fake.text(key), '<script>one</script>');
    assert.equal(step().agentTab, true, 'still an agent page');
    const last = await w.post('/hub/card-writes/revert', { section: 'html', folder: pageCard.folder, batch: 'labelxxxx' });
    assert.equal(last.status, 200, JSON.stringify(last.body));
    assert.equal(w.fake.text(key), '<p>owner</p>');
    assert.equal(step().agentTab, undefined, 'the owner text only: the bridge comes back');
    assert.deepEqual(last.body.clearedMarks, ['page.html']);
  } finally { await w.close(); }
});

test('an owner edit between two writes that keeps the agent script keeps the mark too', async () => {
  const w = await world({ sections: { html: { name: 'Html', entities: [pageCard] } } });
  try {
    const key = `sections/html/${pageCard.folder}/page.html`;
    w.seed(key, '<p>owner</p>', 'text/html');
    const X = { 'x-card-batch': 'labelxxxx' };
    await w.put('html', `${pageCard.folder}/page.html`, '<script>one</script>', { ...EDIT(md5('<p>owner</p>')), ...X });
    w.seed(key, '<script>one</script><p>owner edit</p>', 'text/html');
    await w.put('html', `${pageCard.folder}/page.html`, '<script>one</script><p>owner edit</p><script>three</script>', { ...EDIT(md5('<script>one</script><p>owner edit</p>')), ...X });
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'html', folder: pageCard.folder, batch: 'labelxxxx' })).status, 200);
    assert.equal(w.fake.text(key), '<script>one</script><p>owner edit</p>');
    assert.equal(w.listOf('html').entities[0].steps[0].agentTab, true, 'the first script is still on the page');
  } finally { await w.close(); }
});

test('Revert only undoes the newest live writes on a file: the same bytes written again do not let an older row through', async () => {
  const w = await world();
  try {
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const folder = owned.folder;
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# agent text', { ...EDIT(md5('# Owner')), 'x-card-batch': 'firstbatch' })).status, 200);
    w.seed(key, '# OWNER WORK', 'text/markdown');
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# agent text', { ...EDIT(md5('# OWNER WORK')), 'x-card-batch': 'secondbat' })).status, 200);
    const older = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'firstbatch' });
    assert.equal(older.status, 409, JSON.stringify(older.body));
    assert.match(older.body.error, /Revert the newer write first/);
    assert.equal(w.fake.text(key), '# agent text', 'nothing moved');
    assert.equal(w.reverts().length, 0);
    const newer = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'secondbat' });
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
    assert.equal(w.fake.text(key), '# OWNER WORK', 'the owner\'s work comes back');
    // The older row was never undone, and now it cannot move the file either: the owner's text is there.
    const stale = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'firstbatch' });
    assert.equal(stale.status, 409);
    assert.equal(w.fake.text(key), '# OWNER WORK');
  } finally { await w.close(); }
});

test('Revert with another record between two of the label\'s: the older one is left alone and the other batch can still go back', async () => {
  const w = await world();
  try {
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const folder = owned.folder;
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# a', { ...EDIT(md5('# Owner')), 'x-card-batch': 'labelxxxx' })).status, 200);
    w.seed(key, '# OWNER WORK', 'text/markdown');
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# a', { ...EDIT(md5('# OWNER WORK')), 'x-card-batch': 'zedbatch01' })).status, 200);
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# c', { ...EDIT(md5('# a')), 'x-card-batch': 'labelxxxx' })).status, 200);
    const label = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'labelxxxx' });
    assert.equal(label.status, 200, JSON.stringify(label.body));
    assert.equal(w.fake.text(key), '# a', 'only the newest write went back');
    assert.equal(label.body.leftAlone[0].file, `${folder}/index.md`);
    const zed = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'zedbatch01' });
    assert.equal(zed.status, 200, JSON.stringify(zed.body));
    assert.equal(w.fake.text(key), '# OWNER WORK');
  } finally { await w.close(); }
});

test('a revert file with no list of undone ids undoes nothing', async () => {
  const w = await world();
  try {
    const folder = owned.folder;
    await w.put('magic-loops', `${folder}/index.md`, '# one', { ...EDIT(md5('# Owner')), 'x-card-batch': 'legacybatch' });
    w.seed(`sections/inbox/card-writes/magic-loops/${folder}/20990101T000000000Z-aaaa-revert.json`, JSON.stringify({ v: 1, kind: 'revert', section: 'magic-loops', folder, of: 'legacybatch', by: 'owner', at: '2099-01-01T00:00:00.000Z', restored: [] }), 'application/json');
    const rows = (await w.get(`/hub/card-writes?section=magic-loops&folder=${folder}`)).body.groups;
    assert.deepEqual(rows.map(row => [row.batch, row.canRevert, Boolean(row.reverted)]), [['legacybatch', true, false]]);
  } finally { await w.close(); }
});

test('one file the owner changed does not block the row: the other file goes back and the changed one is named', async () => {
  const w = await world();
  try {
    const folder = owned.folder;
    for (const name of ['a.md', 'b.md']) assert.equal((await w.put('magic-loops', `${folder}/${name}`, `# ${name} v1`, CREATE(`seed${name[0]}00001`))).status, 200);
    assert.equal((await w.put('magic-loops', `${folder}/a.md`, '# a.md v2', EDIT(md5('# a.md v1'), 'twofiles001'))).status, 200);
    assert.equal((await w.put('magic-loops', `${folder}/b.md`, '# b.md v2', EDIT(md5('# b.md v1'), 'twofiles001'))).status, 200);
    w.seed(`sections/magic-loops/${folder}/b.md`, '# b.md owner tweak', 'text/markdown');
    const answer = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'twofiles001' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.restored, [`${folder}/a.md`]);
    assert.deepEqual(answer.body.leftAlone, [{ file: `${folder}/b.md`, why: 'You changed this file after the agent, so it was left alone' }]);
    assert.equal(w.fake.text(`sections/magic-loops/${folder}/a.md`), '# a.md v1');
    assert.equal(w.fake.text(`sections/magic-loops/${folder}/b.md`), '# b.md owner tweak', 'the owner\'s tweak is untouched');
    // The row is done: the left file will not be offered again.
    const row = (await w.get(`/hub/card-writes?section=magic-loops&folder=${folder}`)).body.groups.find(group => group.batch === 'twofiles001');
    assert.equal(row.canRevert, false);
    assert.ok(row.reverted);
  } finally { await w.close(); }
});

test('when the owner changed the only file, Revert says so plainly, and the row loses its button', async () => {
  const w = await world();
  try {
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const folder = owned.folder;
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# agent', { ...EDIT(md5('# Owner')), 'x-card-batch': 'ownerchg001' })).status, 200);
    w.seed(key, '# agent, then the owner', 'text/markdown');
    const answer = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'ownerchg001' });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'You changed this file after the agent, so it was left alone.');
    assert.equal(w.fake.text(key), '# agent, then the owner');
    const row = (await w.get(`/hub/card-writes?section=magic-loops&folder=${folder}`)).body.groups[0];
    assert.equal(row.canRevert, false, 'no button: nothing can be undone');
    assert.equal(row.reverted.left, true);
    assert.equal((await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'ownerchg001' })).body.error, 'Already reverted.');
  } finally { await w.close(); }
});

test('two runs edit a tab and the owner tweaks it: no circular message, and no button on either row', async () => {
  const w = await world();
  try {
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const folder = owned.folder;
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# run one', { ...EDIT(md5('# Owner')), 'x-card-batch': 'runone00001' })).status, 200);
    assert.equal((await w.put('magic-loops', `${folder}/index.md`, '# run two', { ...EDIT(md5('# run one')), 'x-card-batch': 'runtwo00001' })).status, 200);
    w.seed(key, '# run two, tweaked', 'text/markdown');
    const newest = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'runtwo00001' });
    assert.equal(newest.body.error, 'You changed this file after the agent, so it was left alone.');
    const older = await w.post('/hub/card-writes/revert', { section: 'magic-loops', folder, batch: 'runone00001' });
    assert.equal(older.status, 409);
    assert.match(older.body.error, /You changed this file after the agent/, 'the older row is not told to revert a newer write that can never go back');
    const rows = (await w.get(`/hub/card-writes?section=magic-loops&folder=${folder}`)).body.groups;
    assert.deepEqual(rows.map(row => row.canRevert), [false, false]);
    assert.equal(w.fake.text(key), '# run two, tweaked');
  } finally { await w.close(); }
});
