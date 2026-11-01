// The Asks bot with a fake Discord and a fake Hub: what it posts, what a click does, what it says when the
// server refuses, the alarm, and a restart. One case runs the real site API behind the bot's hub client.
// Every id is made up. Nothing here imports discord.js or touches the network beyond 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CHANGED, createBot, createStateFile, readConfig } from '../bot.mjs';
import { createHubClient } from '../hub-client.mjs';
import { createSiteApi } from '../../api/server.mjs';
import { createHub } from '../../api/hub.mjs';
import { createBucket } from '../../api/s3.mjs';
import { startFakeS3 } from '../../api/test/fake-s3.mjs';
import { askJson, seeder } from '../../api/test/hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const OWNER = '100000000000000001';
const OTHER = '100000000000000002';
const SITE = 'https://hub.example.test';
const T0 = new Date('2026-10-27T10:00:00Z');
const later = minutes => new Date(T0.getTime() + minutes * 60000).toISOString();
const run = promisify(execFile);

function setup({ asks = [], state = null, backfill = false, details = {}, answer } = {}) {
  const order = [];
  const logs = [];
  const sent = [];
  const edits = [];
  const ephemerals = [];
  const hubCalls = [];
  let counter = 0;
  const discord = {
    failWith: null,
    onClick(handler) { this.handler = handler; },
    async start() {},
    async stop() {},
    async sendDM(user, message) {
      if (this.failWith) throw Object.assign(new Error('Cannot send messages to this user'), { code: this.failWith });
      counter += 1;
      sent.push({ user, ...message });
      return { channel: `C${counter}`, message: `${400000000000000000 + counter}` };
    },
    async editMessage(target, message) { edits.push({ target, ...message }); },
  };
  const hub = {
    asks,
    details,
    async listAsks() { hubCalls.push('list'); order.push('list'); return { asks: this.asks }; },
    async getAsk(id) { hubCalls.push(`get ${id}`); return this.details[id] ?? null; },
    async answer(body) {
      hubCalls.push('answer'); order.push('answer'); hub.posted = body;
      if (answer instanceof Error) throw answer;
      return answer ? answer(body) : { status: 201, body: { state: 'answered', answer: { by: 'owner', via: 'discord', choice: body.choice } } };
    },
  };
  let saved = state;
  const store = { load: () => (saved ? structuredClone(saved) : null), save: next => { saved = structuredClone(next); } };
  const bot = createBot({
    hub, discord, store, ownerId: OWNER, siteUrl: SITE, backfill, now: () => T0, log: line => logs.push(line),
    setTimer: () => null, clearTimer: () => {},
  });
  const click = ({ user = OWNER, customId, message, id = '200000000000000001' }) => ({
    id, user, customId, message, channel: 'C1',
    async deferUpdate() { order.push('defer'); },
    async ephemeral(text) { ephemerals.push(text); },
  });
  return { bot, hub, discord, sent, edits, ephemerals, hubCalls, logs, order, click, saved: () => saved };
}

const ask = (slug, extra = {}) => ({
  id: `20261027-probe-${slug}-a1b2`, project: 'magic-loops', question: 'Which jump arc feels right?',
  options: [{ id: 'A', label: 'Snappy' }, { id: 'B', label: 'Floaty' }], requirePasskey: false,
  createdAt: later(5), expiresAt: later(60 * 24), rev: '0123456789abcdef', ...extra,
});

