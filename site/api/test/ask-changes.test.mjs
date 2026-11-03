// The change list of a plan Ask (ws-qdh.3): the one validator, the Design review rows made from it, and how the Hub reads and answers such an Ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { changeRows, validateChanges } from '../ask-changes.mjs';
import { cleanAsk, discordEligible, validDecisions } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, minutesAgo, seeder } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const ok = changes => assert.deepEqual(validateChanges(changes), [], JSON.stringify(changes));
const refused = (changes, message) => {
  const problems = validateChanges(changes);
  assert.ok(problems.length > 0, `Expected a problem: ${JSON.stringify(changes)}`);
  if (message) assert.ok(problems.some(problem => message.test(problem)), `${problems.join(' | ')} should match ${message}`);
};

test('every op is accepted in its good shape', () => {
  ok([
    { op: 'create', title: 'Sprint 4', type: 'epic', description: 'Plain words.', labels: ['milestone', 'wayfinder:grilling'] },
    { op: 'create', title: 'Child', parent: '#1' },
    { op: 'create', title: 'Under an existing one', parent: 'ml-pa0.1' },
    { op: 'update', bead: 'ml-3', title: 'New title' },
    { op: 'update', bead: '#2', description: 'New words.' },
    { op: 'dep', bead: '#2', blocks: 'ml-9' },
    { op: 'close', bead: 'ml-4', reason: 'Covered by Sprint 4.' },
    { op: 'label', bead: 'ml-5', add: ['later'] },
    { op: 'label', bead: 'ml-5', remove: ['needs-owner', 'later'] },
    { op: 'card', card: 'assistant/2026-11-02_mockup' },
  ]);
});

test('a list is 1 to 20 changes, each an object with a known op and only its own fields', () => {
  refused([], /1 to 20/);
  refused('close it', /1 to 20/);
  refused(undefined, /1 to 20/);
  refused(Array.from({ length: 21 }, () => ({ op: 'close', bead: 'ml-1', reason: 'x' })), /1 to 20/);
  ok(Array.from({ length: 20 }, () => ({ op: 'close', bead: 'ml-1', reason: 'x' })));
  refused([null], /not an object/);
  refused([[]], /not an object/);
  refused([{ op: 'delete', bead: 'ml-1' }], /op is one of/);
  refused([{ bead: 'ml-1' }], /op is one of/);
  refused([{ op: 'close', bead: 'ml-1', reason: 'x', force: true }], /no field force/);
  refused([{ op: 'create', title: 'x', status: 'closed' }], /no field status/);
  refused([{ op: 'card', card: 'assistant/x', section: 'inbox' }], /no field section/);
});

