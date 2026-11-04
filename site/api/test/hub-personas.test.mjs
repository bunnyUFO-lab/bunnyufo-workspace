// The owner's persona edits (ws-im1.4.1): the pure checks, the version store over the stand-in S3, the routes, and the agent-edit Ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { CHAT_PERSONAS, PERSONA_TEMPLATES, chatPersonaOf, chatPersonasForClient, personaTextOf, storedPersona } from '../chat-personas.mjs';
import { PERSONA_FILE_RE, VIEW_ONLY, checkPersonaEdit, effectivePersona, syncRole } from '../hub-personas.mjs';
import { AGENT_EDIT_OPTIONS, validateAgentEdit } from '../agent-edit.mjs';
import { discordEligible, validId } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { agentConfigJson, askJson, seedAgentConfig, seeder } from './hub-fixtures.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { parsePublicKey, publicKeyPem, sign, verify } from '../signing.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const TEARDOWN = CHAT_PERSONAS.find(entry => entry.id === 'teardown');
const edit = (extra = {}) => ({ role: TEARDOWN.role, prompt: TEARDOWN.text, model: TEARDOWN.model, base: 'default', ...extra });

async function fixture({ requireRemoteUser = true, env = {} } = {}) {
  const clock = { time: NOW.getTime() };
  const root = await mkdtemp(path.join(tmpdir(), 'buw-persona-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => new Date(clock.time), env });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'c.json'), sectionsTtl: 0, requireRemoteUser, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data, user = 'owner') => {
    const answered = await fetch(`${origin}/api${route}`, {
      method, headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Content-Type': 'application/json' }), ...(user ? { 'Remote-User': user } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
    });
    const text = await answered.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: answered.status, body };
  };
  const files = agent => [...fake.objects.keys()].filter(name => name.startsWith(`sections/inbox/team/${agent}/persona-`)).sort();
  /** Moves the clock a second on, so two writes never share a stamp. */
  const tick = () => { clock.time += 1000; };
  const save = async (agent, data, user = 'owner') => { tick(); return call('POST', `/hub/team/${agent}/persona`, data, user); };
  const revert = async (agent, data, user = 'owner') => { tick(); return call('POST', `/hub/team/${agent}/persona/revert`, data, user); };
  const seed = seeder(fake);
  return { clock, fake, hub, call, files, save, revert, seed, close: async () => { server.closeAllConnections?.(); server.close(); await fake.close(); } };
}

test('checkPersonaEdit: a good edit is cleaned; every other key, length, control character, model and secret is refused', () => {
  const good = checkPersonaEdit({ role: ' a role ', prompt: 'Line one.\r\nLine two.\tTabbed', model: 'sonnet', note: ' why ', base: 'default' });
  assert.deepEqual(good, { role: 'a role', prompt: 'Line one.\nLine two.\tTabbed', model: 'sonnet', note: 'why', base: 'default' });
  assert.equal(checkPersonaEdit({ ...good, base: 'persona-20261103T101010123Z-ab12' }).base, 'persona-20261103T101010123Z-ab12');
  const refused = (raw, message, status = 400) => assert.throws(() => checkPersonaEdit(raw), error => error.status === status && message.test(error.message), JSON.stringify(raw).slice(0, 80));
  refused(null, /JSON object/);
  refused({ ...good, extra: 1 }, /no field extra/);
  refused({ ...good, role: '' }, /role line cannot be empty/);
  refused({ ...good, role: 'x'.repeat(201) }, /at most 200/);
  refused({ ...good, role: 'two\nlines' }, /control character/);
  refused({ ...good, prompt: '   ' }, /prompt cannot be empty/);
  refused({ ...good, prompt: 'x'.repeat(8001) }, /at most 8000/);
  refused({ ...good, prompt: 'bell\u0007' }, /control character/);
  refused({ ...good, prompt: `line${String.fromCharCode(0x2028)}separator` }, /control character/);
  refused({ ...good, note: 'n'.repeat(201) }, /at most 200/);
  refused({ ...good, model: 'opus' }, /not in the list/);
  refused({ ...good, model: undefined }, /not in the list/);
  refused({ ...good, base: undefined }, /base/);
  refused({ ...good, base: '../x' }, /base/);
  refused({ ...good, prompt: `Use this key: sk-ant-${'a'.repeat(30)}` }, /looks like a secret/);
  refused({ ...good, role: `token: ${'Z9'.repeat(10)}` }, /looks like a secret/);
  refused({ ...good, prompt: 'x'.repeat(45) }, /looks like a secret/);
  for (const name of VIEW_ONLY) refused({ ...good, [name]: 'x' }, /view-only/, 403);
  assert.deepEqual(VIEW_ONLY, ['toolsets', 'platformToolsets', 'skills', 'soul', 'cron', 'jobs', 'terminal', 'fallbacks', 'provider']);
});

test('every default persona text passes the edit check, so opening and saving never trips the secret check', () => {
  for (const entry of CHAT_PERSONAS) {
    const clean = checkPersonaEdit({ role: entry.role, prompt: entry.text, model: entry.model, base: 'default' });
    assert.equal(clean.prompt, entry.text.trim(), entry.id);
  }
});

test('syncRole replaces the old role once, in the first line only', () => {
  const prompt = 'You are Teardown, one of the owner\'s agents: how a public game works. The owner talks.\n- Mention how a public game works elsewhere.';
  assert.equal(syncRole(prompt, 'how a public game works', 'how a game works'), 'You are Teardown, one of the owner\'s agents: how a game works. The owner talks.\n- Mention how a public game works elsewhere.');
  assert.equal(syncRole(prompt, 'something else', 'x'), prompt, 'an old role that is not in the first line leaves it alone');
  assert.equal(syncRole(prompt, 'how a public game works', 'how a public game works'), prompt);
  assert.equal(syncRole('One line, role.', 'role', 'job'), 'One line, job.');
});

test('effectivePersona: no version or a default one is the app\'s entry; an edit overlays role, model and text', () => {
  assert.equal(effectivePersona(TEARDOWN, null), TEARDOWN);
  assert.equal(effectivePersona(TEARDOWN, { id: 'persona-x', default: true }), TEARDOWN);
  const edited = effectivePersona(TEARDOWN, { id: 'persona-20261103T101010123Z-ab12', role: 'r', prompt: 'p', model: 'haiku', at: 'T', by: 'owner', note: 'n' });
  assert.deepEqual([edited.id, edited.name, edited.role, edited.text, edited.model, edited.preset], ['teardown', 'Teardown', 'r', 'p', 'haiku', 'game-teardown']);
  assert.deepEqual(edited.edited, { id: 'persona-20261103T101010123Z-ab12', at: 'T', by: 'owner', note: 'n' });
});

test('signed out: no read of the prompts and no write, and an agent with no persona has none to read or write', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', '/hub/team/teardown/persona', undefined, null)).status, 401);
    assert.equal((await f.call('POST', '/hub/team/teardown/persona', edit(), null)).status, 401);
    assert.equal((await f.call('POST', '/hub/team/teardown/persona/revert', { to: 'default', base: 'default' }, null)).status, 401);
    for (const id of ['hermes', 'briefs', 'claude']) {
      assert.equal((await f.call('GET', `/hub/team/${id}/persona`)).status, 404, id);
      assert.equal((await f.save(id, edit())).status, 404, id);
    }
    assert.equal((await f.call('GET', '/hub/team/nobody/persona')).status, 404);
    assert.equal(f.files('teardown').length, 0);
    const team = (await f.call('GET', '/hub/team')).body.agents;
    assert.deepEqual(team.filter(agent => agent.editable?.persona).map(agent => agent.id), ['researcher', 'market-researcher', 'teardown', 'planner']);
    assert.ok(team.every(agent => !('chatModel' in agent)), 'nothing is edited yet');
  } finally { await f.close(); }
});

