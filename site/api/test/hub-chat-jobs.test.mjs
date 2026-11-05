// Jobs in a chat: which requests a reply names, the rows the page reads, and the one tap that signs several (HIGH RISK: signing).
// A fake bucket and a fake Hermes; nothing here touches a real inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { idsIn, jobIdsOf, jobRow, producesAt, splitCreated } from '../chat-jobs.mjs';
import { parsePublicKey, publicKeyPem, verify } from '../signing.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { startFakeHermes } from './fake-hermes.mjs';
import { requestJson } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

test('a card job names the section its card goes to when the Hub knows it, and says what decides it when not', () => {
  const text = "a card in the project's section, or in assistant, with sources";
  assert.equal(producesAt(text, 'magic-loops'), 'a card in magic-loops, with sources');
  assert.equal(producesAt(text, 'assistant'), 'a card in assistant, with sources');
  assert.equal(producesAt(text), "a card in the project's section, or in assistant when agents may not write there, with sources");
  assert.equal(producesAt('a PR'), 'a PR', 'text without a place is left alone');
  const item = { id: 'r1', title: 'T', project: 'magic-loops', state: 'proposed' };
  const preset = { agent: 'Researcher', produces: "a card in the project's section, or in assistant", minutes: 30 };
  assert.equal(jobRow({ item, request: { text: 'x' }, preset, cardSection: 'magic-loops' }).produces, 'a card in magic-loops');
  assert.match(jobRow({ item, request: { text: 'x' }, preset }).produces, /when agents may not write there/);
});

const keyPair = generateKeyPairSync('ed25519');
const KEY_ENV = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const PUB = parsePublicKey(publicKeyPem(keyPair.privateKey));
const DAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const HOUR = 3_600_000;
const rid = (slug, n = 'a1b2') => `${DAY}-probe-${slug}-${n}`;
const CHAT = `${DAY}-abc123`;

async function fixture({ hermes = {}, env = {}, requireRemoteUser = true, key = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-chatjobs-'));
  const fake = await startFakeS3();
  const upstream = await startFakeHermes({ key: 'k1', ...hermes });
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hubEnv = { HERMES_URL: upstream.url, HERMES_API_KEY: 'k1', HUB_CHAT_RUNS: '1', HUB_MAP_REQUESTS_MS: '0', ...(key ? KEY_ENV : {}), ...env };
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'c.json'), sectionsTtl: 0, requireRemoteUser, allowedOrigins: ['https://site.example'], hub: createHub({ bucket, enabled: true, env: hubEnv }) });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = { 'Remote-User': 'owner', Origin: 'https://site.example' };
  const call = async (method, route, data, headers = owner) => {
    const answer = await fetch(`${origin}/api${route}`, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await answer.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* an event stream */ }
    return { status: answer.status, body, text };
  };
  const put = (request, files = {}, writer = 'agent') => {
    fake.seed(`sections/inbox/requests/${request.id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json', { writer });
    for (const [name, body] of Object.entries(files)) fake.seed(`sections/inbox/requests/${request.id}/${name}`, `${JSON.stringify(body)}\n`, 'application/json');
  };
  /** A conversation file: lines are written as they are. */
  const chatFile = (id, lines) => fake.seed(`sections/inbox/chat/${id}.jsonl`, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'application/x-ndjson');
  const close = async () => { server.closeAllConnections?.(); server.close(); await upstream.close(); await fake.close(); };
  return { fake, upstream, call, put, chatFile, close };
}

/** A proposal the way an agent files it: written by the agent token, not the owner. */
const job = (slug, extra = {}) => ({ ...requestJson({ id: rid(slug), project: 'probe', by: 'hermes-main', text: `Research ${slug}. The plan card is assistant/plan.`, now: new Date() }), preset: 'research', target: 'hermes', origin: { kind: 'agent', name: 'hermes' }, ...extra });
const assistant = (jobs, extra = {}) => ({ role: 'assistant', text: `Here are the jobs: ${jobs.join(' ')}`, at: new Date().toISOString(), jobs, ...extra });
const user = text => ({ role: 'user', text, at: new Date().toISOString() });

/** POST /hub/chat and read the whole event stream. */
async function send(call, data) {
  const answer = await call('POST', '/hub/chat', data);
  const events = [];
  for (const block of answer.text.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const payload = /^data: (.+)$/m.exec(block)?.[1];
    if (event) events.push({ event, data: JSON.parse(payload) });
  }
  return { status: answer.status, events, body: answer.body };
}
const linesOf = (fake, id) => fake.text(`sections/inbox/chat/${id}.jsonl`).trim().split('\n').map(line => JSON.parse(line));
const signed = (fake, id) => fake.objects.has(`sections/inbox/requests/${id}/approved.json`);
const approve = (call, id, ids, headers) => call('POST', `/hub/chat/${id}/jobs/approve`, { ids }, headers);

// --- the pure parts ---

test('idsIn finds request ids in prose, in a path and in a preview, and never inside a longer run of id characters', () => {
  const a = rid('one');
  const b = rid('two', 'z9y8');
  assert.deepEqual(idsIn(`**${a}** — the first\n- ${b}.\nSee #/~hub/request/${a} and \`${b}\``), [a, b]);
  assert.deepEqual(idsIn(`x${a}`), [], 'a letter in front is no id');
  assert.deepEqual(idsIn(`${a}-extra`), [], 'a longer run is no id');
  assert.deepEqual(idsIn(undefined), []);
});

