// The card API's write gate for a `@library` right: an agent adds cards and tabs to a project section, never
// deletes, says who and why, and leaves one record per write in the inbox. Everything runs against the stand-in S3;
// the `inbox` keys below are fixtures in that fake, never the real bucket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBucket } from '../../api/s3.mjs';
import { startFakeS3 } from '../../api/test/fake-s3.mjs';
import { SYNC_SKIPPED, createCardApi, libraryFolderOk, libraryPathOk, parseScope, parseTokens } from '../handler.mjs';
import { SKIP_DIRS, SKIP_ROOT } from '../../../scripts/shared/s3-sync.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const WHO = { 'x-card-agent': 'Researcher', 'x-card-why': encodeURIComponent('Notes for the owner') };
const CREATE = { 'if-none-match': '*', ...WHO };
const EDIT = etag => ({ 'if-match': `"${etag}"`, 'x-card-context': 'chat', ...WHO });
const md5 = text => createHash('md5').update(text).digest('hex');

const owned = { id: 'owner-card', folder: '2026-11-01_owner', title: 'Owner card', description: 'Mine.', category: 'plan', created: '2026-11-01', status: 'active', type: 'standalone', steps: [{ name: 'Notes', path: 'index.md' }], pinned: true, tags: ['keep'], removedTabs: [{ name: 'Old', path: 'old.md', at: '2026-11-01' }] };

