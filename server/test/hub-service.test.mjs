// The Hub on the local service: the same routes over the bucket a registered workspace publishes to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWorkspace } from '../workspaces.mjs';
import { createService } from '../server.mjs';
import { startFakeS3 } from '../../site/api/test/fake-s3.mjs';
import { askJson, seeder } from '../../site/api/test/hub-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function setup() {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const base = await mkdtemp(path.join(root, '.cache', 'hub-service-test-'));
  const app = path.join(base, 'app');
  const one = path.join(base, 'one');
  for (const dir of [path.join(app, 'workspace'), one, path.join(app, 'ui')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(app, 'workspace', 'workspace.json'), JSON.stringify({ entities: [] }));
  await writeFile(path.join(one, 'workspace.json'), JSON.stringify({ entities: [] }));
  await writeFile(path.join(app, 'ui', 'index.html'), '<html></html>');
  return { app, one, registryFile: path.join(base, 'registry', 'workspaces.json') };
}

test('with a bucket registered the service answers hub: true and serves the Hub routes behind its token', async () => {
  const fake = await startFakeS3();
  try {
    const { app, one, registryFile } = await setup();
    await addWorkspace({ registryFile, path: one, name: 'One', bucket: `s3://${fake.bucket}/sections/one`, activate: true });
    const ask = askJson({ id: `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-local-a1b2` });
    seeder(fake).ask(ask);
    const service = await createService({ repo: app, uiDir: path.join(app, 'ui'), registryFile, bucketOptions: { endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' } });
    try {
      const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
      const caps = await (await fetch(`${service.origin}/api/capabilities`, { headers })).json();
      assert.equal(caps.hub, true);
      assert.equal(caps.chat, false);
      assert.equal(caps.write, true);
      assert.equal((await fetch(`${service.origin}/api/hub/today`)).status, 401, 'Behind the token like every route.');
      const today = await (await fetch(`${service.origin}/api/hub/today`, { headers })).json();
      assert.equal(today.counts.needsYou, 1);
      const answered = await fetch(`${service.origin}/api/hub/asks/${ask.id}/answer`, { method: 'POST', headers, body: JSON.stringify({ note: 'from the desk' }) });
      assert.equal(answered.status, 201);
      assert.equal(fake.json(`sections/inbox/asks/${ask.id}/answer.json`).by, 'local');
    } finally { await service.close(); }
  } finally { await fake.close(); }
});

test('without a bucket the Hub is off on the local service', async () => {
  const { app } = await setup();
  const service = await createService({ repo: app, uiDir: path.join(app, 'ui'), hubOptions: { env: { BUW_S3_BUCKET: '' } } });
  try {
    const headers = { Authorization: `Bearer ${service.token}` };
    assert.equal((await (await fetch(`${service.origin}/api/capabilities`, { headers })).json()).hub, false);
    assert.equal((await fetch(`${service.origin}/api/hub/today`, { headers })).status, 404);
  } finally { await service.close(); }
});