test('splitCreated: named requests are jobs, the rest stays created; a persona makes every request a job; at most 6', () => {
  const items = [{ kind: 'approval', id: 'r1' }, { kind: 'request', id: 'r2' }, { kind: 'ask', id: 'a1' }];
  assert.deepEqual(splitCreated(items, { seen: ['r1'] }), { jobs: ['r1'], created: [items[1], items[2]] });
  assert.deepEqual(splitCreated(items, { seen: [], persona: { id: 'p' } }), { jobs: ['r1', 'r2'], created: [items[2]] });
  assert.equal(splitCreated(Array.from({ length: 9 }, (_, index) => ({ kind: 'approval', id: `r${index}` })), { seen: Array.from({ length: 9 }, (_, index) => `r${index}`) }).jobs.length, 6);
  assert.deepEqual(jobIdsOf([user('x'), assistant(['a', 'b']), assistant(['b', 'c'])]), ['a', 'b', 'c']);
});

// --- attribution ---

test('a run that names two ids gets jobs on its line; a request it filed but did not name stays created; an unnamed one from elsewhere is never a job', async () => {
  const named = job('named', {});
  const fromPreview = job('preview', {});
  const unnamed = job('unnamed', {});
  const elsewhere = job('elsewhere', { by: 'someone-else' });   // filed by another writer in the same window: createdSince never sees it
  let filing = async () => {};
  const { fake, call, put, close } = await fixture({
    hermes: { runScript: [{ call: () => filing() }, `1. ${named.id} researcher\n`, { tool: 'terminal', preview: `cards request state ${fromPreview.id}` }, 'Nothing runs until you approve.'] },
  });
  try {
    filing = async () => { for (const request of [named, fromPreview, unnamed, elsewhere]) put({ ...request, createdAt: new Date().toISOString() }); };   // filed during the turn, dated now, as the card API would
    const result = await send(call, { text: 'Plan the thing' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.events.find(item => item.event === 'jobs').data.ids.sort(), [named.id, fromPreview.id].sort());
    assert.deepEqual(result.events.find(item => item.event === 'created').data.items.map(item => item.id), [unnamed.id]);
    const saved = linesOf(fake, result.events.at(-1).data.conversation);
    assert.deepEqual(saved[1].jobs.sort(), [named.id, fromPreview.id].sort());
    assert.deepEqual(saved[1].created.map(item => item.id), [unnamed.id]);
    assert.ok(!JSON.stringify(saved[1]).includes('Research named'), 'the line keeps ids, never the words');
    assert.ok(!saved[1].jobs.includes(elsewhere.id));
  } finally { await close(); }
});

test('rows are built from the request files: the file\'s title and text, what it delivers, where it runs, and the way to approve', async () => {
  const one = job('rows', { title: 'The real title' });
  const { call, put, chatFile, close } = await fixture();
  try {
    put(one);
    chatFile(CHAT, [user('go'), assistant([one.id])]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].id, rows[0].title, rows[0].state, rows[0].approvable, rows[0].runsOn, rows[0].agent], [one.id, 'The real title', 'proposed', true, 'hermes', 'Researcher']);
    assert.match(rows[0].text, /^Research rows\./);
    assert.equal(rows[0].produces, 'a card in assistant', 'probe has no Library section: the row names assistant, not a choice between two');
    assert.equal(rows[0].flag, undefined);
    // The line holds the id only: the words come from the request file.
    assert.equal((await call('GET', '/hub/chat/20260101-zzzzzz/jobs')).status, 404);
  } finally { await close(); }
});

