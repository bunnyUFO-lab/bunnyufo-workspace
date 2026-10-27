// The cards CLI's inbox commands against the stand-in S3, over the card API (a local HTTP server
// running the real handler) and straight to the bucket (--via s3), plus retries and the spool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBucket } from '../site/api/s3.mjs';
import { startFakeS3 } from '../site/api/test/fake-s3.mjs';
import { createCardApi, parseTokens } from '../site/card-api/handler.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = text => createHash('sha256').update(text).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

/** The handler behind a local HTTP server; `flaky.fail` is how many requests answer 503 first (Infinity: always). */
async function serve(api, flaky) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (flaky.fail > 0) {
      flaky.fail -= 1;
      flaky.refused += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      return response.end('{"error":"busy"}');
    }
    const url = new URL(request.url, 'http://local');
    const result = await api({
      requestContext: { http: { method: request.method } },
      rawPath: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body: chunks.length ? Buffer.concat(chunks).toString('base64') : undefined,
      isBase64Encoded: true,
    });
    if (flaky.lose > 0 && request.method === 'PUT') {          // the write landed, the answer did not
      flaky.lose -= 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      return response.end('{"error":"gateway"}');
    }
    response.writeHead(result.statusCode, result.headers);
    response.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${server.address().port}`;
  return server;
}

async function setup() {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', JSON.stringify({ name: 'Inbox', hidden: true, entities: [] }), 'application/json');
  const api = createCardApi({ bucket, tokens: parseTokens(`all=${sha('tok-all')},ro=${sha('tok-ro')}:read=*`) });
  const flaky = { fail: 0, refused: 0, lose: 0 };
  const server = await serve(api, flaky);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cards-cli-'));
  const spool = path.join(dir, 'spool.jsonl');
  const base = {
    ...process.env, HOME: dir, USERPROFILE: dir, BUW_REGISTRY: path.join(dir, 'none.json'), BUW_SPOOL: spool,
    BUW_CARD_API: server.url, BUW_CARDS_PASSWORD: 'tok-all', BUW_CARDS_VIA: '', BUW_CARDS_RETRY_MS: '5', CLAUDE_SESSION_ID: '',
  };
  delete base.AWS_ACCESS_KEY_ID;
  delete base.AWS_PROFILE;
  const direct = { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', BUW_S3_BUCKET: fake.bucket, BUW_S3_ENDPOINT: fake.endpoint, BUW_S3_REGION: 'us-east-1', BUW_CARDS_PASSWORD: '' };
  /** Run the CLI; resolves { code, stdout, stderr } whether or not it exits 0. */
  const cli = (via, ...args) => new Promise(resolve => {
    const env = { ...(via === 's3' ? { ...base, ...direct } : base), ...cli.env };
    execFile(process.execPath, [path.join(repo, 'scripts/cards.mjs'), ...args, ...(via ? ['--via', via] : [])], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
  cli.env = {};
  const keys = prefix => [...fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/${prefix}`)).sort();
  const close = async () => { server.close(); await fake.close(); await rm(dir, { recursive: true, force: true }); };
  return { fake, cli, keys, flaky, dir, spool, close };
}