test('save keeps the old version: a new create-only file, listed newest first with the app\'s text last', async () => {
  const f = await fixture();
  try {
    const first = (await f.call('GET', '/hub/team/teardown/persona')).body;
    assert.deepEqual(first.versions.map(row => row.id), ['default']);
    assert.deepEqual(first.current, { version: 'default', role: TEARDOWN.role, prompt: TEARDOWN.text, model: 'codex' });
    assert.equal(first.default.prompt, TEARDOWN.text);
    assert.deepEqual(first.models.map(model => model.id), ['auto', 'codex', 'sonnet', 'haiku', 'deepseek-flash']);

    const one = await f.save('teardown', edit({ prompt: `${TEARDOWN.text}\n- Keep answers short.`, model: 'sonnet', note: 'Shorter.' }));
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const [name] = f.files('teardown');
    assert.match(name.split('/').pop(), PERSONA_FILE_RE);
    assert.equal(one.body.version, name.split('/').pop().replace('.json', ''));
    const stored = f.fake.json(name);
    assert.deepEqual(Object.keys(stored).sort(), ['at', 'by', 'model', 'note', 'prompt', 'role', 'v']);
    assert.deepEqual([stored.v, stored.by, stored.model, stored.note], [1, 'owner', 'sonnet', 'Shorter.']);
    assert.equal(f.fake.objects.get(name).metadata.writer, undefined, 'the Hub\'s own file carries no writer mark');

    const two = await f.save('teardown', edit({ prompt: 'You are Teardown. Be terse.', model: 'haiku', base: one.body.version }));
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.equal(f.files('teardown').length, 2, 'the first version is still there');
    const view = (await f.call('GET', '/hub/team/teardown/persona')).body;
    assert.deepEqual(view.versions.map(row => row.id), [two.body.version, one.body.version, 'default']);
    assert.equal(view.current.prompt, 'You are Teardown. Be terse.');
    assert.equal(view.versions[1].prompt.endsWith('Keep answers short.'), true);
    assert.equal(view.versions[1].note, 'Shorter.');

    const team = (await f.call('GET', '/hub/team')).body.agents;
    assert.equal(team.find(agent => agent.id === 'teardown').chatModel, 'Haiku');
    assert.equal(team.find(agent => agent.id === 'researcher').chatModel, undefined);
    const details = (await f.call('GET', '/hub/team/teardown/details')).body;
    const prompt = details.prompts.find(item => item.id === 'persona');
    assert.equal(prompt.text, 'You are Teardown. Be terse.');
    assert.match(prompt.note, /^Edited \d{4}-\d{2}-\d{2} by owner\.$/);
    assert.deepEqual([details.agent.chatModel, details.agent.editable, details.agent.role], ['Haiku', { persona: true, profile: true }, TEARDOWN.role]);
    const job = details.prompts.find(item => item.id === 'job');
    assert.ok(job && !('note' in job && /Edited/.test(job.note)), 'the job template stays the app\'s');
  } finally { await f.close(); }
});

test('save refuses a stale base (409), a no-op, a secret, an unlisted model, and every view-only key (403) on both routes', async () => {
  const f = await fixture();
  try {
    const one = await f.save('teardown', edit({ prompt: 'You are Teardown. One.' }));
    assert.equal(one.status, 200);
    const stale = await f.save('teardown', edit({ prompt: 'You are Teardown. Two.' }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'This persona changed while you were looking.');
    assert.equal((await f.save('teardown', edit({ prompt: 'You are Teardown. One.', base: one.body.version }))).body.error, 'Nothing changed.');
    assert.equal((await f.save('teardown', edit({ prompt: `key: sk-ant-${'b'.repeat(30)}`, base: one.body.version }))).status, 400);
    assert.equal((await f.save('teardown', edit({ model: 'opus', base: one.body.version }))).status, 400);
    for (const name of VIEW_ONLY) {
      const a = await f.save('teardown', { ...edit({ base: one.body.version }), [name]: ['x'] });
      assert.equal(a.status, 403, name);
      assert.equal(a.body.error, 'Toolsets, skills, SOUL.md and scheduled jobs are view-only.');
      const b = await f.revert('teardown', { to: 'default', base: one.body.version, [name]: 'x' });
      assert.equal(b.status, 403, name);
    }
    assert.equal(f.files('teardown').length, 1, 'only the first save wrote');
  } finally { await f.close(); }
});

test('a role change that would push the prompt past 8000 characters is a 400, not a version the page cannot read', async () => {
  const f = await fixture();
  try {
    const long = `${TEARDOWN.text} ` + 'x '.repeat((8000 - TEARDOWN.text.length - 1) / 2);
    const one = await f.save('teardown', edit({ prompt: long.slice(0, 7990) }));
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const grow = await f.save('teardown', edit({ prompt: one.body.current.prompt, role: 'a much longer role line, '.repeat(6), base: one.body.version }));
    assert.equal(grow.status, 400, JSON.stringify(grow.body));
    assert.match(grow.body.error, /at most 8000/);
    assert.equal(f.files('teardown').length, 1);
    const stray = await f.revert('teardown', { to: 'default', base: one.body.version, meta: { toolsets: [] } });
    assert.equal(stray.status, 400, 'a revert takes exactly to and base');
  } finally { await f.close(); }
});

test('a role change on an unedited prompt carries into its first line; one with an edited prompt does not touch it', async () => {
  const f = await fixture();
  try {
    const role = 'taking a public game apart, step by step';
    const one = await f.save('teardown', edit({ role }));
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.current.prompt.split('\n')[0], `You are Teardown, one of the owner's agents: ${role}. The owner is talking with you in a chat; this is not a job.`);
    assert.equal(one.body.current.prompt.split('\n').slice(1).join('\n'), TEARDOWN.text.split('\n').slice(1).join('\n'));
    const two = await f.save('teardown', edit({ role: 'a new role', prompt: `${one.body.current.prompt}\n- Extra.`, base: one.body.version }));
    assert.equal(two.body.current.prompt.split('\n')[0], one.body.current.prompt.split('\n')[0]);
    assert.equal(two.body.current.role, 'a new role');
  } finally { await f.close(); }
});

test('Revert writes a new file that copies the chosen version, "Back to the app\'s text" follows the app again, and nothing is deleted', async () => {
  const f = await fixture();
  try {
    const one = await f.save('teardown', edit({ prompt: 'You are Teardown. First.', model: 'sonnet' }));
    const two = await f.save('teardown', edit({ prompt: 'You are Teardown. Second.', model: 'haiku', base: one.body.version }));
    const back = await f.revert('teardown', { to: one.body.version, base: two.body.version });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(f.files('teardown').length, 3, 'a new file, the others stay');
    const copy = f.fake.json(f.files('teardown').at(-1));
    assert.deepEqual([copy.prompt, copy.model, copy.revertOf], ['You are Teardown. First.', 'sonnet', one.body.version]);
    assert.equal(back.body.current.prompt, 'You are Teardown. First.');
    assert.equal((await f.revert('teardown', { to: back.body.version, base: back.body.version })).status, 400, 'the current version cannot be reverted to');
    assert.equal((await f.revert('teardown', { to: one.body.version, base: two.body.version })).status, 409, 'a stale base');
    assert.equal((await f.revert('teardown', { to: 'persona-20200101T000000000Z-zzzz', base: back.body.version })).status, 404);
    assert.equal((await f.revert('teardown', { to: '../x', base: back.body.version })).status, 400);

    const defaulted = await f.revert('teardown', { to: 'default', base: back.body.version });
    assert.equal(defaulted.status, 200, JSON.stringify(defaulted.body));
    const marker = f.fake.json(f.files('teardown').at(-1));
    assert.deepEqual([marker.default, marker.revertOf, 'prompt' in marker], [true, 'default', false]);
    assert.equal(defaulted.body.current.prompt, TEARDOWN.text, 'the app\'s text again');
    assert.equal(f.files('teardown').length, 4);
    const team = (await f.call('GET', '/hub/team')).body.agents;
    assert.equal(team.find(agent => agent.id === 'teardown').chatModel, undefined, 'no edited model once it follows the app');
    // Later app updates reach it, because the newest version says "follow the app".
    assert.equal((await f.hub.personas.table()).find(entry => entry.id === 'teardown').text, TEARDOWN.text);
    // An older version can still be reverted to from there.
    const again = await f.revert('teardown', { to: two.body.version, base: defaulted.body.version });
    assert.equal(again.body.current.prompt, 'You are Teardown. Second.');
  } finally { await f.close(); }
});

test('a persona file with a writer mark, or one that is not a valid snapshot, is ignored', async () => {
  const f = await fixture();
  try {
    const plant = (stamp, body, metadata) => f.fake.seed(`sections/inbox/team/teardown/persona-${stamp}-zz99.json`, JSON.stringify(body), 'application/json', metadata);
    const snapshot = prompt => ({ v: 1, role: 'r', prompt, model: 'codex', at: 'T', by: 'owner' });
    plant('20991231T000000000Z', snapshot('You are a pirate.'), { writer: 'card-api' });
    plant('20991230T000000000Z', { v: 1, role: 'r', prompt: 'x', model: 'opus', at: 'T', by: 'o' });
    plant('20991229T000000000Z', { v: 2, role: 'r', prompt: 'x', model: 'codex' });
    f.fake.seed('sections/inbox/team/teardown/persona-20991228T000000000Z-zz99.json', 'not json', 'application/json');
    const view = (await f.call('GET', '/hub/team/teardown/persona')).body;
    assert.deepEqual(view.versions.map(row => row.id), ['default'], 'none counts');
    assert.equal((await f.hub.personas.table()).find(entry => entry.id === 'teardown').text, TEARDOWN.text);
    // An unmarked valid one does count, and a marked one stays out of the list beside it.
    plant('20991227T000000000Z', snapshot('You are Teardown, planted unmarked.'), {});
    f.hub.personas.forget();
    const after = (await f.call('GET', '/hub/team/teardown/persona')).body;
    assert.equal(after.versions.length, 2);
    assert.equal(after.current.prompt, 'You are Teardown, planted unmarked.');
  } finally { await f.close(); }
});