test('a finished job\'s row carries its outcome and the site path of its card, in assistant and in any other section', async () => {
  const inAssistant = job('card-a');
  const inProject = job('card-b');
  const withPr = job('card-c');
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    const finished = (request, result) => put({ ...request, createdAt: new Date(Date.now() - 3_600_000).toISOString() }, {
      'approved.json': { v: 1, request: request.id, target: 'hermes', limits: { minutes: 30 }, expires: new Date(Date.now() + 3_600_000).toISOString(), at: new Date(Date.now() - 3_000_000).toISOString(), by: 'owner' },
      'taken.json': { runner: 'hermes', at: new Date(Date.now() - 2_900_000).toISOString() },
      'result.json': { at: new Date(Date.now() - 2_000_000).toISOString(), by: 'hermes', ...result },
    });
    finished(inAssistant, { outcome: 'card', card: 'assistant/x' });
    finished(inProject, { outcome: 'card', card: 'dev-proj/x' });
    finished(withPr, { outcome: 'pr', pr: 'https://github.com/example/repo/pull/9' });
    for (const section of ['assistant', 'dev-proj']) fake.seed(`sections/${section}/workspace.json`, JSON.stringify({ name: section, entities: [{ id: 'x', title: 'A card', folder: 'x', created: '2026-11-01' }] }), 'application/json');
    chatFile(CHAT, [user('go'), assistant([inAssistant.id, inProject.id, withPr.id])]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.deepEqual(rows.map(row => [row.state, row.approvable]), [['done', false], ['done', false], ['done', false]]);
    assert.deepEqual(rows.map(row => row.finish.cardHref), ['/assistant#/x', '/dev-proj#/x', undefined]);
    assert.equal(rows[2].finish.pr, 'https://github.com/example/repo/pull/9');
  } finally { await close(); }
});

test('a persona chat flags every request it finds, with no one tap; Approve is refused with nothing signed', async () => {
  const filed = job('persona');
  let filing = async () => {};
  const { fake, call, put, close } = await fixture({ hermes: { runScript: [{ call: () => filing() }, 'I filed something but never said its id.'] } });
  try {
    filing = async () => put({ ...filed, createdAt: new Date().toISOString() });
    const result = await send(call, { text: 'Hello', persona: 'market-researcher' });
    const id = result.events.at(-1).data.conversation;
    assert.deepEqual(linesOf(fake, id)[1].jobs, [filed.id]);
    const rows = (await call('GET', `/hub/chat/${id}/jobs`)).body.jobs;
    assert.deepEqual([rows[0].flag, rows[0].approvable], ['persona', false]);
    assert.match(rows[0].why, /is not meant to propose jobs\. Open it to decline or approve\./);
    const refused = await approve(call, id, [filed.id]);
    assert.equal(refused.status, 409);
    assert.equal(signed(fake, filed.id), false);
  } finally { await close(); }
});

// --- HIGH RISK: signing ---

