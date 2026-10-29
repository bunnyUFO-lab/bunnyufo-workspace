// Policy approval: the site API signs eligible proposals by itself, within limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyKinds } from '../policy.mjs';
import { stack, until, wait } from './hermes-stack.mjs';

const agent = { origin: { kind: 'agent', name: 'some-agent' } };
const POLICY = { HUB_POLICY_APPROVE: 'research,docs' };

test('parsePolicyKinds accepts research and docs only', () => {
  assert.deepEqual(parsePolicyKinds('research,docs'), ['research', 'docs']);
  assert.deepEqual(parsePolicyKinds(' Docs , code, research, research '), ['docs', 'research']);
  assert.deepEqual(parsePolicyKinds('code,build,art'), []);
  assert.deepEqual(parsePolicyKinds(''), []);
  assert.deepEqual(parsePolicyKinds(undefined), []);
});

test('policy is off by default: nothing is signed and capabilities list no kinds', async () => {
  const s = await stack({ hermesOptions: { endWith: 'Done.\nCARD: assistant/x' } });
  try {
    const api = await s.addHub();
    await api.hub.policy.ready;
    const id = s.propose('off', agent);
    assert.deepEqual(await api.hub.policy.sweep(), []);
    await wait(80);
    assert.equal(s.file(id, 'approved.json'), null);
    assert.deepEqual((await api.get('/capabilities')).body.policy, []);
  } finally { await s.close(); }
});

test('an agent research request is signed by policy and started, without a click', async () => {
  const s = await stack({ hermesOptions: { runScript: ['working ', { hold: true }] }, env: POLICY });
  try {
    const id = s.propose('auto', agent);
    const api = await s.addHub();
    await api.hub.policy.ready;
    assert.deepEqual((await api.get('/capabilities', undefined)).body.policy, ['research', 'docs']);
    await until(() => s.file(id, 'approved.json'), 'a policy signature');
    const approved = s.file(id, 'approved.json');
    assert.deepEqual([approved.by, approved.target, approved.request], ['policy', 'hermes', id]);
    assert.ok(approved.signature);
    await until(() => s.hermes.runs.length === 1, 'the run');
    assert.equal(s.hermes.runs[0].key, id);
    assert.equal((await until(async () => (await api.get(`/hub/requests/${id}`)).body.state === 'running' && 'running', 'running')), 'running');
  } finally { await s.close(); }
});

test('an owner research request is signed too; an agent docs request is signed for its routed target', async () => {
  const s = await stack({ env: POLICY });
  try {
    const api = await s.addHub();
    await api.hub.policy.ready;
    const research = s.propose('owner');
    const docs = s.propose('docs', { ...agent, preset: 'docs', target: 'pc', repo: 'example/probe' });
    assert.deepEqual((await api.hub.policy.sweep()).sort(), [research, docs].sort());
    assert.equal(s.file(docs, 'approved.json').target, 'pc');
    assert.equal(s.file(docs, 'approved.json').by, 'policy');
    assert.equal(s.file(research, 'approved.json').by, 'policy');
  } finally { await s.close(); }
});

test('a run\'s request, a code task and a kind that is not listed stay proposed', async () => {
  const s = await stack({ env: { HUB_POLICY_APPROVE: 'research' } });
  try {
    const api = await s.addHub();
    await api.hub.policy.ready;
    const fromRun = s.propose('fromrun', { origin: { kind: 'run', name: 'some-run' } });
    const code = s.propose('code', { ...agent, preset: 'code-task', target: 'pc', repo: 'example/probe' });
    const docs = s.propose('docs', { ...agent, preset: 'docs', target: 'pc', repo: 'example/probe' });
    const ok = s.propose('fine', agent);
    assert.deepEqual(await api.hub.policy.sweep(), [ok]);
    for (const id of [fromRun, code, docs]) assert.equal(s.file(id, 'approved.json'), null, id);
    assert.equal((await api.get(`/hub/requests/${fromRun}`)).body.state, 'proposed');
  } finally { await s.close(); }
});

test('the day\'s limit counts only policy signatures; over it a proposal stays with a note, and a tap still signs it', async () => {
  const s = await stack({ env: { ...POLICY, HUB_POLICY_PER_DAY: '2' } });
  try {
    const api = await s.addHub();
    await api.hub.policy.ready;
    const one = s.propose('one', agent);
    const two = s.propose('two', agent);
    const three = s.propose('three', agent);
    // A tap-signed approval does not count toward the limit.
    const mine = s.propose('mine', { preset: 'docs', target: 'pc', repo: 'example/probe', origin: { kind: 'run', name: 'r' } });
    assert.equal((await api.post(`/hub/requests/${mine}/approve`, { target: 'pc' })).status, 201);
    const signed = await api.hub.policy.sweep();
    assert.equal(signed.length, 2, JSON.stringify(signed));
    assert.equal([one, two, three].filter(id => s.file(id, 'approved.json')).length, 2);
    assert.equal(s.file(mine, 'approved.json').by, 'owner');
    const left = [one, two, three].find(id => !s.file(id, 'approved.json'));
    const row = (await api.get('/hub/inbox?filter=needs-you')).body.items.find(item => item.id === left);
    assert.equal(row.note, 'Policy limit reached today');
    assert.equal((await api.hub.policy.sweep()).length, 0, 'The limit holds across sweeps.');
    assert.equal((await api.post(`/hub/requests/${left}/approve`, { target: 'hermes' })).status, 201, 'A tap still signs it.');
  } finally { await s.close(); }
});