test('a qualifying Ask gets one DM with a button per option and the link, and its rev is kept; a passkey-only Ask gets none', async () => {
  const simple = ask('simple');
  const locked = ask('locked', { requirePasskey: true, rev: 'fedcba9876543210' });
  const t = setup({ asks: [simple, locked] });
  await t.bot.poll();
  assert.equal(t.sent.length, 1);
  const [dm] = t.sent;
  assert.equal(dm.user, OWNER);
  assert.match(dm.content, /^\*\*Agent needs you · Magic Loops\*\*\nWhich jump arc feels right\?$/);
  assert.deepEqual(dm.components.options, [
    { customId: `a:${simple.id}:A`, label: 'Snappy' }, { customId: `a:${simple.id}:B`, label: 'Floaty' },
  ]);
  assert.deepEqual(dm.components.link, { label: 'Open in the Hub', url: `${SITE}/#/~hub/ask/${simple.id}` });
  const { posted } = t.bot.snapshot();
  assert.deepEqual(Object.keys(posted), [simple.id]);
  assert.equal(posted[simple.id].rev, simple.rev);
  assert.equal(posted[simple.id].channel, 'C1');
  await t.bot.poll();
  assert.equal(t.sent.length, 1, 'A second poll posts nothing again.');
});

test('a long question is cut to 1500 characters', async () => {
  const t = setup({ asks: [ask('long', { question: 'word '.repeat(600) })] });
  await t.bot.poll();
  assert.ok(t.sent[0].content.split('\n')[1].length <= 1500);
});

test('a click from another user gets an ephemeral refusal, calls nothing and leaves no id in the log', async () => {
  const a = ask('other');
  const t = setup({ asks: [a] });
  await t.bot.poll();
  const before = t.hubCalls.length;
  const message = t.bot.snapshot().posted[a.id].message;
  await t.bot.handleClick(t.click({ user: OTHER, customId: `a:${a.id}:A`, message, id: '200000000000000099' }));
  assert.deepEqual(t.ephemerals, ['Only the owner can answer this.']);
  assert.equal(t.hubCalls.length, before, 'No Hub call.');
  assert.ok(!t.order.includes('defer'));
  assert.ok(!t.logs.join('\n').includes(OTHER) && !t.logs.join('\n').includes('200000000000000099'));
  assert.equal(t.edits.length, 0);
});