test('the table is cached for 30 seconds and cleared by a write', async () => {
  const f = await fixture();
  try {
    const first = await f.hub.personas.table();
    assert.equal(await f.hub.personas.table(), first, 'the same object while it is fresh');
    f.clock.time += 31000;
    assert.notEqual(await f.hub.personas.table(), first, 'rebuilt after 30 s');
    const before = await f.hub.personas.table();
    await f.save('teardown', edit({ prompt: 'You are Teardown. Changed.' }));
    const after = await f.hub.personas.table();
    assert.notEqual(after, before);
    assert.equal(after.find(entry => entry.id === 'teardown').text, 'You are Teardown. Changed.');
  } finally { await f.close(); }
});

// --- the agent-edit Ask ---

/** Answers as the page does: with the `rev` of the Ask file it showed. */
async function answerWith(f, id, choice) {
  const rev = (await f.call('GET', `/hub/asks/${id}`)).body.rev;
  return f.call('POST', `/hub/asks/${id}/answer`, { choice, ...(rev ? { rev } : {}) });
}

const proposal = (extra = {}) => ({ op: 'persona', agent: 'teardown', base: 'default', prompt: 'You are Teardown. Be brief.', why: 'Answers ran long.', ...extra });
function agentEditAsk(f, tail, agentEdit, extra = {}) {
  const ask = { ...askJson({ id: `${day}-workspace-app-edit-${tail}`, project: 'workspace-app', now: NOW, options: AGENT_EDIT_OPTIONS, question: 'Shorten the Teardown prompt?', allowDrawing: false, kind: 'approval' }), requirePasskey: true, agentEdit, ...extra };
  f.seed.ask(ask);
  return ask.id;
}

test('validateAgentEdit: a good proposal passes; every other shape, limit, option set and view-only key is named', () => {
  const ask = (agentEdit, extra = {}) => ({ requirePasskey: true, options: AGENT_EDIT_OPTIONS, agentEdit, ...extra });
  assert.deepEqual(validateAgentEdit(ask(proposal())), []);
  assert.deepEqual(validateAgentEdit(ask(proposal({ prompt: undefined, role: 'a role', model: 'haiku' }))), []);
  const has = (problems, pattern) => assert.ok(problems.some(line => pattern.test(line)), `${pattern}: ${problems.join(' | ')}`);
  has(validateAgentEdit(ask(null)), /is an object/);
  has(validateAgentEdit(ask(proposal({ op: 'model' }))), /op is persona or profile/);
  has(validateAgentEdit(ask(proposal({ agent: 'Bad Id' }))), /agent is an agent id/);
  has(validateAgentEdit(ask(proposal({ base: 'newest' }))), /base is the version/);
  has(validateAgentEdit(ask(proposal({ prompt: undefined }))), /changes the role, the prompt or the model/);
  has(validateAgentEdit(ask(proposal({ prompt: 'x'.repeat(8001) }))), /1 to 8000/);
  has(validateAgentEdit(ask(proposal({ role: 'a\nb' }))), /control character/);
  has(validateAgentEdit(ask(proposal({ why: 'w'.repeat(401) }))), /why is 1 to 400/);
  has(validateAgentEdit(ask(proposal({ extra: 1 }))), /no field extra/);
  has(validateAgentEdit(ask(proposal(), { requirePasskey: false })), /requires a passkey/);
  has(validateAgentEdit(ask(proposal(), { options: [AGENT_EDIT_OPTIONS[1], AGENT_EDIT_OPTIONS[0]] })), /exactly the options/);
  has(validateAgentEdit(ask(proposal(), { options: [{ ...AGENT_EDIT_OPTIONS[0], image: 'a.png' }, AGENT_EDIT_OPTIONS[1]] })), /exactly the options/);
  has(validateAgentEdit(ask(proposal(), { changes: [] })), /no changes, decisions/);
  for (const name of VIEW_ONLY) has(validateAgentEdit(ask(proposal({ [name]: 'x' }))), /view-only/);
});

test('validateAgentEdit, op profile: a good proposal passes; the models, the chain, the profile, the keys and the view-only names are checked', () => {
  const ask = (agentEdit, extra = {}) => ({ requirePasskey: true, options: AGENT_EDIT_OPTIONS, agentEdit, ...extra });
  const model = (provider, name) => ({ provider, model: name });
  const good = (extra = {}) => ({ op: 'profile', profile: 'main', primary: model('anthropic', 'claude-sonnet-5-5'), fallbacks: [model('openai-codex', 'gpt-6-sol')], why: 'Codex is slow.', ...extra });
  assert.deepEqual(validateAgentEdit(ask(good())), []);
  assert.deepEqual(validateAgentEdit(ask(good({ fallbacks: [], why: undefined }))), []);
  const has = (problems, pattern) => assert.ok(problems.some(line => pattern.test(line)), `${pattern}: ${problems.join(' | ')}`);
  has(validateAgentEdit(ask(good({ profile: 'other' }))), /profile is main or briefs/);
  has(validateAgentEdit(ask(good({ primary: undefined }))), /primary is/);
  has(validateAgentEdit(ask(good({ primary: model('anthropic', 'a b') }))), /primary is/);
  has(validateAgentEdit(ask(good({ primary: { ...model('a', 'b'), env: 'KEY' } }))), /primary is/);
  has(validateAgentEdit(ask(good({ fallbacks: 'none' }))), /fallbacks is a list of 0 to 4/);
  has(validateAgentEdit(ask(good({ fallbacks: Array.from({ length: 5 }, (_, index) => model('p', `m${index}`)) }))), /0 to 4/);
  has(validateAgentEdit(ask(good({ fallbacks: [model('anthropic', 'claude-sonnet-5-5')] }))), /lists a model twice/);
  has(validateAgentEdit(ask(good({ fallbacks: [model('p', 'm'), model('p', 'm')] }))), /lists a model twice/);
  has(validateAgentEdit(ask(good({ agent: 'teardown' }))), /no field agent/);
  has(validateAgentEdit(ask(good({ prompt: 'x' }))), /no field prompt/);
  has(validateAgentEdit(ask(good({ model: 'haiku' }))), /no field model/);
  has(validateAgentEdit(ask(good({ why: 'w'.repeat(401) }))), /why is 1 to 400/);
  has(validateAgentEdit(ask(good(), { requirePasskey: false })), /requires a passkey/);
  has(validateAgentEdit(ask(good(), { options: [AGENT_EDIT_OPTIONS[1], AGENT_EDIT_OPTIONS[0]] })), /exactly the options/);
  has(validateAgentEdit(ask(good(), { decisions: [] })), /no changes, decisions/);
  // 'fallbacks' belongs to a profile edit and stays view-only on a persona edit; the other view-only names are refused on both.
  has(validateAgentEdit(ask(proposal({ fallbacks: [] }))), /view-only/);
  for (const name of VIEW_ONLY.filter(item => item !== 'fallbacks')) has(validateAgentEdit(ask(good({ [name]: 'x' }))), /view-only/);
});

test('an agent-edit Ask answered Apply over the web writes one version with fromAsk; Skip writes none', async () => {
  const f = await fixture();
  try {
    const id = agentEditAsk(f, 'a1b2', proposal());
    const detail = (await f.call('GET', `/hub/asks/${id}`)).body;
    assert.equal(detail.agentEdit.agent, 'teardown');
    assert.equal(detail.agentEditBlocked, undefined);
    const done = await answerWith(f, id, 'apply');
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.agentEdit.applied, true);
    assert.equal(f.files('teardown').length, 1);
    const stored = f.fake.json(f.files('teardown')[0]);
    assert.deepEqual([stored.fromAsk, stored.by, stored.prompt, stored.role, stored.model, stored.note], [id, 'owner', 'You are Teardown. Be brief.', TEARDOWN.role, TEARDOWN.model, 'Agent edit: Answers ran long.']);
    assert.equal((await f.hub.personas.table()).find(entry => entry.id === 'teardown').text, 'You are Teardown. Be brief.');
    assert.equal((await answerWith(f, id, 'apply')).status, 409, 'a second answer');
    assert.equal(f.files('teardown').length, 1);

    const skip = agentEditAsk(f, 'c3d4', proposal({ base: done.body.agentEdit.version, prompt: 'You are Teardown. Other.' }));
    const skipped = await answerWith(f, skip, 'skip');
    assert.equal(skipped.status, 201);
    assert.equal(skipped.body.agentEdit, undefined);
    assert.equal(f.files('teardown').length, 1, 'Skip writes nothing');
  } finally { await f.close(); }
});