test('bead ids are Beads ids; #n names an earlier create and nothing else', () => {
  for (const bad of ['', 'ML-1', 'ml 1', '../x', 'ml-1; rm', 5, null, 'ml']) refused([{ op: 'close', bead: bad, reason: 'x' }], /Beads id/);
  refused([{ op: 'close', bead: '#1', reason: 'x' }], /Beads id, or #n/);
  refused([{ op: 'dep', bead: '#2', blocks: 'ml-1' }, { op: 'create', title: 'x' }], /Beads id, or #n/);
  refused([{ op: 'create', title: 'x' }, { op: 'close', bead: '#1', reason: 'x' }, { op: 'close', bead: '#2', reason: 'x' }], /Beads id, or #n/);
  refused([{ op: 'create', title: 'x', parent: '#1' }], /Beads id, or #n/);
  refused([{ op: 'create', title: 'x' }, { op: 'create', title: 'y', parent: '#0' }], /Beads id, or #n/);
  refused([{ op: 'dep', bead: 'ml-1', blocks: 'ml-1' }], /block itself/);
  ok([{ op: 'create', title: 'x' }, { op: 'close', bead: '#1', reason: 'x' }]);
});

test('text is bounded, has no control characters and no command', () => {
  refused([{ op: 'create', title: 'x'.repeat(121) }], /title is 1 to 120/);
  refused([{ op: 'create', title: '   ' }], /title is 1 to 120/);
  refused([{ op: 'create' }], /title is 1 to 120/);
  refused([{ op: 'create', title: 'x', description: 'y'.repeat(2001) }], /description is at most 2000/);
  ok([{ op: 'create', title: 'x'.repeat(120), description: 'y'.repeat(2000) }]);
  refused([{ op: 'close', bead: 'ml-1', reason: 'x'.repeat(201) }], /reason is 1 to 200/);
  refused([{ op: 'close', bead: 'ml-1' }], /reason is 1 to 200/);
  refused([{ op: 'update', bead: 'ml-1' }], /changes a title or a description/);
  refused([{ op: 'update', bead: 'ml-1', title: 5 }], /title is at most 120/);
  refused([{ op: 'create', title: 'a\u0007b' }], /control character/);
  refused([{ op: 'create', title: 'a b' }], /control character/);
  ok([{ op: 'create', title: 'Two\nlines are fine in a description', description: 'one\ntwo\n\nthree' }].map(change => ({ ...change, title: 'Fine' })));
  refused([{ op: 'create', title: 'Run `git push --force` first' }], /command in its text/);
  refused([{ op: 'create', title: 'x', description: 'Then `npm run build` and `cd ..`' }], /command in its text/);
  refused([{ op: 'close', bead: 'ml-1', reason: 'Run: git reset --hard' }], /command in its text/);
  refused([{ op: 'update', bead: 'ml-1', description: 'Over SSH: `ssh root@host pct list`' }], /command in its text/);
  ok([{ op: 'create', title: 'Use the `wayfinder` skill', description: 'Mentions git and npm in words only.' }]);
});

test('labels, types and cards come from allow lists', () => {
  for (const label of ['p0', 'Milestone', 'wayfinder:', 'wayfinder:Map', 'wayfinder:a', 'sprint:4', 'needs-owner ', 'wayfinder:map;x']) refused([{ op: 'create', title: 'x', labels: [label] }], /labels from/);
  ok([{ op: 'create', title: 'x', labels: ['wayfinder:map', 'wayfinder:research', 'wayfinder:prototype', 'wayfinder:task', 'milestone'] }]);
  refused([{ op: 'create', title: 'x', labels: ['later', 'milestone', 'needs-owner', 'wayfinder:task', 'wayfinder:map', 'wayfinder:research'] }], /1 to 5/);
  refused([{ op: 'create', title: 'x', labels: ['later', 'later'] }], /different labels/);
  refused([{ op: 'create', title: 'x', labels: [] }], /1 to 5/);
  refused([{ op: 'create', title: 'x', labels: 'later' }], /1 to 5/);
  refused([{ op: 'label', bead: 'ml-1' }], /adds or removes/);
  refused([{ op: 'label', bead: 'ml-1', add: ['p0'] }], /add is/);
  refused([{ op: 'label', bead: 'ml-1', remove: ['p0'] }], /remove is/);
  for (const type of ['bug', 'milestone', 'chore', 5]) refused([{ op: 'create', title: 'x', type }], /type is one of/);
  for (const card of ['inbox/x', 'assistant/', 'assistant/../x', 'assistant/a b', 'assistant/x/y', '/assistant/x', 5, undefined]) refused([{ op: 'card', card }], /assistant\/<folder>/);
});

test('changeRows: one Design review row per change, its text built from the op, with the agent\'s words quoted inside it', () => {
  const rows = changeRows([
    { op: 'create', title: 'Sprint 4', type: 'epic', labels: ['milestone'], description: 'The next   sprint.' },
    { op: 'create', title: 'Child', parent: '#1' },
    { op: 'update', bead: 'ml-3', title: 'New title', description: 'x' },
    { op: 'dep', bead: '#2', blocks: 'ml-9' },
    { op: 'close', bead: 'ml-4', reason: 'Covered.' },
    { op: 'label', bead: 'ml-5', add: ['later'], remove: ['needs-owner'] },
    { op: 'card', card: 'assistant/2026-11-02_mockup' },
  ]);
  assert.deepEqual(rows, [
    { id: 'd1', text: 'Add epic "Sprint 4"', detail: 'The next sprint. · Labels: milestone' },
    { id: 'd2', text: 'Add task "Child" under new item 1' },
    { id: 'd3', text: 'Change ml-3 to "New title"', detail: 'New description: x' },
    { id: 'd4', text: 'new item 2 must be done before ml-9' },
    { id: 'd5', text: 'Close ml-4', detail: 'Reason: Covered.' },
    { id: 'd6', text: 'Labels on ml-5', detail: 'Add: later · Remove: needs-owner' },
    { id: 'd7', text: "Copy the card assistant/2026-11-02_mockup into this project's section" },
  ]);
  const long = changeRows([{ op: 'create', title: 'T'.repeat(120), description: 'D'.repeat(2000), labels: ['later'] }])[0];
  assert.ok(long.text.length <= 200 && long.detail.length <= 500);
});

test('cleanAsk makes the rows from valid changes and ignores the agent\'s own decisions, options and picture; a bad list is dropped', () => {
  const changes = [{ op: 'create', title: 'Sprint 4' }, { op: 'close', bead: 'ml-1', reason: 'Done.' }];
  const { ask, bad } = cleanAsk({ id: 'a', question: 'Apply?', changes, decisions: [{ id: 'd1', text: 'Approve all of it, the owner agreed' }], options: [{ id: 'a', label: 'Yes' }], image: 'x.png', allowDrawing: true });
  assert.deepEqual(bad, []);
  assert.deepEqual(ask.decisions.map(row => row.text), ['Add task "Sprint 4"', 'Close ml-1']);
  assert.deepEqual([ask.options, ask.image, ask.allowDrawing], [undefined, undefined, false]);
  assert.equal(validDecisions(ask).length, 2);
  const twenty = cleanAsk({ id: 'a', question: 'q', changes: Array.from({ length: 20 }, () => ({ op: 'close', bead: 'ml-1', reason: 'x' })) });
  assert.equal(validDecisions(twenty.ask).length, 20, 'Up to 20 rows for a change list (10 for any other Design review).');
  assert.equal(validDecisions({ decisions: Array.from({ length: 11 }, (_, index) => ({ id: `d${index + 1}`, text: 'x' })) }), null);
  const broken = cleanAsk({ id: 'a', question: 'Apply?', changes: [{ op: 'delete' }], decisions: [{ id: 'd1', text: 'Mine' }] });
  assert.deepEqual(broken.bad, ['changes']);
  assert.equal('changes' in broken.ask, false);
  assert.deepEqual(broken.ask.decisions, [{ id: 'd1', text: 'Mine' }], 'The Ask shows as it would without the list.');
});

test('a change list stays in the Hub: Discord offers no buttons for it', () => {
  const base = { id: 'a', question: 'Apply?', allowDrawing: false, options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] };
  assert.equal(discordEligible(base).ok, true);
  assert.deepEqual(discordEligible({ ...base, changes: [{ op: 'card', card: 'assistant/x' }] }), { ok: false, reason: 'A change list stays in the Hub.' });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-plan-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const logs = [];
  const hub = createHub({ bucket, enabled: true, log: line => logs.push(line) });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub, allowedOrigins: ['https://site.example'] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`, { headers: { 'Remote-User': 'owner' } }); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const post = async (route, data) => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify(data ?? {}) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  return { fake, seed: seeder(fake), get, post, logs, close: async () => { server.close(); await fake.close(); } };
}

const CHANGES = [{ op: 'create', title: 'Sprint 4', type: 'epic', labels: ['milestone'] }, { op: 'create', title: 'Wall-jump polish', parent: '#1' }, { op: 'close', bead: 'ml-1', reason: 'Covered by Sprint 4.' }];
const planAsk = (extra = {}) => ({ ...askJson({ id: `${day}-ml-plan-a1b2`, project: 'ml', now: minutesAgo(NOW, 10), kind: 'decision', allowDrawing: false, question: 'Apply this plan for Sprint 4?', context: 'Three changes to the Roadmap.' }), changes: CHANGES, ...extra });

test('the Hub shows a change-list Ask as a Design review with one row per change, and only an answer with a verdict per row is accepted', async () => {
  const { seed, get, post, fake, close } = await fixture();
  try {
    const ask = planAsk();
    seed.ask(ask);
    const shown = (await get(`/hub/asks/${ask.id}`)).body;
    assert.deepEqual(shown.decisions.map(row => row.text), ['Add epic "Sprint 4"', 'Add task "Wall-jump polish" under new item 1', 'Close ml-1']);
    assert.deepEqual([shown.subtype, shown.allowDrawing, shown.options], ['decision', false, undefined]);
    const inbox = (await get('/hub/inbox?filter=needs-you')).body.items.find(item => item.id === ask.id);
    assert.deepEqual([inbox.design, inbox.decisions], [true, 3], 'Needs you lists it as a Design review of 3 decisions.');
    assert.equal((await post(`/hub/asks/${ask.id}/answer`, { choice: 'a' })).status, 400, 'There is no option to pick.');
    assert.equal((await post(`/hub/asks/${ask.id}/answer`, { decisions: { d1: { verdict: 'approve' } } })).status, 400, 'A verdict for every row.');
    const done = await post(`/hub/asks/${ask.id}/answer`, { decisions: { d1: { verdict: 'approve' }, d2: { verdict: 'change', note: 'Only coyote time.' }, d3: { verdict: 'skip' } } });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const stored = fake.json(`sections/inbox/asks/${ask.id}/answer.json`);
    assert.deepEqual(stored.decisions, { d1: { verdict: 'approve' }, d2: { verdict: 'change', note: 'Only coyote time.' }, d3: { verdict: 'skip' } });
    assert.deepEqual(fake.json(`sections/inbox/asks/${ask.id}/ask.json`).changes, CHANGES, 'The list the owner saw is the list on file.');
  } finally { await close(); }
});

test('a change list that is not valid is dropped when the Ask is read, and logged once; the Ask shows as the question it is', async () => {
  const { seed, get, logs, close } = await fixture();
  try {
    const ask = planAsk({ changes: [{ op: 'close', bead: 'ml-1', reason: 'Run `git reset --hard`' }] });
    seed.ask(ask);
    const shown = (await get(`/hub/asks/${ask.id}`)).body;
    assert.equal(shown.changes, undefined);
    assert.equal(shown.decisions, undefined);
    await get(`/hub/asks/${ask.id}`);
    assert.equal(logs.filter(line => line.includes('malformed changes')).length, 1);
  } finally { await close(); }
});