async function setup({ clock = { at: 1_800_000_000_000 }, wrap = bucket => bucket } = {}) {
  const fake = await startFakeS3();
  const bucket = wrap(createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' }));
  const list = (id, body) => fake.seed(`sections/${id}/workspace.json`, JSON.stringify(body), 'application/json');
  list('magic-loops', { name: 'Magic Loops', entities: [owned], retired: { gone: { kind: 'trashed', folder: '2026-11-01_gone', entity: { id: 'gone', folder: '2026-11-01_gone' } } } });
  fake.seed(`sections/magic-loops/${owned.folder}/index.md`, '# Owner', 'text/markdown');
  list('assistant', { name: 'Assistant', entities: [] });
  list('hidden-sec', { name: 'Hidden', hidden: true, entities: [] });
  list('archived-sec', { name: 'Archived', archived: true, entities: [] });
  list('inbox', { name: 'Inbox', hidden: true, entities: [] });
  list('inbox-dev', { name: 'Inbox dev', hidden: true, entities: [] });
  list('dev-x', { name: 'Dev x', entities: [] });
  list('fresh', { name: 'Fresh', entities: [] });
  const tokens = parseTokens([
    `all=${sha('tok-all')}`,
    `lib=${sha('tok-lib')}:read=*;write=inbox|assistant|@library`,
    `hermes-main=${sha('tok-main')}:read=*;write=inbox|assistant`,
    `reader=${sha('tok-reader')}:read=*`,
  ].join(', '));
  const api = createCardApi({ bucket, tokens, today: () => '2026-11-05', now: () => clock.at });
  const call = async (method, rawPath, { token = 'tok-lib', body, query, headers = {} } = {}) => {
    const response = await api({
      requestContext: { http: { method } }, rawPath, queryStringParameters: query,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.statusCode, data: JSON.parse(response.body), headers: response.headers };
  };
  const put = (section, file, text, headers = CREATE, token = 'tok-lib') => call('PUT', `/sections/${section}/files/${file}`, { token, body: text, headers: { 'content-type': 'text/plain', ...headers } });
  const entry = (section, id, body, headers = WHO, token = 'tok-lib') => call('PUT', `/sections/${section}/cards/${id}`, { token, body, headers });
  const records = (inbox = 'inbox') => [...fake.objects.keys()].filter(key => key.startsWith(`sections/${inbox}/card-writes/`)).sort().map(key => ({ key, ...fake.json(key) }));
  const listOf = section => fake.json(`sections/${section}/workspace.json`);
  return { fake, api, call, put, entry, records, listOf, clock };
}
const finish = async t => { await t.fake.close(); };

test('grammar: @library is a member of write, nowhere else, and the scope keeps its shape', () => {
  const rights = parseScope('read=*;write=inbox|assistant|@library');
  assert.equal(rights.read, null);
  assert.deepEqual([...rights.write], ['inbox', 'assistant', '@library']);
  assert.ok(rights.delete instanceof Set && rights.delete.size === 0);
  assert.deepEqual([...parseScope('write=@library').write], ['@library']);
  assert.throws(() => parseScope('read=@library'));
  assert.throws(() => parseScope('read=*;delete=@library'));
  assert.throws(() => parseScope('a|@library'), 'the old list form does not take it');
  assert.throws(() => parseScope('write=@Library'));
  assert.equal(parseTokens(`lib=${sha('x')}:read=*;write=inbox|@library`)[0].rights.write.has('@library'), true);
  assert.throws(() => parseTokens(`lib=${sha('x')}:read=@library`), /BUW_CARD_TOKENS/);
});

test('a new card: files with If-None-Match, then the entry; it is listed and each write has a record', async () => {
  const t = await setup();
  try {
    assert.equal((await t.put('magic-loops', '2026-11-05_x/notes.md', '# Notes')).status, 200);
    const asset = await t.put('magic-loops', '2026-11-05_x/pic.png', 'png');
    assert.equal(t.fake.objects.get('sections/magic-loops/2026-11-05_x/pic.png').contentType, 'image/png', 'the type comes from the name, never from the caller');
    assert.equal(asset.status, 200);
    const stored = t.fake.objects.get('sections/magic-loops/2026-11-05_x/notes.md');
    assert.deepEqual({ writer: stored.metadata.writer, agent: stored.metadata.agent }, { writer: 'lib', agent: 'Researcher' });
    assert.match(stored.metadata['write-id'], /^\d{8}T\d{9}Z-[0-9a-f]{4}$/);
    const made = await t.entry('magic-loops', 'x', { id: 'x', title: 'X', folder: '2026-11-05_x', description: 'd', steps: [{ name: 'Notes', path: 'notes.md' }], status: 'active' });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    assert.equal(made.data.created, true);
    assert.equal(made.data.recorded, true);
    assert.deepEqual(t.listOf('magic-loops').entities.map(item => item.id), ['owner-card', 'x']);
    const rows = t.records();
    assert.equal(rows.length, 3, 'two files and the entry');
    const file = rows.find(row => row.file === '2026-11-05_x/notes.md');
    assert.deepEqual({ kind: file.kind, entry: file.entry, agent: file.agent, token: file.token, section: file.section, folder: file.folder, context: file.context, why: file.why, previousVersionId: file.previousVersionId }, { kind: 'new-card', entry: false, agent: 'Researcher', token: 'lib', section: 'magic-loops', folder: '2026-11-05_x', context: null, why: 'Notes for the owner', previousVersionId: null });
    assert.ok(file.versionId && file.etag === md5('# Notes'));
    const list = rows.find(row => row.entry);
    assert.deepEqual({ file: list.file, kind: list.kind, cardId: list.cardId, steps: list.steps }, { file: 'workspace.json', kind: 'new-card', cardId: 'x', steps: ['notes.md'] });
    for (const row of rows) assert.equal(t.fake.objects.get(row.key).metadata.writer, 'card-api');
    assert.ok(rows.every(row => row.key.startsWith('sections/inbox/card-writes/magic-loops/2026-11-05_x/')), 'records are in the inbox, never in the project');
    assert.equal([...t.fake.objects.keys()].some(key => key.startsWith('sections/magic-loops/') && key.includes('card-writes')), false);
  } finally { await finish(t); }
});

test('a new tab on an existing card keeps every stored step, appends, and marks agentTab whatever was posted', async () => {
  const t = await setup();
  try {
    await t.put('magic-loops', `${owned.folder}/tab.html`, '<p>hi</p>');
    const body = { ...owned, steps: [...owned.steps, { name: 'Tab', path: 'tab.html', agentTab: false }] };
    const answer = await t.entry('magic-loops', 'owner-card', body);
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.deepEqual(answer.data.ignored, []);
    const after = t.listOf('magic-loops').entities[0];
    assert.deepEqual(after.steps, [{ name: 'Notes', path: 'index.md' }, { name: 'Tab', path: 'tab.html', agentTab: true }]);
    assert.equal(after.pinned, true);
    assert.deepEqual(after.tags, ['keep']);
    assert.equal(after.updated, '2026-11-05');
    const rows = t.records();
    assert.deepEqual(rows.map(row => [row.file, row.kind]).sort(), [['2026-11-01_owner/tab.html', 'new-tab'], ['workspace.json', 'new-tab']]);
    assert.deepEqual(rows.find(row => row.entry).steps, ['tab.html']);
  } finally { await finish(t); }
});

test('a posted body that drops a stored step or changes the title and folder loses nothing, and says what it ignored', async () => {
  const t = await setup();
  try {
    await t.put('magic-loops', `${owned.folder}/tab.html`, '<p>hi</p>');
    const body = { ...owned, title: 'Hijacked', folder: 'elsewhere', pinned: false, steps: [{ name: 'Tab', path: 'tab.html' }] };
    const answer = await t.entry('magic-loops', 'owner-card', body);
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.deepEqual([...answer.data.ignored].sort(), ['folder', 'pinned', 'steps', 'title']);
    const after = t.listOf('magic-loops').entities[0];
    assert.equal(after.title, 'Owner card');
    assert.equal(after.folder, owned.folder);
    assert.equal(after.pinned, true);
    assert.deepEqual(after.steps.map(step => step.path), ['index.md', 'tab.html']);
    // The same body again adds nothing and writes no list.
    const writes = t.fake.log.filter(entry => entry.method === 'PUT' && entry.key === 'sections/magic-loops/workspace.json').length;
    const again = await t.entry('magic-loops', 'owner-card', body);
    assert.equal(again.data.unchanged, true);
    assert.equal(t.fake.log.filter(entry => entry.method === 'PUT' && entry.key === 'sections/magic-loops/workspace.json').length, writes);
  } finally { await finish(t); }
});

test('a new card may set only the allowed fields, and a step has no url', async () => {
  const t = await setup();
  try {
    await t.put('magic-loops', '2026-11-05_y/a.md', 'a');
    const base = { id: 'y', title: 'Y', folder: '2026-11-05_y', steps: [{ name: 'A', path: 'a.md' }] };
    const refused = await t.entry('magic-loops', 'y', { ...base, pinned: true, tags: ['x'], removedTabs: [] });
    assert.equal(refused.status, 422);
    assert.match(refused.data.error, /pinned, tags, removedTabs/);
    assert.equal((await t.entry('magic-loops', 'y', { ...base, status: 'archived' })).status, 422);
    assert.equal((await t.entry('magic-loops', 'y', { ...base, steps: [{ name: 'A', url: 'https://example.com' }] })).status, 422);
    assert.equal((await t.entry('magic-loops', 'y', { ...base, steps: [{ name: 'A', path: 'missing.md' }] })).status, 422, 'a step needs a file in the folder');
    assert.equal((await t.entry('magic-loops', 'y', base, {})).status, 422, 'who and why are required');
    assert.equal(t.listOf('magic-loops').entities.length, 1);
  } finally { await finish(t); }
});

test('nothing is deleted or removed: DELETE is 403 and an append keeps the list top-level fields', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('DELETE', `/sections/magic-loops/files/${owned.folder}/index.md`)).status, 403);
    assert.equal((await t.call('DELETE', `/sections/magic-loops/files/${owned.folder}/index.md`, { token: 'tok-main' })).status, 403);
    assert.ok(t.fake.objects.has(`sections/magic-loops/${owned.folder}/index.md`));
    await t.put('magic-loops', '2026-11-05_z/a.md', 'a');
    await t.entry('magic-loops', 'z', { id: 'z', title: 'Z', folder: '2026-11-05_z', steps: [{ name: 'A', path: 'a.md' }] });
    const list = t.listOf('magic-loops');
    assert.deepEqual(Object.keys(list.retired), ['gone']);
    assert.equal(list.name, 'Magic Loops');
    assert.ok(list.entities.some(item => item.id === 'owner-card'));
    assert.equal(t.fake.log.some(entry => entry.method === 'DELETE'), false);
  } finally { await finish(t); }
});