test('without a signing key policy does nothing', async () => {
  const s = await stack({ env: { ...POLICY, HUB_SIGNING_KEY: '' } });
  try {
    const id = s.propose('nokey', agent);
    const api = await s.addHub();
    await api.hub.policy.ready;
    assert.deepEqual(api.hub.policy.kinds, []);
    assert.deepEqual(await api.hub.policy.sweep(), []);
    assert.equal(s.file(id, 'approved.json'), null);
  } finally { await s.close(); }
});

test('the sweep and a request that waits at the Hermes cap: policy signs, the run waits', async () => {
  const s = await stack({ hermesOptions: { runScript: ['go ', { hold: true }] }, env: POLICY });
  try {
    const api = await s.addHub();
    await api.hub.policy.ready;
    const first = ['a', 'b', 'c'].map(slug => s.propose(slug, agent));
    await api.hub.policy.sweep();
    await until(() => s.hermes.runs.length === 3, 'three runs');
    const fourth = s.propose('d', agent);
    assert.deepEqual(await api.hub.policy.sweep(), [fourth]);
    assert.ok(s.file(fourth, 'approved.json').signature);
    assert.equal(s.file(fourth, 'taken.json'), null, 'It waits for a free slot.');
    assert.equal(s.hermes.runs.length, 3);
    assert.equal(first.length, 3);
  } finally { await s.close(); }
});

// --- review fixes: who may be signed, and what a day is ---

import { pacificDay } from '../policy.mjs';

test('policy fails closed: no origin, no writer, a runner\'s writer or a body that disagrees with the writer stay proposed', async () => {
  const s = await stack({ env: POLICY });
  try {
    const api = await s.addHub();
    await api.hub.policy.ready;
    const noOrigin = s.propose('noorigin', { origin: undefined }, { writer: 'agent' });
    const noWriter = s.propose('nowriter', agent, { writer: null });
    const runner = s.propose('runner', agent, { writer: 'runner' }); // a run's token claiming to be an agent
    const hermes = s.propose('hermes', agent, { writer: 'hermes' });
    const mismatch = s.propose('mismatch', { origin: { kind: 'owner', name: 'o' } }, { writer: 'agent' }); // an agent claiming to be the owner
    const wrongSite = s.propose('wrongsite', agent, { writer: 'site' });
    const ok = s.propose('fine', agent, { writer: 'agent' });
    assert.deepEqual(await api.hub.policy.sweep(), [ok]);
    for (const id of [noOrigin, noWriter, runner, hermes, mismatch, wrongSite]) assert.equal(s.file(id, 'approved.json'), null, id);
    for (const id of [noOrigin, runner]) assert.equal((await api.get(`/hub/requests/${id}`)).body.state, 'proposed');
  } finally { await s.close(); }
});

test('a request the site wrote carries the writer metadata and is signed by policy', async () => {
  const s = await stack({ env: POLICY });
  try {
    const api = await s.addHub();
    await api.hub.policy.ready;
    const made = await api.post('/hub/requests', { project: 'probe', text: 'Research tug games', preset: 'research' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(s.fake.objects.get(`sections/inbox/requests/${made.body.id}/request.json`).metadata.writer, 'site');
    assert.deepEqual(await api.hub.policy.sweep(), [made.body.id]);
    assert.equal(s.file(made.body.id, 'approved.json').by, 'policy');
  } finally { await s.close(); }
});

test('a day is a Pacific day: 20 signatures cannot fall in one day by crossing UTC midnight', async () => {
  assert.equal(pacificDay(new Date('2026-10-29T23:30:00Z')), '2026-10-29');
  assert.equal(pacificDay(new Date('2026-10-30T02:00:00Z')), '2026-10-29', 'UTC has turned over; it is 7 PM in Pacific time.');
  assert.equal(pacificDay(new Date('2026-10-30T08:00:00Z')), '2026-10-30');
  assert.equal(pacificDay(new Date('2026-12-30T07:59:00Z')), '2026-12-29', 'Standard time: UTC-8.');
  const s = await stack({ env: { ...POLICY, HUB_POLICY_PER_DAY: '2' } });
  try {
    const day = new Date().toISOString().slice(0, 10);
    s.clock.at = new Date(`${day}T23:30:00Z`).getTime();
    const api = await s.addHub();
    await api.hub.policy.ready;
    const first = ['a', 'b', 'c'].map(slug => s.propose(slug, agent));
    assert.equal((await api.hub.policy.sweep()).length, 2);
    s.clock.at += 90 * 60_000; // 01:00 UTC the next day, still the same Pacific day
    assert.equal(pacificDay(new Date(s.clock.at)), pacificDay(new Date(`${day}T23:30:00Z`)));
    assert.deepEqual(await api.hub.policy.sweep(), [], 'The limit holds across UTC midnight.');
    const left = first.find(id => !s.file(id, 'approved.json'));
    const row = (await api.get('/hub/inbox?filter=needs-you')).body.items.find(item => item.id === left);
    assert.equal(row.note, 'Policy limit reached today');
    s.clock.at += 8 * 3600_000; // 09:00 UTC: a new Pacific day
    assert.deepEqual(await api.hub.policy.sweep(), [left]);
  } finally { await s.close(); }
});
