// `POST /hub/requests/:id/again`: what an Edit may change. "Done when" is carried and may be removed; text that is left alone keeps
// the "written by" marker, and text that is rewritten drops it. (The rest of `again` is in hub-requests.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { requestJson, seeder } from './hub-fixtures.mjs';

const SITE = 'https://site.example';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const keyPair = generateKeyPairSync('ed25519');
const env = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-again-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, data) => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify(data ?? {}) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const seed = seeder(fake);
  return { fake, post, seed, close: async () => { server.close(); await fake.close(); } };
}

const agentRequest = (slug, extra = {}) => ({ ...requestJson({ id: `${day}-probe-${slug}-a1b2`, now: NOW }), project: 'probe', preset: 'market-research', target: 'hermes', origin: { kind: 'agent', name: 'hermes-briefs' }, doneWhen: 'three takeaways', ...extra });
const copyOf = (fake, answer) => fake.json(`sections/inbox/requests/${answer.body.id}/request.json`);

test('again carries a new "Done when", removes it when empty, and leaves it alone when absent', async () => {
  const { fake, post, seed, close } = await fixture();
  try {
    const changed = agentRequest('done1');
    seed.request(changed);
    const first = await post(`/hub/requests/${changed.id}/again`, { doneWhen: 'a card with sources' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(copyOf(fake, first).doneWhen, 'a card with sources');
    assert.equal(fake.json(`sections/inbox/requests/${changed.id}/declined.json`).reason, `replaced by ${first.body.id}`);

    const emptied = agentRequest('done2');
    seed.request(emptied);
    const second = await post(`/hub/requests/${emptied.id}/again`, { doneWhen: '  ' });
    assert.equal(second.status, 201);
    assert.equal(copyOf(fake, second).doneWhen, undefined, 'An empty one removes it.');

    const kept = agentRequest('done3');
    seed.request(kept);
    const third = await post(`/hub/requests/${kept.id}/again`, { target: 'hermes' });
    assert.equal(copyOf(fake, third).doneWhen, 'three takeaways');
  } finally { await close(); }
});

test('again refuses a "Done when" over 400 characters or one that is not text, and writes nothing', async () => {
  const { fake, post, seed, close } = await fixture();
  try {
    const request = agentRequest('done4');
    seed.request(request);
    const before = fake.objects.size;
    const long = await post(`/hub/requests/${request.id}/again`, { doneWhen: 'x'.repeat(401) });
    assert.equal(long.status, 400);
    assert.match(long.body.error, /400/);
    assert.equal((await post(`/hub/requests/${request.id}/again`, { doneWhen: 5 })).status, 400);
    assert.equal(fake.objects.size, before, 'Nothing was copied.');
    assert.equal((await post(`/hub/requests/${request.id}/again`, { doneWhen: 'x'.repeat(400) })).status, 201, '400 characters is allowed.');
  } finally { await close(); }
});

test('again without text keeps who wrote the text; with text the owner has written it', async () => {
  const { fake, post, seed, close } = await fixture();
  try {
    const request = agentRequest('mark1');
    seed.request(request);
    const same = await post(`/hub/requests/${request.id}/again`, { target: 'hermes' });
    assert.equal(same.status, 201);
    const kept = copyOf(fake, same);
    assert.deepEqual([kept.origin.kind, kept.textOrigin?.kind, kept.textOrigin?.name], ['owner', 'agent', 'hermes-briefs']);

    const other = agentRequest('mark2');
    seed.request(other);
    const rewritten = await post(`/hub/requests/${other.id}/again`, { text: 'My own words' });
    const copy = copyOf(fake, rewritten);
    assert.equal(copy.text, 'My own words');
    assert.equal(copy.textOrigin, undefined, 'The owner rewrote it, so there is nothing to warn about.');
  } finally { await close(); }
});