for (const via of ['api', 's3']) {
  test(`event (${via}): a file under events/<today>/ with the contract's fields; a bad kind exits 1`, async () => {
    const { fake, cli, keys, close } = await setup();
    try {
      const done = await cli(via, 'event', 'deployed', '--title', 'Deployed it', '--project', 'probe', '--url', 'https://example.test/x', '--summary', 'ok', '--source', 'gamedev-deploy');
      assert.equal(done.code, 0, done.stderr);
      const [key] = keys(`events/${today()}/`);
      assert.match(key, new RegExp(`sections/inbox/events/${today()}/\\d{6}-[a-z0-9-]+-[0-9a-f]{6}\\.json$`));
      assert.equal(done.stdout.trim(), key.replace('sections/inbox/', ''));
      const event = fake.json(key);
      assert.deepEqual(Object.keys(event).sort(), ['host', 'kind', 'project', 'source', 'summary', 'title', 'ts', 'url']);
      assert.equal(event.kind, 'deployed');
      assert.equal(event.source, 'gamedev-deploy');
      assert.match(event.host, /^[a-z0-9-]+$/);
      assert.equal((await cli(via, 'event', 'nonsense', '--title', 'x')).code, 1);
      assert.equal(keys('events/').length, 1);
    } finally { await close(); }
  });

  test(`event (${via}): review-done carries the file of the review it clears`, async () => {
    const { fake, cli, keys, close } = await setup();
    try {
      const done = await cli(via, 'event', 'review-done', '--title', 'Done: x', '--review', '120000-pc-000001.json');
      assert.equal(done.code, 0, done.stderr);
      const [key] = keys(`events/${today()}/`);
      const event = fake.json(key);
      assert.equal(event.kind, 'review-done');
      assert.equal(event.review, '120000-pc-000001.json');
    } finally { await close(); }
  });

  test(`event (${via}): resumed is a kind`, async () => {
    const { fake, cli, keys, close } = await setup();
    try {
      const resumed = await cli(via, 'event', 'resumed', '--title', 'probe: back at work');
      assert.equal(resumed.code, 0, resumed.stderr);
      const [key] = keys(`events/${today()}/`);
      assert.equal(fake.json(key).kind, 'resumed');
    } finally { await close(); }
  });

  test(`ask (${via}): create, list, answer by hand, list --answered, pickup, second pickup exits 3`, async () => {
    const { fake, cli, keys, dir, close } = await setup();
    try {
      await writeFile(path.join(dir, 'ask.json'), JSON.stringify({ question: 'Rotate the API token now or next week?', context: 'Some **context**.', options: [{ id: 'now', label: 'Now' }, { id: 'later', label: 'Later', image: 'later.png' }] }));
      await writeFile(path.join(dir, 'later.png'), Buffer.from([137, 80, 78, 71]));
      const bad = await cli(via, 'ask', 'create', '--project', 'probe', '--file', path.join(dir, 'ask.json'));
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /later\.png/, 'An option names a picture that was not given.');

      const created = await cli(via, 'ask', 'create', '--project', 'probe', '--bead', 'bd-7', '--file', path.join(dir, 'ask.json'), '--image', path.join(dir, 'later.png'));
      assert.equal(created.code, 0, created.stderr);
      const id = created.stdout.trim().split('\n').at(-1);
      assert.match(id, /^\d{8}-probe-rotate-the-api-now-or-[0-9a-f]{4}$/, 'The slug drops the word the file-name filter refuses.');
      const ask = fake.json(`sections/inbox/asks/${id}/ask.json`);
      assert.equal(ask.project, 'probe');
      assert.equal(ask.bead, 'bd-7');
      assert.equal(ask.allowNote, true);
      assert.equal(ask.allowDrawing, false);
      assert.equal(ask.from.tool, 'claude-code');
      assert.equal(Date.parse(ask.expiresAt) - Date.parse(ask.createdAt), 7 * 24 * 3600 * 1000);
      assert.ok(fake.objects.has(`sections/inbox/asks/${id}/later.png`));
      const [eventKey] = keys(`events/${today()}/`);
      assert.equal(fake.json(eventKey).kind, 'ask-created');
      assert.equal(fake.json(eventKey).ask, id);

      const listed = await cli(via, 'ask', 'list', '--project', 'probe');
      assert.equal(listed.stdout.trim(), `${id}\topen\tprobe\tRotate the API token now or next week?`);
      assert.equal((await cli(via, 'ask', 'list', '--project', 'probe', '--answered')).stdout.trim(), '');

      fake.seed(`sections/inbox/asks/${id}/answer.json`, JSON.stringify({ at: new Date().toISOString(), by: 'owner', choice: 'later' }), 'application/json');
      assert.match((await cli(via, 'ask', 'list', '--answered')).stdout, new RegExp(`^${id}\\tanswered\\tprobe\\t`));
      const got = await cli(via, 'ask', 'get', id);
      assert.match(got.stdout, /== ask\.json[\s\S]*== answer\.json[\s\S]*"choice": "later"[\s\S]*== other files\nasks\/.*later\.png|later\.png/);

      assert.equal((await cli(via, 'ask', 'pickup', id)).code, 0);
      assert.match((await cli(via, 'ask', 'list', '--project', 'probe')).stdout, /\tpicked up\t/);
      const second = await cli(via, 'ask', 'pickup', id);
      assert.equal(second.code, 3);
      assert.match(second.stderr, /was written already by /);
      assert.equal((await cli(via, 'ask', 'list', '--answered')).stdout.trim(), '', 'No longer waiting.');
      assert.equal((await cli(via, 'ask', 'cancel', id)).code, 0);
      assert.match((await cli(via, 'ask', 'list')).stdout, /\tcancelled\t/, 'Cancelled outranks picked up.');
      assert.equal((await cli(via, 'ask', 'cancel', id)).code, 3);
    } finally { await close(); }
  });

  test(`request (${via}): create, list --open, take, second take exits 3`, async () => {
    const { cli, close } = await setup();
    try {
      const created = await cli(via, 'request', 'create', '--project', 'probe', '--text', 'Add a dark mode to the probe', '--when', 'nightly', '--by', 'hermes');
      assert.equal(created.code, 0, created.stderr);
      const id = created.stdout.trim().split('\n').at(-1);
      assert.match(id, /^\d{8}-probe-add-a-dark-mode-to-[0-9a-f]{4}$/);
      assert.equal((await cli(via, 'request', 'create', '--project', 'probe', '--text', 'x', '--when', 'someday')).code, 1);
      assert.equal((await cli(via, 'request', 'list', '--open', '--project', 'probe')).stdout.trim(), `${id}\topen\tprobe\tAdd a dark mode to the probe`);
      assert.equal((await cli(via, 'request', 'take', id)).code, 1, 'take wants --bead');
      assert.equal((await cli(via, 'request', 'take', id, '--bead', 'bd-9')).code, 0);
      assert.equal((await cli(via, 'request', 'list', '--open')).stdout.trim(), '');
      assert.match((await cli(via, 'request', 'list')).stdout, /\ttaken\t/);
      assert.equal((await cli(via, 'request', 'take', id, '--bead', 'bd-9')).code, 3);
    } finally { await close(); }
  });

  test(`beads push (${via}): both files, with the count`, async () => {
    const { fake, cli, dir, close } = await setup();
    try {
      await writeFile(path.join(dir, 'beads.jsonl'), '{"id":"bd-1"}\n{"id":"bd-2"}\n\n{"id":"bd-3"}\n');
      const pushed = await cli(via, 'beads', 'push', '--project', 'probe', '--from', path.join(dir, 'beads.jsonl'));
      assert.equal(pushed.code, 0, pushed.stderr);
      assert.equal(fake.text('sections/inbox/beads/probe.jsonl'), '{"id":"bd-1"}\n{"id":"bd-2"}\n\n{"id":"bd-3"}\n');
      const meta = fake.json('sections/inbox/beads/probe.meta.json');
      assert.equal(meta.count, 3);
      assert.deepEqual(Object.keys(meta).sort(), ['count', 'host', 'pushedAt', 'repo']);
      assert.equal((await cli(via, 'beads', 'push', '--project', 'probe', '--from', path.join(dir, 'beads.jsonl'))).code, 0, 'A plain put replaces.');
    } finally { await close(); }
  });
}