test('a click on a message with no state entry says to open it in the Hub, and calls nothing', async () => {
  const t = setup();
  await t.bot.poll();
  await t.bot.handleClick(t.click({ customId: 'a:20261027-probe-gone-a1b2:A', message: '400000000000000777' }));
  assert.equal(t.ephemerals.length, 1);
  assert.match(t.ephemerals[0], /^Open it in the Hub: https:\/\/hub\.example\.test\/#\/~hub\/ask\/20261027-probe-gone-a1b2$/);
  assert.deepEqual(t.hubCalls, ['list']);
  // A message that exists but belongs to a different Ask is the same.
  const a = ask('mine');
  const u = setup({ asks: [a] });
  await u.bot.poll();
  await u.bot.handleClick(u.click({ customId: 'a:20261027-probe-else-a1b2:A', message: u.bot.snapshot().posted[a.id].message }));
  assert.equal(u.hubCalls.filter(call => call === 'answer').length, 0);
});

test('a click defers first, then posts the stored rev with exactly the six keys, and records the interaction id', async () => {
  const a = ask('order');
  const t = setup({ asks: [a] });
  await t.bot.poll();
  const message = t.bot.snapshot().posted[a.id].message;
  await t.bot.handleClick(t.click({ customId: `a:${a.id}:B`, message, id: '200000000000000005' }));
  assert.deepEqual(t.order, ['list', 'defer', 'answer']);
  assert.deepEqual(Object.keys(t.hub.posted).sort(), ['ask', 'choice', 'interaction', 'message', 'rev', 'user']);
  assert.deepEqual(t.hub.posted, { ask: a.id, choice: 'B', rev: a.rev, user: OWNER, interaction: '200000000000000005', message });
  assert.ok(t.bot.snapshot().sent.includes('200000000000000005'));
});

test('the answer route\'s replies each give the edit or the ephemeral reply the brief lists', async () => {
  const cases = [
    ['201', () => ({ status: 201, body: { answer: { choice: 'B', via: 'discord' } } }), { edit: /Answered: B · Floaty, via Discord$/, buttons: false, link: false }],
    ['409 changed', () => ({ status: 409, body: { error: CHANGED } }), { edit: /This Ask changed\. Open it in the Hub\.$/, buttons: false, link: true }],
    ['409 answered first', () => ({ status: 409, body: { error: 'This Ask is already answered.', answer: { choice: 'A', via: 'discord' } } }), { edit: /Answered: A · Snappy, via Discord$/, buttons: false, link: false }],
    ['409 answered in the Hub', () => ({ status: 409, body: { error: 'This Ask is already answered.', answer: { choice: 'A', by: 'owner' } } }), { edit: /Answered: A · Snappy, in the Hub$/, buttons: false, link: false }],
    ['409 other', () => ({ status: 409, body: { error: 'This Ask is cancelled.' } }), { edit: /This Ask is cancelled\.$/, buttons: false, link: false }],
    ['403', () => ({ status: 403, body: { error: 'x' } }), { edit: /Answer this one in the Hub\.$/, buttons: false, link: true }],
  ];
  for (const [name, answer, want] of cases) {
    const a = ask('reply');
    const t = setup({ asks: [a], answer });
    await t.bot.poll();
    await t.bot.handleClick(t.click({ customId: `a:${a.id}:B`, message: t.bot.snapshot().posted[a.id].message }));
    assert.equal(t.edits.length, 1, name);
    assert.match(t.edits[0].content, want.edit, name);
    assert.deepEqual(t.edits[0].components?.options ?? [], [], `${name}: no option buttons`);
    assert.equal(!!t.edits[0].components?.link, want.link, `${name}: link`);
    assert.ok(t.edits[0].content.startsWith('**Agent needs you · Magic Loops**'), `${name}: the question stays`);
    assert.equal(Object.keys(t.bot.snapshot().posted).length, 0, `${name}: no longer tracked`);
    assert.equal(t.ephemerals.length, 0, name);
  }
  // 400 and a network error keep the buttons and answer privately.
  for (const [name, answer, text] of [
    ['400', () => ({ status: 400, body: { error: 'That is not one of the options.' } }), 'That is not one of the options.'],
    ['network', new Error('fetch failed'), 'Could not reach the Hub; try again.'],
    ['500', () => ({ status: 500, body: null }), 'The Hub did not take that answer; try again.'],
  ]) {
    const a = ask('keep');
    const t = setup({ asks: [a], answer });
    await t.bot.poll();
    await t.bot.handleClick(t.click({ customId: `a:${a.id}:A`, message: t.bot.snapshot().posted[a.id].message }));
    assert.deepEqual(t.ephemerals, [text], name);
    assert.equal(t.edits.length, 0, `${name}: the buttons stay`);
    assert.ok(t.bot.snapshot().posted[a.id], `${name}: still tracked`);
  }
});

test('an Ask answered in the web app loses its buttons on the next poll; a cancelled, changed or snoozed one is handled too', async () => {
  const web = ask('web', { question: 'Web question' });
  const gone = ask('cancelled', { id: '20261027-probe-cancelled-c3c3' });
  const moved = ask('moved', { id: '20261027-probe-moved-d4d4' });
  const nap = ask('nap', { id: '20261027-probe-nap-e5e5' });
  const t = setup({ asks: [web, gone, moved, nap] });
  await t.bot.poll();
  assert.equal(t.sent.length, 4);
  t.hub.asks = [{ ...moved, rev: 'aaaaaaaaaaaaaaaa' }];
  t.hub.details = {
    [web.id]: { state: 'answered', answer: { by: 'owner', choice: 'B' } },
    [gone.id]: { state: 'cancelled' },
    [nap.id]: { state: 'snoozed' },
  };
  await t.bot.poll();
  const by = text => t.edits.find(edit => edit.content.includes(text));
  assert.match(by('Web question').content, /Answered: B · Floaty, in the Hub$/);
  assert.equal(t.edits.length, 3);
  assert.ok(t.edits.some(edit => /This Ask was cancelled\.$/.test(edit.content)));
  assert.ok(t.edits.some(edit => /This Ask changed\. Open it in the Hub\.$/.test(edit.content) && edit.components.link));
  assert.ok(t.edits.every(edit => !(edit.components?.options?.length)), 'No edit keeps option buttons.');
  assert.deepEqual(Object.keys(t.bot.snapshot().posted), [nap.id], 'A snoozed Ask is still answerable, so it stays.');
  assert.equal(t.sent.length, 4, 'No alarm for any of them.');
});

test('alarm: an answer via Discord with an interaction the bot did not send gets one DM; a known one gets none', async () => {
  const stranger = ask('stranger');
  const mine = ask('mine', { id: '20261027-probe-mine-b2b2', question: 'Another question' });
  const t = setup({ asks: [stranger, mine] });
  await t.bot.poll();
  await t.bot.handleClick(t.click({ customId: `a:${mine.id}:A`, message: t.bot.snapshot().posted[mine.id].message, id: '200000000000000011' }));
  // The click above was answered by 201 (default fake). A second Ask was answered by someone holding the token.
  t.hub.asks = [];
  t.hub.details = { [stranger.id]: { state: 'answered', question: 'Which jump arc feels right?', answer: { by: 'owner', via: 'discord', choice: 'A', discord: { interaction: '200000000000000666', message: '1' } } } };
  const before = t.sent.length;
  await t.bot.poll();
  assert.equal(t.sent.length, before + 1);
  assert.equal(t.sent.at(-1).content, 'Which jump arc feels right? was answered through the Discord path, but not from this bot. Check the token.');
  assert.equal(t.sent.at(-1).components, null);
  await t.bot.poll();
  assert.equal(t.sent.length, before + 1, 'Once only: the Ask is no longer tracked.');

  // An id the bot did send (its POST was lost on the way back) is no alarm.
  const lost = ask('lost', { id: '20261027-probe-lost-f6f6' });
  const u = setup({ asks: [lost], answer: new Error('socket hang up') });
  await u.bot.poll();
  await u.bot.handleClick(u.click({ customId: `a:${lost.id}:A`, message: u.bot.snapshot().posted[lost.id].message, id: '200000000000000042' }));
  u.hub.asks = [];
  u.hub.details = { [lost.id]: { state: 'answered', answer: { by: 'owner', via: 'discord', choice: 'A', discord: { interaction: '200000000000000042', message: '1' } } } };
  await u.bot.poll();
  assert.equal(u.sent.length, 1, 'No alarm DM.');
  assert.match(u.edits.at(-1).content, /Answered: A · Snappy, via Discord$/);

  // The question in the alarm is cut to 80 characters.
  const wordy = ask('wordy', { id: '20261027-probe-wordy-a7a7', question: 'q'.repeat(300) });
  const w = setup({ asks: [wordy] });
  await w.bot.poll();
  w.hub.asks = [];
  w.hub.details = { [wordy.id]: { state: 'answered', question: 'q'.repeat(300), answer: { via: 'discord', choice: 'A', discord: { interaction: '9' } } } };
  await w.bot.poll();
  assert.ok(w.sent.at(-1).content.split(' was answered')[0].length <= 80);
});

test('a restart with a state file posts no duplicates; a first run does not post old Asks; BACKFILL does', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'asks-bot-'));
  const a = ask('restart');
  const make = (asks, backfill = false) => {
    const t = setup({ asks, backfill });
    return { ...t, bot: createBot({ hub: t.hub, discord: t.discord, store: createStateFile(dir), ownerId: OWNER, siteUrl: SITE, backfill, now: () => T0, log: () => {}, setTimer: () => null }) };
  };
  const first = make([a]);
  await first.bot.start();
  assert.equal(first.sent.length, 1);
  const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.since, T0.toISOString());
  assert.equal(state.posted[a.id].rev, a.rev);
  const second = make([a]);
  await second.bot.start();
  assert.equal(second.sent.length, 0, 'The restarted bot knows the Ask.');

  const fresh = await mkdtemp(path.join(tmpdir(), 'asks-bot-'));
  const old = ask('old', { createdAt: new Date(T0.getTime() - 3600_000).toISOString() });
  const make2 = (backfill) => {
    const t = setup({ asks: [old], backfill });
    return { ...t, bot: createBot({ hub: t.hub, discord: t.discord, store: createStateFile(fresh), ownerId: OWNER, siteUrl: SITE, backfill, now: () => T0, log: () => {}, setTimer: () => null }) };
  };
  const noBackfill = make2(false);
  await noBackfill.bot.start();
  assert.equal(noBackfill.sent.length, 0, 'An Ask from before the first run is not posted.');
  const other = await mkdtemp(path.join(tmpdir(), 'asks-bot-'));
  const t3 = setup({ asks: [old], backfill: true });
  const withBackfill = createBot({ hub: t3.hub, discord: t3.discord, store: createStateFile(other), ownerId: OWNER, siteUrl: SITE, backfill: true, now: () => T0, log: () => {}, setTimer: () => null });
  await withBackfill.start();
  assert.equal(t3.sent.length, 1, 'BACKFILL=1 posts it.');
});