test('reserved names and workspace.json are refused on put, upload and as an entry folder', async () => {
  const t = await setup();
  try {
    for (const section of ['magic-loops', 'assistant']) {
      for (const file of ['_shared/x.css', 'card-responses/a/b.json', 'inbox/x/y', 'sections/x/y', 'state.json/y']) {
        const put = await t.put(section, file, 'x', section === 'assistant' ? { 'if-none-match': '*' } : CREATE);
        assert.ok([400, 403].includes(put.status), `${section}/${file}: ${put.status}`);
        const up = await t.call('POST', `/sections/${section}/uploads`, { body: { files: [{ path: file }] } });
        assert.ok([400, 403].includes(up.status), `upload ${section}/${file}: ${up.status}`);
      }
      assert.equal((await t.put(section, 'workspace.json', 'x')).status, 400);
    }
    // cardPath alone lets these through; the reserved list is what stops them.
    assert.equal((await t.put('magic-loops', 'card-responses/a/b.json', 'x')).status, 403);
    assert.equal((await t.put('assistant', 'inbox/a/b.json', 'x', {})).status, 403);
    assert.equal((await t.call('POST', '/sections/assistant/uploads', { body: { files: [{ path: 'card-responses/a.json' }] } })).status, 403);
    for (const folder of ['card-responses', 'sections', 'inbox', 'state.json']) {
      const answer = await t.entry('magic-loops', 'bad', { id: 'bad', title: 'B', folder, steps: [] });
      assert.equal(answer.status, 403, `${folder}: ${JSON.stringify(answer.data)}`);
    }
    assert.equal((await t.entry('magic-loops', 'bad', { id: 'bad', title: 'B', folder: '_x', steps: [] })).status, 400);
  } finally { await finish(t); }
});

test('paths: Windows traps are refused, normal names pass', async () => {
  const t = await setup();
  try {
    for (const file of ['a/..\\..\\x', 'a/b:c', 'a/con.txt', 'a/x.', 'a/x ', '.git/x', 'a/NUL', 'a/com1.md', 'a/b*c', 'a/-x']) {
      const answer = await t.put('magic-loops', file, 'x');
      assert.ok([400, 422].includes(answer.status), `${JSON.stringify(file)} gave ${answer.status}`);
    }
    for (const file of ['2026-11-05_ok/Notes (v2).md', '2026-11-05_ok/sub dir/a.b.txt', '2026-11-05_ok/index.md']) {
      assert.equal((await t.put('magic-loops', encodeURI(file), 'x')).status, 200, file);
    }
    assert.equal(libraryFolderOk('a b'), false);
    assert.equal(libraryFolderOk('2026-11-05_ok'), true);
    assert.equal(libraryPathOk('a/b.md'), true);
    assert.equal(libraryPathOk('a'), false);
    assert.equal((await t.entry('magic-loops', 'p', { id: 'p', title: 'P', folder: 'lpt1', steps: [] })).status, 422);
  } finally { await finish(t); }
});

