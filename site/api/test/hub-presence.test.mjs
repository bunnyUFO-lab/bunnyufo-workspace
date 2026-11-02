// The Away switch: the view rules, the request checks, and the route (owner only, Origin, a marked file counts as off).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { checkPresenceRequest, presenceView } from '../hub-presence.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const HOUR = 3600000;
const NOW = new Date('2026-11-02T10:00:00Z');
const keyPair = generateKeyPairSync('ed25519');
const SIGNING = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const iso = ms => new Date(NOW.getTime() + ms).toISOString();

test('presenceView: away only for away:true with an until ahead by at most 12 h', () => {
  assert.equal(presenceView({ away: true, until: iso(HOUR) }, NOW).away, true);
  assert.equal(presenceView({ away: true, until: iso(12 * HOUR) }, NOW).away, true);
  assert.equal(presenceView({ away: true, until: iso(12 * HOUR + 1000) }, NOW).away, false, 'a longer one was not written by the Hub');
  assert.equal(presenceView({ away: true, until: iso(-1) }, NOW).away, false, 'expired');
  assert.equal(presenceView({ away: true, until: iso(0) }, NOW).away, false);
  assert.equal(presenceView({ away: false, until: iso(HOUR) }, NOW).away, false);
  assert.equal(presenceView({ away: 'true', until: iso(HOUR) }, NOW).away, false);
  assert.equal(presenceView({ away: true }, NOW).away, false);
  assert.equal(presenceView({ away: true, until: 'soon' }, NOW).away, false);
  for (const odd of [null, undefined, 'x', 7, []]) assert.equal(presenceView(odd, NOW).away, false);
  assert.deepEqual(presenceView({ away: true, until: iso(HOUR), at: iso(0), by: 'owner' }, NOW), { away: true, until: iso(HOUR), at: iso(0), by: 'owner' });
});

test('checkPresenceRequest: away must be a boolean; hours is a whole number 1 to 12, default 12; off ignores hours', () => {
  assert.deepEqual(checkPresenceRequest({ away: true }, fail), { away: true, hours: 12 });
  assert.deepEqual(checkPresenceRequest({ away: true, hours: 3 }, fail), { away: true, hours: 3 });
  assert.deepEqual(checkPresenceRequest({ away: false, hours: 99 }, fail), { away: false, hours: 0 });
  for (const bad of [{}, { away: 'yes' }, { away: 1 }, { away: true, hours: 0 }, { away: true, hours: 13 }, { away: true, hours: 24 }, { away: true, hours: 1.5 }, { away: true, hours: '4' }, { away: true, hours: null }]) {
    assert.throws(() => checkPresenceRequest(bad, fail), error => error.status === 400, JSON.stringify(bad));
  }
});

async function fixture({ requireRemoteUser = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-presence-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const clock = { time: NOW.getTime() };
  const hub = createHub({ bucket, enabled: true, now: () => new Date(clock.time), env: { ...SIGNING }, log: () => {} });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data, headers = {}) => {
    const answered = await fetch(`${origin}/api${route}`, { method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(data ?? {}) });
    const text = await answered.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: answered.status, body, text };
  };
  const post = (data, headers = { Origin: SITE, 'Remote-User': 'owner' }) => call('POST', '/hub/presence', data, headers);
  return { fake, call, post, get: () => call('GET', '/hub/presence'), clock, close: async () => { server.close(); await fake.close(); } };
}

test('/hub/presence: nothing stored reads as at the PC; on writes the file with no writer mark, off expires it', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.get()).body, { away: false, until: null, at: null, by: null });
    const on = await f.post({ away: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.body.away, true);
    assert.equal(on.body.until, iso(12 * HOUR), 'a default of 12 h');
    const stored = f.fake.json('sections/inbox/presence.json');
    assert.deepEqual(Object.keys(stored).sort(), ['at', 'away', 'by', 'until', 'v']);
    assert.equal(stored.by, 'owner');
    assert.deepEqual(f.fake.objects.get('sections/inbox/presence.json').metadata, {}, 'the Hub writes it with no writer mark, which hub-hooks reads as the owner');
    assert.equal((await f.get()).body.away, true);
    assert.equal((await f.post({ away: true, hours: 2 })).body.until, iso(2 * HOUR));
    f.clock.time += 2 * HOUR + 1000;
    assert.equal((await f.get()).body.away, false, 'a forgotten switch turns itself off');
    await f.post({ away: true, hours: 5 });
    const off = await f.post({ away: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.away, false);
    assert.equal(f.fake.json('sections/inbox/presence.json').away, false);
    assert.equal((await f.get()).body.away, false);
  } finally { await f.close(); }
});

test('/hub/presence: no user 401, no or foreign Origin 403, bad hours 400; a refused call writes nothing', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post({ away: true }, { Origin: SITE })).status, 401);
    assert.equal((await f.post({ away: true }, { 'Remote-User': 'owner' })).status, 403, 'the Origin check');
    assert.equal((await f.post({ away: true }, { Origin: 'https://evil.example', 'Remote-User': 'owner' })).status, 403);
    for (const bad of [{}, { away: 'yes' }, { away: true, hours: 13 }, { away: true, hours: 0 }, { away: true, hours: 1.5 }]) {
      assert.equal((await f.post(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(f.fake.objects.get('sections/inbox/presence.json'), undefined);
    assert.equal((await f.call('PUT', '/hub/presence', { away: true }, { Origin: SITE, 'Remote-User': 'owner' })).status, 404, 'POST only');
  } finally { await f.close(); }
});

test('/hub/presence: a file the card API wrote (it carries a writer mark) reads as at the PC, and so does one that is not JSON', async () => {
  const f = await fixture();
  try {
    const away = JSON.stringify({ v: 1, away: true, at: iso(0), until: iso(HOUR), by: 'someone' });
    f.fake.seed('sections/inbox/presence.json', away, 'application/json', { writer: 'card-api' });
    assert.equal((await f.get()).body.away, false, 'marked');
    f.fake.seed('sections/inbox/presence.json', away, 'application/json', {});
    assert.equal((await f.get()).body.away, true, 'the same bytes with no mark');
    f.fake.seed('sections/inbox/presence.json', 'not json', 'application/json', {});
    assert.equal((await f.get()).body.away, false);
  } finally { await f.close(); }
});