test('one tap signs each id on its own, through the one path: verifying signatures, own hashes, user as signer, target as the page shows it', async () => {
  const a = job('sign-a');
  const b = job('sign-b', { preset: 'docs', target: undefined, repo: 'owner/repo' });   // no target: what /presets/route says is signed
  delete b.target;
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    put(a); put(b);
    fake.seed('sections/probe/workspace.json', JSON.stringify({ entities: [], tracked: { repo: 'owner/repo' } }), 'application/json');   // the project's own repo
    chatFile(CHAT, [user('go'), assistant([a.id, b.id])]);
    const shown = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    const page = (await call('GET', '/hub/presets/route?preset=docs&project=probe&repo=owner/repo')).body;
    assert.equal(shown.find(row => row.id === b.id).runsOn, page.target, 'the row says what the approval page says');
    const answer = await approve(call, CHAT, [a.id, b.id]);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.body.results.map(item => [item.id, item.ok]), [[a.id, true], [b.id, true]]);
    for (const request of [a, b]) {
      const stored = fake.json(`sections/inbox/requests/${request.id}/approved.json`);
      assert.equal(verify(stored, PUB), true);
      assert.equal(stored.request, request.id);
      assert.equal(stored.requestSha256, createHash('sha256').update(fake.text(`sections/inbox/requests/${request.id}/request.json`)).digest('hex'));
      assert.equal(stored.by, 'owner');
      assert.equal(stored.limits.minutes > 0, true);
      assert.equal(new Date(stored.expires).getTime() - new Date(stored.at).getTime(), 72 * 3600 * 1000);
    }
    assert.equal(fake.json(`sections/inbox/requests/${b.id}/approved.json`).target, page.target, 'the signed target equals the page\'s');
    assert.notEqual(fake.json(`sections/inbox/requests/${a.id}/approved.json`).nonce, fake.json(`sections/inbox/requests/${b.id}/approved.json`).nonce);
    // A second tap: each is refused, and the signatures stay as they were.
    const before = fake.text(`sections/inbox/requests/${a.id}/approved.json`);
    const again = await approve(call, CHAT, [a.id]);
    assert.deepEqual(again.body.results.map(item => item.ok), [false]);
    assert.equal(fake.text(`sections/inbox/requests/${a.id}/approved.json`), before);
  } finally { await close(); }
});

test('what the approval page refuses, one tap refuses: hidden preset, Bunnylink, at-pc, owner origin, a sprint item, a second approval; nothing is written', async () => {
  const hidden = job('hidden', { preset: 'agent-avatar-sheet' });
  const homelab = job('homelab', { project: 'bunnylink', id: `${DAY}-bunnylink-homelab-b111` });
  const atPc = job('atpc', { target: 'at-pc' });
  const owners = job('owners', { origin: { kind: 'owner', name: 'owner' } });
  const sprint = job('sprint', { sprint: { head: rid('head', 'h111'), seq: 1 } });
  const model = job('model', { preset: 'code-task', target: 'pc', model: 'sonnet' });
  const done = job('done');
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    const all = [hidden, homelab, atPc, owners, sprint, model, done];
    for (const request of all) put(request, request === done ? { 'approved.json': { v: 1 } } : {});
    chatFile(CHAT, [user('go'), assistant(all.map(request => request.id).slice(0, 6)), assistant([done.id])]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.ok(rows.filter(row => row.state === 'proposed').every(row => row.approvable === false && row.why), 'every one of them shows why it has no tap');
    for (const part of [all.slice(0, 3), all.slice(3, 6)]) {
      const answer = await approve(call, CHAT, part.map(request => request.id));
      assert.equal(answer.status, 200, answer.text);
      assert.ok(answer.body.results.every(item => item.ok === false && item.error), JSON.stringify(answer.body));
    }
    for (const request of all) assert.equal(signed(fake, request.id) && request !== done, false, request.id);
    assert.equal((await approve(call, CHAT, [done.id])).body.results[0].ok, false, 'an approved one is refused');
  } finally { await close(); }
});

test('an id that is not on this chat\'s lines is refused with nothing signed, even beside ids that are; an id from another chat too', async () => {
  const mine = job('mine');
  const stranger = job('stranger');
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    put(mine); put(stranger);
    chatFile(CHAT, [user('go'), assistant([mine.id])]);
    chatFile(`${DAY}-def456`, [user('go'), assistant([stranger.id])]);
    for (const ids of [[stranger.id], [mine.id, stranger.id], [rid('missing', 'm999')]]) {
      const answer = await approve(call, CHAT, ids);
      assert.equal(answer.status, 404, JSON.stringify(ids));
    }
    assert.equal(signed(fake, mine.id) || signed(fake, stranger.id), false);
    for (const body of [[], 'x', Array.from({ length: 7 }, (_, index) => rid('many', `a00${index}`)), [mine.id, mine.id], [5]]) {
      assert.equal((await call('POST', `/hub/chat/${CHAT}/jobs/approve`, { ids: body })).status, 400, JSON.stringify(body));
    }
    assert.equal(signed(fake, mine.id), false);
  } finally { await close(); }
});