test('an agent-edit Ask that cannot be trusted writes nothing, says why, and the answer stands', async () => {
  const f = await fixture();
  try {
    const one = await f.save('teardown', edit({ prompt: 'You are Teardown. Mine.' }));
    const cases = [
      ['a stale base', agentEditAsk(f, 'e001', proposal({ base: 'default' })), /changed after the edit was written/],
      ['no passkey', agentEditAsk(f, 'e002', proposal({ base: one.body.version }), { requirePasskey: false }), /requires a passkey/],
      ['other options', agentEditAsk(f, 'e003', proposal({ base: one.body.version }), { options: [{ id: 'apply', label: 'Do it' }, AGENT_EDIT_OPTIONS[1]] }), /exactly the options/],
      ['a view-only key', agentEditAsk(f, 'e004', { ...proposal({ base: one.body.version }), toolsets: ['web'] }), /view-only/],
      ['a secret in the prompt', agentEditAsk(f, 'e005', proposal({ base: one.body.version, prompt: `key: sk-ant-${'c'.repeat(30)}` })), /looks like a secret/],
      ['an unlisted model', agentEditAsk(f, 'e006', proposal({ base: one.body.version, prompt: undefined, model: 'opus' })), /not in the list/],
      ['an agent with no persona', agentEditAsk(f, 'e007', proposal({ agent: 'hermes', base: one.body.version })), /No such persona/],
    ];
    // The page learns beforehand which Asks cannot be applied (only while they can still be answered).
    const blocked = (await f.call('GET', `/hub/asks/${cases[0][1]}`)).body;
    assert.match(blocked.agentEditBlocked ?? '', /changed after the edit was written/);
    const bad = (await f.call('GET', `/hub/asks/${cases[1][1]}`)).body;
    assert.match(bad.agentEditBlocked ?? '', /requires a passkey/);
    for (const [name, id, why] of cases) {
      const done = await answerWith(f, id, 'apply');
      assert.equal(done.status, 201, name);
      assert.equal(done.body.state, 'answered', name);
      assert.equal(done.body.agentEdit.applied, false, name);
      assert.match(done.body.agentEdit.why, why, name);
    }
    assert.equal(f.files('teardown').length, 1, 'only the owner\'s own save');
    assert.equal((await f.call('GET', `/hub/asks/${cases[0][1]}`)).body.agentEditBlocked, undefined, 'an answered Ask is done, not blocked');
  } finally { await f.close(); }
});

test('a role-only proposal carries into the prompt\'s first line, like the Edit page', async () => {
  const f = await fixture();
  try {
    const id = agentEditAsk(f, 'f001', { op: 'persona', agent: 'researcher', base: 'default', role: 'research cards with sources, shorter' });
    const done = await answerWith(f, id, 'apply');
    assert.equal(done.body.agentEdit.applied, true, JSON.stringify(done.body));
    const view = (await f.call('GET', '/hub/team/researcher/persona')).body;
    assert.match(view.current.prompt.split('\n')[0], /agents: research cards with sources, shorter\. The owner/);
    assert.equal(view.current.role, 'research cards with sources, shorter');
  } finally { await f.close(); }
});

// --- the profile change (ws-im1.4.2): Edit -> Ask -> Apply -> signed approved.json -> the host's result -> a newer export ---

const CODEX = { provider: 'openai-codex', model: 'gpt-6-sol' };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5-5' };
const DEEPSEEK = { provider: 'deepseek', model: 'deepseek-v4-pro' };
const FLASH = { provider: 'deepseek', model: 'deepseek-flash' };
const OPTIONS = { main: [CODEX, SONNET, HAIKU, DEEPSEEK, FLASH], briefs: [SONNET, HAIKU, DEEPSEEK, FLASH] };
const keyPair = generateKeyPairSync('ed25519');
const SIGNING = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const publicKey = parsePublicKey(publicKeyPem(keyPair.privateKey));
const changeKey = (id, file) => `sections/inbox/agent-config/changes/${id}/${file}`;

/** The host's export `minutes` before the fixture clock; `main` is Codex first, then Sonnet and DeepSeek (agentConfigJson), unless `main` says otherwise. */
let exportSeq = 0;
function putExport(f, { minutes = 12, main, options = OPTIONS } = {}) {
  // Each export has its own name (the Hub remembers a name's content), a second later than the one before.
  exportSeq += 1;
  const raw = agentConfigJson({ now: new Date(f.clock.time + exportSeq * 1000), exportedMinutesAgo: minutes });
  for (const name of ['main', 'briefs']) if (options?.[name]) raw.profiles[name].modelOptions = options[name];
  if (main) { raw.profiles.main.model = { provider: main.provider, default: main.model }; raw.profiles.main.fallbacks = main.fallbacks; }
  seedAgentConfig(f.fake, raw);
  return raw;
}
const changeBody = (extra = {}) => ({ primary: SONNET, fallbacks: [CODEX, FLASH], why: 'Codex is slow today.', ...extra });
const approvals = f => [...f.fake.objects.keys()].filter(name => name.includes('/agent-config/changes/') && name.endsWith('/approved.json'));
const asksWritten = f => [...f.fake.objects.keys()].filter(name => /\/asks\/[^/]+\/ask\.json$/.test(name)).length;
const hostResult = (f, id, outcome, code, extra = {}) => f.fake.seed(changeKey(id, 'result.json'), JSON.stringify({ v: 1, change: id, outcome, code, rolledBack: false, at: new Date(f.clock.time).toISOString(), ...extra }), 'application/json', { writer: 'hermes-config' });
const detailsOf = async (f, agent = 'teardown') => (await f.call('GET', `/hub/team/${agent}/details`)).body;
const postChange = (f, agent, data, user = 'owner') => f.call('POST', `/hub/team/${agent}/profile-change`, data, user);

test('profile change, end to end from Teardown: Edit, an Ask the Hub writes, Apply signs, the host answers, a newer export shows it live', async () => {
  const f = await fixture({ env: { ...SIGNING, HERMES_URL: 'http://127.0.0.1:9', HERMES_API_KEY: 'k' } });
  try {
    putExport(f);
    const before = await detailsOf(f);
    assert.equal(before.agent.editable.profile, true);
    assert.deepEqual(before.settings.modelOptions, OPTIONS.main, 'the host\'s own list reaches the page');
    assert.equal(before.change, undefined);

    // 1. The request makes one Ask, written by the Hub: its id, project, origin, kind and passkey flag are the Hub's.
    const made = await postChange(f, 'teardown', changeBody());
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.ask;
    assert.match(id, new RegExp(`^${day}-profile-main-[a-z0-9]{4}$`));
    assert.deepEqual(made.body.from, { ...CODEX, fallbacks: [SONNET, DEEPSEEK] });
    assert.deepEqual(made.body.to, { ...SONNET, fallbacks: [CODEX, FLASH] });
    const stored = f.fake.json(`sections/inbox/asks/${id}/ask.json`);
    assert.deepEqual([stored.project, stored.from, stored.kind, stored.requirePasskey, stored.options], ['workspace-app', { tool: 'hub' }, 'approval', true, AGENT_EDIT_OPTIONS]);
    assert.deepEqual(validateAgentEdit(stored), []);
    assert.match(stored.context, /Now: openai-codex · gpt-6-sol, then anthropic · claude-sonnet-5-5, then deepseek · deepseek-v4-pro\./);
    assert.match(stored.context, /New: anthropic · claude-sonnet-5-5, then openai-codex · gpt-6-sol, then deepseek · deepseek-flash\./);
    assert.match(stored.context, /shared by Hermes, Researcher, Market researcher, Teardown and Planner\./);
    assert.match(stored.context, /Hermes main restarts within about 5 minutes\. A chat or job running then stops\./);
    assert.equal(approvals(f).length, 0, 'asking signs nothing');

    // 2. The Hub's own read of that file: the Ask folder, the id check and the state all accept it. It is open and the Discord path cannot answer it.
    assert.equal(validId(id), true);
    const open = (await f.call('GET', `/hub/asks/${id}`)).body;
    assert.deepEqual([open.state, open.agentEdit.op, open.requirePasskey, open.agentEditBlocked], ['open', 'profile', true, undefined]);
    assert.ok(JSON.stringify((await f.call('GET', '/hub/inbox')).body).includes(id), 'it is in the inbox, among the Asks');
    assert.deepEqual(discordEligible(stored), { ok: false, reason: 'This Ask requires a passkey.' });
    assert.equal(discordEligible({ ...stored, requirePasskey: false }).ok, false, 'and still not if the flag were missing');

    // 3. Apply signs: one approved.json, create-only, with the old chain read from the export at this moment.
    const done = await answerWith(f, id, 'apply');
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.agentEdit.applied, true);
    assert.deepEqual(approvals(f), [changeKey(id, 'approved.json')]);
    const signed = f.fake.json(changeKey(id, 'approved.json'));
    assert.deepEqual(Object.keys(signed).sort(), ['ask', 'at', 'by', 'change', 'expires', 'from', 'kind', 'nonce', 'profile', 'signature', 'to', 'v']);
    assert.deepEqual([signed.v, signed.kind, signed.change, signed.ask, signed.profile, signed.by], [1, 'profile-change', id, id, 'main', 'owner']);
    assert.deepEqual([signed.from, signed.to], [made.body.from, made.body.to]);
    assert.equal(Date.parse(signed.expires) - Date.parse(signed.at), 24 * 3600 * 1000);
    assert.equal(verify(signed, publicKey), true, 'the Hub\'s signature verifies with the public key');
    assert.equal(verify({ ...signed, to: { ...signed.to, model: 'claude-haiku-5-5' } }, publicKey), false);
    assert.equal((await answerWith(f, id, 'apply')).status, 409, 'answered twice');
    assert.equal(approvals(f).length, 1, 'one Ask makes one approval');

    // 4. Waiting: Details of any agent on the profile says so, and a second request for the profile is refused until the host answers.
    f.clock.time += 60000;
    const waiting = await detailsOf(f, 'hermes');
    assert.deepEqual([waiting.change.state, waiting.change.id, waiting.change.to.model], ['waiting', id, 'claude-sonnet-5-5']);
    assert.equal((await postChange(f, 'planner', changeBody({ fallbacks: [] }))).status, 409);

    // 5. The host applied it: a result with the card API's mark. The export does not show it yet.
    f.clock.time += 120000;
    hostResult(f, id, 'applied', 'ok');
    assert.equal((await detailsOf(f)).change.state, 'applied');
    // 6. A newer export, made at or after the result, with the new settings: live in Details, on the Team card and in Auto's label.
    f.clock.time += 60000;
    putExport(f, { minutes: 0, main: { ...SONNET, fallbacks: [CODEX, FLASH] } });
    const live = await detailsOf(f);
    assert.equal(live.change.state, 'live');
    assert.deepEqual(live.settings.model, { provider: 'anthropic', default: 'claude-sonnet-5-5' });
    assert.deepEqual(live.settings.fallbacks, [CODEX, FLASH]);
    assert.equal((await f.call('GET', '/hub/team')).body.agents.find(agent => agent.id === 'teardown').model, 'claude-sonnet-5-5 · then gpt-6-sol, deepseek-flash');
    f.clock.time += 31000;
    assert.equal((await f.call('GET', '/hub/chat')).body.autoFirst, 'Sonnet');
  } finally { await f.close(); }
});