test('conditional writes, who and why, and the stale If-Match', async () => {
  const t = await setup();
  try {
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', WHO)).status, 428);
    assert.match((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', WHO)).data.error, /conditional/);
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', { 'if-none-match': '*' })).status, 422);
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', { 'if-none-match': '*', 'x-card-agent': 'R' })).status, 422);
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', { 'if-none-match': '*', 'x-card-agent': '!bad', 'x-card-why': 'x' })).status, 422);
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', { ...CREATE, 'x-card-context': 'bogus' })).status, 422);
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', { ...CREATE, 'x-card-batch': 'BAD' })).status, 422);
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', { ...CREATE, 'x-card-why': encodeURIComponent('x'.repeat(301)) })).status, 422);
    assert.equal((await t.put('magic-loops', '2026-11-05_c/a.md', 'a', { ...CREATE, 'x-card-batch': 'abcd1234' })).status, 200);
    assert.equal(t.records()[0].batch, 'abcd1234');
    // An edit: needs a context, and a stale etag changes nothing.
    const etag = md5('# Owner');
    const noContext = await t.put('magic-loops', `${owned.folder}/index.md`, 'new', { 'if-match': `"${etag}"`, ...WHO });
    assert.equal(noContext.status, 422);
    assert.match(noContext.data.error, /which chat or job/);
    const stale = await t.put('magic-loops', `${owned.folder}/index.md`, 'new', EDIT('0'.repeat(32)));
    assert.equal(stale.status, 412);
    assert.equal(t.fake.text(`sections/magic-loops/${owned.folder}/index.md`), '# Owner');
    assert.equal(t.records().filter(row => row.file.endsWith('index.md')).length, 0);
  } finally { await finish(t); }
});

test('an edit is recorded with the version it replaced', async () => {
  const t = await setup();
  try {
    const key = `sections/magic-loops/${owned.folder}/index.md`;
    const before = t.fake.objects.get(key);
    const done = await t.put('magic-loops', `${owned.folder}/index.md`, '# Edited', EDIT(before.etag));
    assert.equal(done.status, 200, JSON.stringify(done.data));
    const row = t.records()[0];
    assert.equal(row.kind, 'edit');
    assert.equal(row.previousVersionId, before.versionId);
    assert.equal(row.previousEtag, before.etag);
    assert.equal(row.versionId, t.fake.objects.get(key).versionId);
    assert.equal(row.context, 'chat');
    // The old bytes are still there by version, which is what Revert reads.
    const version = await createBucket({ bucket: t.fake.bucket, endpoint: t.fake.endpoint, credentials: t.fake.credentials, region: 'us-east-1' }).getVersion(key, before.versionId);
    assert.equal(version.buffer.toString(), '# Owner');
  } finally { await finish(t); }
});

test('upload URLs: a Library section gets none, assistant still does', async () => {
  const t = await setup();
  try {
    const refused = await t.call('POST', '/sections/magic-loops/uploads', { body: { files: [{ path: '2026-11-05_u/big.zip' }] } });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /4 MB/);
    const ok = await t.call('POST', '/sections/assistant/uploads', { body: { files: [{ path: '2026-11-05_u/big.zip' }] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.uploads.length, 1);
  } finally { await finish(t); }
});

test('hidden, archived and inbox sections are refused; a new section needs no setting; an off section is refused and assistant is not affected', async () => {
  const t = await setup();
  try {
    for (const section of ['hidden-sec', 'archived-sec', 'inbox-dev']) {
      assert.equal((await t.put(section, '2026-11-05_h/a.md', 'a')).status, 403, section);
    }
    assert.match((await t.put('hidden-sec', '2026-11-05_h/a.md', 'a')).data.error, /may not write section "hidden-sec"/);
    assert.equal((await t.put('fresh', '2026-11-05_f/a.md', 'a')).status, 200, 'a new section needs no setting');
    t.fake.seed('sections/inbox/library-writes.json', JSON.stringify({ v: 1, off: ['magic-loops', 'assistant'], at: '2026-11-05T00:00:00Z', by: 'owner' }), 'application/json');
    t.clock.at += 31_000;
    const off = await t.put('magic-loops', '2026-11-05_o/a.md', 'a');
    assert.equal(off.status, 403);
    assert.match(off.data.error, /turned agent cards off for section "magic-loops"\. Write to assistant/);
    assert.equal((await t.put('assistant', '2026-11-05_o/a.md', 'a')).status, 200, 'the literal right does not depend on the setting');
    assert.equal((await t.put('fresh', '2026-11-05_f/b.md', 'b')).status, 200);
  } finally { await finish(t); }
});

test('the setting: no file allows, a marked, bad or unreadable file refuses, and it is cached for 30 seconds', async () => {
  const t = await setup();
  const settingKey = 'sections/inbox/library-writes.json';
  const attempt = async name => (await t.put('fresh', `2026-11-05_s/${name}.md`, name)).status;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(await attempt('none'), 200);
    t.fake.seed(settingKey, JSON.stringify({ v: 1, off: ['fresh'] }), 'application/json');
    assert.equal(await attempt('cached'), 200, 'the setting is read at most every 30 s');
    t.clock.at += 31_000;
    assert.equal(await attempt('off'), 403);
    t.fake.seed(settingKey, JSON.stringify({ v: 1, off: [] }), 'application/json', { writer: 'card-api' });
    t.clock.at += 31_000;
    assert.equal(await attempt('marked'), 403, 'a file the API wrote is not the owner\'s');
    t.fake.seed(settingKey, '{not json', 'application/json');
    t.clock.at += 31_000;
    assert.equal(await attempt('bad'), 403);
    t.fake.seed(settingKey, JSON.stringify({ v: 2, off: 'x' }), 'application/json');
    t.clock.at += 31_000;
    assert.equal(await attempt('shape'), 403);
    assert.ok(errors.length >= 3, 'each refusal is logged');
    t.fake.seed(settingKey, JSON.stringify({ v: 1, off: [] }), 'application/json');
    t.clock.at += 31_000;
    assert.equal(await attempt('back'), 200);
    t.fake.fail = key => key === settingKey;
    t.clock.at += 31_000;
    const down = await t.put('fresh', '2026-11-05_s/down.md', 'x');
    assert.equal(down.status, 503);
    assert.match(down.data.error, /Could not check the section setting/);
    t.fake.fail = null;
    assert.equal(await attempt('after'), 200, 'a storage error is not cached');
  } finally { console.error = original; await finish(t); }
});

test('no token, the passphrase included, writes the setting or the records', async () => {
  const t = await setup();
  try {
    for (const token of ['tok-all', 'tok-lib', 'tok-main']) {
      for (const section of ['inbox', 'inbox-dev']) {
        assert.equal((await t.call('PUT', `/sections/${section}/files/library-writes.json`, { token, body: '{}', headers: { 'if-none-match': '*' } })).status, 400, 'cardPath refuses a root file');
        const rec = await t.call('PUT', `/sections/${section}/files/card-writes/magic-loops/f/x.json`, { token, body: '{}', headers: { 'if-none-match': '*' } });
        assert.equal(rec.status, 403, `${token} ${section} put`);
        const up = await t.call('POST', `/sections/${section}/uploads`, { token, body: { files: [{ path: 'card-writes/magic-loops/f/x.json' }] } });
        assert.equal(up.status, 403, `${token} ${section} upload`);
        const del = await t.call('DELETE', `/sections/${section}/files/card-writes/magic-loops/f/x.json`, { token });
        assert.equal(del.status, 403, `${token} ${section} delete`);
      }
    }
    t.fake.seed('sections/inbox/card-writes/magic-loops/f/x.json', '{}', 'application/json');
    const read = await t.api({ requestContext: { http: { method: 'GET' } }, rawPath: '/sections/inbox/files/card-writes/magic-loops/f/x.json', headers: { Authorization: 'Bearer tok-reader' } });
    assert.equal(read.statusCode, 200, 'reading is fine');
  } finally { await finish(t); }
});

test('records: one file per write, the token is the caller, and a record that cannot be written still answers 200', async () => {
  const t = await setup();
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await t.put('magic-loops', '2026-11-05_r/a.md', 'a');
    await t.put('magic-loops', '2026-11-05_r/b.md', 'b');
    const rows = t.records();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.ok(rows.every(row => row.token === 'lib' && row.v === 1 && /^\d{4}-\d\d-\d\dT/.test(row.at)));
    t.fake.fail = (key, method) => method === 'PUT' && key.includes('/card-writes/');
    const answer = await t.put('magic-loops', '2026-11-05_r/c.md', 'c');
    assert.equal(answer.status, 200);
    assert.equal(answer.data.recorded, false);
    assert.equal(t.fake.text('sections/magic-loops/2026-11-05_r/c.md'), 'c', 'the file is there');
    assert.ok(errors.some(line => line.startsWith('[card-writes] not recorded') && line.includes('2026-11-05_r/c.md')));
    t.fake.fail = null;
    // assistant leaves rows too, with a missing agent reading unknown; the passphrase leaves none.
    await t.put('assistant', '2026-11-05_r/d.md', 'd', { 'if-none-match': '*' }, 'tok-main');
    const row = t.records().find(item => item.section === 'assistant');
    assert.deepEqual({ agent: row.agent, token: row.token, kind: row.kind }, { agent: 'unknown', token: 'hermes-main', kind: 'new-card' });
    const before = t.records().length;
    await t.put('magic-loops', '2026-11-05_r/e.md', 'e', { 'if-none-match': '*' }, 'tok-all');
    assert.equal(t.records().length, before);
  } finally { console.error = original; await finish(t); }
});

test('dev sections keep their records and setting under inbox-dev', async () => {
  const t = await setup();
  try {
    assert.equal((await t.put('dev-x', '2026-11-05_d/a.md', 'a')).status, 200);
    assert.equal(t.records('inbox').length, 0);
    assert.equal(t.records('inbox-dev').length, 1);
    assert.ok(t.records('inbox-dev')[0].key.startsWith('sections/inbox-dev/card-writes/dev-x/2026-11-05_d/'));
    // The real inbox's setting says nothing about dev-x, and the dev inbox's setting does.
    t.fake.seed('sections/inbox/library-writes.json', JSON.stringify({ v: 1, off: ['dev-x'] }), 'application/json');
    t.clock.at += 31_000;
    assert.equal((await t.put('dev-x', '2026-11-05_d/b.md', 'b')).status, 200);
    t.fake.seed('sections/inbox-dev/library-writes.json', JSON.stringify({ v: 1, off: ['dev-x'] }), 'application/json');
    t.clock.at += 31_000;
    assert.equal((await t.put('dev-x', '2026-11-05_d/c.md', 'c')).status, 403);
  } finally { await finish(t); }
});

test('a retired folder is refused, and a name in another case is a 409', async () => {
  const t = await setup();
  try {
    const trashed = await t.put('magic-loops', '2026-11-01_gone/a.md', 'a');
    assert.equal(trashed.status, 409);
    assert.match(trashed.data.error, /Trash/);
    assert.equal((await t.put('magic-loops', `${owned.folder}/Index.md`, 'x')).status, 409);
    assert.equal(t.fake.objects.has(`sections/magic-loops/${owned.folder}/Index.md`), false);
    assert.equal((await t.put('magic-loops', `${owned.folder}/other.md`, 'x')).status, 200);
    await t.put('magic-loops', '2026-11-05_k/a.md', 'a');
    await t.entry('magic-loops', 'k', { id: 'k', title: 'K', folder: '2026-11-05_k', steps: [{ name: 'A', path: 'a.md' }] });
    await t.put('magic-loops', '2026-11-05_K/a.md', 'a');
    assert.equal((await t.entry('magic-loops', 'k2', { id: 'k2', title: 'K2', folder: '2026-11-05_K', steps: [{ name: 'A', path: 'a.md' }] })).status, 409);
  } finally { await finish(t); }
});

test('access: each section route says direct, library or read', async () => {
  const t = await setup();
  try {
    const mine = await t.call('GET', '/sections/magic-loops');
    assert.equal(mine.data.access, 'library');
    assert.equal((await t.call('GET', '/sections/assistant')).data.access, 'direct');
    assert.equal((await t.call('GET', '/sections/hidden-sec')).data.access, 'read');
    assert.equal((await t.call('GET', '/sections/magic-loops', { token: 'tok-reader' })).data.access, 'read');
    assert.equal((await t.call('GET', '/sections/magic-loops', { token: 'tok-main' })).data.access, 'read');
    assert.equal((await t.call('GET', '/sections/magic-loops', { token: 'tok-all' })).data.access, 'direct');
    const all = Object.fromEntries((await t.call('GET', '/sections')).data.sections.map(row => [row.id, row.access]));
    assert.equal(all['magic-loops'], 'library');
    assert.equal(all.assistant, 'direct');
    assert.equal(all['archived-sec'], 'read');
    assert.equal(all['inbox-dev'], 'read');
    t.fake.seed('sections/inbox/library-writes.json', JSON.stringify({ v: 1, off: ['magic-loops'] }), 'application/json');
    t.clock.at += 31_000;
    assert.equal((await t.call('GET', '/sections/magic-loops')).data.access, 'read', 'an off section reads as read');
    assert.equal(Object.fromEntries((await t.call('GET', '/sections')).data.sections.map(row => [row.id, row.access]))['magic-loops'], 'read');
  } finally { await finish(t); }
});

test('a token without @library is unchanged: no Library write, and the same 403 before the list is read', async () => {
  const t = await setup();
  try {
    assert.equal((await t.put('magic-loops', '2026-11-05_m/a.md', 'a', CREATE, 'tok-main')).status, 403);
    assert.equal((await t.put('magic-loops', '2026-11-05_m/a.md', 'a', CREATE, 'tok-reader')).status, 403);
    const before = t.fake.log.length;
    assert.equal((await t.put('no-such', '2026-11-05_m/a.md', 'a', CREATE, 'tok-main')).status, 403);
    assert.equal(t.fake.log.slice(before).some(entry => entry.key.endsWith('no-such/workspace.json')), false, 'a caller with no right never causes a read');
    assert.equal((await t.put('no-such', '2026-11-05_m/a.md', 'a')).status, 404, 'a Library caller gets past to the read');
  } finally { await finish(t); }
});

test('a lost race on the list (409 or 412) is retried for every caller', async () => {
  const t = await setup();
  try {
    await t.put('magic-loops', '2026-11-05_q/a.md', 'a');
    let raced = 0;
    const real = t.fake.fail;
    // Make the first list write look like AWS's 409 by changing the list under it once.
    const key = 'sections/magic-loops/workspace.json';
    const original = t.fake.json(key);
    t.fake.fail = (k, method) => {
      if (k === key && method === 'PUT' && raced === 0) { raced += 1; t.fake.seed(key, JSON.stringify({ ...original, name: 'Renamed' }), 'application/json'); }
      return false;
    };
    const answer = await t.entry('magic-loops', 'q', { id: 'q', title: 'Q', folder: '2026-11-05_q', steps: [{ name: 'A', path: 'a.md' }] });
    t.fake.fail = real;
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.equal(t.listOf('magic-loops').name, 'Renamed', 'the retry kept the other writer\'s change');
    assert.ok(t.listOf('magic-loops').entities.some(item => item.id === 'q'));
  } finally { await finish(t); }
});

test('a file may not go below a file or where a folder is, in any case', async () => {
  const t = await setup();
  try {
    await t.put('magic-loops', `${owned.folder}/sub/a.md`, 'a');
    for (const file of [`${owned.folder}/index.md/evil.txt`, `${owned.folder}/INDEX.md/evil.txt`, `${owned.folder}/sub`, `${owned.folder}/Sub`, `${owned.folder}/sub/a.md/x`]) {
      const answer = await t.put('magic-loops', file, 'x');
      assert.equal(answer.status, 409, `${file}: ${JSON.stringify(answer.data)}`);
    }
    assert.equal((await t.put('magic-loops', `${owned.folder}/sub/b.md`, 'b')).status, 200, 'a sibling in an existing folder is fine');
    assert.equal((await t.put('magic-loops', `${owned.folder}/index.md/evil.txt`, 'x', EDIT(md5('# Owner')))).status, 409, 'an edit cannot do it either');
    assert.deepEqual([...t.fake.objects.keys()].filter(key => /index\.md\/|\/sub$|\/Sub$/i.test(key)), []);
  } finally { await finish(t); }
});

test('reserved and retired names ignore case, and so does a live folder', async () => {
  const t = await setup();
  try {
    for (const name of ['Card-Responses', 'CARD-RESPONSES', 'Workspace.json', 'STATE.JSON', 'Inbox', 'Sections']) {
      assert.equal((await t.put('magic-loops', `${name}/a/b.json`, 'x')).status, 403, name);
      assert.equal((await t.put('assistant', `${name}/a/b.json`, 'x', { 'if-none-match': '*' }, 'tok-main')).status, 403, `assistant ${name}`);
      assert.equal((await t.call('POST', '/sections/magic-loops/uploads', { body: { files: [{ path: `${name}/a.json` }] } })).status, 403, `upload ${name}`);
      assert.equal((await t.entry('magic-loops', 'bad', { id: 'bad', title: 'B', folder: name, steps: [] })).status, 403, `entry ${name}`);
    }
    assert.equal((await t.put('magic-loops', '_Shared/a.css', 'x')).status, 400, 'cardPath refuses an underscore');
    assert.equal((await t.put('magic-loops', '2026-11-01_GONE/x.md', 'x')).status, 409, 'a variant of a trashed folder');
    assert.equal((await t.entry('magic-loops', 'g2', { id: 'g2', title: 'G', folder: '2026-11-01_GONE', steps: [] })).status, 409);
    assert.equal((await t.put('magic-loops', '2026-11-01_OWNER/index.md', 'x')).status, 409, 'a variant of a live folder');
    assert.equal([...t.fake.objects.keys()].some(key => /GONE|OWNER|Card-Responses|CARD-RESPONSES|Workspace\.json\/|STATE|\/Inbox|Sections/.test(key)), false);
  } finally { await finish(t); }
});

test('an agent cannot bring back a tab the owner removed', async () => {
  const t = await setup();
  try {
    t.fake.seed(`sections/magic-loops/${owned.folder}/old.md`, 'old', 'text/markdown');
    const answer = await t.entry('magic-loops', 'owner-card', { ...owned, steps: [...owned.steps, { name: 'Old', path: 'old.md' }] });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.ok(answer.data.ignored.some(item => item.includes('old.md')), JSON.stringify(answer.data.ignored));
    const after = t.listOf('magic-loops').entities[0];
    assert.deepEqual(after.steps.map(step => step.path), ['index.md']);
    assert.deepEqual(after.removedTabs.map(item => item.path), ['old.md']);
    assert.equal(t.records().length, 0, 'nothing was added');
  } finally { await finish(t); }
});

test('a 409 from S3 on a file put is a lost race (412), not a 500', async () => {
  const t = await setup({ wrap: bucket => ({ ...bucket, put: async (key, ...rest) => { if (key.endsWith('/race.md')) throw Object.assign(new Error('conflict'), { status: 409 }); return bucket.put(key, ...rest); } }) });
  try {
    const answer = await t.put('magic-loops', '2026-11-05_r/race.md', 'x');
    assert.equal(answer.status, 412);
    assert.match(answer.data.error, /already exists/);
  } finally { await finish(t); }
});

test('an If-Match edit of an existing html tab marks the step agentTab, and the record names it', async () => {
  const t = await setup();
  try {
    t.fake.seed(`sections/magic-loops/${owned.folder}/page.html`, '<p>mine</p>', 'text/html');
    const list = t.listOf('magic-loops');
    list.entities[0].steps.push({ name: 'Page', path: 'page.html' });
    t.fake.seed('sections/magic-loops/workspace.json', JSON.stringify(list), 'application/json');
    const md = await t.put('magic-loops', `${owned.folder}/index.md`, '# Edited', EDIT(md5('# Owner')));
    assert.equal(md.status, 200);
    assert.deepEqual(t.listOf('magic-loops').entities[0].steps.map(step => step.agentTab), [undefined, undefined], 'a Markdown edit marks nothing');
    const stale = await t.put('magic-loops', `${owned.folder}/page.html`, '<p>x</p>', EDIT('0'.repeat(32)));
    assert.equal(stale.status, 412);
    assert.equal(t.listOf('magic-loops').entities[0].steps[1].agentTab, undefined, 'a refused edit marks nothing');
    const done = await t.put('magic-loops', `${owned.folder}/page.html`, '<p>agent</p>', EDIT(md5('<p>mine</p>')));
    assert.equal(done.status, 200, JSON.stringify(done.data));
    const steps = t.listOf('magic-loops').entities[0].steps;
    assert.deepEqual(steps[1], { name: 'Page', path: 'page.html', agentTab: true });
    assert.equal(steps[0].agentTab, undefined);
    const row = t.records().find(item => item.file.endsWith('page.html'));
    assert.equal(row.kind, 'edit');
    assert.equal(row.markedAgentTab, 'page.html');
    // A second edit finds it marked and writes no list.
    const writes = () => t.fake.log.filter(entry => entry.method === 'PUT' && entry.key === 'sections/magic-loops/workspace.json').length;
    const before = writes();
    t.clock.at += 1000; // records sort by their time stamp
    await t.put('magic-loops', `${owned.folder}/page.html`, '<p>again</p>', EDIT(md5('<p>agent</p>')));
    assert.equal(writes(), before);
    assert.equal(t.records().filter(item => item.file.endsWith('page.html')).pop().markedAgentTab, undefined);
  } finally { await finish(t); }
});

test('a folder spelled differently from a folder in the card is refused', async () => {
  const t = await setup();
  try {
    await t.put('magic-loops', `${owned.folder}/assets/logo.png`, 'logo');
    const answer = await t.put('magic-loops', `${owned.folder}/Assets/x.png`, 'x');
    assert.equal(answer.status, 409, JSON.stringify(answer.data));
    assert.equal((await t.put('magic-loops', `${owned.folder}/assets/x.png`, 'x')).status, 200);
    assert.equal(t.fake.objects.has(`sections/magic-loops/${owned.folder}/Assets/x.png`), false);
  } finally { await finish(t); }
});

test('a card folder the sync skips is refused in any case, and the API list equals the sync list', async () => {
  const t = await setup();
  try {
    assert.deepEqual([...SYNC_SKIPPED].sort(), [...SKIP_DIRS, ...SKIP_ROOT].map(name => name.toLowerCase()).sort(), 'handler.mjs keeps its own copy of the names s3-sync.mjs skips');
    for (const name of ['categories', 'Categories', 'GEMFILE', 'Gemfile.lock', 'README.md', 'Index.md', 'node_modules', 'Docker-Compose.yml', 'docker-compose.yml']) {
      assert.equal((await t.put('magic-loops', `${name}/a.md`, 'x')).status, 403, `put ${name}`);
      assert.equal((await t.entry('magic-loops', 'bad', { id: 'bad', title: 'B', folder: name, steps: [] })).status, 403, `entry ${name}`);
    }
    assert.equal((await t.put('magic-loops', 'category/a.md', 'x')).status, 200, 'a near name is fine');
    assert.equal(t.fake.objects.has('sections/magic-loops/categories/a.md'), false);
  } finally { await finish(t); }
});

test('a Library right does not edit an existing script file, but may add a new one', async () => {
  const t = await setup();
  try {
    for (const ext of ['js', 'mjs', 'cjs', 'wasm', 'JS']) {
      const key = `sections/magic-loops/${owned.folder}/app.${ext}`;
      t.fake.seed(key, 'owner code', 'text/javascript');
      const refused = await t.put('magic-loops', `${owned.folder}/app.${ext}`, 'agent code', EDIT(md5('owner code')));
      assert.equal(refused.status, 403, ext);
      assert.match(refused.data.error, /new tab/);
      assert.equal(t.fake.text(key), 'owner code');
    }
    assert.equal(t.records().length, 0);
    assert.equal((await t.put('magic-loops', `${owned.folder}/new-app.js`, 'new code')).status, 200);
  } finally { await finish(t); }
});