test('no user is 401 and no signing key is 503, each with nothing written', async () => {
  const one = job('nokey');
  const keyless = await fixture({ key: false });
  try {
    keyless.put(one);
    keyless.chatFile(CHAT, [user('go'), assistant([one.id])]);
    const answer = await approve(keyless.call, CHAT, [one.id]);
    assert.equal(answer.status, 503);
    assert.equal(signed(keyless.fake, one.id), false);
    const rows = (await keyless.call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.equal(rows[0].approvable, false);
    assert.ok(rows[0].why);
  } finally { await keyless.close(); }
  const open = await fixture({ requireRemoteUser: false });
  try {
    open.put(one);
    open.chatFile(CHAT, [user('go'), assistant([one.id])]);
    const answer = await approve(open.call, CHAT, [one.id], { Origin: 'https://site.example' });
    assert.equal(answer.status, 401);
    assert.equal(signed(open.fake, one.id), false);
  } finally { await open.close(); }
  const anonymous = await fixture();
  try {
    anonymous.put(one);
    anonymous.chatFile(CHAT, [user('go'), assistant([one.id])]);
    assert.equal((await approve(anonymous.call, CHAT, [one.id], {})).status, 401);
    assert.equal(signed(anonymous.fake, one.id), false);
  } finally { await anonymous.close(); }
});

test('one failure among three leaves the other two signed, and the answer says which; a later look shows the states', async () => {
  const first = job('first');
  const second = job('second', { target: 'at-pc' });   // the page would refuse this one
  const third = job('third');
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    for (const request of [first, second, third]) put(request);
    chatFile(CHAT, [user('go'), assistant([first.id, second.id, third.id])]);
    const answer = await approve(call, CHAT, [first.id, second.id, third.id]);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.results.map(item => [item.id, item.ok]), [[first.id, true], [second.id, false], [third.id, true]]);
    assert.match(answer.body.results[1].error, /never signed/);
    assert.match(answer.body.results[0].state, /^(approved|taken|running)$/);
    assert.deepEqual([signed(fake, first.id), signed(fake, second.id), signed(fake, third.id)], [true, false, true]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.equal(rows[1].state, 'proposed');
    assert.match(rows[0].state, /^(approved|taken|running)$/);   // the fake Hermes may already have taken it
    assert.match(rows[2].state, /^(approved|taken|running)$/);
  } finally { await close(); }
});

// --- after review: what the row shows, which requests reach it, and how many one tap takes ---

const track = (fake, repo = 'owner/repo') => fake.seed('sections/probe/workspace.json', JSON.stringify({ entities: [], tracked: { repo } }), 'application/json');
const backdate = (fake, id, ms) => { fake.objects.get(`sections/inbox/requests/${id}/request.json`).lastModified = new Date(Date.now() - ms).toUTCString(); };

test('the row shows the project, repo and model, and a repo that is not the project\'s or a pinned model gets no one tap', async () => {
  const other = job('other-repo', { preset: 'code-task', target: 'pc', repo: 'someone/other-repo' });
  const own = job('own-repo', { preset: 'code-task', target: 'pc', repo: 'owner/repo' });
  const pinned = job('pinned', { model: 'haiku' });
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    track(fake);
    for (const request of [other, own, pinned]) put(request);
    chatFile(CHAT, [user('go'), assistant([other.id, own.id, pinned.id])]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.deepEqual(rows.map(row => [row.project, row.repo, row.model, row.approvable]), [['probe', 'someone/other-repo', undefined, false], ['probe', 'owner/repo', undefined, true], ['probe', undefined, 'haiku', false]]);
    assert.match(rows[0].why, /repo/i);
    assert.match(rows[2].why, /model/i);
    const answer = await approve(call, CHAT, [other.id, pinned.id]);
    assert.deepEqual(answer.body.results.map(item => item.ok), [false, false]);
    assert.equal(signed(fake, other.id) || signed(fake, pinned.id), false);
    assert.equal((await approve(call, CHAT, [own.id])).body.results[0].ok, true);
  } finally { await close(); }
});