test('profile change: signed out, no key, no list, a model the host does not offer, no change and every other bad body are refused before an Ask is written', async () => {
  const f = await fixture({ env: SIGNING });
  const keyless = await fixture();
  try {
    assert.equal((await postChange(f, 'teardown', changeBody(), null)).status, 401, 'signed out');
    assert.equal((await postChange(f, 'teardown', changeBody())).status, 409, 'no export yet');
    putExport(f, { options: {} });
    const noList = await postChange(f, 'teardown', changeBody());
    assert.equal(noList.status, 409);
    assert.match(noList.body.error, /has not published its model list/);
    putExport(f);
    const refused = async (data, status, pattern, agent = 'teardown') => {
      const got = await postChange(f, agent, data);
      assert.equal(got.status, status, `${JSON.stringify(data).slice(0, 80)}: ${JSON.stringify(got.body)}`);
      assert.match(got.body.error, pattern);
    };
    await refused(changeBody({ primary: { provider: 'anthropic', model: 'claude-opus-5' } }), 409, /not a model the Hermes host offers/);
    await refused(changeBody({ fallbacks: [{ provider: 'anthropic', model: 'claude-opus-5' }] }), 409, /not a model the Hermes host offers/);
    await refused({ primary: CODEX, fallbacks: [SONNET, DEEPSEEK] }, 409, /uses already/);
    await refused(changeBody({ primary: CODEX, fallbacks: [CODEX] }), 400, /lists a model twice/);
    await refused(changeBody({ fallbacks: [HAIKU, DEEPSEEK, FLASH, CODEX, { provider: 'x', model: 'y' }] }), 400, /0 to 4/);
    await refused(changeBody({ primary: { provider: 'anthropic' } }), 400, /primary is/);
    await refused(changeBody({ primary: { ...SONNET, key: 'x' } }), 400, /primary is/);
    await refused(changeBody({ why: `key: sk-ant-${'c'.repeat(30)}` }), 400, /looks like a secret/);
    await refused(changeBody({ profile: 'briefs' }), 400, /no field profile/);
    await refused(changeBody({ model: 'x' }), 400, /no field model/);
    for (const name of ['toolsets', 'platformToolsets', 'skills', 'soul', 'cron', 'jobs', 'terminal', 'provider']) await refused(changeBody({ [name]: 'x' }), 403, /view-only/);
    await refused(changeBody(), 404, /no Hermes profile/, 'claude');
    await refused(changeBody(), 404, /No such agent/, 'nobody');
    // Briefs cannot pick Codex: the host's list for briefs has none.
    await refused(changeBody({ primary: CODEX, fallbacks: [] }), 409, /not a model the Hermes host offers/, 'briefs');
    assert.equal(asksWritten(f), 0, 'nothing was written');
    // An export 8 hours old: the settings may have changed since.
    f.clock.time += 8 * 3600 * 1000;
    const old = await postChange(f, 'teardown', changeBody());
    assert.equal(old.status, 409);
    assert.match(old.body.error, /is old/);
    // A server with no signing key cannot ask at all.
    putExport(keyless);
    const off = await postChange(keyless, 'teardown', changeBody());
    assert.equal(off.status, 409);
    assert.match(off.body.error, /no signing key/);
    assert.equal(asksWritten(f) + asksWritten(keyless), 0);
  } finally { await f.close(); await keyless.close(); }
});

test('profile change: Apply signs nothing for an Ask that cannot be trusted, and the answer stands', async () => {
  const f = await fixture({ env: SIGNING });
  try {
    putExport(f);
    const profileEdit = (extra = {}) => ({ op: 'profile', profile: 'main', primary: SONNET, fallbacks: [CODEX], ...extra });
    const cases = [
      ['no passkey', agentEditAsk(f, 'p001', profileEdit(), { requirePasskey: false }), /requires a passkey/],
      ['other options', agentEditAsk(f, 'p002', profileEdit(), { options: [{ id: 'apply', label: 'Do it' }, AGENT_EDIT_OPTIONS[1]] }), /exactly the options/],
      ['a view-only key', agentEditAsk(f, 'p003', { ...profileEdit(), toolsets: ['web'] }), /view-only/],
      ['a model the host does not offer', agentEditAsk(f, 'p004', profileEdit({ primary: { provider: 'anthropic', model: 'claude-opus-5' } })), /not a model the Hermes host offers/],
      ['no change', agentEditAsk(f, 'p005', profileEdit({ primary: CODEX, fallbacks: [SONNET, DEEPSEEK] })), /uses already/],
      ['a duplicate', agentEditAsk(f, 'p006', profileEdit({ fallbacks: [SONNET] })), /twice/],
      ['another profile than the export has', agentEditAsk(f, 'p007', profileEdit({ profile: 'prod' })), /profile is main or briefs/],
    ];
    assert.match((await f.call('GET', `/hub/asks/${cases[3][1]}`)).body.agentEditBlocked ?? '', /not a model the Hermes host offers/);
    for (const [name, id, why] of cases) {
      const done = await answerWith(f, id, 'apply');
      assert.equal(done.status, 201, name);
      assert.equal(done.body.state, 'answered', name);
      assert.equal(done.body.agentEdit.applied, false, name);
      assert.match(done.body.agentEdit.why, why, name);
    }
    assert.equal(approvals(f).length, 0, 'nothing was signed');
    // The same good Ask: signed out of the passkey gate (no Remote-User) there is no one to sign for, and an old export is not trusted either.
    const open = agentEditAsk(f, 'p008', profileEdit());
    assert.equal((await f.call('GET', `/hub/asks/${open}`)).body.agentEditBlocked, undefined);
    f.clock.time += 8 * 3600 * 1000;
    assert.match((await f.call('GET', `/hub/asks/${open}`)).body.agentEditBlocked ?? '', /is old/);
    const late = await answerWith(f, open, 'apply');
    assert.equal(late.body.agentEdit.applied, false);
    assert.equal(approvals(f).length, 0);
    // A skip writes nothing at all.
    putExport(f, { minutes: 0 });
    const skip = agentEditAsk(f, 'p009', profileEdit());
    assert.equal((await answerWith(f, skip, 'skip')).body.agentEdit, undefined);
    assert.equal(approvals(f).length, 0);
  } finally { await f.close(); }
});