test('Discord refusing the DM (error 50007) is logged once per Ask and the poll goes on', async () => {
  const a = ask('dms');
  const t = setup({ asks: [a] });
  t.discord.failWith = 50007;
  await t.bot.poll();
  await t.bot.poll();
  assert.equal(t.logs.filter(line => line.includes('50007')).length, 1);
  assert.equal(t.sent.length, 0);
  assert.equal(Object.keys(t.bot.snapshot().posted).length, 0);
});

test('startup without HUB_URL or SITE_URL fails with a clear message, and a bad value is named', () => {
  const full = { DISCORD_TOKEN: 'd', HUB_TOKEN: 'h', OWNER_ID: OWNER, HUB_URL: 'http://site-api:8099', SITE_URL: SITE };
  const config = readConfig(full);
  assert.equal(config.hubUrl, 'http://site-api:8099');
  assert.equal(config.pollSeconds, 60);
  assert.equal(config.backfill, false);
  for (const name of ['HUB_URL', 'SITE_URL']) {
    const { [name]: _gone, ...rest } = full;
    assert.throws(() => readConfig(rest), error => error.message.includes(`Missing ${name}`) && /no defaults/.test(error.message), name);
  }
  assert.throws(() => readConfig({ ...full, SITE_URL: 'not a url' }), /SITE_URL is not an http\(s\) address/);
  assert.throws(() => readConfig({ ...full, OWNER_ID: 'me' }), /OWNER_ID/);
  assert.throws(() => readConfig({ ...full, DISCORD_TOKEN: '' }), /DISCORD_TOKEN/);
  assert.equal(readConfig({ ...full, SITE_URL: `${SITE}/` }).siteUrl, SITE, 'A trailing slash is dropped.');
});

