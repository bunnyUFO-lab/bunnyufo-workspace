// Custom pet sheets: what is listed, chosen and served, over the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { checkSheet, pngSize, sheetSprite } from '../hub-sheets.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { seeder, teamSheet } from './hub-fixtures.mjs';

const SITE = 'https://site.example';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-sheets-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, env: {} });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const raw = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, bytes: Buffer.from(await answer.arrayBuffer()), headers: answer.headers }; };
  const post = async (route, data, user = 'owner') => {
    const answer = await fetch(`${origin}/api${route}`, {
      method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', ...(user ? { 'Remote-User': user } : {}) }, body: JSON.stringify(data),
    });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const seed = seeder(fake);
  const putSheet = (agent, sheet) => { for (const [name, body] of Object.entries(sheet.files)) seed.put(`team/${agent}/${name}`, body, name.endsWith('.png') ? 'image/png' : 'application/json'); };
  return { fake, get, raw, post, seed, putSheet, close: async () => { server.close(); await fake.close(); } };
}

const sprite = async (f, id) => (await f.get('/hub/team')).body.agents.find(row => row.id === id).sprite;
const pick = (f, agent, sheet) => f.post(`/hub/team/${agent}/avatar`, { kind: 'custom', sheet });
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

test('a good sheet is listed, and choosing it round-trips through GET /hub/team', async () => {
  const f = await fixture();
  try {
    const good = teamSheet('claude');
    f.putSheet('claude', good);
    const listed = await f.get('/hub/team/claude/sheets');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.sheets.length, 1);
    const row = listed.body.sheets[0];
    assert.deepEqual({ sheet: row.sheet, at: row.at, url: row.url, current: row.current }, { sheet: good.id, at: '2026-10-29T10:00:00.000Z', url: `/hub/file?path=team/claude/${good.id}.png`, current: false });
    assert.equal(row.rows.length, 9);
    assert.notEqual((await sprite(f, 'claude')).kind, 'custom', 'Listed is not chosen.');

    const chosen = await pick(f, 'claude', good.id);
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.sha256, good.json.sha256, 'The Hub writes the hash it computed.');
    const now = await sprite(f, 'claude');
    assert.equal(now.kind, 'custom');
    assert.equal(now.sheet, good.id);
    assert.equal(now.url, `/hub/file?path=team/claude/${good.id}.png`);
    assert.deepEqual(now.frame, { w: 192, h: 208 });
    assert.equal(now.cols, 8);
    assert.equal(now.rows[0].state, 'idle');
    assert.equal((await f.get('/hub/team/claude/sheets')).body.sheets[0].current, true);
    const written = [...f.fake.objects.keys()].filter(name => /team\/claude\/avatar-/.test(name));
    assert.equal(written.length, 1);
    assert.deepEqual(Object.keys(f.fake.json(written[0])).sort(), ['at', 'by', 'kind', 'sha256', 'sheet']);
  } finally { await f.close(); }
});