test('profile change: the old settings are read at Apply, not when the Ask was written; a waiting change blocks a second approval; a late one does not', async () => {
  const f = await fixture({ env: SIGNING });
  try {
    putExport(f);
    const edit = { op: 'profile', profile: 'main', primary: SONNET, fallbacks: [CODEX] };
    const first = agentEditAsk(f, 'q001', edit);
    const second = agentEditAsk(f, 'q002', { ...edit, fallbacks: [FLASH] });
    // The host's settings moved between asking and answering (newer export, one minute on).
    f.clock.time += 60000;
    putExport(f, { minutes: 0, main: { ...HAIKU, fallbacks: [DEEPSEEK] } });
    const done = await answerWith(f, first, 'apply');
    assert.equal(done.body.agentEdit.applied, true, JSON.stringify(done.body));
    assert.deepEqual(f.fake.json(changeKey(first, 'approved.json')).from, { ...HAIKU, fallbacks: [DEEPSEEK] });
    // A second Ask for the same profile, while the first still waits for the host.
    const blocked = await answerWith(f, second, 'apply');
    assert.equal(blocked.body.agentEdit.applied, false);
    assert.match(blocked.body.agentEdit.why, /still waiting for the Hermes host/);
    assert.equal(approvals(f).length, 1);
    // The briefs profile is its own: a change there is not blocked by the main one.
    const other = await postChange(f, 'briefs', { primary: SONNET, fallbacks: [DEEPSEEK] });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    // Past its 24 hours with no result the first is late: Details says so, and it no longer blocks a new request.
    f.clock.time += 25 * 3600 * 1000;
    putExport(f, { minutes: 0, main: { ...HAIKU, fallbacks: [DEEPSEEK] } });
    const lateDetails = await detailsOf(f);
    assert.deepEqual([lateDetails.change.state, lateDetails.change.reason], ['late', 'The Hermes host did not pick this up.']);
    // A day after that it is not shown any more.
    f.clock.time += 24 * 3600 * 1000;
    putExport(f, { minutes: 0, main: { ...HAIKU, fallbacks: [DEEPSEEK] } });
    assert.equal((await detailsOf(f)).change, undefined);
    const retry = await postChange(f, 'teardown', changeBody({ primary: FLASH, fallbacks: [] }));
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
  } finally { await f.close(); }
});

test('profile change: a result counts only with the host\'s mark and beside a good approval; failures carry words, never the host\'s text', async () => {
  const f = await fixture({ env: SIGNING });
  try {
    putExport(f);
    const made = await postChange(f, 'teardown', changeBody());
    const id = made.body.ask;
    assert.equal((await answerWith(f, id, 'apply')).body.agentEdit.applied, true);
    f.clock.time += 60000;
    // No mark, or the passphrase's: ignored.
    f.fake.seed(changeKey(id, 'result.json'), JSON.stringify({ v: 1, change: id, outcome: 'applied', code: 'ok', rolledBack: false, at: new Date(f.clock.time).toISOString() }), 'application/json');
    assert.equal((await detailsOf(f)).change.state, 'waiting', 'a result with no mark is ignored');
    f.fake.seed(changeKey(id, 'result.json'), JSON.stringify({ v: 1, change: id, outcome: 'applied', code: 'ok', rolledBack: false, at: new Date(f.clock.time).toISOString() }), 'application/json', { writer: 'agent' });
    assert.equal((await detailsOf(f)).change.state, 'waiting', 'nor one from another token');
    // A failed result: the state, the words for the code and "the old settings stay".
    hostResult(f, id, 'failed', 'missing-key', { rolledBack: false });
    const failed = (await detailsOf(f)).change;
    assert.deepEqual([failed.state, failed.code, failed.reason], ['failed', 'missing-key', 'The host has no API key for one of the models']);
    assert.equal(JSON.stringify(failed).includes('stderr'), false);
    // The next change is allowed once the host has answered, failed or not.
    const next = await postChange(f, 'teardown', changeBody({ fallbacks: [FLASH] }));
    assert.equal(next.status, 201, JSON.stringify(next.body));
  } finally { await f.close(); }
});

test('profile change: Apply signs the Ask file the page showed; a changed file, or no rev, is a 409 that writes no answer and signs nothing (persona edits too)', async () => {
  const f = await fixture({ env: SIGNING });
  try {
    putExport(f);
    const id = (await postChange(f, 'teardown', changeBody())).body.ask;
    const shown = (await f.call('GET', `/hub/asks/${id}`)).body;
    assert.match(shown.rev, /^[0-9a-f]{16}$/);
    // Someone with the passphrase overwrites ask.json (no writer mark) after the page loaded: another model.
    const key = `sections/inbox/asks/${id}/ask.json`;
    const original = f.fake.text(key);
    const swapped = JSON.parse(original);
    swapped.agentEdit.primary = FLASH;
    f.fake.seed(key, `${JSON.stringify(swapped, null, 2)}\n`, 'application/json');
    const refused = await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply', rev: shown.rev });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /changed while you were looking/);
    assert.equal(f.fake.text(`sections/inbox/asks/${id}/answer.json`), null, 'no answer is written');
    assert.equal(approvals(f).length, 0, 'nothing is signed');
    // The page reloads: the new rev is what it shows now, and an answer with it applies the file as it is then.
    const again = (await f.call('GET', `/hub/asks/${id}`)).body;
    assert.notEqual(again.rev, shown.rev);
    assert.equal(again.agentEdit.primary.model, 'deepseek-flash');
    // No rev at all is refused too.
    f.fake.seed(key, original, 'application/json');
    const bare = await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply' });
    assert.equal(bare.status, 409);
    assert.equal(approvals(f).length, 0);
    // The original bytes are back, so the first rev fits again and signs exactly what was shown.
    const done = await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply', rev: shown.rev });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(f.fake.json(changeKey(id, 'approved.json')).to.model, 'claude-sonnet-5-5');

    // The persona op has the same protection.
    const persona = agentEditAsk(f, 'r001', proposal());
    const personaShown = (await f.call('GET', `/hub/asks/${persona}`)).body;
    const personaKey = `sections/inbox/asks/${persona}/ask.json`;
    f.fake.seed(personaKey, `${JSON.stringify({ ...JSON.parse(f.fake.text(personaKey)), agentEdit: proposal({ prompt: 'You are Teardown. Something else.' }) })}\n`, 'application/json');
    assert.equal((await f.call('POST', `/hub/asks/${persona}/answer`, { choice: 'apply', rev: personaShown.rev })).status, 409);
    assert.equal(f.files('teardown').length, 0, 'no persona version was written');
    assert.equal(f.fake.text(`sections/inbox/asks/${persona}/answer.json`), null);
    // A plain Ask needs no rev.
    const plain = agentEditAsk(f, 'r002', proposal({ prompt: 'You are Teardown. Be brief.' }));
    assert.equal((await answerWith(f, plain, 'skip')).status, 201);
  } finally { await f.close(); }
});