test('a request dated ahead, by an unexpected name, or from a run is never a verified one-tap proposal; a future or backdated file is kept out of the turn\'s jobs', async () => {
  const ahead = job('ahead', { createdAt: new Date(Date.now() + 365 * 24 * HOUR).toISOString() });
  const backdated = job('backdated');
  const spoof = job('spoof', { by: 'hermes-spoof' });
  const viaRun = job('via-run', { origin: { kind: 'run', name: 'some-run' } });
  const good = job('good');
  let filing = async () => {};
  const { fake, call, put, close } = await fixture({ hermes: { runScript: [{ call: () => filing() }, `Open proposals: ${ahead.id} ${backdated.id} ${spoof.id} ${viaRun.id} ${good.id}`] } });
  try {
    filing = async () => {
      for (const request of [ahead, backdated, spoof, viaRun, good]) put({ ...request, createdAt: request.createdAt > new Date().toISOString() ? request.createdAt : new Date().toISOString() });
      backdate(fake, backdated.id, HOUR);   // the body claims now; the object says an hour ago
    };
    const result = await send(call, { text: 'What is open?' });
    const id = result.events.at(-1).data.conversation;
    const saved = linesOf(fake, id)[1];
    assert.deepEqual([...saved.jobs].sort(), [spoof.id, viaRun.id, good.id].sort(), 'the dated-ahead and the backdated file never reach the turn');
    assert.ok(!(saved.created ?? []).some(item => [ahead.id, backdated.id].includes(item.id)));
    const rows = Object.fromEntries((await call('GET', `/hub/chat/${id}/jobs`)).body.jobs.map(row => [row.id, row]));
    assert.deepEqual([rows[good.id].verified, rows[good.id].approvable], [true, true]);
    assert.deepEqual([rows[spoof.id].verified, rows[spoof.id].approvable], [false, false]);
    assert.equal(rows[viaRun.id].approvable, false);
    assert.equal(rows[spoof.id].writer, 'hermes');
    const refused = await approve(call, id, [spoof.id, viaRun.id]);
    assert.deepEqual(refused.body.results.map(item => item.ok), [false, false]);
    assert.equal(signed(fake, spoof.id) || signed(fake, viaRun.id), false);
  } finally { await close(); }
});

test('one tap only for ids named in the reply\'s text: an id seen only in a tool preview gets a row, with Open it to approve', async () => {
  const said = job('said');
  const previewed = job('previewed');
  let filing = async () => {};
  const { fake, call, put, close } = await fixture({ hermes: { runScript: [{ call: () => filing() }, { tool: 'web_fetch', preview: `see ${previewed.id}` }, `Proposed: ${said.id}`] } });
  try {
    filing = async () => { for (const request of [said, previewed]) put({ ...request, createdAt: new Date().toISOString() }); };
    const id = (await send(call, { text: 'Plan' })).events.at(-1).data.conversation;
    const rows = Object.fromEntries((await call('GET', `/hub/chat/${id}/jobs`)).body.jobs.map(row => [row.id, row]));
    assert.deepEqual([rows[said.id].approvable, rows[previewed.id].approvable], [true, false]);
    assert.match(rows[previewed.id].why, /not named in the reply/i);
    const answer = await approve(call, id, [previewed.id]);
    assert.equal(answer.body.results[0].ok, false);
    assert.equal(signed(fake, previewed.id), false);
  } finally { await close(); }
});

test('a job that opens windows on the PC gets no one tap, and the server refuses it too', async () => {
  const windows = job('windows', { preset: 'playtest-build', target: 'pc' });
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    put(windows);
    chatFile(CHAT, [user('go'), assistant([windows.id], { text: `Proposed: ${windows.id}` })]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.deepEqual([rows[0].approvable, rows[0].verified], [false, true]);
    assert.match(rows[0].why, /windows/i);
    assert.equal((await approve(call, CHAT, [windows.id])).body.results[0].ok, false);
    assert.equal(signed(fake, windows.id), false);
  } finally { await close(); }
});

