// Run after npm run build. A checklist (#/~hub/checklist/<id>) through a real browser on a phone (390 x 844, touch), over
// the fixture service with its two checklists: the To do tab and the Inbox badge, the guide that starts open, 44 px tap
// targets, Copy, ticks that show at once and survive a reload, an untick, a failed tick, Submit with its one warning,
// the submitted list, and the read-only host. Nothing is ever overwritten: the bucket only gains files.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CHECKLIST, SUBMITTED_CHECKLIST, startHubFixture } from './hub-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ checklists: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...options });
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
const tall = async (locator, what) => {
  const count = await locator.count();
  assert.ok(count > 0, `${what}: there is something to measure.`);
  for (let index = 0; index < count; index += 1) {
    const box = await locator.nth(index).boundingBox();
    assert.ok(box && box.height >= 44, `${what} #${index} is ${box?.height} px tall, under 44.`);
  }
};
const prefix = `sections/inbox/checklists/${FIXTURE_CHECKLIST}/`;
const filesOf = () => [...fixture.fake.objects.keys()].filter(key => key.startsWith(prefix)).sort();
const marksOf = action => filesOf().filter(key => key.slice(prefix.length).startsWith(`${action}-`));
const snapshot = () => new Map(filesOf().map(key => [key, fixture.fake.text(key)]));
const waitProgress = (page, text) => page.waitForFunction(value => document.querySelector('[data-progress]')?.textContent === value, text);

