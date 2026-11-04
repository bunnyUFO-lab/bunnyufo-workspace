// The owner's persona edits (ws-im1.4.1): the pure checks, the version store over the stand-in S3, the routes, and the agent-edit Ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { CHAT_PERSONAS } from '../chat-personas.mjs';
import { PERSONA_FILE_RE, VIEW_ONLY, checkPersonaEdit, effectivePersona, syncRole } from '../hub-personas.mjs';
import { AGENT_EDIT_OPTIONS, validateAgentEdit } from '../agent-edit.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, seeder } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const TEARDOWN = CHAT_PERSONAS.find(entry => entry.id === 'teardown');
const edit = (extra = {}) => ({ role: TEARDOWN.role, prompt: TEARDOWN.text, model: TEARDOWN.model, base: 'default', ...extra });

async function fixture({ requireRemoteUser = true } = {}) {
  const clock = { time: NOW.getTime() };
  const root = await mkdtemp(path.join(tmpdir(), 'buw-persona-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => new Date(clock.time), env: {} });
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
    assert.deepEqual(team.filter(agent => agent.editable).map(agent => agent.id), ['researcher', 'market-researcher', 'teardown', 'planner']);
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
    assert.deepEqual([details.agent.chatModel, details.agent.editable, details.agent.role], ['Haiku', { persona: true }, TEARDOWN.role]);
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
  has(validateAgentEdit(ask(proposal({ op: 'profile' }))), /op is persona/);
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

test('an agent-edit Ask answered Apply over the web writes one version with fromAsk; Skip writes none', async () => {
  const f = await fixture();
  try {
    const id = agentEditAsk(f, 'a1b2', proposal());
    const detail = (await f.call('GET', `/hub/asks/${id}`)).body;
    assert.equal(detail.agentEdit.agent, 'teardown');
    assert.equal(detail.agentEditBlocked, undefined);
    const done = await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply' });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.agentEdit.applied, true);
    assert.equal(f.files('teardown').length, 1);
    const stored = f.fake.json(f.files('teardown')[0]);
    assert.deepEqual([stored.fromAsk, stored.by, stored.prompt, stored.role, stored.model, stored.note], [id, 'owner', 'You are Teardown. Be brief.', TEARDOWN.role, TEARDOWN.model, 'Agent edit: Answers ran long.']);
    assert.equal((await f.hub.personas.table()).find(entry => entry.id === 'teardown').text, 'You are Teardown. Be brief.');
    assert.equal((await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply' })).status, 409, 'a second answer');
    assert.equal(f.files('teardown').length, 1);

    const skip = agentEditAsk(f, 'c3d4', proposal({ base: done.body.agentEdit.version, prompt: 'You are Teardown. Other.' }));
    const skipped = await f.call('POST', `/hub/asks/${skip}/answer`, { choice: 'skip' });
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
    for (const [name, id, why] of cases) {
      const done = await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply' });
      assert.equal(done.status, 201, name);
      assert.equal(done.body.state, 'answered', name);
      assert.equal(done.body.agentEdit.applied, false, name);
      assert.match(done.body.agentEdit.why, why, name);
    }
    assert.equal(f.files('teardown').length, 1, 'only the owner\'s own save');
    // The page learns beforehand which Asks cannot be applied.
    const blocked = (await f.call('GET', `/hub/asks/${cases[0][1]}`)).body;
    assert.match(blocked.agentEditBlocked ?? '', /changed after the edit was written/);
    const bad = (await f.call('GET', `/hub/asks/${cases[1][1]}`)).body;
    assert.match(bad.agentEditBlocked ?? '', /requires a passkey/);
  } finally { await f.close(); }
});

test('a role-only proposal carries into the prompt\'s first line, like the Edit page', async () => {
  const f = await fixture();
  try {
    const id = agentEditAsk(f, 'f001', { op: 'persona', agent: 'researcher', base: 'default', role: 'research cards with sources, shorter' });
    const done = await f.call('POST', `/hub/asks/${id}/answer`, { choice: 'apply' });
    assert.equal(done.body.agentEdit.applied, true, JSON.stringify(done.body));
    const view = (await f.call('GET', '/hub/team/researcher/persona')).body;
    assert.match(view.current.prompt.split('\n')[0], /agents: research cards with sources, shorter\. The owner/);
    assert.equal(view.current.role, 'research cards with sources, shorter');
  } finally { await f.close(); }
});