test('profile change: an approved.json nobody signed counts for nothing, and a repeated model in the old order is refused before it is signed', async () => {
  const f = await fixture({ env: SIGNING });
  try {
    putExport(f);
    const id = `${day}-profile-main-zz01`;
    const planted = { v: 1, kind: 'profile-change', change: id, profile: 'main', from: { ...CODEX, fallbacks: [SONNET, DEEPSEEK] }, to: { ...SONNET, fallbacks: [] }, expires: new Date(f.clock.time + 86400000).toISOString(), nonce: 'AAAAAAAAAAAAAAAAAAAAAA', at: new Date(f.clock.time).toISOString(), by: 'owner', ask: id, signature: 'not-a-signature' };
    f.fake.seed(changeKey(id, 'approved.json'), JSON.stringify(planted), 'application/json');
    assert.equal((await detailsOf(f)).change, undefined, 'an unsigned approval is not shown');
    assert.equal((await postChange(f, 'teardown', changeBody())).status, 201, 'and does not block a request');
    // The same file signed by another key is no better.
    const other = generateKeyPairSync('ed25519').privateKey;
    const id2 = `${day}-profile-main-zz02`;
    f.fake.seed(changeKey(id2, 'approved.json'), JSON.stringify(sign({ ...planted, change: id2, ask: id2, signature: undefined }, other)), 'application/json');
    assert.equal(((await detailsOf(f)).changes ?? []).some(item => item.id === id2), false);

    // A chain with a model twice, as a hand-edited config could have: the page and the Ask refuse it; nothing is signed.
    const dup = await fixture({ env: SIGNING });
    try {
      putExport(dup, { main: { ...CODEX, fallbacks: [SONNET, SONNET] } });
      const refused = await postChange(dup, 'teardown', changeBody({ primary: HAIKU, fallbacks: [] }));
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /lists a model twice now/);
      const hand = agentEditAsk(dup, 's001', { op: 'profile', profile: 'main', primary: HAIKU, fallbacks: [] });
      const done = await answerWith(dup, hand, 'apply');
      assert.equal(done.body.agentEdit.applied, false);
      assert.match(done.body.agentEdit.why, /lists a model twice now/);
      assert.equal(approvals(dup).length, 0);
    } finally { await dup.close(); }

// --- A persona made from a template (ws-im1.4.3) ---

const make = async (f, data, user = 'owner') => { f.clock.time += 1000; return f.call('POST', '/hub/team/new', data, user); };
const LEVEL = { template: 'research', name: 'Level reviewer', role: 'reviews level designs and cites the sources' };
const retire = async (f, id) => { f.clock.time += 1000; return f.call('POST', `/hub/team/${id}/persona/retire`, {}); };
const teamRow = async (f, id) => (await f.call('GET', '/hub/team')).body.agents.find(row => row.id === id);

test('new persona from the research template: a Team card, Chat in the menu, its text, Edit and Revert as on a default', async () => {
  const f = await fixture();
  try {
    const before = (await f.call('GET', '/hub/team')).body;
    const made = await make(f, LEVEL);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.id, made.body.name], ['level-reviewer', 'Level reviewer']);
    const file = f.fake.json(f.files('level-reviewer')[0]);
    assert.equal(file.template, 'research');
    assert.equal(file.model, 'codex');
    assert.equal(file.created, true);
    assert.equal(file.prompt, personaTextOf({ name: 'Level reviewer', role: LEVEL.role, extra: '' }), 'the research template is the default text under a new name');
    assert.equal(f.fake.objects.get(f.files('level-reviewer')[0]).metadata?.writer, undefined, 'the Hub\'s own write carries no mark');

    const card = await teamRow(f, 'level-reviewer');
    assert.deepEqual([card.name, card.room, card.profile, card.runtime, card.custom, card.role], ['Level reviewer', 'Research', 'main', 'Hermes profile main', true, LEVEL.role]);
    assert.deepEqual(card.action, { label: 'Chat', chat: 'level-reviewer' });
    assert.deepEqual(card.editable, { persona: true, profile: true });
    assert.equal(card.model, 'Codex gpt-6-sol · Sonnet, then DeepSeek fallback');
    assert.equal(card.sprite.kind, 'random');
    assert.equal(card.status, 'offline', 'Hermes is not set up in this fixture');
    const after = (await f.call('GET', '/hub/team')).body;
    assert.deepEqual(after.agents.filter(row => row.id !== 'level-reviewer'), before.agents, 'the others are as before');

    const menu = chatPersonasForClient(await f.hub.personas.table());
    assert.deepEqual(menu.find(entry => entry.id === 'level-reviewer'), { id: 'level-reviewer', name: 'Level reviewer', role: LEVEL.role, preset: undefined, model: 'codex' });
    assert.ok(menu.every(entry => !('text' in entry)));

    const details = (await f.call('GET', '/hub/team/level-reviewer/details')).body;
    assert.equal(details.agent.profile, 'main');
    assert.equal(details.prompts.find(item => item.id === 'persona').text, file.prompt);
    assert.equal(details.prompts.find(item => item.id === 'persona').note, undefined, 'not edited yet');

    const view = (await f.call('GET', '/hub/team/level-reviewer/persona')).body;
    assert.deepEqual([view.custom, view.default, view.versions.length, view.name], [true, null, 1, 'Level reviewer']);
    assert.ok(view.versions.every(row => !row.default), 'no "Back to the app\'s text" row');
    const one = await f.save('level-reviewer', { role: LEVEL.role, prompt: `${file.prompt}\n- Two lines.`, model: 'sonnet', base: view.current.version });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(f.fake.json(f.files('level-reviewer').at(-1)).name, 'Level reviewer', 'a version of a made persona carries its name');
    assert.equal((await f.hub.personas.table()).find(entry => entry.id === 'level-reviewer').model, 'sonnet');
    const back = await f.revert('level-reviewer', { to: view.current.version, base: one.body.version });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.current.prompt, file.prompt);
    assert.equal(back.body.current.model, 'codex');
    assert.equal((await f.revert('level-reviewer', { to: 'default', base: back.body.version })).status, 400, 'a made persona has no app text');
    assert.match((await f.call('GET', '/hub/team/level-reviewer/details')).body.prompts.find(item => item.id === 'persona').note, /^Edited /);
  } finally { await f.close(); }
});

test('the planner and plain templates are the Planner\'s text under the new name and a short chat prompt; every template passes the edit check', async () => {
  const f = await fixture();
  try {
    const planner = await make(f, { template: 'planner', name: 'Roadmap helper', role: 'plans a roadmap' });
    assert.equal(planner.status, 201, JSON.stringify(planner.body));
    const plannerText = f.fake.json(f.files('roadmap-helper')[0]).prompt;
    const original = CHAT_PERSONAS.find(entry => entry.id === 'planner').text;
    assert.ok(plannerText.startsWith('You are Roadmap helper, one of the owner\'s agents: you talk a plan'));
    assert.equal(plannerText.slice(plannerText.indexOf(',')), original.slice(original.indexOf(',')), 'only the name differs');
    const plain = await make(f, { template: 'plain', name: 'Quick answers', role: 'answers short questions.' });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const plainFile = f.fake.json(f.files('quick-answers')[0]);
    assert.match(plainFile.prompt, /^You are Quick answers, one of the owner's agents: answers short questions\. The owner/, 'a closing full stop of the role is not doubled');
    assert.equal(plainFile.role, 'answers short questions');
    assert.match(plainFile.prompt, /Never create requests or Asks, and write no cards\./);
    assert.ok(!/cards ask|changes\.json/.test(plainFile.prompt));
    for (const template of PERSONA_TEMPLATES) {
      const clean = checkPersonaEdit({ role: 'a role', prompt: template.text('A name', 'a role'), model: template.model, base: 'default' });
      assert.ok(clean.prompt.length > 50, template.id);
    }
    const listed = (await f.call('GET', '/hub/team/templates')).body;
    assert.deepEqual(listed.templates.map(item => item.id), ['research', 'planner', 'plain']);
    assert.ok(listed.templates.every(item => item.label && item.line && item.text.includes('<name>')));
    assert.deepEqual([listed.retired, listed.max], [[], 20]);
  } finally { await f.close(); }
});

test('refused: a bad template, name or role, a taken or reserved name, a view-only key, an agent, signed out; nothing is written', async () => {
  const f = await fixture();
  try {
    const refuse = async (data, status, pattern, user = 'owner') => {
      const answer = await make(f, data, user);
      assert.equal(answer.status, status, `${JSON.stringify(data).slice(0, 80)} -> ${JSON.stringify(answer.body)}`);
      if (pattern) assert.match(answer.body.error, pattern);
    };
    await refuse({ ...LEVEL, template: 'hermes' }, 400, /templates/);
    await refuse({ ...LEVEL, template: undefined }, 400, /templates/);
    await refuse({ ...LEVEL, name: '' }, 400, /name/);
    await refuse({ ...LEVEL, name: 'Level; reviewer' }, 400, /letters, digits and spaces/);
    await refuse({ ...LEVEL, name: 'L'.repeat(41) }, 400, /40/);
    await refuse({ ...LEVEL, name: '2nd reviewer' }, 400, /starts with a letter/);
    await refuse({ ...LEVEL, name: 7 }, 400, /text/);
    for (const name of ['Hermes', 'New', 'Templates', 'Researcher', 'Market researcher', 'Planner', 'Claude', 'Briefs', 'Teardown']) await refuse({ ...LEVEL, name }, 400, /taken/);
    await refuse({ ...LEVEL, role: '' }, 400, /role line/);
    await refuse({ ...LEVEL, role: '...' }, 400, /role line/);
    await refuse({ ...LEVEL, role: 'r'.repeat(201) }, 400, /at most 200/);
    await refuse({ ...LEVEL, role: 'two\nlines' }, 400, /control character/);
    await refuse({ ...LEVEL, role: `uses sk-ant-${'a'.repeat(30)}` }, 400, /secret/);
    await refuse({ ...LEVEL, prompt: 'You are a pirate.' }, 400, /no field prompt/);
    await refuse({ ...LEVEL, model: 'sonnet' }, 400, /no field model/);
    await refuse({ ...LEVEL, toolsets: ['web'] }, 403, /view-only/);
    await refuse({ ...LEVEL, soul: 'x' }, 403, /view-only/);
    await refuse(LEVEL, 401, /signed-in|Sign in/, null);
    await refuse(null, 400, /templates/);
    assert.deepEqual([...f.fake.objects.keys()].filter(name => /\/team\/.*persona-/.test(name)), []);
    assert.equal((await make(f, LEVEL)).status, 201);
    assert.equal((await make(f, { ...LEVEL, name: 'level  REVIEWER' })).status, 409, 'the same id in another spelling is taken');
    assert.equal((await f.call('GET', '/hub/team/templates', undefined, null)).status, 401, 'the templates carry prompt text: sign in');
    assert.equal((await f.call('POST', '/hub/team/level-reviewer/persona/retire', {}, null)).status, 401);
    assert.equal((await retire(f, 'researcher')).status, 400, 'an agent of the app is not retired');
    assert.equal((await retire(f, 'nobody')).status, 404);
    assert.equal(f.files('researcher').length, 0);
  } finally { await f.close(); }
});

test('a 21st persona is refused, retired ones count, and the Team lists the 19 live ones', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 20; n += 1) {
      const name = `Helper ${String.fromCharCode(97 + n)}`;
      const answer = await make(f, { template: 'plain', name, role: 'helps' });
      assert.equal(answer.status, 201, `${name}: ${JSON.stringify(answer.body)}`);
    }
    const over = await make(f, { template: 'plain', name: 'One too many', role: 'helps' });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /at most 20/);
    assert.equal((await retire(f, 'helper-a')).status, 200);
    assert.equal((await make(f, { template: 'plain', name: 'One too many', role: 'helps' })).status, 400, 'retired ones count');
    const agents = (await f.call('GET', '/hub/team')).body.agents;
    assert.equal(agents.filter(row => row.custom).length, 19);
  } finally { await f.close(); }
});

