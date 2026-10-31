// Run after npm run build. The review view (#/~hub/review/<event file>[/<card file>]) through a
// real browser, over the fixture service: the row's way in, the sections, a card file read in
// place (stubbed at /w/, which the local service does not serve), the deep link, an old event with
// only a title, Mark done, the phone layout, and the read-only host.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHubFixture } from './hub-fixture.mjs';
import { eventJson } from '../../site/api/test/hub-fixtures.mjs';
import { solidPng } from '../../site/api/test/png.mjs';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const PNG = solidPng(1, 1);

const fixture = await startHubFixture({ seedData: false });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
const go = async (page, hash) => { await page.evaluate(value => { location.hash = value; }, hash); };
/** Stubs for the card files and the screenshots, as the published site and GitHub would answer. */
const stubWorld = async page => {
  await page.route('**/w/one/sprint-card/briefs/x-1.md', route => route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: '# Brief heading\n\nSome words.\n\n![shot](img/a.png)\n' }));
  await page.route('**/w/one/sprint-card/briefs/img/a.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/w/one/sprint-card/reviews/x-1-qa.md', route => route.fulfill({ status: 200, contentType: 'text/markdown', body: '# QA triage heading\n' }));
  await page.route('https://raw.githubusercontent.com/**', route => (route.request().url().endsWith('/extra.png') ? route.abort() : route.fulfill({ status: 200, contentType: 'image/png', body: PNG })));
};