try {
  const page = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  await page.goto(`${fixture.url}#/~hub/inbox`);
  await page.locator('[data-hub-tab-badge]').waitFor();

  step('the To do tab is second, lists the open list first with "1 of 4", and the Inbox badge counts it');
  assert.equal(await page.locator('[data-hub-tab-badge]').innerText(), '4', 'Three things wait in the fixture, and the list is a fourth.');
  await page.locator('.hub-chips .hub-chip').first().waitFor();
  assert.deepEqual(await page.locator('.hub-chips .hub-chip').allInnerTexts(), ['Needs you', 'To do', 'Asks', 'Reviews', 'Requests', 'Blocked', 'Answered']);
  assert.ok(await page.locator('.hub-row', { hasText: 'Finish the Discord bot setup' }).count() >= 1, 'The list is in Needs you too.');
  await page.locator('.hub-chip', { hasText: 'To do' }).tap();
  const row = page.locator('.hub-row', { hasText: 'Finish the Discord bot setup' });
  await page.locator('.hub-row', { hasText: 'Update the router settings' }).waitFor();
  assert.match(await row.locator('.hub-row-meta').innerText(), /^To do · probe · 1 of 4 · /);
  assert.deepEqual(await page.locator('.hub-row .hub-row-title').allInnerTexts(), ['Finish the Discord bot setup', 'Update the router settings'], 'Open first, then the submitted one.');
  assert.match(await page.locator('.hub-row', { hasText: 'Update the router settings' }).locator('.hub-row-meta').innerText(), /^To do · probe · 2 of 3 · submitted · /);
  await noSideways(page, 'To do');

  step('opening it: the first open item with a guide is expanded, and a done item shows its time');
  await row.tap();
  await page.locator('.hub-cl h2', { hasText: 'Finish the Discord bot setup' }).waitFor();
  assert.equal(await page.locator('[data-hub-inbox-badge], [data-hub-tab-badge]').first().innerText(), '4');
  assert.equal(await page.locator('[data-item="02"] [data-toggle]').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-item="01"] [data-toggle]').getAttribute('aria-expanded'), 'false', 'Item 1 has a link, and starts closed.');
  assert.equal(await page.locator('[data-item="04"] [data-toggle]').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('[data-item="03"] [data-toggle]').count(), 0, 'No guide and no link: the text is the checkbox\'s label.');
  assert.match(await page.locator('[data-item="01"] .hub-cl-meta').innerText(), /^done \d/);
  assert.equal(await page.locator('[data-item="01"] [data-box]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('[data-progress]').innerText(), '1 of 4 done');
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '1');
  assert.deepEqual(await page.locator('.hub-cl-group').allTextContents(), ['Discord developer portal', 'Your server']);
  await page.locator('[data-item="02"] pre').waitFor();
  assert.match(await page.locator('[data-item="02"] pre').innerText(), /bunnylink-secret set discord-bot-token/);
  assert.equal(await page.locator('[data-item="02"] .hub-cl-more a', { hasText: 'Open details' }).getAttribute('href'), 'https://example.test/discord/bot');
  assert.equal(await page.locator('[data-item="02"] .hub-cl-more a', { hasText: 'the portal guide' }).getAttribute('target'), '_blank');
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await noSideways(page, 'checklist');

  step('every checkbox, the expand toggle, Copy and Submit are at least 44 px tall');
  await tall(page.locator('[data-box]'), 'a checkbox');
  await tall(page.locator('[data-toggle]'), 'an expand toggle');
  await tall(page.locator('.hub-copy'), 'Copy');
  await tall(page.locator('[data-submit]'), 'Submit');
  await tall(page.locator('.hub-cl .hub-btn'), 'a button');
  for (const box of await page.locator('[data-box]').all()) assert.ok((await box.boundingBox()).width >= 44, 'and 44 px wide');

  step('Copy puts the block on the clipboard and says Copied');
  await page.locator('.hub-copy').tap();
  await page.locator('.hub-copy', { hasText: 'Copied' }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard.split(/\r?\n/).join('\n'), 'ssh root@host.example.test\nbunnylink-secret set discord-bot-token');
  await page.locator('.hub-copy', { hasText: /^Copy$/ }).waitFor({ timeout: 4000 });

  step('a tap shows at once, the item ignores taps while it is saving, others can be ticked, and the ticks are new files');
  const before = snapshot();
  let released = false;
  await page.route('**/api/hub/checklists/*/items/*', async route => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    released = true;
    await route.continue();
  });
  await page.locator('[data-item="02"] [data-box]').tap();
  await waitProgress(page, '2 of 4 done');
  assert.equal(released, false, 'The progress text changed before the response.');
  assert.equal(await page.locator('[data-item="02"] [data-box]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('[data-item="02"] [data-box]').isDisabled(), true, 'Busy: it ignores taps.');
  assert.equal(await page.locator('[data-submit]').isDisabled(), true, 'Submit waits for saves.');
  await page.locator('[data-item="03"] .hub-cl-title').tap();
  await waitProgress(page, '3 of 4 done');
  assert.equal(released, false);
  await page.waitForFunction(() => !document.querySelector('[data-item="02"] [data-box]').disabled && !document.querySelector('[data-item="03"] [data-box]').disabled);
  assert.equal(await page.locator('[data-progress]').innerText(), '3 of 4 done', 'The answers agree with the guess.');
  assert.equal(marksOf('tick').length, 3, 'The seeded tick and two more.');
  for (const [key, text] of before) assert.equal(fixture.fake.text(key), text, `${key} was not changed.`);
  await page.unroute('**/api/hub/checklists/*/items/*');

  step('after a reload the ticks are still there, and an untick writes a new file');
  await page.reload();
  await page.locator('[data-progress]', { hasText: '3 of 4 done' }).waitFor();
  assert.equal(await page.locator('[data-item="02"] [data-box]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('[data-item="03"] [data-box]').getAttribute('aria-checked'), 'true');
  assert.match(await page.locator('[data-item="03"] .hub-cl-meta').innerText(), /^done \d/);
  await new Promise(resolve => setTimeout(resolve, 20));
  await page.locator('[data-item="03"] [data-box]').tap();
  await waitProgress(page, '2 of 4 done');
  await page.waitForFunction(() => !document.querySelector('[data-item="03"] [data-box]').disabled);
  assert.equal(marksOf('untick').length, 1);
  assert.match(marksOf('untick')[0], /\/untick-03-\d{8}T\d{9}Z-[a-z0-9]{4}\.json$/);
  assert.equal(marksOf('tick').length, 3, 'The earlier ticks stay.');
  for (const [key, text] of before) assert.equal(fixture.fake.text(key), text, `${key} was not changed.`);
  await page.reload();
  await page.locator('[data-progress]', { hasText: '2 of 4 done' }).waitFor();
  assert.equal(await page.locator('[data-item="03"] [data-box]').getAttribute('aria-checked'), 'false');

  step('a tick that fails goes back and says why under the item');
  await page.route('**/api/hub/checklists/*/items/*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The inbox is down.' }) }));
  await page.locator('[data-item="04"] [data-box]').tap();
  await page.locator('[data-item="04"] [data-item-error]', { hasText: 'The inbox is down.' }).waitFor();
  assert.equal(await page.locator('[data-item="04"] [data-box]').getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('[data-progress]').innerText(), '2 of 4 done');
  await page.unroute('**/api/hub/checklists/*/items/*');
  await noSideways(page, 'checklist with an error');

  step('Submit with open items warns first, the second press sends, and the list leaves Needs you');
  await page.locator('textarea').fill('Skipped the DMs.');
  assert.equal(await page.locator('[data-submit]').innerText(), 'Submit');
  await page.locator('[data-submit]').tap();
  const warning = page.locator('[data-warning]');
  await warning.waitFor();
  assert.equal((await warning.innerText()).trim(), '2 items are still open. Submit anyway?');
  assert.equal(await page.locator('[data-submit]').innerText(), 'Submit with 2 open');
  assert.equal(filesOf().some(key => key.endsWith('/submit.json')), false, 'The first press sends nothing.');
  await tall(page.locator('[data-submit]'), 'Submit with open');
  await noSideways(page, 'the Submit warning');
  await page.locator('[data-submit]').tap();
  await page.locator('.hub[data-screen="inbox"]').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/~hub/inbox');
  await page.locator('[data-marked-done]', { hasText: 'Submitted. The agent sees it at its next session.' }).waitFor();
  const submit = fixture.fake.json(`${prefix}submit.json`);
  assert.deepEqual({ note: submit.note, done: submit.done, open: submit.open, by: submit.by }, { note: 'Skipped the DMs.', done: ['01', '02'], open: ['03', '04'], by: 'local' });
  const events = [...fixture.fake.objects.keys()].filter(key => key.includes('/events/')).map(key => fixture.fake.json(key)).filter(event => event.kind === 'checklist-submitted');
  assert.equal(events.length, 1);
  assert.deepEqual({ checklist: events[0].checklist, summary: events[0].summary, title: events[0].title }, { checklist: FIXTURE_CHECKLIST, summary: '2 of 4 done', title: 'Submitted: Finish the Discord bot setup' });
  await page.waitForFunction(() => document.querySelector('[data-hub-tab-badge]')?.textContent === '3');
  assert.equal(await page.locator('.hub-row', { hasText: 'Finish the Discord bot setup' }).count(), 0, 'Gone from Needs you.');
  await page.locator('.hub-chip', { hasText: 'To do' }).tap();
  const submittedRow = page.locator('.hub-row', { hasText: 'Finish the Discord bot setup' });
  await submittedRow.waitFor();
  assert.match(await submittedRow.locator('.hub-row-meta').innerText(), /^To do · probe · 2 of 4 · submitted · /);

  step('a submitted list is read-only, with the time and the note');
  await submittedRow.tap();
  await page.locator('.hub-cl[data-state="submitted"]').waitFor();
  await page.locator('[data-submitted]', { hasText: 'Skipped the DMs.' }).waitFor();
  assert.match(await page.locator('[data-submitted]').innerText(), /^Submitted just now|^Submitted \d+ min ago/);
  assert.equal(await page.locator('[data-submit]').count(), 0);
  for (const box of await page.locator('[data-box]').all()) assert.equal(await box.isDisabled(), true);
  await page.locator('[data-item="04"] [data-box]').tap({ force: true }).catch(() => {});
  assert.equal(await page.locator('[data-progress]').innerText(), '2 of 4 done', 'Nothing changed.');
  assert.equal(marksOf('tick').length, 3);
  await noSideways(page, 'a submitted list');

  step('a list the agent withdrew is read-only and says so');
  fixture.fake.seed(`${prefix}cancel.json`, JSON.stringify({ at: new Date().toISOString(), by: 'pc' }), 'application/json');
  await page.reload();
  await page.locator('[data-cancelled]', { hasText: 'The agent withdrew this list.' }).waitFor();
  assert.equal(await page.locator('[data-submit]').count(), 0);
  fixture.fake.objects.delete(`${prefix}cancel.json`);

  step('a submitted list in the To do tab, and another phone-width look at the second list');
  await go(page, `#/~hub/checklist/${SUBMITTED_CHECKLIST}`);
  await page.locator('.hub-cl h2', { hasText: 'Update the router settings' }).waitFor();
  assert.deepEqual(await page.locator('.hub-cl-group').allTextContents(), ['Router', 'After']);
  await noSideways(page, 'the second list');
  await go(page, '#/~hub/checklist');
  await page.locator('.hub-chip.on', { hasText: 'To do' }).waitFor();

  step('a read-only host shows the list, says "Sign in to tick items." and sends nothing');
  const dist = path.join(root, 'dist');
  const detail = {
    id: FIXTURE_CHECKLIST, project: 'probe', createdAt: new Date().toISOString(), from: { host: 'pc.example.test' }, title: 'A read-only list', state: 'open', done: 0, total: 2, files: [],
    items: [{ id: '01', text: 'First step', done: false }, { id: '02', text: 'Second step', done: false, guide: 'Do the **thing**.' }],
  };
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, transcribe: false, reason: 'Read-only here: sign in at https://site.example.test to change cards.' },
    '/api/card-state': { cards: {} },
    '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
    '/w/one/workspace.json': { entities: [] },
    '/api/hub/today': { counts: { needsYou: 1, running: 0, recent: 0, alerts: 0 }, needsYou: [], running: [], recent: [], alerts: [], at: new Date().toISOString() },
    [`/api/hub/checklists/${FIXTURE_CHECKLIST}`]: detail,
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
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  try {
    const guest = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    await guest.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/checklist/${FIXTURE_CHECKLIST}`);
    await guest.locator('.hub-cl h2', { hasText: 'A read-only list' }).waitFor();
    assert.match(await guest.locator('.hub-banner').innerText(), /ticking checklists/);
    assert.equal(await guest.locator('[data-readonly-note]').count(), 0, 'Quiet until someone taps.');
    await guest.locator('[data-item="01"] [data-box]').tap({ force: true });
    await guest.locator('[data-readonly-note]', { hasText: 'Sign in to tick items.' }).first().waitFor();
    assert.equal(await guest.locator('[data-item="01"] [data-box]').getAttribute('aria-checked'), 'false');
    assert.equal(await guest.locator('[data-progress]').innerText(), '0 of 2 done');
    await guest.locator('[data-submit]').tap({ force: true });
    await guest.locator('[data-readonly-note]', { hasText: 'Sign in to tick items.' }).first().waitFor();
    assert.equal(await guest.locator('[data-warning]').count(), 0, 'No warning: nothing was sent.');
    assert.equal(await guest.locator('.hub-error').count(), 0);
    assert.deepEqual(writes, [], 'Nothing was sent.');
    await noSideways(guest, 'the read-only list at 390 px');
  } finally { stub.close(); }

  console.log('hub-checklist-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