test('retire leaves the Team and the menu, keeps its text for old chats and every file; Bring back is a Revert and returns it', async () => {
  const f = await fixture();
  try {
    await make(f, LEVEL);
    const view = (await f.call('GET', '/hub/team/level-reviewer/persona')).body;
    const retired = await retire(f, 'level-reviewer');
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    const marker = f.fake.json(f.files('level-reviewer').at(-1));
    assert.deepEqual(Object.keys(marker).sort(), ['at', 'by', 'name', 'retired', 'v']);
    assert.equal(f.files('level-reviewer').length, 2, 'nothing is deleted');
    assert.equal(await teamRow(f, 'level-reviewer'), undefined);
    assert.equal((await f.call('GET', '/hub/team/level-reviewer/details')).status, 404);
    assert.equal(chatPersonasForClient(await f.hub.personas.table()).some(entry => entry.id === 'level-reviewer'), false);
    const table = await f.hub.personas.table();
    const kept = table.find(entry => entry.id === 'level-reviewer');
    assert.deepEqual([kept.retired, kept.text, kept.name], [true, view.current.prompt, 'Level reviewer'], 'the table keeps it for old chats');
    assert.throws(() => chatPersonaOf('level-reviewer', table), error => error.status === 400 && error.message === 'Unknown persona.');
    assert.equal(storedPersona('level-reviewer', table).text, view.current.prompt);
    assert.equal((await retire(f, 'level-reviewer')).status, 409, 'twice');
    assert.equal((await f.save('level-reviewer', { role: 'x', prompt: 'You are X.', model: 'codex', base: retired.body.version })).status, 409, 'no edit of a retired persona');
    assert.equal((await make(f, LEVEL)).status, 409, 'a retired one keeps its id');

    const list = (await f.call('GET', '/hub/team/templates')).body.retired;
    assert.deepEqual(list, [{ id: 'level-reviewer', name: 'Level reviewer', role: LEVEL.role, to: view.current.version, base: retired.body.version }]);
    assert.equal((await f.revert('level-reviewer', { to: 'persona-20200101T000000000Z-zzzz', base: list[0].base })).status, 404);
    const back = await f.revert('level-reviewer', { to: list[0].to, base: list[0].base });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(f.files('level-reviewer').length, 3);
    const copy = f.fake.json(f.files('level-reviewer').at(-1));
    assert.deepEqual([copy.name, copy.template, copy.revertOf], ['Level reviewer', 'research', view.current.version]);
    assert.ok(await teamRow(f, 'level-reviewer'), 'it returns');
    assert.ok(chatPersonasForClient(await f.hub.personas.table()).some(entry => entry.id === 'level-reviewer'));
    assert.deepEqual((await f.call('GET', '/hub/team/templates')).body.retired, []);
    // The retirement itself is not a version to go back to, and it can be brought back a second time.
    assert.equal((await f.revert('level-reviewer', { to: retired.body.version, base: back.body.version })).status, 400);
    const again = await retire(f, 'level-reviewer');
    assert.equal((await f.revert('level-reviewer', { to: list[0].to, base: again.body.version })).status, 200);
  } finally { await f.close(); }
});

test('a folder with only an avatar, an unreadable or marked version, an agent\'s id or a nameless version is no persona', async () => {
  const f = await fixture();
  try {
    const plant = (agent, stamp, body, metadata) => f.fake.seed(`sections/inbox/team/${agent}/persona-${stamp}-zz99.json`, typeof body === 'string' ? body : JSON.stringify(body), 'application/json', metadata);
    const good = { v: 1, role: 'r', prompt: 'You are Z.', model: 'codex', name: 'Zed', template: 'plain', at: 'T', by: 'owner' };
    f.fake.seed('sections/inbox/team/only-avatar/avatar-20261101T000000000Z-ab12.json', JSON.stringify({ kind: 'random', salt: 3, at: 'T', by: 'o' }), 'application/json');
    plant('unreadable', '20261101T000000000Z', 'not json');
    plant('marked', '20261101T000000000Z', good, { writer: 'card-api' });
    plant('nameless', '20261101T000000000Z', { ...good, name: undefined });
    plant('bad-name', '20261101T000000000Z', { ...good, name: 'Bad; name' });
    plant('briefs', '20261101T000000000Z', good, {});
    plant('hermes', '20261101T000000000Z', good, {});
    plant('claude', '20261101T000000000Z', good, {});
    plant('teardown', '20261101T000000000Z', { ...good, role: 'a hijacked role', prompt: 'x' }, {});
    plant('retired-only', '20261101T000000000Z', { v: 1, retired: true, name: 'Gone', at: 'T', by: 'o' }, {});
    assert.deepEqual((await f.hub.personas.table()).map(entry => entry.id), ['researcher', 'market-researcher', 'teardown', 'planner']);
    const team = (await f.call('GET', '/hub/team')).body.agents;
    assert.deepEqual(team.map(row => row.id), ['hermes', 'briefs', 'claude', 'researcher', 'market-researcher', 'teardown', 'planner']);
    assert.equal(team.find(row => row.id === 'teardown').role, 'a hijacked role', 'an agent of the app takes a valid version as before');
    assert.equal((await f.call('GET', '/hub/team/briefs/persona')).status, 404);
    assert.equal((await f.call('POST', '/hub/team/hermes/persona', { role: 'r', prompt: 'p', model: 'codex', base: 'default' })).status, 404);
    assert.equal((await make(f, { ...LEVEL, name: 'Only avatar' })).status, 201, 'an avatar-only folder does not block the name');
    // An agent of the app cannot carry a retirement.
    plant('teardown', '20261102T000000000Z', { v: 1, retired: true, name: 'Teardown', at: 'T', by: 'o' }, {});
    f.hub.personas.forget();
    assert.equal((await f.hub.personas.table()).find(entry => entry.id === 'teardown').role, 'a hijacked role');
    assert.equal((await teamRow(f, 'teardown')).id, 'teardown');
  } finally { await f.close(); }
});

test('an agent-edit Ask for a made persona applies through the same table; an agent has no way to make or retire one', async () => {
  const f = await fixture();
  try {
    await make(f, LEVEL);
    const view = (await f.call('GET', '/hub/team/level-reviewer/persona')).body;
    const id = agentEditAsk(f, 'lv01', proposal({ agent: 'level-reviewer', base: view.current.version, prompt: 'You are Level reviewer. Be brief.' }));
    f.clock.time += 1000;
    const done = await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply' });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.agentEdit.applied, true, JSON.stringify(done.body));
    const stored = f.fake.json(f.files('level-reviewer').at(-1));
    assert.deepEqual([stored.fromAsk, stored.name, stored.template, stored.prompt], [id, 'Level reviewer', 'research', 'You are Level reviewer. Be brief.']);
    assert.equal((await f.hub.personas.table()).find(entry => entry.id === 'level-reviewer').text, 'You are Level reviewer. Be brief.');
    // No op makes or retires a persona.
    const ask = agentEdit => ({ requirePasskey: true, options: AGENT_EDIT_OPTIONS, agentEdit });
    for (const op of ['new', 'create', 'retire']) assert.ok(validateAgentEdit(ask({ op, name: 'X', template: 'plain', agent: 'level-reviewer' })).length > 0, op);
    assert.ok(validateAgentEdit(ask(proposal({ agent: 'level-reviewer', retired: true }))).length > 0);
    assert.ok(validateAgentEdit(ask(proposal({ agent: 'level-reviewer', name: 'Other', template: 'plain' }))).length > 0, 'no renaming');
  } finally { await f.close(); }
});

test('the profile Ask of a made persona is for Hermes main and names it among those who share the profile', async () => {
  const f = await fixture({ env: { ...SIGNING, HERMES_URL: 'http://127.0.0.1:9', HERMES_API_KEY: 'k' } });
  try {
    putExport(f);
    assert.equal((await make(f, LEVEL)).status, 201);
    assert.equal((await f.call('GET', '/hub/team/level-reviewer/details')).body.agent.editable.profile, true);
    const made = await postChange(f, 'level-reviewer', changeBody());
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.match(f.fake.json(`sections/inbox/asks/${made.body.ask}/ask.json`).context, /shared by Hermes, Researcher, Market researcher, Teardown, Planner and Level reviewer\./);
    assert.equal((await postChange(f, 'claude', changeBody())).status, 404);
  } finally { await f.close(); }
});