try {
  const seedSection = (id, entities, tracked) => fixture.fake.seed(`sections/${id}/workspace.json`, JSON.stringify({ name: id, ...(tracked ? { tracked } : {}), entities }), 'application/json');
  seedSection('two', [{ id: 'hubdemo-sprint', title: 'Hubdemo sprint', folder: 'sprint-card' }], { repo: 'example/probe-app' });
  fixture.fake.seed('sections/two/sprint-card/reviews/x-1-qa.md', '# Old QA triage heading', 'text/markdown');
  const shot = name => `https://raw.githubusercontent.com/example/app/pr-assets/ws-b1z.9/${name}`;
  const file = fixture.seed.event(eventJson({
    kind: 'ready-for-review', ts: new Date(Date.now() - 5 * 60000), title: 'Detail probe', summary: 'Two pull requests, **both** green.',
    card: 'https://example.test/one#/sprint-card', url: 'https://example.test/pr/1',
    extra: {
      prs: ['https://github.com/example/app/pull/3', 'https://github.com/example/app/pull/4'],
      cardDir: 'one/sprint-card',
      cardFiles: ['briefs/x-1.md', 'reviews/x-1-qa.md', 'qa/missing.md'],
      screenshots: [shot('board-before.png'), shot('board-after.png'), shot('extra.png')],
      verdicts: [{ leg: 'smoke', result: 'pass', text: 'Smoke tests passed.' }, { leg: 'review', result: 'pass', text: 'Verified.' }],
      deployUrl: 'https://build.example.test/',
    },
  }));
  const oldFile = fixture.seed.event(eventJson({ kind: 'ready-for-review', ts: new Date(Date.now() - 4 * 60000), title: 'Old probe', summary: 'Only a title and a summary.' }));
  const partFile = fixture.seed.event(eventJson({ kind: 'ready-for-review', ts: new Date(Date.now() - 3 * 60000), title: 'Part probe', extra: { verdicts: [{ leg: 'smoke', result: 'pass', text: 'Green.' }] } }));
  const cardLinkFile = fixture.seed.event(eventJson({ kind: 'ready-for-review', ts: new Date(Date.now() - 2 * 60000), title: 'Card link probe', url: 'https://example.test/one#/sprint-card' }));
  const doneEvents = () => [...fixture.fake.objects.keys()].filter(key => key.includes('/events/') && fixture.fake.json(key)?.kind === 'review-done').map(key => fixture.fake.json(key));

  const page = await open({ width: 1280, height: 800 });
  await stubWorld(page);
  await page.goto(`${fixture.url}#/~hub/needs/pr`);

  step('the row text is a link to the review, and the row keeps its buttons');
  const row = page.locator('.ni', { hasText: 'Detail probe' });
  await row.waitFor();
  const entry = row.locator('[data-review-open]');
  assert.equal(await entry.getAttribute('href'), `#/~hub/review/${file}`);
  assert.equal(await row.locator('button', { hasText: 'Mark done' }).count(), 1);
  await entry.click();
  await page.locator('.hub-review h2', { hasText: 'Detail probe' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#/~hub/review/${file}`);

  step('the view shows the summary, status, pull requests, screenshots, files and the build');
  const view = page.locator('.hub-review');
  assert.match(await view.innerText(), /Two pull requests, both green\./);
  assert.equal(await view.locator('.hub-pill', { hasText: 'probe' }).count(), 1);
  for (const [leg, label] of [['smoke', 'Smoke tests'], ['review', 'Review']]) {
    const line = view.locator(`[data-verdict="${leg}"]`);
    assert.match(await line.innerText(), new RegExp(`^${label}`));
    assert.equal(await line.locator('.hub-dot.g').count(), 1, `${label} has the green dot.`);
  }
  await view.getByText('QA did not run for this item.').waitFor();
  const prs = view.locator('[data-section="prs"] a');
  assert.deepEqual(await prs.allInnerTexts(), ['app #3', 'app #4']);
  assert.equal(await prs.first().getAttribute('target'), '_blank');
  assert.equal(await prs.last().getAttribute('target'), '_blank');
  const pairs = view.locator('[data-pair]');
  assert.equal(await pairs.count(), 2, 'One before/after pair and one more picture.');
  assert.deepEqual(await pairs.first().locator('figcaption').allInnerTexts(), ['Before · board', 'After · board']);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pair] img')].length === 2 && [...document.querySelectorAll('[data-pair] img')].every(image => image.naturalWidth > 0));
  const third = pairs.nth(1).locator('[data-shot]');
  await third.getByText('Open image').waitFor();
  assert.equal(await third.locator('img').count(), 0, 'The picture that failed is replaced.');
  assert.equal(await third.locator('figcaption').innerText(), 'extra');
  assert.deepEqual(await view.locator('[data-file]').evaluateAll(nodes => nodes.map(node => node.firstChild.textContent)), ['Brief', 'QA triage', 'QA report']);
  assert.equal(await view.locator('[data-section="files"] a', { hasText: 'Open the card' }).getAttribute('href'), 'https://example.test/one#/sprint-card');
  assert.equal(await view.locator('[data-section="try"] a', { hasText: 'Open the build' }).getAttribute('target'), '_blank');
  await noSideways(page, 'review view at 1280 px');

  step('a review has a top link to Needs you, a hint on Mark done, and the row button says what it does');
  assert.equal(await page.locator('[data-legacy]').count(), 0, 'A review with fields is not old.');
  assert.equal(await view.locator('[data-done-hint]').isVisible(), true);
  assert.match(await page.locator('.hub-review-reader').innerText(), /Pick a file to read it here\./);
  await page.locator('[data-back-top]').waitFor();
  assert.equal(await page.locator('[data-back-top]').getAttribute('href'), '#/~hub/needs');
  assert.equal(await page.locator('[data-hub-link="needs"]').getAttribute('aria-current'), 'page', 'The sidebar keeps Needs you current.');
  await go(page, `#/~hub/review/${partFile}`);
  await page.locator('[data-section="status"]').waitFor();
  assert.equal(await page.locator('[data-legacy]').count(), 0, 'Verdicts only: not old.');
  await page.getByText('No screenshots came with this item.').waitFor();
  await go(page, '#/~hub/needs/pr');
  assert.equal(await page.locator('.ni', { hasText: 'Detail probe' }).locator('button', { hasText: 'Mark done' }).getAttribute('title'), 'Hide from Needs you. Does not approve or merge.');
  await go(page, `#/~hub/review/${file}`);
  await page.locator('.hub-review h2', { hasText: 'Detail probe' }).waitFor();
  for (const [w, h] of [[800, 600], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    const top = await page.locator('[data-back-top]').boundingBox();
    assert.ok(top && top.y >= 0 && top.y + top.height <= h, `The top link is in the first viewport at ${w} px.`);
  }

  step('reading a file: Brief opens in place with its image, focus on the reader title, the reader beside the sections');
  await view.locator('[data-file="briefs/x-1.md"]').click();
  await page.getByRole('heading', { name: 'Brief heading' }).waitFor();
  assert.ok((await page.evaluate(() => location.hash)).endsWith('/briefs/x-1.md'));
  const picture = page.locator('.hub-review-reader img');
  assert.ok((await picture.getAttribute('src')).endsWith('/w/one/sprint-card/briefs/img/a.png'));
  await page.waitForFunction(() => { const image = document.querySelector('.hub-review-reader img'); return !!image && image.naturalWidth > 0; });
  assert.equal(await page.evaluate(() => { const active = document.activeElement; return active?.tagName === 'H3' && !!active.closest('.hub-review-reader'); }), true, 'Focus is on the reader title.');
  assert.equal(await view.locator('[data-file="briefs/x-1.md"]').getAttribute('aria-current'), 'true');
  const [side, reader] = await Promise.all([page.locator('.hub-review-side').boundingBox(), page.locator('.hub-review-reader').boundingBox()]);
  assert.ok(reader.x >= side.x + side.width, `The reader (${reader.x}) is right of the sections (${side.x + side.width}).`);

  step('a file that is not served says so and offers the card; Back closes the reader');
  await view.locator('[data-file="qa/missing.md"]').click();
  const missing = page.locator('[data-file-missing]');
  await missing.waitFor();
  assert.match(await missing.innerText(), /This file is not on the site yet/);
  await page.locator('.hub-review-reader a', { hasText: 'Open the card' }).waitFor();
  assert.equal(await page.locator('.hub-review-reader .buw-markdown').count(), 0, 'No empty reader.');
  await page.goBack();
  await page.getByRole('heading', { name: 'Brief heading' }).waitFor();
  await page.goBack();
  await page.getByText('Pick a file to read it here.').waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#/~hub/review/${file}`);

  step('deep links: a file opens, an unknown review says so');
  await go(page, `#/~hub/review/${file}/reviews/x-1-qa.md`);
  await page.getByRole('heading', { name: 'QA triage heading' }).waitFor();
  await go(page, `#/~hub/review/${file}/briefs/x-1.md`);
  await page.getByRole('heading', { name: 'Brief heading' }).waitFor();
  await go(page, '#/~hub/review/nope.json');
  await page.getByText('This review is not in the last 7 days.').waitFor();
  assert.equal(await page.locator('a', { hasText: 'Back to Needs you' }).getAttribute('href'), '#/~hub/needs');

  step('an old event with only a title opens with honest empty states and a working Mark done');
  await go(page, '#/~hub/needs/pr');
  await page.locator('.ni', { hasText: 'Old probe' }).locator('[data-review-open]').click();
  await page.locator('.hub-review h2', { hasText: 'Old probe' }).waitFor();
  await page.locator('[data-legacy]').waitFor();
  assert.equal(await page.locator('.hub-review-reader').count(), 0, 'Nothing to read: no reader panel.');
  for (const gone of ['[data-section="status"]', '[data-section="shots"]', '[data-section="files"]', '[data-section="try"]']) assert.equal(await page.locator(gone).count(), 0, `${gone} is replaced by the one note.`);
  assert.equal(await page.getByText(/^No (test or review|screenshots|brief or reports|deployed build)/).count(), 0, 'The flat empty lines are gone.');
  await page.getByText('No pull request link came with this item.').waitFor();
  assert.equal(await page.locator('[data-legacy]').count(), 1);
  assert.equal(await page.locator('[data-done-hint]').isVisible(), true, 'Says what Mark done means.');
  assert.match(await page.locator('[data-done-hint]').innerText(), /does not approve or merge/);
  const before = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Mark done' }).click();
  await page.locator('[data-next-note]', { hasText: 'Marked done · next:' }).waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#\/~hub\/(review|needs)/, 'Mark done moves on to the next item.');
  assert.equal(await page.locator('[data-next-back]').getAttribute('href'), `#/~hub/review/${oldFile}`, 'Back opens the review that was marked done.');
  assert.equal(await page.evaluate(() => history.length), before + 1, 'It added an entry: the browser Back returns to the review too.');
  assert.equal(doneEvents().length, 1);
  assert.equal(doneEvents()[0].review, oldFile);
  await go(page, '#/~hub/needs/pr');
  await page.locator('.ni', { hasText: 'Detail probe' }).waitFor();
  assert.equal(await page.locator('.ni', { hasText: 'Old probe' }).count(), 0, 'The row is gone.');
  await go(page, `#/~hub/review/${oldFile}`);
  await page.locator('[data-done]', { hasText: /Marked done .* by local/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mark done' }).count(), 0);

  step('an old event with no links: the summary yields the pull requests, the file and the sprint card');
  const linksFile = fixture.seed.event(eventJson({
    kind: 'ready-for-review', ts: new Date(Date.now() - 2 * 60000), title: 'hubdemo: first item', project: 'wrong-project',
    summary: 'Built. PR #2 + workspace-skills#26, see reviews/x-1-qa.md and qa/nothing.md.',
  }));
  const quiet = fixture.seed.event(eventJson({ kind: 'ready-for-review', ts: new Date(Date.now() - 2 * 60000), title: 'unknown: first item', summary: 'PR #2 + workspace-skills#26, see reviews/x-1-qa.md.' }));
  await page.route('**/w/two/sprint-card/reviews/x-1-qa.md', route => route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Old QA triage heading' }));
  await go(page, `#/~hub/review/${linksFile}`);
  await page.locator('.hub-review h2', { hasText: 'hubdemo: first item' }).waitFor();
  const prLinks = page.locator('[data-section="prs"] a');
  assert.deepEqual(await prLinks.evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), ['https://github.com/example/probe-app/pull/2', 'https://github.com/example/workspace-skills/pull/26']);
  assert.equal(await page.locator('[data-found]').count(), 1, 'Says they were found in the summary.');
  assert.match(await page.locator('[data-legacy]').innerText(), /found from the text/, 'The old-review note says where the links came from.');
  for (const name of ['status', 'shots', 'try']) assert.equal(await page.locator(`[data-section="${name}"]`).count(), 0, `The empty ${name} panel stays hidden.`);
  assert.equal(await page.locator('[data-section="files"] [data-file="reviews/x-1-qa.md"]').count(), 1, 'The inferred file is listed.');
  assert.equal(await page.locator('.hub-md a[href="https://github.com/example/probe-app/pull/2"]').count(), 1, 'PR #2 is a link in the summary.');
  assert.equal(await page.locator('.hub-md a[href="https://github.com/example/workspace-skills/pull/26"]').count(), 1);
  assert.equal(await page.locator('[data-sprint-card]').first().innerText(), 'Sprint card: Hubdemo sprint');
  assert.equal(await page.locator('.hub-md a', { hasText: 'qa/nothing.md' }).count(), 0, 'A file that does not exist stays plain text.');
  const cited = page.locator('.hub-md a', { hasText: 'reviews/x-1-qa.md' });
  const look = await page.locator('.hub-review-head .hub-md').evaluate(node => ({ body: getComputedStyle(node).color, link: getComputedStyle(node.querySelector('a')).color, line: getComputedStyle(node.querySelector('a')).textDecorationLine }));
  assert.ok(look.link !== look.body && look.line.includes('underline'), `A summary link looks like a link (${JSON.stringify(look)}).`);
  assert.equal(await cited.getAttribute('href'), `#/~hub/review/${linksFile}/reviews/x-1-qa.md`);
  await cited.click();
  await page.getByRole('heading', { name: 'Old QA triage heading' }).waitFor();
  await go(page, `#/~hub/review/${quiet}`);
  await page.locator('.hub-review h2', { hasText: 'unknown: first item' }).waitFor();
  assert.equal(await page.locator('[data-section="prs"] a').count(), 0, 'No card and no known repo: nothing to link.');
  assert.equal(await page.locator('[data-sprint-card]').count(), 0);

  step('a blocked row has Mark done: it hides the row for good');
  const blockedFile = fixture.seed.event(eventJson({ kind: 'blocked', ts: new Date(Date.now() - 60000), session: 'sess-stale-ui', title: 'Stale blocked session' }));
  await go(page, '#/~hub/needs/unstick');
  const stale = page.locator('.ni[data-kind="unstick"]', { hasText: 'Stale blocked session' });
  await stale.waitFor();
  await stale.locator('button', { hasText: 'Mark done' }).click();
  await stale.waitFor({ state: 'detached' });
  assert.equal(doneEvents().filter(event => event.review === blockedFile).length, 1);
  await page.reload();
  await page.locator('.hub-chips').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.ni[data-kind="unstick"]', { hasText: 'Stale blocked session' }).count(), 0, 'Still hidden after a reload.');

  step('phone: no sideways scroll at 390 and 375 px, the reader replaces the sections, Back returns focus to the file');
  const phone = await open({ width: 390, height: 844 });
  await stubWorld(phone);
  await phone.goto(`${fixture.url}#/~hub/review/${file}`);
  await phone.locator('.hub-review h2', { hasText: 'Detail probe' }).waitFor();
  await phone.waitForFunction(() => [...document.querySelectorAll('[data-pair] img')].every(image => image.complete));
  assert.equal(await phone.locator('[data-hub-tab="needs"]').getAttribute('aria-current'), 'page', 'Needs you is the current tab on a review.');
  assert.equal(await phone.locator('[data-hub-tab="more"].active').count(), 0, 'More is not active.');
  const tabStyle = key => phone.locator(`[data-hub-tab="${key}"]`).evaluate(node => { const style = getComputedStyle(node); return `${style.color}|${style.fontWeight}`; });
  assert.equal(await tabStyle('more'), await tabStyle('work'), 'More looks like the other idle tabs.');
  assert.notEqual((await tabStyle('more')).split('|')[0], (await tabStyle('needs')).split('|')[0], 'The Needs you tab is lit and More is not.');
  await noSideways(phone, 'review view at 390 px');
  const wide = await phone.evaluate(() => [...document.querySelectorAll('.hub-review img')].filter(image => image.getBoundingClientRect().right > innerWidth + 0.5).length);
  assert.equal(wide, 0, 'No image is wider than the screen.');
  await phone.locator('[data-file="briefs/x-1.md"]').click();
  await phone.getByRole('heading', { name: 'Brief heading' }).waitFor();
  assert.equal(await phone.locator('.hub-review-side').isVisible(), false, 'The sections are hidden while a file is open.');
  await phone.locator('.hub-review-back').waitFor();
  await noSideways(phone, 'a brief at 390 px');
  await phone.locator('.hub-review-back').click();
  await phone.locator('[data-file="briefs/x-1.md"]').waitFor();
  assert.equal(await phone.evaluate(() => location.hash), `#/~hub/review/${file}`);
  await phone.waitForFunction(() => document.activeElement?.dataset?.file === 'briefs/x-1.md'); // Focus is back on the Brief button.
  await phone.setViewportSize({ width: 375, height: 812 });
  await phone.waitForTimeout(150);
  await noSideways(phone, 'review view at 375 px');

  step('a review whose url is a card link: Open card in the head, nothing under Pull requests, no "posted before" note');
  await go(page, '#/~hub/needs/pr');
  assert.equal(await page.locator('.ni', { hasText: 'Card link probe' }).locator('a.hub-btn:not([data-review-open])').innerText(), 'Open card');
  assert.equal(await page.locator('.ni', { hasText: 'Detail probe' }).locator('a.hub-btn', { hasText: 'Open link' }).innerText(), 'Open link', 'A link that is no card keeps its label.');
  await go(page, `#/~hub/review/${cardLinkFile}`);
  await page.locator('.hub-review h2', { hasText: 'Card link probe' }).waitFor();
  const linkHead = page.locator('.hub-review-head [data-link-head]');
  assert.equal(await linkHead.innerText(), 'Open card');
  assert.equal(await linkHead.getAttribute('href'), 'https://example.test/one#/sprint-card');
  assert.equal(await page.locator('[data-section="prs"] a').count(), 0, 'The card link is no pull request.');
  assert.match(await page.locator('[data-section="prs"]').innerText(), /No pull request link came with this item\./);
  assert.equal(await page.getByText('posted before').count(), 0);
  assert.equal((await page.locator('[data-legacy]').innerText()).trim(), 'No links or test results came with this review.');
  await go(page, `#/~hub/review/${oldFile}`);
  await page.locator('.hub-review h2', { hasText: 'Old probe' }).waitFor();
  assert.equal(await page.locator('[data-link-head]').count(), 0, 'No url, no button.');
  await go(page, `#/~hub/review/${file}`);
  await page.locator('.hub-review h2', { hasText: 'Detail probe' }).waitFor();
  assert.equal(await page.locator('.hub-review-head [data-link-head]').innerText(), 'Open link', 'A page that is not a card is "Open link".');

  step('read-only: Mark done shows the sign-in note and sends nothing');
  const dist = path.join(root, 'dist');
  const reviewId = '120000-pc-000001.json';
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, reason: 'Read-only here: sign in at https://site.example.test to change cards.' },
    '/api/card-state': { cards: {} },
    '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
    '/w/one/workspace.json': { entities: [] },
    '/api/hub/today': { counts: { needsYou: 1, running: 0, recent: 0, alerts: 0 }, needsYou: [], running: [], recent: [], alerts: [], at: new Date().toISOString() },
    [`/api/hub/reviews/${reviewId}`]: { id: reviewId, title: 'A read-only review', at: new Date().toISOString(), project: 'probe', host: 'pc.example.test', summary: 'Canned.', done: false },
  };
  const writes = [];
  const stub = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://site');
    const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    if (request.method !== 'GET') { writes.push(`${request.method} ${url.pathname}`); return send(403, 'application/json', '{"error":"read-only"}'); }
    if (canned[url.pathname]) return send(200, 'application/json', JSON.stringify(canned[url.pathname]));
    if (url.pathname.startsWith('/api/')) return send(404, 'application/json', '{"error":"none"}');
    try {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return send(200, name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', await readFile(path.join(dist, name)));
    } catch { return send(200, 'text/html', await readFile(path.join(dist, 'index.html'))); }
  });
  await listenOnGoodPort(stub, '127.0.0.1');
  try {
    const guest = await open({ width: 1200, height: 800 });
    await guest.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/review/${reviewId}`);
    await guest.locator('.hub-review h2', { hasText: 'A read-only review' }).waitFor();
    const markDone = guest.getByRole('button', { name: 'Mark done' });
    await markDone.waitFor();
    await markDone.click({ force: true });
    await guest.locator('[data-readonly-note]').waitFor();
    assert.deepEqual(writes, [], 'Nothing was sent.');
  } finally { stub.close(); }

  console.log('hub-review-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
