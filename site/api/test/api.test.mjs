// The site's data service against a stand-in S3: no network, no bucket, no key of anyone's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSiteApi, slugify } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

/** A request with a Host of our choosing (fetch will not send one): the status and the headers. */
const asHost = (origin, host, route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const request = http.request(`${origin}${route}`, { method, headers: { ...headers, Host: host } }, response => {
    response.resume();
    response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(Object.entries(response.headers).map(([k, v]) => [k, String(v)])) }));
  });
  request.on('error', reject);
  request.end(body);
});

const card = (id, extra = {}) => ({
  id, folder: id, title: id, description: 'A card.', category: 'test',
  created: '2026-01-01', updated: '2026-01-01', status: 'active',
  steps: [{ name: 'Page', path: 'index.html' }], ...extra,
});

/** A bucket like the real one — sections/<id>/workspace.json plus card files — and the service over it. */
async function fixture({ template = true, bucket: withBucket = true, requireRemoteUser = false, siteUrl, cardApi, contentOrigin, dev, stateKey, deployedRef } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-site-api-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });

  const publish = ({ id, name, entities }) => {
    fake.seed(`sections/${id}/workspace.json`, `${JSON.stringify({ ...(name ? { name } : {}), entities }, null, 2)}\n`, 'application/json');
    for (const entity of entities) fake.seed(`sections/${id}/${entity.folder}/index.html`, `<h1>${entity.id}</h1>`, 'text/html; charset=utf-8');
  };
  publish({ id: 'one', name: 'Section One', entities: [card('alpha'), card('gamma')] });
  publish({ id: 'two', entities: [card('beta', { pinned: true, pinOrder: 0 })] });
  fake.seed('sections/one/_shared/report.css', 'body{}', 'text/css');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');

  const templateDir = path.join(root, 'template');
  if (template) {
    await mkdir(path.join(templateDir, '_shared'), { recursive: true });
    await writeFile(path.join(templateDir, '_config.yml'), 'title: Workspace\n');
    await writeFile(path.join(templateDir, '_shared', 'report.css'), 'body{}\n');
    await writeFile(path.join(templateDir, 'workspace.json'), '{"entities":[]}');  // ignored: generated
    await mkdir(path.join(templateDir, 'sample-markdown'), { recursive: true });
    await writeFile(path.join(templateDir, 'sample-markdown', 'index.md'), '# Sample\n');      // ignored: a sample card
  }

  const server = createSiteApi({ bucket: withBucket ? bucket : null, templateDir, stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser, siteUrl, cardApi, contentOrigin, dev, stateKey, deployedRef, ...(requireRemoteUser ? { allowedOrigins: ['https://site.example'] } : {}) });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, data, method, headers = {}) => fetch(`${origin}/api${route}`, {
    method: method ?? (data === undefined ? 'GET' : 'POST'),
    headers: { ...(requireRemoteUser && (method ?? (data === undefined ? 'GET' : 'POST')) !== 'GET' ? { Origin: 'https://site.example' } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const raw = (route, init) => fetch(`${origin}${route}`, init);
  const entity = (id, cardId) => fake.json(`sections/${id}/workspace.json`).entities.find(item => item.id === cardId);
  /** What the state object holds for one card — the overlay the page applies over the published list. */
  const stateOf = (id, cardId) => fake.json('state.json')?.cards[`${id}/${cardId}`] ?? null;
  const close = async () => { server.close(); await fake.close(); };
  return { server, origin, request, raw, fake, bucket, entity, stateOf, close };
}

test('a name becomes the id the address uses', () => {
  assert.equal(slugify('Pixel Scenery'), 'pixel-scenery');
  assert.equal(slugify('  Magic  Loops!! '), 'magic-loops');
  assert.equal(slugify('???'), '');
});

test('sites.json lists every section in the bucket, named by its card list', async () => {
  const { raw, close } = await fixture();
  try {
    const list = await (await raw('/sites.json')).json();
    assert.deepEqual(list.map(site => [site.id, site.name, site.base]).sort(), [
      ['one', 'Section One', '/w/one'],
      ['two', 'Two', '/w/two'],
    ]);
    assert.ok(list.every(site => site.publishedAt), 'When each card list was last uploaded.');
  } finally { await close(); }
});

test('a section file is streamed from the bucket with its type and ETag', async () => {
  const { raw, fake, close } = await fixture();
  try {
    const page = await raw('/w/one/alpha/index.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await page.text(), '<h1>alpha</h1>');
    const etag = page.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    const again = await raw('/w/one/alpha/index.html', { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304, 'A browser that has it is told so.');
    const head = await raw('/w/one/_shared/report.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/css');
    assert.equal(await head.text(), '');
    const list = await (await raw('/w/one/workspace.json')).json();
    assert.equal(list.entities.length, 2);
    assert.equal((await raw('/w/one/nope.html')).status, 404);
    assert.equal((await raw('/w/nope/index.html')).status, 404);
    assert.equal((await raw('/w/one/../state.json')).status, 404, 'Nothing outside the section is reachable.');
    assert.equal((await raw('/w/one/%2e%2e/state.json')).status, 404);
    assert.ok(!fake.log.some(entry => entry.key === 'state.json' && entry.method === 'GET' && entry.headers['if-none-match']), 'The state object was never served as a file.');
  } finally { await close(); }
});

test('capabilities say what the site can do', async () => {
  const { request, close } = await fixture();
  try {
    const answer = await (await request('/capabilities')).json();
    assert.equal(answer.write, true);
    assert.equal(answer.create, true);
    assert.equal(answer.store, 'bucket');
    assert.deepEqual(answer.sections.sort(), ['one', 'two']);
  } finally { await close(); }
});

test('capabilities report contentOrigin only when one is set', async () => {
  const unset = await fixture();
  try { assert.equal((await (await unset.request('/capabilities')).json()).contentOrigin, null); } finally { await unset.close(); }
  const set = await fixture({ contentOrigin: 'https://cards.example.localhost/ignored/path' });
  try { assert.equal((await (await set.request('/capabilities')).json()).contentOrigin, 'https://cards.example.localhost/ignored/path'); } finally { await set.close(); }
});

test('with a content origin, its host serves card files with the sandbox CSP and nothing else', async () => {
  const { origin, raw, close } = await fixture({ contentOrigin: 'http://cards.example.localhost' });
  const onContent = (route, init) => asHost(origin, 'cards.example.localhost', route, init);
  const csp = 'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-same-origin';
  try {
    const page = await onContent('/w/one/alpha/index.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), csp);
    assert.equal((await onContent('/w/one/_shared/report.css')).headers.get('content-security-policy'), csp, 'Every /w/ response carries it, not only HTML.');
    for (const route of ['/api/capabilities', '/api/card-state', '/sites.json', '/api/hub/asks', '/']) {
      assert.equal((await onContent(route)).status, 404, `${route} is not served on the content host.`);
    }
    assert.equal((await onContent('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, 'No write reaches the API from the content host.');
    const app = await raw('/w/one/alpha/index.html');
    assert.equal(app.status, 200);
    assert.equal(app.headers.get('content-security-policy'), "frame-ancestors 'self'", 'The app host serves /w/ but only the app itself may frame it.');
    assert.equal((await raw('/api/capabilities')).status, 200);
  } finally { await close(); }
});

test('without a content origin, /w/ has no CSP and no host is special', async () => {
  const { origin, close } = await fixture();
  try {
    const page = await asHost(origin, 'cards.example.localhost', '/w/one/alpha/index.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), null);
  } finally { await close(); }
});

test('without a bucket the site is read-only and says why', async () => {
  const { request, raw, close } = await fixture({ bucket: false });
  try {
    const answer = await (await request('/capabilities')).json();
    assert.equal(answer.write, false);
    assert.equal(answer.create, false);
    assert.match(answer.reason, /no cards bucket/);
    assert.deepEqual(await (await raw('/sites.json')).json(), []);
    assert.equal((await raw('/w/one/alpha/index.html')).status, 503);
    assert.equal((await request('/workspace/status', { workspace: 'one', id: 'alpha', status: 'archived' })).status, 503);
  } finally { await close(); }
});

test('archiving writes the state object and uploads no card file', async () => {
  const { request, fake, entity, stateOf, close } = await fixture();
  try {
    const before = fake.log.length;
    const answer = await (await request('/workspace/status', { workspace: 'one', id: 'alpha', status: 'archived' })).json();
    assert.equal(answer.status, 'archived');
    assert.equal(stateOf('one', 'alpha').status, 'archived');
    // The card's own files are the publish's business and nothing here touched them.
    assert.equal(entity('one', 'alpha').status, 'active', 'workspace.json is left exactly as published.');
    const puts = fake.log.slice(before).filter(entry => entry.method === 'PUT');
    assert.deepEqual(puts.map(entry => entry.key), ['state.json'], 'Metadata is one object.');
    assert.ok(puts[0].headers['if-match'], 'Written against the ETag it read, so a phone and a desktop never overwrite each other.');
    // Restoring counts as a touch, or the date rule would archive it again at once.
    const back = await (await request('/workspace/status', { workspace: 'one', id: 'alpha', status: 'active' })).json();
    assert.equal(back.updated, new Date().toISOString().slice(0, 10));
    assert.equal(stateOf('one', 'alpha').status, 'active');
  } finally { await close(); }
});

test('a write that lost a race is retried from a fresh read', async () => {
  const { request, bucket, stateOf, close } = await fixture();
  try {
    // Someone else (the local app) writes between this service's read and its put: the first put is
    // refused with 412 and the change is reapplied over what they wrote.
    const original = bucket.putJson.bind(bucket);
    let raced = false;
    bucket.putJson = async (key, value, options) => {
      if (!raced) {
        raced = true;
        const current = await bucket.getJson(key);
        await original(key, { version: 1, cards: { ...current.value.cards, 'two/beta': { tags: ['phone'] } } }, { ifMatch: current.etag });
      }
      return original(key, value, options);
    };
    assert.equal((await request('/workspace/pin', { workspace: 'one', id: 'gamma', pinned: true, order: 1 })).status, 200);
    assert.deepEqual(stateOf('one', 'gamma'), { pinned: true, pinOrder: 1 });
    assert.deepEqual(stateOf('two', 'beta'), { tags: ['phone'] }, 'The other write survived.');
  } finally { await close(); }
});

test('a card the section never published cannot be put in the state object', async () => {
  const { request, close } = await fixture();
  try {
    assert.equal((await request('/workspace/status', { workspace: 'one', id: 'beta', status: 'archived' })).status, 404);
    assert.equal((await request('/workspace/pin', { workspace: 'nope', id: 'alpha', pinned: true })).status, 404);
  } finally { await close(); }
});

test('pinning and unpinning write only the pin fields', async () => {
  const { request, entity, stateOf, close } = await fixture();
  try {
    await request('/workspace/pin', { workspace: 'one', id: 'gamma', pinned: true, order: 3 });
    assert.deepEqual(stateOf('one', 'gamma'), { pinned: true, pinOrder: 3 });
    assert.equal(entity('one', 'gamma').status, 'active', 'Pinning is not a status change.');
    await request('/workspace/pin', { workspace: 'one', id: 'gamma', pinned: false });
    assert.deepEqual(stateOf('one', 'gamma'), { pinned: false }, 'Unpinned is stored, because the published card says pinned.');
  } finally { await close(); }
});

test('a card icon is one emoji in the state, and an empty one clears it', async () => {
  const { request, stateOf, close } = await fixture();
  try {
    const answer = await (await request('/workspace/icon', { workspace: 'one', id: 'alpha', emoji: '🚀' })).json();
    assert.equal(answer.emoji, '🚀');
    assert.deepEqual(stateOf('one', 'alpha'), { emoji: '🚀' });
    await request('/workspace/icon', { workspace: 'one', id: 'alpha', emoji: '' });
    assert.equal(stateOf('one', 'alpha'), null);
    assert.equal((await request('/workspace/icon', { workspace: 'one', id: 'alpha', emoji: '<img src=x>' })).status, 400);
    assert.equal((await request('/workspace/icon', { workspace: 'one', id: 'alpha', emoji: 'a much too long icon name' })).status, 400);
  } finally { await close(); }
});

test('tags are a list on the card, and an empty list clears them', async () => {
  const { request, stateOf, close } = await fixture();
  try {
    const answer = await (await request('/workspace/tags', { workspace: 'one', id: 'alpha', tags: ['idea', ' idea ', 'later'] })).json();
    assert.deepEqual(answer.tags, ['idea', 'later']);
    assert.deepEqual(stateOf('one', 'alpha'), { tags: ['idea', 'later'] });
    const state = await (await request('/card-state')).json();
    assert.deepEqual(state.cards['one/alpha'].tags, ['idea', 'later']);
    await request('/workspace/tags', { workspace: 'one', id: 'alpha', tags: [] });
    assert.equal(stateOf('one', 'alpha'), null);
    assert.equal((await request('/workspace/tags', { workspace: 'one', id: 'alpha', tags: 'idea' })).status, 400);
  } finally { await close(); }
});

test('a reorder across two sections keeps the order the page sent', async () => {
  const { request, stateOf, close } = await fixture();
  try {
    const answer = await (await request('/workspace/pins', {
      list: [{ id: 'beta', workspace: 'two' }, { id: 'alpha', workspace: 'one' }],
    })).json();
    assert.deepEqual(answer.pins, [
      { id: 'beta', workspace: 'two', pinOrder: 0 },
      { id: 'alpha', workspace: 'one', pinOrder: 1 },
    ]);
    assert.deepEqual(stateOf('two', 'beta'), { pinned: true, pinOrder: 0 });
    assert.deepEqual(stateOf('one', 'alpha'), { pinned: true, pinOrder: 1 });
    const state = await (await request('/card-state')).json();
    assert.equal(state.cards['one/alpha'].pinOrder, 1, 'The page reads the whole overlay in one call.');
  } finally { await close(); }
});

test('a new section is the template and an empty card list with its name, on the site at once', async () => {
  const { request, raw, fake, close } = await fixture();
  try {
    const answer = await (await request('/sections', { name: 'Pixel Scenery' })).json();
    assert.equal(answer.id, 'pixel-scenery');
    assert.equal(answer.path, 'sections/pixel-scenery');
    assert.deepEqual(fake.json('sections/pixel-scenery/workspace.json'), { name: 'Pixel Scenery', entities: [] });
    assert.equal(fake.text('sections/pixel-scenery/_config.yml'), 'title: Workspace\n');
    assert.equal(fake.text('sections/pixel-scenery/_shared/report.css'), 'body{}\n', 'Report styles come with it.');
    assert.equal(fake.text('sections/pixel-scenery/sample-markdown/index.md'), null, 'The template\'s sample cards do not.');
    const list = await (await raw('/sites.json')).json();
    assert.ok(list.some(site => site.id === 'pixel-scenery' && site.name === 'Pixel Scenery'), 'No publish to wait for.');
  } finally { await close(); }
});

test('a hidden section is listed with hidden: true, a normal one carries no such key, and a new one holds only its card list', async () => {
  const { request, raw, fake, close } = await fixture();
  try {
    fake.seed('sections/hid/workspace.json', '{"name":"Hid","hidden":true,"entities":[]}\n', 'application/json');
    const list = await (await raw('/sites.json')).json();
    assert.equal(list.find(site => site.id === 'hid').hidden, true);
    assert.ok(!('hidden' in list.find(site => site.id === 'one')));
    const answer = await request('/sections', { name: 'Field Data', hidden: true });
    assert.equal(answer.status, 201);
    assert.equal((await answer.json()).files, 1, 'Exactly one object.');
    assert.deepEqual(fake.json('sections/field-data/workspace.json'), { name: 'Field Data', hidden: true, entities: [] });
    assert.equal(fake.text('sections/field-data/_config.yml'), null, 'No template files.');
    assert.equal(fake.text('sections/field-data/_shared/report.css'), null);
    assert.equal((await raw('/w/field-data/workspace.json')).status, 200, 'Still served.');
  } finally { await close(); }
});

test('a section is refused when the name is taken, reserved or empty', async () => {
  const { request, close } = await fixture();
  try {
    assert.equal((await request('/sections', { name: '  ' })).status, 400);
    assert.equal((await request('/sections', { name: '???' })).status, 400);
    assert.equal((await request('/sections', { name: 'template' })).status, 400);
    assert.equal((await request('/sections', { name: 'State' })).status, 400);
    assert.equal((await request('/sections', { name: 'Inbox' })).status, 400, 'The Hub owns this one.');
    assert.equal((await request('/sections', { name: 'Today' })).status, 400);
    assert.equal((await request('/sections', { name: 'One' })).status, 409);
  } finally { await close(); }
});

test('without a template the site says so rather than making half a section', async () => {
  const { request, close } = await fixture({ template: false });
  try {
    assert.equal((await (await request('/capabilities')).json()).create, false);
    assert.equal((await request('/sections', { name: 'Pixel Scenery' })).status, 503);
  } finally { await close(); }
});

test('bad input and unknown names are refused, not guessed at', async () => {
  const { request, close } = await fixture();
  try {
    assert.equal((await request('/workspace/status', { workspace: 'one', id: 'alpha', status: 'deleted' })).status, 400);
    assert.equal((await request('/workspace/status', { workspace: 'nope', id: 'alpha', status: 'archived' })).status, 404);
    assert.equal((await request('/workspace/status', { workspace: 'one', id: 'missing', status: 'archived' })).status, 404);
    assert.equal((await request('/workspace/pin', { workspace: 'one', id: 'alpha' })).status, 400);
    assert.equal((await request('/workspace/pin', { workspace: 'one', id: 'alpha', pinned: true, order: -1 })).status, 400);
    assert.equal((await request('/workspace/pins', { workspace: 'one', list: [] })).status, 400);
    assert.equal((await request('/nothing-here', {})).status, 404);
  } finally { await close(); }
});

test('a bucket in another region than the CLI default is found from the redirect S3 answers', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('.s3.us-west-2.')) {
      return new Response('<Error><Code>PermanentRedirect</Code></Error>', { status: 301, headers: { 'x-amz-bucket-region': 'us-east-1' } });
    }
    assert.match(init.headers.Authorization, /\/us-east-1\/s3\/aws4_request/, 'Re-signed for the region that answered.');
    return new Response('{"version":1,"cards":{}}', { status: 200, headers: { ETag: '"abc"', 'Content-Type': 'application/json' } });
  };
  const bucket = createBucket({ bucket: 'cards', region: 'us-west-2', credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, fetchImpl });
  assert.deepEqual((await bucket.getJson('state.json')).value, { version: 1, cards: {} });
  assert.equal(calls.length, 2);
  await bucket.getJson('state.json');
  assert.equal(calls.length, 3, 'The right region is remembered.');
  assert.match(calls[2], /\.s3\.us-east-1\./);
});

test('cards are made, given sections and edited on the site, straight into the bucket', async () => {
  const { request, fake, entity, close } = await fixture();
  try {
    const capabilities = await (await request('/capabilities')).json();
    assert.equal(capabilities.cards, true);

    const made = await request('/cards', { workspace: 'one', title: 'Phone notes', description: 'Written on the bus.' });
    assert.equal(made.status, 201);
    const { card } = await made.json();
    assert.equal(card.id, 'phone-notes');
    assert.match(fake.text(`sections/one/${card.folder}/index.md`), /^# Phone notes/);
    assert.ok(entity('one', 'phone-notes'), 'The card is in the section\'s card list.');
    assert.ok(entity('one', 'alpha'), 'The cards already there stay.');

    const section = await (await request('/cards/section', { workspace: 'one', id: card.id, name: 'Todo' })).json();
    assert.equal(section.path, 'todo.md');
    assert.deepEqual(entity('one', 'phone-notes').steps.map(step => step.path), ['index.md', 'todo.md']);

    const opened = await (await request(`/cards/markdown?workspace=one&id=${card.id}&path=todo.md`)).json();
    assert.equal(opened.text, '# Todo\n\n');
    const saved = await request('/cards/markdown', { workspace: 'one', id: card.id, path: 'todo.md', text: '# Todo\n\n- [ ] boss\n', base: opened.etag });
    assert.equal(saved.status, 200);
    assert.equal(fake.text(`sections/one/${card.folder}/todo.md`), '# Todo\n\n- [ ] boss\n');

    const stale = await request('/cards/markdown', { workspace: 'one', id: card.id, path: 'todo.md', text: 'older', base: opened.etag });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).current.text, '# Todo\n\n- [ ] boss\n', 'A refused save says what is there now.');

    assert.equal((await request('/cards', { workspace: 'nowhere', title: 'x' })).status, 404);
    assert.equal((await request('/cards/markdown', { workspace: 'one', id: 'alpha', path: 'index.html', text: 'x', base: null })).status, 400, 'Only Markdown sections are edited here.');
  } finally { await close(); }
});

test('with Remote-User required, a write without it is refused and changes nothing', async () => {
  const { request, stateOf, close } = await fixture({ requireRemoteUser: true });
  try {
    const refused = await request('/workspace/pin', { workspace: 'one', id: 'alpha', pinned: true });
    assert.equal(refused.status, 401);
    assert.match((await refused.json()).error, /Remote-User/);
    assert.equal(stateOf('one', 'alpha'), null);
  } finally { await close(); }
});

test('with Remote-User required, a write that carries it goes through', async () => {
  const { request, stateOf, close } = await fixture({ requireRemoteUser: true });
  try {
    const done = await request('/workspace/pin', { workspace: 'one', id: 'alpha', pinned: true }, undefined, { 'Remote-User': 'owner' });
    assert.equal(done.status, 200);
    assert.equal(stateOf('one', 'alpha')?.pinned, true);
  } finally { await close(); }
});

test('with Remote-User required, reads stay open', async () => {
  const { request, raw, close } = await fixture({ requireRemoteUser: true });
  try {
    assert.equal((await request('/card-state')).status, 200);
    assert.equal((await raw('/sites.json')).status, 200);
  } finally { await close(); }
});

test('with Remote-User required, capabilities say read-only until a user is named', async () => {
  const { request, close } = await fixture({ requireRemoteUser: true, siteUrl: 'https://workspaces.example.net', cardApi: 'https://api.workspaces.example.net' });
  try {
    const anonymous = await (await request('/capabilities')).json();
    assert.equal(anonymous.write, false);
    assert.equal(anonymous.create, false);
    assert.equal(anonymous.cards, false);
    assert.equal(anonymous.reason, 'Read-only here: sign in at https://workspaces.example.net to change cards.');
    assert.equal(anonymous.cardApi, 'https://api.workspaces.example.net');
    const signedIn = await (await request('/capabilities', undefined, undefined, { 'Remote-User': 'owner' })).json();
    assert.equal(signedIn.write, true);
    assert.equal(signedIn.reason, undefined);
    assert.equal(signedIn.cardApi, 'https://api.workspaces.example.net');
  } finally { await close(); }
});

test('with no site address or card API set, the reason names no address and cardApi is null', async () => {
  const { request, close } = await fixture({ requireRemoteUser: true });
  try {
    const anonymous = await (await request('/capabilities')).json();
    assert.equal(anonymous.reason, 'Read-only here: sign in to change cards.');
    assert.equal(anonymous.cardApi, null);
  } finally { await close(); }
});

const devOnly = { writable: id => id.startsWith('dev-') };

test('the development copy writes only dev- sections, reports its branch, and keeps its own state object', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-dev-ref-'));
  const deployedRef = path.join(root, '.deployed-ref');
  const first = await fixture({ dev: devOnly, stateKey: 'dev-state.json', deployedRef });
  try {
    // Before any deploy there is no branch to name.
    assert.deepEqual((await (await first.request('/capabilities')).json()).dev, { branch: null });
  } finally { await first.close(); }

  await writeFile(deployedRef, JSON.stringify({ branch: 'sprint/ws-1-x', sha: 'abc1234def', pr: 7, at: '2026-10-28T10:00:00Z' }));
  const second = await fixture({ dev: devOnly, stateKey: 'dev-state.json', deployedRef });
  try {
    const caps = await (await second.request('/capabilities')).json();
    assert.deepEqual(caps.dev, { branch: 'sprint/ws-1-x', sha: 'abc1234def', pr: 7, at: '2026-10-28T10:00:00Z' });

    // The real sections are refused, whatever the route.
    const refused = await second.request('/workspace/pin', { workspace: 'one', id: 'alpha', pinned: true });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /writes only dev-/);
    assert.equal((await second.request('/workspace/status', { workspace: 'one', id: 'alpha', status: 'archived' })).status, 403);
    assert.equal((await second.request('/workspace/pins', { list: [{ workspace: 'one', id: 'alpha' }] })).status, 403);
    assert.equal((await second.request('/cards', { workspace: 'one', title: 'X' })).status, 403);
    assert.equal((await second.request('/sections', { name: 'Not dev' })).status, 403);
    assert.equal(second.stateOf('one', 'alpha'), null);

    // A dev- section works, and its pin goes to dev-state.json, not state.json.
    second.fake.seed('sections/dev-sandbox/workspace.json', `${JSON.stringify({ entities: [card('probe')] })}\n`, 'application/json');
    second.fake.seed('sections/dev-sandbox/probe/index.html', '<h1>probe</h1>', 'text/html');
    const ok = await second.request('/workspace/pin', { workspace: 'dev-sandbox', id: 'probe', pinned: true });
    assert.equal(ok.status, 200, JSON.stringify(await ok.json().catch(() => null)));
    assert.equal(second.fake.json('dev-state.json').cards['dev-sandbox/probe'].pinned, true);
    assert.equal(second.fake.json('state.json').cards['dev-sandbox/probe'], undefined, 'state.json is untouched.');
    assert.equal((await second.request('/sections', { name: 'dev-newone' })).status, 201);

    // Pins name their own sections (the app sends no top-level workspace): all dev- passes, a mixed list is refused.
    second.fake.seed('sections/dev-sandbox/workspace.json', `${JSON.stringify({ entities: [card('probe'), card('other')] })}
`, 'application/json');
    const allDev = await second.request('/workspace/pins', { list: [{ workspace: 'dev-sandbox', id: 'probe' }, { workspace: 'dev-sandbox', id: 'other' }] });
    assert.equal(allDev.status, 200, JSON.stringify(await allDev.json().catch(() => null)));
    const mixed = await second.request('/workspace/pins', { list: [{ workspace: 'dev-sandbox', id: 'probe' }, { workspace: 'one', id: 'alpha' }] });
    assert.equal(mixed.status, 403);
  } finally { await second.close(); }
});

test('the real site has no dev key in /capabilities and accepts writes to any section', async () => {
  const { request, close } = await fixture();
  try {
    const caps = await (await request('/capabilities')).json();
    assert.equal('dev' in caps, false);
    assert.equal((await request('/workspace/pin', { workspace: 'one', id: 'alpha', pinned: true })).status, 200);
  } finally { await close(); }
});

test('the category, tab and Trash routes work on the site and never send a DELETE to the bucket', async () => {
  const { request, fake, entity, close } = await fixture();
  try {
    const made = await (await request('/cards', { workspace: 'one', title: 'Phone notes', category: 'brief' })).json();
    const id = made.card.id;
    await request('/cards/section', { workspace: 'one', id, name: 'Todo' });
    await request('/cards/section', { workspace: 'one', id, name: 'Ideas' });

    const renamed = await (await request('/cards/category', { workspace: 'one', from: 'brief', to: 'Briefs' })).json();
    assert.deepEqual(renamed, { from: 'brief', to: 'briefs', count: 1, merged: false });
    assert.equal(entity('one', id).category, 'briefs');
    assert.equal((await (await request('/cards/update', { workspace: 'one', id, category: 'test' })).json()).card.category, 'test');

    assert.equal((await request('/cards/section/move', { workspace: 'one', id, from: 2, to: 0 })).status, 200);
    assert.deepEqual(entity('one', id).steps.map(step => step.path), ['ideas.md', 'index.md', 'todo.md']);
    assert.equal((await request('/cards/section/delete', { workspace: 'one', id, index: 0, path: 'todo.md' })).status, 409, 'A stale index is refused.');
    assert.equal((await request('/cards/section/delete', { workspace: 'one', id, index: 0, path: 'ideas.md' })).status, 200);
    assert.equal(fake.text(`sections/one/${made.card.folder}/ideas.md`), '# Ideas\n\n', 'The file stays in the bucket.');
    assert.equal((await request('/cards/section/restore', { workspace: 'one', id, path: 'ideas.md' })).status, 200);
    assert.deepEqual(entity('one', id).steps.map(step => step.path), ['ideas.md', 'index.md', 'todo.md']);

    assert.equal((await request('/cards/delete', { workspace: 'one', id })).status, 200);
    assert.equal(entity('one', id), undefined);
    assert.equal(fake.json('sections/one/workspace.json').retired[id].kind, 'deleted');
    assert.match(fake.text(`sections/one/${made.card.folder}/index.md`), /Phone notes/);
    assert.equal((await request('/cards/restore', { workspace: 'one', id })).status, 200);
    assert.ok(entity('one', id));
    assert.equal((await request('/cards/delete', { workspace: 'one', id: 'nope' })).status, 404);

    assert.ok(!fake.log.some(entry => entry.method === 'DELETE'), 'Nothing was deleted from the bucket.');
  } finally { await close(); }
});

test('the new write routes keep the Origin and dev-copy gates', async () => {
  const gated = await fixture({ requireRemoteUser: true });
  try {
    for (const [route, body] of [['/cards/delete', { id: 'alpha' }], ['/cards/category', { from: 'test', to: 'x' }], ['/cards/section/delete', { id: 'alpha', index: 0, path: 'index.html' }]]) {
      const noOrigin = await fetch(`${gated.origin}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify({ workspace: 'one', ...body }) });
      assert.equal(noOrigin.status, 403, route);
    }
    assert.ok(gated.entity('one', 'alpha'));
  } finally { await gated.close(); }
  const dev = await fixture({ dev: devOnly, stateKey: 'dev-state.json' });
  try {
    for (const [route, body] of [['/cards/delete', { id: 'alpha' }], ['/cards/restore', { id: 'alpha' }], ['/cards/category', { from: 'test', to: 'x' }], ['/cards/section/move', { id: 'alpha', from: 0, to: 0 }]]) {
      assert.equal((await dev.request(route, { workspace: 'one', ...body })).status, 403, route);
    }
    assert.ok(dev.entity('one', 'alpha'));
  } finally { await dev.close(); }
});

test('a card moves between workspaces on the site; hidden, inbox and missing targets are refused; nothing is deleted', async () => {
  const { request, fake, entity, stateOf, close } = await fixture();
  try {
    fake.seed('sections/inbox/workspace.json', '{"hidden":true,"entities":[]}\n', 'application/json');
    fake.seed('sections/ideas/workspace.json', '{"name":"Game Ideas","hidden":true,"entities":[]}\n', 'application/json');
    assert.equal((await request('/workspace/pin', { workspace: 'one', id: 'alpha', pinned: true })).status, 200);
    for (const to of ['inbox', 'ideas', 'nowhere']) {
      const refused = await request('/cards/move', { workspace: 'one', id: 'alpha', to });
      assert.ok([409, 404].includes(refused.status), `${to}: ${refused.status}`);
    }
    assert.equal((await request('/cards/move', { workspace: 'one', id: 'alpha', to: 'one' })).status, 400);
    assert.ok(entity('one', 'alpha'), 'Nothing moved.');

    const done = await request('/cards/move', { workspace: 'one', id: 'alpha', to: 'two', category: 'Brief' });
    assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
    const body = await done.json();
    assert.deepEqual([body.from, body.to, body.card.category], ['one', 'two', 'brief']);
    assert.equal(entity('one', 'alpha'), undefined);
    assert.equal(entity('two', 'alpha').folder, 'alpha');
    assert.equal(fake.json('sections/one/workspace.json').retired.alpha.to, 'two');
    assert.equal(fake.text('sections/two/alpha/index.html'), '<h1>alpha</h1>');
    assert.equal(fake.text('sections/one/alpha/index.html'), '<h1>alpha</h1>', 'The source file stays.');
    assert.equal(stateOf('two', 'alpha')?.pinned, true);
    assert.equal(stateOf('one', 'alpha'), null);
    assert.ok(!fake.log.some(entry => entry.method === 'DELETE'));
  } finally { await close(); }
});

test('a move needs write access to both workspaces on the development copy and the Origin gate on the site', async () => {
  const dev = await fixture({ dev: devOnly, stateKey: 'dev-state.json' });
  try {
    for (const id of ['dev-a', 'dev-b']) dev.fake.seed(`sections/${id}/workspace.json`, `${JSON.stringify({ entities: id === 'dev-a' ? [card('probe')] : [] })}\n`, 'application/json');
    dev.fake.seed('sections/dev-a/probe/index.html', '<h1>probe</h1>', 'text/html');
    assert.equal((await dev.request('/cards/move', { workspace: 'dev-a', id: 'probe', to: 'one' })).status, 403, 'Into a real workspace.');
    assert.equal((await dev.request('/cards/move', { workspace: 'one', id: 'alpha', to: 'dev-b' })).status, 403, 'Out of a real workspace.');
    assert.equal((await dev.request('/cards/move', { workspace: 'dev-a', id: 'probe', to: 'dev-b' })).status, 200);
  } finally { await dev.close(); }
  const gated = await fixture({ requireRemoteUser: true });
  try {
    const noOrigin = await fetch(`${gated.origin}/api/cards/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify({ workspace: 'one', id: 'alpha', to: 'two' }) });
    assert.equal(noOrigin.status, 403);
    assert.ok(gated.entity('one', 'alpha'));
  } finally { await gated.close(); }
});

test('an S3 body that fails mid-download ends that one response; the server keeps answering', { timeout: 30_000 }, async () => {
  const fake = await startFakeS3();
  fake.seed('sections/one/workspace.json', JSON.stringify({ entities: [card('alpha')] }), 'application/json');
  fake.seed('sections/one/alpha/index.html', '<h1>alpha</h1>', 'text/html; charset=utf-8');
  fake.seed('sections/one/alpha/big.bin', 'x'.repeat(1000), 'application/octet-stream');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  // The stand-in S3 for every call, except that the body of big.bin starts and then breaks.
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/alpha/big.bin') && init.method === 'GET') {
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(100))); setTimeout(() => controller.error(new Error('upstream broke')), 20); },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000', ETag: '"e"' } });
    }
    return fetch(url, init);
  };
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1', fetchImpl });
  const root = await mkdtemp(path.join(tmpdir(), 'buw-site-api-'));
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'state.json'), sectionsTtl: 0 });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // The download is cut short: the client sees a failure, not a complete file.
    await assert.rejects(async () => (await fetch(`${origin}/w/one/alpha/big.bin`)).arrayBuffer());
    // A client that leaves mid-body is the same case from the other side.
    const early = await fetch(`${origin}/w/one/alpha/big.bin`);
    await early.body.cancel();
    // The process is still up (an uncaught error would fail this test) and serves the next request.
    const next = await fetch(`${origin}/w/one/alpha/index.html`);
    assert.equal(next.status, 200);
    assert.match(await next.text(), /alpha/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fake.close(); }
});