test('new-token.mjs writes the token and its hash, prints only the paths, and never overwrites', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'asks-token-'));
  const file = path.join(dir, 'nested', 'hub-discord-token');
  const script = fileURLToPath(new URL('../new-token.mjs', import.meta.url));
  const made = await run(process.execPath, [script, '--out', file]);
  const token = (await readFile(file, 'utf8')).trim();
  assert.match(token, /^buwd_[A-Za-z0-9_-]{43}$/);
  assert.equal((await readFile(`${file}.sha256`, 'utf8')).trim(), createHash('sha256').update(token).digest('hex'));
  assert.ok(!made.stdout.includes(token) && !made.stderr.includes(token), 'The token is never printed.');
  assert.deepEqual(made.stdout.trim().split('\n'), [file, `${file}.sha256`]);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(run(process.execPath, [script, '--out', file]), error => /already exists/.test(error.stderr) && !error.stderr.includes(token));
  assert.equal((await readFile(file, 'utf8')).trim(), token, 'The first token is untouched.');
  await assert.rejects(run(process.execPath, [script]), error => /Usage/.test(error.stderr));
});

test('end to end: a click through the real site API puts answer.json in the bucket with via discord and the right rev', async () => {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const token = 'buwd_test-token-made-in-the-test';
  const hub = createHub({ bucket, enabled: true, env: { HUB_DISCORD_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'), HUB_DISCORD_OWNER_ID: OWNER }, log: () => {} });
  const root = await mkdtemp(path.join(tmpdir(), 'asks-e2e-'));
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 's.json'), requireRemoteUser: true, hub });
  await listenOnGoodPort(server, '127.0.0.1');
  try {
    const now = new Date();
    const id = `${now.toISOString().slice(0, 10).replace(/-/g, '')}-probe-e2e-a1b2`;
    seeder(fake).ask(askJson({ id, now, options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], allowDrawing: false }));
    const t = setup();
    const client = createHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token });
    const bot = createBot({ hub: client, discord: t.discord, store: { load: () => null, save: () => {} }, ownerId: OWNER, siteUrl: SITE, now: () => new Date(now.getTime() - 3600_000), log: line => t.logs.push(line), setTimer: () => null });
    await bot.start();
    assert.equal(t.sent.length, 1);
    const { message, rev } = bot.snapshot().posted[id];
    assert.equal(rev, createHash('sha256').update(fake.text(`sections/inbox/asks/${id}/ask.json`)).digest('hex').slice(0, 16));
    await bot.handleClick(t.click({ customId: `a:${id}:B`, message, id: '200000000000000321' }));
    const stored = fake.json(`sections/inbox/asks/${id}/answer.json`);
    assert.equal(stored.via, 'discord');
    assert.equal(stored.by, 'owner');
    assert.equal(stored.choice, 'B');
    assert.equal(stored.rev, rev);
    assert.deepEqual(stored.discord, { interaction: '200000000000000321', message });
    assert.match(t.edits.at(-1).content, /Answered: B · No, via Discord$/);
    assert.ok(!t.logs.join('\n').includes(token) && !t.logs.join('\n').includes(OWNER));

    // The Ask now changes under a posted message: the click is refused and the DM says so.
    const second = `${id.slice(0, -4)}b2b2`;
    seeder(fake).ask(askJson({ id: second, now, options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], allowDrawing: false }));
    await bot.poll();
    const posted = bot.snapshot().posted[second];
    fake.seed(`sections/inbox/asks/${second}/ask.json`, JSON.stringify({ ...askJson({ id: second, now, options: [{ id: 'A', label: 'Yes, delete it' }, { id: 'B', label: 'No' }], allowDrawing: false }) }), 'application/json');
    await bot.handleClick(t.click({ customId: `a:${second}:A`, message: posted.message, id: '200000000000000322' }));
    assert.equal(fake.text(`sections/inbox/asks/${second}/answer.json`), null, 'Nothing was written.');
    assert.match(t.edits.at(-1).content, /This Ask changed\. Open it in the Hub\.$/);
  } finally {
    server.close();
    await fake.close();
  }
});

test('the compose file mounts the env file and nothing more of the site folder, so the bot cannot read api.env', async () => {
  const compose = await readFile(fileURLToPath(new URL('../docker-compose.yml', import.meta.url)), 'utf8');
  const lines = compose.split(/\r?\n/).filter(line => !line.trim().startsWith('#'));
  const start = lines.findIndex(line => /^\s{4}volumes:\s*$/.test(line));
  assert.ok(start >= 0, 'The service lists its volumes.');
  const mounts = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s{6}-\s+(\S+)\s*$/.exec(line);
    if (!item) break;
    mounts.push(item[1]);
  }
  assert.deepEqual(mounts, ['./:/app:ro', '${BUW_DOCS_ROOT:-/srv/buw-docs}/_app/asks-bot.env:/run/asks-bot.env:ro', 'asks-bot-state:/state']);
  assert.match(compose, /BUW_ENV_FILE: \/run\/asks-bot\.env\s*$/m);
  assert.ok(!/BUW_DOCS_ROOT:-\/srv\/buw-docs\}:/.test(compose.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')), 'No mount of the whole site folder.');
});