test('retries: 503 twice then 200 succeeds; always 503 spools the event and exits 0; the next event replays it', async () => {
  const { cli, keys, flaky, spool, close } = await setup();
  try {
    flaky.fail = 2;
    const retried = await cli('api', 'event', 'alert', '--title', 'Retried');
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(flaky.refused, 2);
    assert.equal(keys('events/').length, 1);

    flaky.fail = Infinity;
    const down = await cli('api', 'event', 'alert', '--title', 'While down');
    assert.equal(down.code, 0, 'A spooled event is not a failure.');
    assert.match(down.stdout, /spooled/);
    assert.equal(keys('events/').length, 1);
    const lines = (await readFile(spool, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual([entry.v, entry.kind, entry.section, entry.createOnly, entry.contentType], [1, 'put', 'inbox', true, 'application/json']);
    assert.match(entry.path, /^events\//);
    assert.equal(JSON.parse(entry.body).title, 'While down');
    assert.ok(!/Bearer|tok-all|https?:/.test(lines[0].replace(/"url"[^,]*/, '')), 'No token or address in the spool.');

    flaky.fail = 0;
    assert.equal((await cli('api', 'event', 'alert', '--title', 'Healthy')).code, 0);
    assert.equal(keys('events/').length, 3, 'The spooled event arrived beside the new one.');
    assert.equal((await readFile(spool, 'utf8')).trim(), '', 'And left the spool.');
  } finally { await close(); }
});

test('a failed ask is an error and is not spooled', async () => {
  const { cli, flaky, spool, dir, close } = await setup();
  try {
    await writeFile(path.join(dir, 'ask.json'), JSON.stringify({ question: 'Go?' }));
    flaky.fail = Infinity;
    const failed = await cli('api', 'ask', 'create', '--project', 'probe', '--file', path.join(dir, 'ask.json'));
    assert.equal(failed.code, 1);
    await assert.rejects(readFile(spool, 'utf8'), /ENOENT/);
  } finally { await close(); }
});

test('replay: an entry already there (412) is dropped, one over 24 hours old is dropped, other kinds stay', async () => {
  const { fake, cli, keys, spool, close } = await setup();
  try {
    const line = (at, name, extra = {}) => JSON.stringify({ v: 1, at, kind: 'put', section: 'inbox', path: `events/2026-01-01/${name}.json`, body: `{"title":"${name}"}`, contentType: 'application/json', createOnly: true, ...extra });
    fake.seed('sections/inbox/events/2026-01-01/there.json', '{"title":"first"}', 'application/json');
    const discord = JSON.stringify({ v: 1, at: new Date().toISOString(), kind: 'discord', target: 'needsYou', body: '{}' });
    await writeFile(spool, [
      line(new Date(Date.now() - 25 * 3600 * 1000).toISOString(), 'stale'),
      line(new Date().toISOString(), 'there'),
      line(new Date().toISOString(), 'fresh'),
      discord,
    ].join('\n') + '\n');
    assert.equal((await cli('api', 'ask', 'list')).code, 0, 'Any inbox command replays.');
    assert.equal(fake.text('sections/inbox/events/2026-01-01/stale.json'), null, 'Too old: never sent.');
    assert.equal(fake.text('sections/inbox/events/2026-01-01/there.json'), '{"title":"first"}', 'Create-only: not replaced.');
    assert.equal(fake.text('sections/inbox/events/2026-01-01/fresh.json'), '{"title":"fresh"}');
    assert.equal((await readFile(spool, 'utf8')).trim(), discord, 'Only the hooks\' line is left.');
    assert.equal(keys('events/2026-01-01/').length, 2);
  } finally { await close(); }
});

test('replay: a refusal (403 for a read-only token) keeps the line; an unreadable time expires it', async () => {
  const { fake, cli, spool, close } = await setup();
  try {
    const line = (at, name) => JSON.stringify({ v: 1, at, kind: 'put', section: 'inbox', path: `events/2026-01-01/${name}.json`, body: `{"title":"${name}"}`, contentType: 'application/json', createOnly: true });
    const kept = line(new Date().toISOString(), 'kept');
    await writeFile(spool, [kept, line('not a date', 'garbled'), line(undefined, 'missing')].join(String.fromCharCode(10)) + String.fromCharCode(10));
    cli.env = { BUW_CARDS_PASSWORD: 'tok-ro' };
    assert.equal((await cli('api', 'ask', 'list')).code, 0);
    assert.equal((await readFile(spool, 'utf8')).trim(), kept, 'The 403 did not delete it; the bad time did.');
    assert.equal(fake.text('sections/inbox/events/2026-01-01/kept.json'), null);
    cli.env = {};
    assert.equal((await cli('api', 'ask', 'list')).code, 0);
    assert.equal(fake.text('sections/inbox/events/2026-01-01/kept.json'), '{"title":"kept"}', 'With a token that can write, it goes.');
    assert.equal((await readFile(spool, 'utf8')).trim(), '');
  } finally { await close(); }
});

test('a create-only write whose answer was lost is not "someone else": claim and ask create succeed once', async () => {
  const { cli, keys, flaky, dir, close } = await setup();
  try {
    flaky.lose = 1;
    const pickup = await cli('api', 'ask', 'pickup', 'a-1');
    assert.equal(pickup.code, 0, pickup.stderr);
    assert.equal(flaky.lose, 0);
    assert.equal(keys('asks/a-1/').length, 1);
    const second = await cli('api', 'ask', 'pickup', 'a-1');
    assert.equal(second.code, 3, 'A real second claim still loses.');

    await writeFile(path.join(dir, 'ask.json'), JSON.stringify({ question: 'Go?' }));
    flaky.lose = 1;
    const made = await cli('api', 'ask', 'create', '--project', 'probe', '--file', path.join(dir, 'ask.json'));
    assert.equal(made.code, 0, made.stderr);
    assert.equal(keys('asks/').filter(key => key.endsWith('/ask.json')).length, 1, 'One ask, not two.');
  } finally { await close(); }
});

/** A stand-in webhook: records every POST it gets. */
async function webhook({ status = 204 } = {}) {
  const posts = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    posts.push({ method: request.method, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(status);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { posts, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('ask create pings #needs-you with a link to the Ask, from the environment', async () => {
  const { cli, dir, close } = await setup();
  const hook = await webhook();
  try {
    await writeFile(path.join(dir, 'ask.json'), JSON.stringify({ question: 'Which jump arc feels right?' }));
    cli.env = { BUW_DISCORD_NEEDS_YOU: hook.url, BUW_SITE_URL: 'https://hub.example.test/' };
    const made = await cli('api', 'ask', 'create', '--project', 'magic-loops', '--file', path.join(dir, 'ask.json'));
    assert.equal(made.code, 0, made.stderr);
    const id = made.stdout.trim().split('\n').at(-1);
    assert.equal(hook.posts.length, 1);
    assert.deepEqual(hook.posts[0].body.allowed_mentions, { parse: [] });
    assert.equal(hook.posts[0].body.content, `**Agent needs you · Magic Loops**\nWhich jump arc feels right?\nhttps://hub.example.test/#/~hub/ask/${id}`);
    assert.ok(!made.stdout.includes(hook.url) && !made.stderr.includes(hook.url), 'The address is never printed.');
  } finally { await hook.close(); await close(); }
});

test('the webhook and the site address can come from ~/.buw/hub.json or a secrets file', async () => {
  const { cli, dir, close } = await setup();
  const hook = await webhook();
  try {
    await mkdir(path.join(dir, '.buw', 'secrets'), { recursive: true });
    await writeFile(path.join(dir, 'ask.json'), JSON.stringify({ question: 'From the file?' }));
    await writeFile(path.join(dir, '.buw', 'hub.json'), JSON.stringify({ discord: { needsYou: hook.url }, siteUrl: 'https://file.example.test' }));
    cli.env = { BUW_DISCORD_NEEDS_YOU: '', BUW_SITE_URL: 'https://ignored.example.test' };
    assert.equal((await cli('api', 'ask', 'create', '--project', 'probe', '--file', path.join(dir, 'ask.json'))).code, 0);
    assert.match(hook.posts[0].body.content, /https:\/\/file\.example\.test\/#\/~hub\/ask\//, 'hub.json wins over BUW_SITE_URL.');
    await rm(path.join(dir, '.buw', 'hub.json'));
    cli.env = { BUW_DISCORD_NEEDS_YOU: '', BUW_SITE_URL: '' };
    await writeFile(path.join(dir, '.buw', 'secrets', 'discord-webhook-needs-you'), `${hook.url}\n`);
    assert.equal((await cli('api', 'ask', 'create', '--project', 'probe', '--file', path.join(dir, 'ask.json'))).code, 0);
    assert.equal(hook.posts.length, 2);
    assert.doesNotMatch(hook.posts[1].body.content, /https?:/, 'No site address, no link.');
  } finally { await hook.close(); await close(); }
});

test('a webhook that is down leaves exit 0 and one spooled discord line without the address', async () => {
  const { cli, dir, spool, close } = await setup();
  const hook = await webhook();
  const dead = hook.url;
  await hook.close();
  try {
    await writeFile(path.join(dir, 'ask.json'), JSON.stringify({ question: 'Anyone there?' }));
    cli.env = { BUW_DISCORD_NEEDS_YOU: dead, BUW_SITE_URL: 'https://hub.example.test' };
    const made = await cli('api', 'ask', 'create', '--project', 'probe', '--file', path.join(dir, 'ask.json'));
    assert.equal(made.code, 0, made.stderr);
    const lines = (await readFile(spool, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(line => line.kind === 'discord');
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].v, lines[0].target], [1, 'needsYou']);
    assert.match(JSON.parse(lines[0].body).content, /Anyone there\?/);
    assert.ok(!JSON.stringify(lines[0]).includes('127.0.0.1'), 'The address is not stored.');
    assert.ok(!made.stderr.includes(dead), made.stderr);
  } finally { await close(); }
});

test('without a webhook nothing is posted and nothing is spooled', async () => {
  const { cli, dir, spool, close } = await setup();
  const hook = await webhook();
  try {
    await writeFile(path.join(dir, 'ask.json'), JSON.stringify({ question: 'Quiet?' }));
    cli.env = { BUW_DISCORD_NEEDS_YOU: '' };
    assert.equal((await cli('api', 'ask', 'create', '--project', 'probe', '--file', path.join(dir, 'ask.json'))).code, 0);
    assert.equal(hook.posts.length, 0);
    await assert.rejects(readFile(spool, 'utf8'), /ENOENT/);
  } finally { await hook.close(); await close(); }
});