test('a sheet that breaks a rule is not listed and a choice of it is a 400', async () => {
  const f = await fixture();
  try {
    const names = ['idle', 'run-right', 'run-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'extra'];
    const rows = (n, patch = {}) => names.slice(0, n).map(state => ({ state, frames: 2, fps: 6, ...patch }));
    const bad = {
      hash: teamSheet('claude', { rand: 'aa01', sha256: '0'.repeat(64) }),
      narrow: teamSheet('claude', { rand: 'aa02', width: 1535 }),
      tenRows: teamSheet('claude', { rand: 'aa03', rows: rows(10) }),
      agent: teamSheet('claude', { rand: 'aa04', jsonAgent: 'hermes' }),
      big: teamSheet('claude', { rand: 'aa05', pad: 5 * 1024 * 1024 }),
      frames: teamSheet('claude', { rand: 'aa06', rows: rows(9, { frames: 9 }) }),
      fps: teamSheet('claude', { rand: 'aa07', rows: rows(9, { fps: 25 }) }),
      order: teamSheet('claude', { rand: 'aa08', rows: rows(9).reverse() }),
    };
    for (const sheet of Object.values(bad)) f.putSheet('claude', sheet);
    const lonely = teamSheet('claude', { rand: 'aa09' });
    f.seed.put(`team/claude/${lonely.id}.json`, lonely.json);
    const noJson = teamSheet('claude', { rand: 'aa10' });
    f.seed.put(`team/claude/${noJson.id}.png`, noJson.png, 'image/png');
    f.seed.put('team/claude/sheet-20261029T100000Z-bb01.json', 'not json{');
    f.seed.put('team/claude/sheet-20261029T100000Z-bb01.png', bad.hash.png, 'image/png');
    assert.deepEqual((await f.get('/hub/team/claude/sheets')).body, { sheets: [] });
    for (const [name, sheet] of Object.entries({ ...bad, lonely, noJson })) {
      const answer = await pick(f, 'claude', sheet.id);
      assert.equal(answer.status, 400, name);
      assert.match(answer.body.error, /isn't ready or failed its check/);
    }
    assert.equal((await pick(f, 'claude', 'sheet-20261029T100000Z-bb01')).status, 400, 'JSON that does not parse.');
    assert.equal((await pick(f, 'claude', '../avatar-x')).status, 400);
    assert.notEqual((await sprite(f, 'claude')).kind, 'custom');
    assert.equal([...f.fake.objects.keys()].filter(name => /avatar-/.test(name)).length, 0, 'Nothing was written.');
  } finally { await f.close(); }
});

test("a sheet in another agent's folder is not that agent's, and a stranger has no sheets", async () => {
  const f = await fixture();
  try {
    const sheet = teamSheet('claude');
    f.putSheet('hermes', sheet);
    assert.deepEqual((await f.get('/hub/team/hermes/sheets')).body, { sheets: [] });
    assert.equal((await pick(f, 'hermes', sheet.id)).status, 400);
    assert.equal((await f.get('/hub/team/stranger/sheets')).status, 404);
  } finally { await f.close(); }
});

test('choosing a sheet needs a signed-in user', async () => {
  const f = await fixture();
  try {
    const sheet = teamSheet('claude');
    f.putSheet('claude', sheet);
    assert.equal((await f.post('/hub/team/claude/avatar', { kind: 'custom', sheet: sheet.id }, null)).status, 401);
  } finally { await f.close(); }
});

test('a later Quick choice overrides a custom one, and choosing the sheet again undoes it', async () => {
  const f = await fixture();
  try {
    const sheet = teamSheet('claude');
    f.putSheet('claude', sheet);
    await pick(f, 'claude', sheet.id);
    await pause();
    await f.post('/hub/team/claude/avatar', { kind: 'builtin', key: 'qa' });
    assert.deepEqual(await sprite(f, 'claude'), { kind: 'builtin', key: 'qa' });
    assert.equal((await f.get('/hub/team/claude/sheets')).body.sheets[0].current, false);
    await pause();
    await pick(f, 'claude', sheet.id);
    assert.equal((await sprite(f, 'claude')).kind, 'custom');
  } finally { await f.close(); }
});

test('a custom choice whose PNG later fails its hash falls back to the older choice', async () => {
  const f = await fixture();
  try {
    const sheet = teamSheet('claude');
    f.putSheet('claude', sheet);
    await f.post('/hub/team/claude/avatar', { kind: 'builtin', key: 'qa' });
    await pause();
    await pick(f, 'claude', sheet.id);
    assert.equal((await sprite(f, 'claude')).kind, 'custom');
    // The bytes are swapped under the same name.
    f.seed.put(`team/claude/${sheet.id}.png`, teamSheet('claude', { shade: 0x10 }).png, 'image/png');
    assert.deepEqual(await sprite(f, 'claude'), { kind: 'builtin', key: 'qa' });
    assert.deepEqual((await f.get('/hub/team/claude/sheets')).body, { sheets: [] });
  } finally { await f.close(); }
});

test('a choice file that names a sheet with the wrong hash, or no hash, does not count', async () => {
  const f = await fixture();
  try {
    const sheet = teamSheet('claude');
    f.putSheet('claude', sheet);
    f.seed.put('team/claude/avatar-20261029T110000Z-aaaa.json', { kind: 'custom', sheet: sheet.id, sha256: 'f'.repeat(64), at: 'x', by: 'owner' });
    f.seed.put('team/claude/avatar-20261029T110001Z-bbbb.json', { kind: 'custom', sheet: sheet.id, at: 'x', by: 'owner' });
    f.seed.put('team/claude/avatar-20261029T110002Z-cccc.json', { kind: 'custom', sheet: 'sheet-20261029T100000Z-zzzz', sha256: sheet.json.sha256, at: 'x', by: 'owner' });
    assert.notEqual((await sprite(f, 'claude')).kind, 'custom');
    f.seed.put('team/claude/avatar-20261029T110003Z-dddd.json', { kind: 'custom', sheet: sheet.id, sha256: sheet.json.sha256, at: 'x', by: 'owner' });
    assert.equal((await sprite(f, 'claude')).kind, 'custom');
  } finally { await f.close(); }
});

test('/hub/file serves a listed sheet PNG and nothing else under team/', async () => {
  const f = await fixture();
  try {
    const sheet = teamSheet('claude');
    f.putSheet('claude', sheet);
    f.seed.put('team/claude/avatar-20261029T110000Z-aaaa.json', { kind: 'builtin', key: 'qa' });
    const ok = await f.raw(`/hub/file?path=team/claude/${sheet.id}.png`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('content-security-policy'), /^sandbox;/);
    assert.ok(ok.bytes.equals(sheet.png));
    for (const rel of ['team/claude/avatar-20261029T110000Z-aaaa.json', `team/claude/${sheet.id}.json`, 'team/claude/sheet-x.png', 'team/stranger/sheet-20261029T100000Z-ab12.png', 'team/claude/x/y.png']) {
      assert.equal((await f.raw(`/hub/file?path=${encodeURIComponent(rel)}`)).status, 400, rel);
    }
    const broken = teamSheet('claude', { rand: 'cd34', width: 1535 });
    f.putSheet('claude', broken);
    assert.equal((await f.raw(`/hub/file?path=team/claude/${broken.id}.png`)).status, 400, 'An unchecked sheet is not served.');
  } finally { await f.close(); }
});

test('the list is newest first and holds at most 20', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 22; index += 1) f.putSheet('claude', teamSheet('claude', { rand: `a${String(index).padStart(3, '0')}`, stamp: `202610${String(10 + index).padStart(2, '0')}T100000Z` }));
    const { sheets } = (await f.get('/hub/team/claude/sheets')).body;
    assert.equal(sheets.length, 20);
    assert.ok(sheets[0].sheet > sheets[19].sheet);
    assert.match(sheets[0].sheet, /^sheet-20261031T/);
  } finally { await f.close(); }
});

test('checkSheet and pngSize on their own', () => {
  const good = teamSheet('claude');
  assert.deepEqual(pngSize(good.png), { width: 1536, height: 1872 });
  assert.equal(pngSize(Buffer.from('not a png at all, really not')), null);
  assert.equal(checkSheet({ agent: 'claude', json: good.json, png: good.png }).ok, true);
  assert.equal(checkSheet({ agent: 'claude', json: null, png: good.png }).ok, false);
  assert.equal(checkSheet({ agent: 'claude', json: { ...good.json, v: 2 }, png: good.png }).ok, false);
  assert.equal(checkSheet({ agent: 'claude', json: { ...good.json, cols: 7 }, png: good.png }).ok, false);
  assert.equal(checkSheet({ agent: 'claude', json: { ...good.json, frame: { w: 192, h: 209 } }, png: good.png }).ok, false);
  assert.equal(sheetSprite('claude', { sheet: good.id, rows: good.json.rows }).url, `/hub/file?path=team/claude/${good.id}.png`);
});
