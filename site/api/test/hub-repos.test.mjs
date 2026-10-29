// The repos Spawn offers (`GET /hub/presets/repos`) and the check a request's repo gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { validRepo } from '../hub-requests.mjs';
import { startFakeS3 } from './fake-s3.mjs';

const SITE = 'https://site.example';
const NOW = new Date();

async function fixture({ env = {}, tracked = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-repos-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  for (const [project, repo] of Object.entries(tracked)) fake.seed(`sections/${project}/workspace.json`, JSON.stringify({ name: project, tracked: { repo }, entities: [] }), 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data) => {
    const answer = await fetch(`${origin}/api${route}`, { method, headers: { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' }, ...(method === 'GET' ? {} : { body: JSON.stringify(data ?? {}) }) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  return { get: route => call('GET', route), post: (route, data) => call('POST', route, data), close: async () => { server.close(); await fake.close(); } };
}

test('the list is each project\'s tracked repo in table order, then the host\'s own, with no repeats and no bad entries', async () => {
  const f = await fixture({
    env: { HUB_KNOWN_REPOS: 'example/extra, example/magic-loops, not a repo, -bad/x, example/other.repo' },
    tracked: { 'sprite-studio': 'example/sprite-studio', 'magic-loops': 'example/magic-loops' },
  });
  try {
    const { status, body } = await f.get('/hub/presets/repos');
    assert.equal(status, 200);
    assert.deepEqual(body.repos, [
      { repo: 'example/magic-loops', project: 'magic-loops' },
      { repo: 'example/sprite-studio', project: 'sprite-studio' },
      { repo: 'example/extra' },
      { repo: 'example/other.repo' },
    ]);
  } finally { await f.close(); }
});

test('with nothing tracked and nothing listed the list is empty', async () => {
  const f = await fixture();
  try { assert.deepEqual((await f.get('/hub/presets/repos')).body, { repos: [] }); } finally { await f.close(); }
});

test('validRepo takes owner/name as GitHub spells it and nothing else', () => {
  for (const good of ['example/probe', 'My-Org/repo.name_1', 'a/b', 'o/.github']) assert.equal(validRepo(good), true, good);
  for (const bad of ['', 'owner', 'owner/', '/name', 'a b/c', '-x/y', 'x-/y', 'x--y/z', 'owner/..', 'owner/.', 'owner/name/extra', 'owner/na me', 'owner/name\n', `${'a'.repeat(40)}/x`, 'https://github.com/o/n', 5, null]) assert.equal(validRepo(bad), false, String(bad));
});

test('a request with a repo that is not owner/name is refused and nothing is written', async () => {
  const f = await fixture();
  try {
    const sent = repo => f.post('/hub/requests', { project: 'probe', text: 'Fix it', preset: 'code-task', repo });
    for (const bad of ['not a repo', 'owner/..', 'https://github.com/o/n', '-x/y']) {
      const answer = await sent(bad);
      assert.equal(answer.status, 400, bad);
      assert.match(answer.body.error, /owner\/name/);
    }
    assert.equal((await sent('example/probe')).status, 201);
  } finally { await f.close(); }
});
