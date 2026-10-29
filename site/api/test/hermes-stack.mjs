// A shared stand-in for the site API's Hermes request runs: one fake S3, one fake Hermes, and as many hubs on them as a test wants.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeHermes } from './fake-hermes.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { requestJson, seeder } from './hub-fixtures.mjs';

const SITE = 'https://site.example';
export const KEY = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
export const TIMING = { reopenMs: 20, pollMs: 20, backoffMs: 20, backoffMaxMs: 40, tickMs: 10, sweepMs: 60_000 };
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
let counter = 0;
export const newId = slug => `${day}-probe-${slug}-${String.fromCharCode(97 + (counter % 26))}${String(++counter).padStart(3, '0')}`;
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`);
    await wait(15);
  }
}

/** One S3, one Hermes, and as many hubs (site API processes) on them as a test wants. */
export async function stack({ hermesOptions = {}, env = {}, timing = TIMING, noHermes = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hermes-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hermes = noHermes ? null : await startFakeHermes({ key: 'k', delayMs: 5, ...hermesOptions });
  const clock = { at: Date.now() };
  const opened = [];
  const addHub = async ({ fetchImpl, log } = {}) => {
    const hub = createHub({
      bucket, enabled: true, now: () => new Date(clock.at), hermesTiming: timing, log: log ?? (() => {}), ...(fetchImpl ? { fetchImpl } : {}),
      env: { HUB_SIGNING_KEY: KEY, ...(hermes ? { HERMES_URL: hermes.url, HERMES_API_KEY: 'k' } : {}), ...env },
    });
    const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, `state-${opened.length}.json`), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, route, data, headers = { 'Remote-User': 'owner' }) => {
      const answer = await fetch(`${origin}/api${route}`, {
        method, headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Content-Type': 'application/json' }), ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
      });
      return { status: answer.status, body: await answer.json().catch(() => null) };
    };
    const api = {
      hub, origin, get: route => call('GET', route), post: (route, data, headers) => call('POST', route, data, headers),
      stop: async () => { await hub.close(); server.closeAllConnections(); server.close(); },
    };
    opened.push(api);
    return api;
  };
  const seed = seeder(fake);
  /** A proposed research request, ready to approve. */
  const writers = {};
  const propose = (slug = 'research', extra = {}, { writer } = {}) => {
    const id = newId(slug);
    const request = { ...requestJson({ id, now: new Date(clock.at) }), preset: 'research', target: 'hermes', origin: { kind: 'owner', name: 'owner' }, ...extra };
    // The token that wrote the file leaves its kind as metadata: the site for the owner's, an agent session for an agent's, a runner for a run's.
    if (writer !== undefined) writers[id] = writer;
    const writerKind = id in writers ? writers[id] : { owner: 'site', agent: 'agent', run: 'runner' }[request.origin?.kind];
    seed.request(request, writerKind ? { writer: writerKind } : {});
    return id;
  };
  const resultOf = id => fake.json(`sections/inbox/requests/${id}/result.json`);
  const file = (id, name) => fake.json(`sections/inbox/requests/${id}/${name}`);
  const close = async () => {
    for (const api of opened) await api.stop().catch(() => {});
    await hermes?.close();
    await fake.close();
  };
  return { fake, hermes, clock, addHub, propose, resultOf, file, seed, close };
}

// The fake loses a release that lands before the run reaches its hold step, so release again until every request has a result.
export const releaseAll = (s, ids) => until(() => {
  for (const run of s.hermes.runs) if (!['completed', 'failed', 'cancelled'].includes(run.status)) s.hermes.release(run.id, 'Ok.\nCARD: assistant/x');
  return ids.every(id => s.resultOf(id));
}, 'all results');

export const approve = (api, id) => api.post(`/hub/requests/${id}/approve`, { target: 'hermes' });