test('a row is checked again when it is read: a file dated ahead, or whose object is older than the reply, has no one tap', async () => {
  const ahead = job('row-ahead', { createdAt: new Date(Date.now() + 365 * 24 * HOUR).toISOString() });
  const old = job('row-old');
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    put(ahead); put(old);
    backdate(fake, old.id, 2 * HOUR);
    chatFile(CHAT, [user('go'), assistant([ahead.id, old.id])]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.deepEqual(rows.map(row => [row.verified, row.approvable]), [[false, false], [false, false]]);
    assert.ok(rows.every(row => row.why));
    const answer = await approve(call, CHAT, [ahead.id, old.id]);
    assert.deepEqual(answer.body.results.map(item => item.ok), [false, false]);
    assert.equal(signed(fake, ahead.id) || signed(fake, old.id), false);
  } finally { await close(); }
});

test('a job filed after the list was cached still gets its row when a new reply names it', async () => {
  const first = job('cache-one');
  const second = job('cache-two');
  const { call, put, chatFile, close } = await fixture({ env: { HUB_MAP_REQUESTS_MS: '30000' } });
  try {
    put(first);
    chatFile(CHAT, [user('go'), assistant([first.id])]);
    assert.equal((await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs.length, 1);
    put(second);   // filed by the card API, another process: nothing clears this process's list
    chatFile(CHAT, [user('go'), assistant([first.id]), user('more'), assistant([second.id])]);
    assert.deepEqual((await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs.map(row => row.id), [first.id, second.id]);
  } finally { await close(); }
});

test('Open the PR is only a github.com pull request link', async () => {
  const good = job('pr-good');
  const evil = job('pr-evil');
  const { call, put, chatFile, close } = await fixture();
  try {
    const finished = (request, pr) => put({ ...request, createdAt: new Date(Date.now() - HOUR).toISOString() }, {
      'approved.json': { v: 1, request: request.id, target: 'hermes', limits: { minutes: 30 }, expires: new Date(Date.now() + HOUR).toISOString(), at: new Date(Date.now() - HOUR).toISOString(), by: 'owner' },
      'taken.json': { runner: 'hermes', at: new Date(Date.now() - HOUR).toISOString() },
      'result.json': { at: new Date().toISOString(), by: 'hermes', outcome: 'pr', pr },
    });
    finished(good, 'https://github.com/example/repo/pull/9');
    finished(evil, 'https://evil.example/login');
    chatFile(CHAT, [user('go'), assistant([good.id, evil.id])]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.equal(rows[0].finish.pr, 'https://github.com/example/repo/pull/9');
    assert.equal(rows[1].finish.pr, undefined);
  } finally { await close(); }
});

test('a chat whose persona is not in the table is still a persona chat: flagged, no one tap', async () => {
  const filed = job('gone');
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    put(filed);
    chatFile(CHAT, [{ ...user('go'), persona: 'gone-persona' }, { ...assistant([filed.id]), persona: 'gone-persona' }]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.deepEqual([rows[0].flag, rows[0].approvable], ['persona', false]);
    assert.equal((await approve(call, CHAT, [filed.id])).status, 409);
    assert.equal(signed(fake, filed.id), false);
  } finally { await close(); }
});

test('one tap takes at most 3 ids, and each row carries the estimate the total is made of', async () => {
  const four = ['t1', 't2', 't3', 't4'].map((slug, index) => job(`cap-${slug}`, index === 3 ? { preset: 'code-task', target: 'pc', repo: 'owner/repo' } : {}));
  const { fake, call, put, chatFile, close } = await fixture();
  try {
    track(fake);
    four.forEach(request => put(request));
    chatFile(CHAT, [user('go'), assistant(four.map(request => request.id))]);
    const rows = (await call('GET', `/hub/chat/${CHAT}/jobs`)).body.jobs;
    assert.deepEqual(rows[0].tokens, { low: 0.7, high: 1.1 });
    assert.match(rows[0].estimate.cost, /tokens/);
    assert.equal(rows[3].tokens, undefined);
    assert.equal((await approve(call, CHAT, four.map(request => request.id))).status, 400);
    assert.equal(four.some(request => signed(fake, request.id)), false);
    assert.equal((await approve(call, CHAT, four.slice(0, 3).map(request => request.id))).status, 200);
  } finally { await close(); }
});
