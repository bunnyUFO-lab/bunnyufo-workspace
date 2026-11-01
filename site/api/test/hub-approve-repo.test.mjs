// Approve resolves a request's repo (ws-q9y.13): the request's own, else the one picked in the sheet, else its project's tracked repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { sha256Hex } from '../signing.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { requestJson } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const keyPair = generateKeyPairSync('ed25519');
const ENV = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), HUB_ROUTINE_DRY_RUN: '1', HUB_NEVER_REPOS: 'example/secret-box', HUB_KNOWN_REPOS: 'example/picked,example/secret-box' };

async function fixture({ tracked = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-apprepo-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  for (const [project, repo] of Object.entries(tracked)) fake.seed(`sections/${project}/workspace.json`, JSON.stringify({ name: project, tracked: { repo }, entities: [] }), 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env: ENV, log: () => {} });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, data) => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify(data ?? {}) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  let n = 0;
  const put = (extra = {}) => {
    n += 1;
    const id = `${day}-workspace-app-job${n}-c${String(n).padStart(3, '0')}`;
    const request = { ...requestJson({ id, now: NOW }), project: 'workspace-app', preset: 'code-task', target: 'cloud', origin: { kind: 'owner', name: 'owner' }, ...extra };
    fake.seed(`sections/inbox/requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
    return request;
  };
  const approved = id => (fake.text(`sections/inbox/requests/${id}/approved.json`) ? fake.json(`sections/inbox/requests/${id}/approved.json`) : null);
  return { fake, post, put, approved, close: async () => { await hub.close(); server.close(); await fake.close(); } };
}

test('a request with no repo is approved for the cloud with its project repo, and request.json is untouched', async () => {
  const f = await fixture({ tracked: { 'workspace-app': 'example/probe' } });
  try {
    const request = f.put();
    delete request.repo;
    const key = `sections/inbox/requests/${request.id}/request.json`;
    f.fake.seed(key, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
    const before = f.fake.text(key);
    const answer = await f.post(`/hub/requests/${request.id}/approve`, { target: 'cloud' });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    const signed = f.approved(request.id);
    assert.equal(signed.repo, 'example/probe');
    assert.equal(signed.target, 'cloud');
    assert.equal(f.fake.text(key), before, 'unchanged bytes');
    assert.equal(signed.requestSha256, sha256Hex(Buffer.from(before)), 'and the hash still covers them');
    assert.match(signed.run.brief, /example\/probe/, 'the brief names the resolved repo');
  } finally { await f.close(); }
});

test('with no tracked repo it is a 400 with the picker hint; a repo from the known list then signs', async () => {
  const f = await fixture();
  try {
    const request = f.put({ repo: undefined });
    const refused = await f.post(`/hub/requests/${request.id}/approve`, { target: 'cloud' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Pick a repo, or run it on the PC/);
    assert.equal(f.approved(request.id), null, 'nothing signed');
    const picked = await f.post(`/hub/requests/${request.id}/approve`, { target: 'cloud', repo: 'example/picked' });
    assert.equal(picked.status, 201, JSON.stringify(picked.body));
    assert.equal(f.approved(request.id).repo, 'example/picked');
    assert.equal(JSON.parse(f.fake.text(`sections/inbox/requests/${request.id}/request.json`)).repo, undefined);
  } finally { await f.close(); }
});

test('a posted repo outside the known list, or on a request that has its own repo, is a 400', async () => {
  const f = await fixture({ tracked: { 'workspace-app': 'example/probe' } });
  try {
    const bare = f.put({ repo: undefined });
    const unknown = await f.post(`/hub/requests/${bare.id}/approve`, { target: 'cloud', repo: 'example/unlisted' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /not a repo the Hub knows/);
    const malformed = await f.post(`/hub/requests/${bare.id}/approve`, { target: 'cloud', repo: 'not a repo' });
    assert.equal(malformed.status, 400);
    const own = f.put({ repo: 'example/probe' });
    const overridden = await f.post(`/hub/requests/${own.id}/approve`, { target: 'cloud', repo: 'example/picked' });
    assert.equal(overridden.status, 400);
    assert.match(overridden.body.error, /already has a repo/);
    for (const id of [bare.id, own.id]) assert.equal(f.approved(id), null, 'nothing signed');
    const fine = await f.post(`/hub/requests/${own.id}/approve`, { target: 'cloud' });
    assert.equal(fine.status, 201, JSON.stringify(fine.body));
    assert.equal(f.approved(own.id).repo, 'example/probe');
  } finally { await f.close(); }
});

test('the never-repo guard still refuses a banned repo reached through the project, or posted from the list', async () => {
  const f = await fixture({ tracked: { 'workspace-app': 'example/secret-box' } });
  try {
    const viaProject = f.put({ repo: undefined });
    const refused = await f.post(`/hub/requests/${viaProject.id}/approve`, { target: 'cloud' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /never run for you by the PC or the cloud/);
    const viaPc = f.put({ repo: undefined, target: 'pc' });
    assert.equal((await f.post(`/hub/requests/${viaPc.id}/approve`, { target: 'pc' })).status, 400, 'also for the PC');
    const posted = f.put({ repo: undefined, project: 'sprite-studio' });
    const again = await f.post(`/hub/requests/${posted.id}/approve`, { target: 'cloud', repo: 'example/secret-box' });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /never run for you/);
    for (const id of [viaProject.id, viaPc.id, posted.id]) assert.equal(f.approved(id), null);
  } finally { await f.close(); }
});

test('a PC approval of a request with no repo carries the project repo; with none it still signs', async () => {
  const f = await fixture({ tracked: { 'workspace-app': 'example/probe' } });
  try {
    const a = f.put({ repo: undefined, target: 'pc' });
    assert.equal((await f.post(`/hub/requests/${a.id}/approve`, { target: 'pc' })).status, 201);
    assert.equal(f.approved(a.id).repo, 'example/probe');
    const b = f.put({ repo: undefined, target: 'pc', project: 'sprite-studio' });
    assert.equal((await f.post(`/hub/requests/${b.id}/approve`, { target: 'pc' })).status, 201);
    assert.equal(f.approved(b.id).repo, null);
  } finally { await f.close(); }
});
