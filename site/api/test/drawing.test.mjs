// Drawings and annotations through the published site's API, over the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { png } from './png.mjs';

const scene = (elements = []) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} });
const md5 = data => createHash('md5').update(data).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-drawing-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const entities = [{ id: 'alpha', folder: 'alpha', title: 'alpha', created: '2026-01-01', updated: '2026-01-01', steps: [{ name: 'Take', path: 'take-2b.png' }, { name: 'Notes', path: 'index.md' }] }];
  fake.seed('sections/one/workspace.json', `${JSON.stringify({ name: 'Section One', entities }, null, 2)}\n`, 'application/json');
  fake.seed('sections/one/alpha/index.md', '# alpha\n', 'text/markdown');
  const original = png(320, 200, 64);
  fake.seed('sections/one/alpha/take-2b.png', original, 'image/png');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, data) => fetch(`${origin}/api${route}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
  });
  const close = async () => { server.close(); await fake.close(); };
  return { fake, request, original, origin, close };
}

test('a drawing is added, saved with its picture, read back, and refused when stale', async () => {
  const { fake, request, origin, close } = await fixture();
  try {
    const added = await request('/cards/section', { workspace: 'one', id: 'alpha', name: 'Drawing', kind: 'drawing' });
    assert.equal(added.status, 201);
    const { path: file, step } = await added.json();
    assert.equal(file, 'drawing.excalidraw');
    assert.equal(step, 2);
    assert.equal(JSON.parse(fake.text('sections/one/alpha/drawing.excalidraw')).elements.length, 0);

    const opened = await (await request(`/cards/drawing?workspace=one&id=alpha&path=${file}`)).json();
    assert.equal(JSON.parse(opened.text).type, 'excalidraw');
    const mine = scene([{ type: 'rectangle', id: 'r' }]);
    const picture = png(400, 300, 50);
    const saved = await request('/cards/drawing', { workspace: 'one', id: 'alpha', path: file, scene: mine, png: picture.toString('base64'), base: opened.etag });
    assert.equal(saved.status, 200);
    const answer = await saved.json();
    assert.equal(answer.etag, md5(mine));
    assert.equal(answer.png, md5(picture));
    assert.equal(fake.text('sections/one/alpha/drawing.excalidraw'), mine);
    assert.deepEqual(fake.objects.get('sections/one/alpha/drawing.png').body, picture);
    assert.equal(fake.objects.get('sections/one/alpha/drawing.png').contentType, 'image/png');

    const reread = await (await request(`/cards/drawing?workspace=one&id=alpha&path=${file}`)).json();
    assert.equal(reread.etag, answer.etag, 'The etag read after a save is the one the next save names.');

    const stale = await request('/cards/drawing', { workspace: 'one', id: 'alpha', path: file, scene: scene(), png: picture.toString('base64'), base: opened.etag });
    assert.equal(stale.status, 409);
    const refusal = await stale.json();
    assert.equal(refusal.current.text, mine);
    assert.equal(refusal.current.etag, answer.etag);

    const served = await fetch(`${origin}/api/w/one/alpha/drawing.excalidraw`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'application/json', 'A drawing is served as JSON through /w/.');
  } finally { await close(); }
});

test('the picture is checked: not a PNG, or over 2048 px', async () => {
  const { request, close } = await fixture();
  try {
    const { path: file } = await (await request('/cards/section', { workspace: 'one', id: 'alpha', name: 'Door', kind: 'drawing' })).json();
    const save = image => request('/cards/drawing', { workspace: 'one', id: 'alpha', path: file, scene: scene(), png: image.toString('base64'), base: null });
    const wide = await save(png(2049, 100));
    assert.equal(wide.status, 400);
    assert.match((await wide.json()).error, /larger than 2048 px/);
    assert.equal((await save(Buffer.from('<svg></svg> and some more bytes to pass 24'))).status, 400);
  } finally { await close(); }
});

test('only the drawing route takes 8 MB; everything else keeps its limit', async () => {
  const { request, close } = await fixture();
  try {
    const { path: file } = await (await request('/cards/section', { workspace: 'one', id: 'alpha', name: 'Door', kind: 'drawing' })).json();
    const limit = 8 * 1024 * 1024;
    const padded = size => JSON.stringify({ workspace: 'one', id: 'alpha', path: file, junk: 'x'.repeat(size - 80) });
    // Just over 8 MB is cut off before it is parsed.
    assert.equal((await request('/cards/drawing', padded(limit + 200))).status, 413);
    // Just under 8 MB gets past the body limit and is refused for its content (no scene), not its size.
    assert.equal((await request('/cards/drawing', padded(limit - 200))).status, 400, 'The size was fine; the missing scene was not.');
    // The same kind of body on a route with the default limit is refused at 256 KB.
    assert.equal((await request('/cards/update', JSON.stringify({ workspace: 'one', id: 'alpha', title: 'x', junk: 'x'.repeat(256 * 1024) }))).status, 413);
    // A scene past 2 MB but under 8 MB is the writer's own 413, with its own words.
    const big = await request('/cards/drawing', { workspace: 'one', id: 'alpha', path: file, scene: ' '.repeat(2 * 1024 * 1024 + 1), png: '', base: null });
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /limited to 2 MB/);
  } finally { await close(); }
});

test('annotating names a new drawing after the picture, inserts its tab, and leaves the picture alone', async () => {
  const { fake, request, original, close } = await fixture();
  try {
    const before = md5(fake.objects.get('sections/one/alpha/take-2b.png').body);
    assert.equal(before, md5(original));
    const first = await request('/cards/annotate', { workspace: 'one', id: 'alpha', image: 'take-2b.png', after: 0, width: 320, height: 200 });
    assert.equal(first.status, 201);
    const made = await first.json();
    assert.equal(made.path, 'take-2b.annotated.excalidraw');
    assert.equal(made.step, 1);
    assert.deepEqual(made.card.steps.map(item => item.path), ['take-2b.png', 'take-2b.annotated.excalidraw', 'index.md']);
    assert.equal(JSON.parse(fake.text('sections/one/alpha/take-2b.annotated.excalidraw')).elements[0].customData.buwSrc, 'take-2b.png');

    // The first one exists, and a picture of a would-be second counts as taken too.
    fake.seed('sections/one/alpha/take-2b.annotated-2.png', png(1, 1), 'image/png');
    const second = await (await request('/cards/annotate', { workspace: 'one', id: 'alpha', image: 'take-2b.png', after: 0 })).json();
    assert.equal(second.path, 'take-2b.annotated-3.excalidraw');

    assert.equal(md5(fake.objects.get('sections/one/alpha/take-2b.png').body), before, 'The original picture is byte for byte the same.');
    assert.equal((await request('/cards/annotate', { workspace: 'one', id: 'alpha', image: '../x.png' })).status, 400);
    assert.equal((await request('/cards/annotate', { workspace: 'one', id: 'alpha', image: 'nothing.png' })).status, 404);
  } finally { await close(); }
});
