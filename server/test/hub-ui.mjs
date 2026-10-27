// Run after npm run build. The Hub through a real browser, over the fixture service: fake S3 seeded
// with an Ask, events and a Beads copy, the local service on top, nothing else written.
//
// Part 2 (CUJ 2): the progress map at desktop and phone width.
// Part 4: Chat and push-to-talk against a fake Hermes.
// Part 3: ✎ on Ask options (CUJ 1 with a drawing) and Sketch.
// Part 1: a card called "hub" still opens; Today, Inbox and Ask at desktop and phone width; CUJ 1
// (answer an Ask, seen as Answered, then Picked up); the 409 path; CUJ 5 (a request from the Board);
// and the read-only banner against a stand-in for the signed-out site.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCORD_ASK, FIXTURE_ASK, PASSKEY_ASK, askId, startHubFixture } from './hub-fixture.mjs';
import { askJson, eventJson, threeOptions } from '../../site/api/test/hub-fixtures.mjs';
import { solidPng } from '../../site/api/test/png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture();
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const requestsSeen = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  page.on('response', response => { if (response.url().includes('/api/hub/') || response.status() >= 500) requestsSeen.push(`${response.status()} ${response.url().replace(/^https?:[/][/][^/]+/, '').slice(0, 90)}`); });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
/** A note or error sits under the row's title, and the title keeps at least 40% of the row. */
const noteUnderTitle = async (row, selector, what) => {
  const [title, whole, note] = await Promise.all([row.locator('.hub-row-title').boundingBox(), row.boundingBox(), row.locator(selector).boundingBox()]);
  assert.ok(note, `${what}: the note is on screen.`);
  assert.ok(note.y >= title.y + title.height - 1, `${what}: the note sits under the title (${note.y} < ${title.y + title.height}).`);
  assert.ok(title.width >= whole.width * 0.4, `${what}: the title keeps its width (${title.width} of ${whole.width}).`);
};
const go = async (page, hash) => {
  await page.evaluate(value => { location.hash = value; }, hash);
};
const hubAnswer = id => fixture.fake.json(`sections/inbox/asks/${id}/answer.json`);

try {
  const page = await open({ width: 1280, height: 900 });
  await page.goto(fixture.url);

  step('a card whose id is hub still opens');
  await page.locator('.sidebar-list').waitFor();
  await go(page, '#/hub');
  await page.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  assert.equal(await page.locator('.hub').count(), 0, '#/hub is a card, not the Hub.');

  step('desktop: the sidebar has the Hub group with a badge of 3, Today counts 3 and 1, Inbox lists the Ask');
  await go(page, '#/~hub/today');
  await page.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await page.locator('[data-hub-badge]').innerText(), '3');
  assert.equal(await page.locator('[data-hub-nav] [data-section="hub"] .sidebar-count').count(), 0, 'The Hub heading carries no count: it only counted the rows below it.');
  assert.equal((await page.locator('.hub-kpi[data-kpi="needs-you"] .hub-kpi-v').innerText()).trim(), '3');
  assert.equal((await page.locator('.hub-kpi[data-kpi="running"] .hub-kpi-v').innerText()).trim(), '1');
  assert.match(await page.locator('.hub-panel[aria-label="Running"]').innerText(), /running since \d\d:\d\d/);
  await noSideways(page, 'Today');
  await page.locator('[data-hub-link="inbox"]').click();
  await page.locator('.hub[data-screen="inbox"]').waitFor();
  await page.locator('.hub-row', { hasText: 'Which jump arc feels right?' }).waitFor();
  assert.equal(await page.locator('.hub-row').count(), 3, 'The Ask, the review and the blocked session.');
  const review = page.locator('.hub-row', { hasText: 'PR ready for review' });
  const reviewLink = review.locator('a.hub-btn');
  assert.equal(await reviewLink.innerText(), 'Open link', 'The fixture link is not on github.com.');
  assert.equal(await reviewLink.getAttribute('target'), '_blank');
  assert.equal(await review.locator('button', { hasText: 'Mark done' }).count(), 1);
  const fixtureBlocked = page.locator('.hub-row', { hasText: 'Permission needed' });
  assert.match(await fixtureBlocked.locator('[data-blocked-hint]').innerText(), /^Open the Claude app on pc\.example\.test$/);
  assert.equal(await fixtureBlocked.locator('a').count(), 0, 'No link: it is words, not a button.');
  assert.equal(await fixtureBlocked.evaluate(node => node.tagName), 'DIV', 'The row is not a link either.');
  assert.equal(await page.locator('a[href="https://claude.ai/code"]').count(), 0, 'Nothing links to a new chat.');
  // One shared source: the sidebar's Inbox entry and the phone bar's badge say the same.
  assert.equal(await page.locator('[data-hub-inbox-badge]').innerText(), '3');
  assert.equal(await page.locator('[data-hub-inbox-badge]').getAttribute('title'), '3 waiting for you');
  assert.equal(await page.locator('[data-hub-tab-badge]').textContent(), '3', 'The tab bar is hidden on desktop but holds the same count.');

  step('CUJ 1 without the drawing: pick B, write a note, send; the answer is in the bucket and the UI says Answered');
  await page.locator('.hub-row', { hasText: 'Which jump arc feels right?' }).click();
  await page.locator('.hub[data-screen="ask"] .hub-option').first().waitFor();
  assert.equal(await page.locator('.hub-option').count(), 3);
  assert.match(await page.locator('.hub-steps li.on').innerText(), /Open/);
  assert.ok(await page.locator('.hub-send, button:has-text("Send answer")').first().isDisabled(), 'Nothing to send yet.');
  await page.locator('[data-option="B"] .hub-option-pick').click();
  await page.locator('.hub-field textarea').fill('shorter hang here');
  await page.locator('button:has-text("Send answer")').click();
  await page.locator('.hub-steps li.on', { hasText: 'Answered' }).waitFor();
  assert.deepEqual([hubAnswer(FIXTURE_ASK).choice, hubAnswer(FIXTURE_ASK).note, hubAnswer(FIXTURE_ASK).by], ['B', 'shorter hang here', 'local']);
  assert.match(await page.locator('.hub-answer').innerText(), /B · floatier/);
  fixture.seed.put(`asks/${FIXTURE_ASK}/pickup.json`, { at: new Date().toISOString(), host: 'pc.example.test', bead: 'bd-7f3c' });
  await page.reload();
  await page.locator('.hub-steps li.on', { hasText: 'Picked up' }).waitFor();

  step('409: an answer that lands first is shown, not overwritten');
  const second = askJson({ id: askId('race', 'b2c3'), bead: 'bd-9', now: new Date(), options: threeOptions() });
  fixture.seed.ask(second);
  await go(page, `#/~hub/ask/${second.id}`);
  await page.locator('[data-option="A"] .hub-option-pick').click();
  fixture.seed.put(`asks/${second.id}/answer.json`, { at: new Date().toISOString(), by: 'phone', choice: 'C' });
  await page.locator('button:has-text("Send answer")').click();
  await page.locator('.hub-error', { hasText: 'Already answered by phone' }).waitFor();
  assert.equal(hubAnswer(second.id).choice, 'C');

  step('an Ask file without "from" (and odd options) renders, and a broken Hub screen leaves the sidebar alone');
  const bare = askId('bare', 'd4e5');
  fixture.seed.put(`asks/${bare}/ask.json`, { id: bare, project: 'probe', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), question: 'Written without a sender?', options: [null, { id: 'A' }], allowNote: true })
  await go(page, `#/~hub/ask/${bare}`);
  await page.locator('h2', { hasText: 'Written without a sender?' }).waitFor();
  await page.locator('.hub-muted', { hasText: 'From an unknown sender' }).waitFor();
  await page.locator('.sidebar').first().waitFor();
  await page.route('**/api/hub/inbox*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [null] }) }));
  await go(page, '#/~hub/inbox');
  await page.locator('.report-error', { hasText: 'This Hub screen could not be shown' }).waitFor();
  assert.ok(await page.locator('.sidebar').first().isVisible(), 'The sidebar survives a broken Hub screen.');
  await page.unroute('**/api/hub/inbox*');
  await page.locator('.report-error button:has-text("Back to Workspace")').click();
  await page.locator('.report-error').waitFor({ state: 'detached' });

  step('CUJ 5: a request from the Board lands in the bucket as next-sprint');
  await go(page, '#/~hub/board/magic-loops');
  await page.locator('.hub-board').waitFor();
  assert.ok(await page.locator('.hub-column').count() === 4);

  step('Board cards lead with the title; the id is a small selectable line after it');
  const [mapAnswer] = await Promise.all([page.waitForResponse(response => response.url().includes('/api/hub/map/magic-loops')), page.reload()]);
  const boardMap = await mapAnswer.json();
  await page.locator('.hub-board').waitFor();
  const titleById = new Map(boardMap.milestones.flatMap(m => m.features.flatMap(f => f.tasks)).map(task => [task.id, task.title]));
  const firstCard = page.locator('.hub-ticket').first();
  const firstId = await firstCard.getAttribute('data-task');
  assert.equal(await firstCard.locator(':scope > *').first().getAttribute('class'), 'hub-ticket-title', 'The title is the first line of a card.');
  assert.equal((await firstCard.locator('.hub-ticket-title').innerText()).trim(), titleById.get(firstId));
  assert.notEqual(titleById.get(firstId), firstId, 'The title is not the id.');
  assert.equal((await firstCard.locator('.hub-id').innerText()).trim(), firstId);
  await page.locator('button:has-text("Ask an agent to do something")').click();
  await page.locator('.hub-field textarea').fill('Add wall-slide dust particles');
  await page.locator('button:has-text("Send")').last().click();
  await page.locator('.hub-ok', { hasText: 'Request sent' }).waitFor();
  const requests = [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/request\.json$/.test(key));
  assert.equal(requests.length, 1);
  const request = fixture.fake.json(requests[0]);
  assert.deepEqual([request.project, request.when, request.text], ['magic-loops', 'next-sprint', 'Add wall-slide dust particles']);

  step('Board shows Loading before its columns, and never Nothing here before the map arrives');
  await page.route('**/api/hub/map/*', async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.continue(); });
  await go(page, '#/~hub/board/probe');
  await go(page, '#/~hub/board/magic-loops');
  await page.locator('.hub-empty', { hasText: 'Loading…' }).waitFor();
  assert.equal(await page.locator('.hub-empty', { hasText: 'Nothing here' }).count(), 0, 'Nothing here before the data arrived.');
  await page.locator('.hub-board').waitFor();
  await page.unroute('**/api/hub/map/*');

  step('Activity: grouped by day, filtered, and Load older steps back a day');
  await go(page, '#/~hub/activity');
  await page.locator('.hub[data-screen="activity"] .hub-row').first().waitFor();
  assert.ok(await page.locator('.hub-row').count() >= 3);
  await page.locator('.hub-chip', { hasText: 'Deploys' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.hub-row').length === 1);
  await page.locator('.hub-row', { hasText: 'Deployed the WebGL preview' }).waitFor();
  await page.locator('button:has-text("Load older")').click();

  step('phone width: the Inbox to Ask flow works and nothing scrolls sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(fixture.url);
  await phone.locator('.sidebar-reopen, .sidebar').first().waitFor();
  const phoneAsk = askJson({ id: askId('phone', 'c3d4'), now: new Date(), options: threeOptions() });
  fixture.seed.ask(phoneAsk);
  for (const [hash, selector] of [['#/~hub/today', '.hub-kpis'], ['#/~hub/inbox', '.hub-panel'], ['#/~hub/board/magic-loops', '.hub-board'], ['#/~hub/activity', '.hub-chips']]) {
    await go(phone, hash);
    await phone.locator(`.hub ${selector}`).first().waitFor();
    await phone.waitForTimeout(250);
    await noSideways(phone, hash);
  }
  await go(phone, '#/~hub/inbox');
  await phone.locator('.hub-row', { hasText: 'Which jump arc feels right?' }).first().waitFor();
  await phone.locator('.hub-row[href*="/ask/"]').first().click();
  await phone.locator('.hub-option').first().waitFor();
  await phone.waitForTimeout(250);
  await noSideways(phone, 'Ask');
  const boxes = await phone.locator('.hub-option').evaluateAll(list => list.map(item => item.getBoundingClientRect().top));
  assert.ok(boxes[1] > boxes[0] && boxes[2] > boxes[1], 'The options stack on a phone.');

  step('phone width: a very long title wraps on the Board and nothing scrolls sideways');
  const longTitle = `${'Alpha beta gamma delta '.repeat(4)}${'x'.repeat(60)} tail`.slice(0, 160);
  await phone.route('**/api/hub/map/magic-loops', async route => {
    const answer = await (await route.fetch()).json();
    for (const m of answer.milestones) for (const f of m.features) for (const task of f.tasks) task.title = longTitle;
    await route.fulfill({ json: answer });
  });
  await go(phone, '#/~hub/board/magic-loops');
  await phone.locator('.hub-ticket').first().waitFor();
  await phone.waitForTimeout(250);
  await noSideways(phone, 'Board with a long title');
  const longBox = await phone.locator('.hub-ticket').first().evaluate(card => ({ title: card.querySelector('.hub-ticket-title').getBoundingClientRect().width, card: card.getBoundingClientRect().width, text: card.querySelector('.hub-ticket-title').textContent }));
  assert.equal(longBox.text, longTitle, 'The Board never clips a title.');
  assert.ok(longBox.title <= longBox.card, 'The title is no wider than its card.');
  await phone.unroute('**/api/hub/map/magic-loops');

  step('phone tab bar: Inbox, Map and Cards are one tap away with the menu shut; no bar over a card or on desktop');
  const tabs = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await tabs.goto(`${fixture.url}#/`);
  await tabs.locator('nav.hub-tabs').waitFor();
  assert.equal(await tabs.locator('nav.hub-tabs').isVisible(), true);
  await tabs.locator('[data-hub-tab-badge]').waitFor();
  // 3 seeded, plus the phone Ask added above.
  assert.equal(await tabs.locator('[data-hub-tab-badge]').innerText(), '4');
  assert.equal(await tabs.locator('[data-hub-tab="chat"]').count(), 0, 'No Chat tab without Hermes.');
  assert.equal(await tabs.locator('[data-hub-tab="cards"][aria-current="page"]').count(), 1, 'Cards is the active tab on Home.');
  await noSideways(tabs, 'Home with the tab bar');
  await tabs.locator('[data-hub-tab="inbox"]').tap();
  await tabs.locator('.hub[data-screen="inbox"]').waitFor();
  assert.equal(await tabs.evaluate(() => location.hash), '#/~hub/inbox');
  assert.equal(await tabs.locator('.app-layout.sidebar-collapsed').count(), 1, 'The menu was never opened.');
  assert.equal(await tabs.locator('[data-hub-tab="inbox"]').getAttribute('aria-current'), 'page');
  // A write refreshes the count at once: no reload, no waiting for the 60 s poll.
  await tabs.locator('.hub-row[href*="/ask/"]').first().tap();
  await tabs.locator('.hub-option').first().waitFor();
  await tabs.locator('.hub-option-pick').first().tap();
  await tabs.locator('button:has-text("Send answer")').tap();
  await tabs.locator('.hub-steps li.on', { hasText: 'Answered' }).waitFor();
  await tabs.waitForFunction(() => document.querySelector('[data-hub-tab-badge]')?.textContent === '3', null, { timeout: 5000 });
  assert.equal(await tabs.locator('[data-hub-badge]').count() ? await tabs.locator('[data-hub-badge]').innerText() : '3', '3', 'The sidebar count follows too.');
  // Later steps need an open Ask again.
  fixture.seed.ask(askJson({ id: askId('phone', 'f6a7'), now: new Date(), options: threeOptions() }));
  await tabs.locator('[data-hub-tab="inbox"]').tap();
  await tabs.locator('.hub[data-screen="inbox"]').waitFor();
  // Board, Activity (and Sketch with writes) are under More; the bar stays at six or fewer.
  assert.ok(await tabs.locator('nav.hub-tabs .hub-tab').count() <= 6, 'No more than six items in the bar.');
  await tabs.locator('[data-hub-tab="more"]').tap();
  assert.deepEqual(await tabs.locator('[data-hub-more]').evaluateAll(list => list.map(item => item.getAttribute('data-hub-more'))), ['board', 'activity', 'sketch']);
  await tabs.locator('[data-hub-more="board"]').tap();
  await tabs.locator('.hub[data-screen="board"]').waitFor();
  assert.equal(await tabs.locator('[data-hub-more]').count(), 0, 'The sheet shuts after a choice.');
  assert.equal(await tabs.locator('[data-hub-tab="more"]').getAttribute('class').then(c => c.includes('active')), true);
  await noSideways(tabs, 'Board with the tab bar');
  await tabs.locator('[data-hub-tab="map"]').tap();
  await tabs.locator('.hub[data-screen="map"]').waitFor();
  await tabs.locator('[data-hub-tab="cards"]').tap();
  await tabs.locator('.entity-card, .home-grid, [data-home]').first().waitFor();
  assert.equal(await tabs.locator('.hub').count(), 0);
  await go(tabs, '#/hub');
  await tabs.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  assert.equal(await tabs.locator('nav.hub-tabs').count(), 0, 'No tab bar while a card is open.');
  assert.equal(await page.locator('nav.hub-tabs').isVisible(), false, 'No tab bar on desktop.');

  step('one /api/hub/today request per poll, not one from the menu and one from Today');
  const poll = await open({ width: 1280, height: 800 });
  let todayCalls = 0;
  poll.on('request', request => { if (new URL(request.url()).pathname === '/api/hub/today') todayCalls += 1; });
  await poll.goto(`${fixture.url}#/~hub/today`);
  await poll.locator('.hub-kpis').waitFor();
  await poll.waitForTimeout(2000);
  assert.equal(todayCalls, 1, `Expected one /today request, saw ${todayCalls}.`);

  step('read-only: a host that says write: false shows the banner and no controls');
  const dist = path.join(root, 'dist');
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, transcribe: false, reason: 'Read-only here: sign in at https://site.example.test to change cards.' },
    '/api/card-state': { cards: {} },
    '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
    '/w/one/workspace.json': { entities: [] },
    '/api/hub/today': { counts: { needsYou: 2, running: 0, recent: 0, alerts: 0 }, needsYou: [{ kind: 'ask', id: 'x-a1b2', title: 'A read-only question', at: new Date().toISOString(), state: 'open', project: 'probe' }, { kind: 'review', id: '120000-pc-000001.json', title: 'A read-only review', at: new Date().toISOString(), project: 'probe' }], running: [], recent: [], alerts: [], at: new Date().toISOString() },
    '/api/hub/projects': { projects: [{ id: 'probe', name: 'Probe', beads: true }] },
    '/api/hub/map/probe': { project: 'probe', meta: { count: 1, pushedAt: new Date().toISOString() }, ageMinutes: 5, sprints: [], milestones: [{ id: 'm1', title: 'M1', state: 'next', features: [{ id: 'f1', title: 'F1', state: 'next', tasks: [{ id: 'bd-1', title: 'A task', state: 'next', status: 'open', signs: [], sprints: [], deps: [] }] }] }] },
    '/api/hub/asks/20261026-probe-x-a1b2': { id: '20261026-probe-x-a1b2', project: 'probe', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), from: { host: 'h', tool: 'claude-code' }, question: 'A read-only question', options: [{ id: 'A', label: 'one' }], allowNote: true, allowDrawing: true, state: 'open', files: ['ask.json'] },
  };
  const stub = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://site');
    const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    if (canned[url.pathname]) return send(200, 'application/json', JSON.stringify(canned[url.pathname]));
    if (url.pathname.startsWith('/api/')) return send(404, 'application/json', '{"error":"none"}');
    try {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return send(200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', await readFile(path.join(dist, file)));
    } catch { return send(200, 'text/html', await readFile(path.join(dist, 'index.html'))); }
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  try {
    const guest = await open({ width: 1200, height: 800 });
    await guest.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/today`);
    await guest.locator('.hub-banner', { hasText: 'Read-only here' }).waitFor();
    assert.match(await guest.locator('.hub-banner a').getAttribute('href'), /^https:\/\/site\.example\.test/);
    assert.match(await guest.locator('.hub-banner').innerText(), /need you to be signed in/);
    assert.equal(await guest.locator('.hub-row', { hasText: 'A read-only question' }).count(), 1);
    assert.match(await guest.locator('.hub-banner').innerText(), /marking reviews done/);
    const readOnlyReview = guest.locator('.hub-row', { hasText: 'A read-only review' });
    assert.equal(await readOnlyReview.locator('a.hub-btn').count(), 0, 'No link, so only Mark done.');
    const markDone = readOnlyReview.locator('button', { hasText: 'Mark done' });
    assert.equal(await markDone.getAttribute('aria-disabled'), 'true');
    await markDone.click({ force: true });
    await readOnlyReview.locator('[data-readonly-note]').waitFor();
    assert.match(await readOnlyReview.locator('[data-readonly-note]').innerText(), /Sign in to mark this done/);
    for (const [width, height] of [[1280, 800], [800, 600], [390, 844]]) {
      await guest.setViewportSize({ width, height });
      await guest.waitForTimeout(150);
      await markDone.click({ force: true });
      await readOnlyReview.locator('[data-readonly-note]').waitFor();
      await noteUnderTitle(readOnlyReview, '[data-readonly-note]', `read-only at ${width} px`);
      if (width === 390) await noSideways(guest, 'read-only review at 390 px');
    }
    await guest.setViewportSize({ width: 1200, height: 800 });
    assert.equal(await guest.locator('.hub-error').count(), 0, 'Nothing was sent.');
    await guest.evaluate(() => { location.hash = '#/~hub/ask/20261026-probe-x-a1b2'; });
    await guest.locator('.hub-option').waitFor();
    assert.equal(await guest.locator('button:has-text("Send answer"), button:has-text("Snooze"), .hub-field textarea').count(), 0);
    assert.equal(await guest.locator('[data-hub-link="sketch"]').count(), 0, 'No Sketch row without write.');
    await guest.locator('[data-readonly-note]').waitFor();
    await guest.locator('[data-option="A"] .hub-option-pick').click({ force: true });
    assert.equal(await guest.locator('[data-option="A"] .hub-option-pick').getAttribute('aria-checked'), 'false');
    assert.equal(await guest.locator('.hub-error').count(), 0);
    await guest.evaluate(() => { location.hash = '#/~hub/board/probe'; });
    await guest.locator('text=Sign in to ask an agent to do something.').waitFor();
    assert.equal(await guest.getByRole('button', { name: 'Ask an agent to do something' }).count(), 0);
    step('read-only at 375 px: the scrim covers the banner and the title; a tap on the banner closes the sheet');
    const tiny = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true });
    await tiny.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/map/probe`);
    await tiny.locator('.hub-map-box svg').waitFor();
    await tiny.locator('[data-node="m1"] > circle').first().tap({ force: true });
    await tiny.locator('.hub-map-panel').waitFor();
    const top = (await tiny.locator('.hub-map-panel').boundingBox()).y;
    const hits = await tiny.evaluate(() => ['.hub-banner', '.hub h2'].map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + Math.min(rect.height / 2, 20);
      return { selector, y, hit: document.elementFromPoint(x, y)?.className };
    }));
    for (const { selector, y, hit } of hits) {
      if (y < top - 2) assert.equal(hit, 'hub-map-scrim', `${selector} is under the scrim, not under ${hit}.`);
    }
    assert.ok(hits[0].y < top - 2, 'The banner is above the sheet, so the check ran.');
    await tiny.touchscreen.tap(187, hits[0].y);
    await tiny.locator('.hub-map-panel').waitFor({ state: 'detached' });
    assert.equal(await tiny.evaluate(() => location.hash), '#/~hub/map/probe');
    assert.equal(await tiny.locator('.hub-map-panel').count(), 0, 'No other node opened.');
  } finally { stub.close(); }


  // Part 2 (CUJ 2): the progress map on the fixture's Beads copy of the CUJ 2 project.
  const wallTitle = 'Tune the wall slide friction curve across every surface type';
  await page.route('**/api/hub/map/magic-loops', async route => {
    const answer = await (await route.fetch()).json();
    for (const m of answer.milestones) for (const f of m.features) for (const task of f.tasks) if (task.id === 'ml-wj-t2') task.title = wallTitle;
    await route.fulfill({ json: answer });
  });
  step('map: the header says how old the copy is, and it starts as one line of milestones');
  await go(page, '#/~hub/map/magic-loops');
  await page.locator('.hub-map-box svg').waitFor();
  assert.match(await page.locator('.hub-top .hub-muted').innerText(), /Beads copy from 20 min ago/);
  assert.equal(await page.locator('[data-kind="m"]').count(), 3);
  assert.equal(await page.locator('[data-kind="f"], [data-kind="t"]').count(), 0);

  step('map: Milestone 2 opens into features, Wall-jump into seven tasks with their signs');
  await page.locator('[data-toggle="ml-m2"]').click({ force: true });
  await page.locator('[data-kind="f"]').waitFor();
  assert.equal(await page.locator('[data-kind="f"]').count(), 1);
  // A node with a working sign has a spinning ring in it, which Playwright never calls stable.
  await page.locator('[data-toggle="ml-wj"]').click({ force: true });
  await page.locator('[data-kind="t"]').first().waitFor();
  assert.equal(await page.locator('[data-kind="t"]').count(), 7);
  assert.equal(await page.locator('[data-node="ml-wj-t3"] [data-sign="working"]').count(), 1, 'The task with a session started 5 minutes ago is working.');
  assert.equal(await page.locator('[data-node="ml-wj-t5"] [data-sign="pr"]').count(), 1, 'The task with an open PR has the PR sign.');
  assert.equal(await page.locator('[data-node="ml-wj-t1"] [data-sign]').count(), 0, 'A closed task has no signs.');
  await page.locator('[data-node="ml-wj-t5"] > circle').click({ force: true });
  assert.match(await page.locator('.hub-map-panel').innerText(), /Wall-jump animation/);
  await page.locator('.hub-map-panel a:has-text("Open PR")').waitFor();
  assert.equal((await page.locator('.hub-map-panel .hub-id').first().innerText()).trim(), 'ml-wj-t5');
  assert.match(await page.locator('.hub-map-panel h3').innerText(), /^Wall-jump animation/, 'The details lead with the title.');
  const labelLengths = await page.locator('[data-kind="t"] text.hub-map-label').evaluateAll(list => list.map(item => item.textContent.length));
  assert.ok(labelLengths.length > 0 && labelLengths.every(length => length <= 25), `Map task labels stay short (${labelLengths}).`);
  const tip = await page.locator('[data-node="ml-wj-t5"] > title').textContent();
  assert.ok(tip.includes('Wall-jump animation') && tip.includes('ml-wj-t5'), 'The node hover text has the title and the id.');
  const longLines = await page.locator('[data-node="ml-wj-t2"] text.hub-map-label').allTextContents();
  assert.equal(longLines.length, 2, 'A long title takes two label lines.');
  assert.ok(longLines.every(line => line.length <= 24), `Both lines fit 24 characters (${longLines}).`);
  assert.ok(longLines[1].endsWith('…'), 'The second line ends in an ellipsis.');
  const longTip = await page.locator('[data-node="ml-wj-t2"] > title').textContent();
  assert.ok(longTip.includes(wallTitle) && longTip.includes('ml-wj-t2'), 'The hover text keeps the full title and the id.');
  assert.ok((await page.locator('[data-node="ml-wj-t2"]').getAttribute('aria-label')).startsWith(wallTitle), 'The aria-label keeps the full title.');
  await page.unroute('**/api/hub/map/magic-loops');

  step('map: tapping a milestone opens its panel; the chevron alone expands');
  const panel = page.locator('.hub-map-panel');
  const fCount = () => page.locator('[data-kind="f"]').count();
  // The side panel covers the right of the page, so bring a node to the left of the box before clicking it.
  const clickNode = async id => {
    await page.locator('.hub-map-box').evaluate((box, nodeId) => {
      const rect = box.querySelector(`[data-node="${nodeId}"] > circle`).getBoundingClientRect();
      box.scrollLeft += rect.left - box.getBoundingClientRect().left - 150;
    }, id);
    await page.locator(`[data-node="${id}"] > circle`).click({ force: true });
  };
  await page.locator('button:has-text("Collapse")').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="t"]').length === 0);
  await go(page, '#/~hub/map/magic-loops');
  await panel.waitFor({ state: 'detached' });
  assert.equal(await fCount(), 0);
  await page.locator('[data-node="ml-m2"] > circle').click({ force: true });
  await panel.waitFor();
  assert.ok((await page.evaluate(() => location.hash)).endsWith('/magic-loops/ml-m2'));
  assert.equal(await fCount(), 0, 'The tap opened the panel and expanded nothing.');
  const text = await panel.innerText();
  for (const part of ['Wall-jump animation', 'open', 'Open PR', 'merged', 'sprint-3 · 4 of 7 tasks', '⟳ 1', '⇄ 1 PR open']) assert.ok(text.includes(part), `The Milestone 2 panel says "${part}".`);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'hub-map-panel-title', 'Focus is on the panel title.');
  await page.locator('[data-toggle="ml-m2"]').click({ force: true });
  await page.locator('[data-kind="f"]').waitFor();
  assert.equal(await panel.count(), 1, 'The chevron leaves the panel as it is.');

  step('map: switching and closing');
  await clickNode('ml-m3');
  await page.waitForFunction(() => document.querySelector('.hub-map-panel h3')?.textContent.includes('Milestone 3'));
  const m3 = await panel.innerText();
  assert.ok(m3.includes('No pull requests yet.') && m3.includes('Not in a sprint.'), 'Milestone 3 has the empty lines.');
  assert.equal(await fCount(), 1, 'A hash change between two map addresses keeps what is expanded.');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => location.hash), '#/~hub/map/magic-loops');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-node') === 'ml-m3');
  await clickNode('ml-m3');
  await panel.waitFor();
  await page.locator('button[aria-label="Close details"]').click();
  await panel.waitFor({ state: 'detached' });

  step('map: a task row in the panel switches it to that task');
  await go(page, '#/~hub/map/magic-loops/ml-m2');
  await panel.waitFor();
  await panel.getByRole('button', { name: 'Wall-jump animation' }).click();
  await page.waitForFunction(() => location.hash.endsWith('/ml-wj-t5') && document.activeElement?.id === 'hub-map-panel-title' && document.activeElement.textContent === 'Wall-jump animation');
  await page.goBack();
  await panel.waitFor({ state: 'detached' });

  step('map: loose tasks sit under "Not in a feature"');
  await go(page, '#/~hub/map/nosprint/ns-m1');
  await panel.waitFor();
  const loose = await panel.innerText();
  assert.ok(loose.includes('Not in a feature') && !loose.includes('other tasks'), 'The loose group has its own name.');
  await go(page, '#/~hub/map/magic-loops');
  await page.locator('[data-node="ml-m3"]').waitFor();
  await panel.waitFor({ state: 'detached' });

  step('map: Enter on a node opens its panel, Space on its chevron expands');
  await page.locator('[data-node="ml-m3"]').focus();
  await page.keyboard.press('Enter');
  await panel.waitFor();
  assert.equal(await fCount(), 0, 'Enter opened the panel and expanded nothing.');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  await page.locator('[data-toggle="ml-m3"]').focus();
  await page.keyboard.press('Space');
  await page.locator('[data-kind="f"]').waitFor();
  assert.equal(await panel.count(), 0, 'Space on the chevron opened no panel.');

  step('map: a node under the side panel is scrolled out from under it');
  await page.locator('button:has-text("Expand all")').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="t"]').length === 9);
  const under = await page.locator('.hub-map-box').evaluate(box => {
    const rect = box.querySelector('[data-node="ml-m3"] > circle').getBoundingClientRect();
    const panelLeft = innerWidth - 48 - Math.min(380, innerWidth * 0.4);
    box.scrollLeft += rect.left - (panelLeft + 120);
    const after = box.querySelector('[data-node="ml-m3"] > circle').getBoundingClientRect();
    return { right: after.right, panelLeft };
  });
  assert.ok(under.right > under.panelLeft, `The node starts under the panel's area (${under.right} <= ${under.panelLeft}).`);
  await go(page, '#/~hub/map/magic-loops/ml-m3');
  await panel.waitFor();
  await page.waitForTimeout(300);
  const [cleared, side] = await Promise.all([page.locator('[data-node="ml-m3"] > circle').first().boundingBox(), panel.boundingBox()]);
  assert.ok(cleared.x + cleared.width <= side.x, `The panel opening scrolled the node clear (${cleared.x + cleared.width} > ${side.x}).`);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  await page.locator('button:has-text("Collapse")').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="f"]').length === 0);

  step('map: a deep link opens the panel; Back closes it');
  await go(page, '#/~hub/map/magic-loops/ml-m2');
  await panel.waitFor();
  await clickNode('ml-m3');
  await page.waitForFunction(() => document.querySelector('.hub-map-panel h3')?.textContent.includes('Milestone 3'));
  await page.goBack();
  await panel.waitFor({ state: 'detached' });
  await go(page, '#/~hub/map/magic-loops/nope');
  await page.locator('.hub-map-box svg').waitFor();
  assert.equal(await panel.count(), 0, 'An unknown id opens nothing.');
  assert.equal(await page.evaluate(() => location.hash), '#/~hub/map/magic-loops/nope');

  step('map: a task opens the panel too, and the panel does not hide the selected node');
  await go(page, '#/~hub/map/magic-loops');
  await page.locator('[data-toggle="ml-m2"]').click({ force: true });
  await page.locator('[data-toggle="ml-wj"]').click({ force: true });
  await page.locator('[data-node="ml-wj-t5"]').waitFor();
  await page.locator('[data-node="ml-wj-t5"] > circle').click({ force: true });
  await panel.waitFor();
  const taskText = await panel.innerText();
  assert.ok(taskText.includes('Wall-jump animation') && taskText.includes('Open PR'));
  await page.locator('button:has-text("Expand all")').click();
  await clickNode('ml-m3');
  await page.waitForFunction(() => document.querySelector('.hub-map-panel h3')?.textContent.includes('Milestone 3'));
  await page.waitForTimeout(200);
  const [nodeBox, panelBox] = await Promise.all([page.locator('[data-node="ml-m3"] > circle').first().boundingBox(), panel.boundingBox()]);
  assert.ok(nodeBox.x + nodeBox.width <= panelBox.x, `The panel leaves the selected node in view (${nodeBox.x + nodeBox.width} > ${panelBox.x}).`);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });

  step('map: the sprint overlay adds one band for sprint-3 with 4 of 7');
  assert.equal(await page.locator('.hub-band').count(), 0);
  await page.locator('button[aria-pressed]', { hasText: 'Sprints' }).click();
  await page.locator('.hub-band').waitFor();
  assert.equal(await page.locator('.hub-band').count(), 1);
  const band = await page.locator('.hub-band').textContent();
  assert.match(band, /sprint-3/);
  assert.match(band, /4 of 7/);

  step('map: the Sprints toggle on a copy with no sprint labels says so; with them it does not');
  assert.equal(await page.locator('[data-no-sprints]').count(), 0, 'The sprint-3 copy has sprints.');
  await page.locator('button[aria-pressed]', { hasText: 'Sprints' }).click();
  await go(page, '#/~hub/map/nosprint');
  await page.locator('.hub-map-box svg').waitFor();
  await page.locator('button[aria-pressed]', { hasText: 'Sprints' }).click();
  await page.locator('[data-no-sprints]').waitFor();
  await go(page, '#/~hub/map/magic-loops');
  await page.locator('.hub-map-box svg').waitFor();
  await page.locator('button[aria-pressed]', { hasText: 'Sprints' }).click();
  await page.locator('.hub-band').waitFor();
  assert.equal(await page.locator('[data-no-sprints]').count(), 0);
  await page.locator('button[aria-pressed]', { hasText: 'Sprints' }).click();

  step('map: Loading shows while the map is fetched')
  await page.route('**/api/hub/map/*', async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.continue(); });
  await go(page, '#/~hub/map/nosprint');
  await page.locator('.hub-empty', { hasText: 'Loading…' }).waitFor();
  await page.locator('.hub-map-box svg').waitFor();
  await page.unroute('**/api/hub/map/*');
  await go(page, '#/~hub/map/magic-loops');
  await page.locator('.hub-map-box svg').waitFor();
  await page.locator('button:has-text("Expand all")').click();

  step('map: Collapse removes the tasks, Expand all shows every task of every milestone');
  await page.locator('button:has-text("Collapse")').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="t"]').length === 0);
  await page.locator('button:has-text("Expand all")').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="t"]').length === 9);

  step('map: Ctrl + wheel zooms where you point');
  await page.locator('button:has-text("Collapse")').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="f"]').length === 0);
  const boxRect = await page.locator('.hub-map-box').boundingBox();
  await page.mouse.move(boxRect.x + 200, boxRect.y + 200);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.locator('[data-kind="f"]').first().waitFor();

  step('map: a project with Asks and events but no Beads copy says so');
  await go(page, '#/~hub/map/probe');
  await page.locator('.hub-empty', { hasText: 'No Beads copy yet' }).waitFor();
  assert.equal(await page.locator('.hub-map-box').count(), 0);

  step('map at phone width: the box scrolls sideways, the page does not, and a tap opens a milestone');
  await go(phone, '#/~hub/map/magic-loops');
  await phone.locator('.hub-map-box svg').waitFor();
  await phone.waitForTimeout(300);
  const sizes = await phone.locator('.hub-map-box').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  assert.ok(sizes.scroll > sizes.client, 'The map is wider than the screen and scrolls inside its box.');
  await noSideways(phone, 'Progress map');
  await phone.locator('[data-toggle="ml-m2"]').tap({ force: true });
  await phone.locator('[data-kind="f"]').waitFor();
  assert.equal(await phone.locator('.hub-map-panel').count(), 0, 'The chevron opens no panel.');
  await noSideways(phone, 'Progress map, opened');
  const sheet = phone.locator('.hub-map-panel');
  await phone.locator('[data-node="ml-m2"] > circle').tap({ force: true });
  await sheet.waitFor();
  const sheetBox = await sheet.boundingBox();
  assert.ok(sheetBox.y >= 844 * 0.25 - 1 && sheetBox.y + sheetBox.height >= 843, `The sheet sits at the bottom (${sheetBox.y}, ${sheetBox.height}).`);
  await noSideways(phone, 'Progress map with the sheet');
  await phone.touchscreen.tap(195, 40);
  await sheet.waitFor({ state: 'detached' });
  await phone.locator('[data-node="ml-m2"] > circle').tap({ force: true });
  await sheet.waitFor();
  await phone.goBack();
  await sheet.waitFor({ state: 'detached' });
  await noSideways(phone, 'Progress map after the sheet');


  // Part 3: ✎ on an Ask's options, and Sketch.
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  /** A freehand stroke on the open editor's canvas, picked by its title as drawing-ui.mjs does. */
  const stroke = async (target, from = 0.4, to = 0.55) => {
    const canvas = target.locator('.drawing-editor canvas.interactive');
    await canvas.waitFor();
    await target.waitForTimeout(700);
    const box = await canvas.boundingBox();
    await target.locator('.drawing-editor label[title^="Draw"]').click();
    await target.mouse.move(box.x + box.width * from, box.y + box.height * 0.5);
    await target.mouse.down();
    await target.mouse.move(box.x + box.width * to, box.y + box.height * 0.55, { steps: 6 });
    await target.mouse.move(box.x + box.width * (to + 0.1), box.y + box.height * 0.45, { steps: 6 });
    await target.mouse.up();
  };
  const sendWithDrawing = async (target, ask) => {
    fixture.seed.ask(ask);
    const before = Buffer.from(fixture.fake.objects.get(`sections/inbox/asks/${ask.id}/b.png`).body);
    await go(target, `#/~hub/ask/${ask.id}`);
    await target.locator('[data-option="B"] img').waitFor();
    await target.waitForFunction(() => [...document.querySelectorAll('[data-option] img')].every(image => image.complete && image.naturalWidth > 0));
    await target.locator('[data-option="B"] .hub-option-draw').click();
    await stroke(target);
    await target.locator('.drawing-bar button', { hasText: /^Done$/ }).click();
    await target.locator('[data-attached]').waitFor();
    assert.match(await target.locator('[data-attached]').innerText(), /Drawing attached to option B/);
    assert.equal(await target.locator('[data-option="B"].sel').count(), 1, 'Drawing on an option selects it.');
    await target.locator('button:has-text("Send answer")').click();
    await target.locator('.hub-steps li.on', { hasText: 'Answered' }).waitFor();
    const folder = `sections/inbox/asks/${ask.id}`;
    const answer = fixture.fake.json(`${folder}/answer.json`);
    assert.equal(answer.choice, 'B');
    assert.deepEqual(answer.drawing, { excalidraw: 'answer.excalidraw', png: 'answer.png' });
    const scene = fixture.fake.json(`${folder}/answer.excalidraw`);
    assert.ok(scene.elements.length >= 2, 'The background and the stroke are in the scene.');
    assert.ok(scene.elements.some(element => element.type === 'freedraw'));
    assert.ok(fixture.fake.objects.get(`${folder}/answer.png`).body.subarray(0, 8).equals(PNG_SIGNATURE), 'The picture is a PNG.');
    assert.ok(fixture.fake.objects.get(`${folder}/b.png`).body.equals(before), 'The option picture is untouched.');
    assert.ok(await target.locator('.hub-answer img').count() === 1, 'The answer shows the drawing.');
  };

  step('CUJ 1 with the drawing: ✎ on option B, a stroke, Done, Send; scene, PNG and answer are in the bucket');
  await sendWithDrawing(page, askJson({ id: askId('draw', 'd4e5'), now: new Date(), options: threeOptions() }));

  step('Sketch: a new sketch is saved as a draft, survives a reload, and can be sent as a request with its picture');
  await go(page, '#/~hub/sketch');
  await page.locator('a:has-text("New sketch")').click();
  await stroke(page);
  await page.locator('.drawing-bar button', { hasText: /^Save$/ }).click();
  await page.locator('.drawing-state', { hasText: 'Saved' }).waitFor();
  const drafts = [...fixture.fake.objects.keys()].filter(key => /inbox\/drawings\/[^/]+\/drawing\.excalidraw$/.test(key));
  assert.equal(drafts.length, 1);
  const draftId = drafts[0].split('/').at(-2);
  assert.match(page.url(), new RegExp(`#/~hub/sketch/${draftId}$`), 'The address names the draft after the first save.');
  await page.locator('.drawing-bar button', { hasText: /^Done$/ }).click();
  await page.locator('.hub-sketch-big img').waitFor();
  await page.reload();
  await page.locator('.hub-sketch-big img').waitFor();
  await page.locator('button:has-text("Edit")').click();
  await page.locator('.drawing-editor canvas.interactive').waitFor();
  await page.waitForTimeout(900);
  const inked = await page.evaluate(() => {
    const canvas = document.querySelector('.drawing-editor canvas.static') ?? document.querySelector('.drawing-editor canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] < 200 || data[index + 1] < 200) count += 1;
    return count;
  });
  assert.ok(inked > 50, 'The stroke is on the canvas after a reload.');
  await page.locator('.drawing-bar button', { hasText: /^Cancel$/ }).click();
  await page.locator('[aria-label="Send to agent"]').waitFor();
  await page.locator('[aria-label="Send to agent"] .hub-chip', { hasText: 'Probe' }).click();
  await page.locator('[aria-label="Send to agent"] textarea').fill('Make the arc look like my sketch');
  await page.locator('button:has-text("Send request")').click();
  await page.locator('.hub-ok', { hasText: 'Sent as' }).waitFor();
  const sketchRequest = [...fixture.fake.objects.keys()].find(key => /requests\/[^/]+-probe-make-the-arc[^/]*\/request\.png$/.test(key));
  assert.ok(sketchRequest, 'The request carries the sketch picture.');
  assert.ok(fixture.fake.objects.get(sketchRequest).body.subarray(0, 8).equals(PNG_SIGNATURE));
  await page.locator('[aria-label="Send to agent"] [role="tab"]', { hasText: 'Answer an Ask' }).click();
  await page.locator('[aria-label="Send to agent"] .hub-row-button').first().waitFor();

  step('phone width with touch: the same Ask answer with a drawing, no page errors');
  await sendWithDrawing(phone, askJson({ id: askId('touch', 'e5f6'), now: new Date(), options: threeOptions() }));

  step('reviews: Open report only with a report link, Mark done always, one click clears the row for good');
  const reviewsIn = () => fixture.fake.objects.keys();
  const doneEvents = () => [...reviewsIn()].filter(key => key.includes('/events/') && fixture.fake.json(key)?.kind === 'review-done').map(key => fixture.fake.json(key));
  fixture.seed.event(eventJson({ kind: 'ready-for-review', ts: new Date(Date.now() - 3 * 60000), title: 'Report-only review', card: 'https://example.test/section#/report' }));
  const bareFile = fixture.seed.event(eventJson({ kind: 'ready-for-review', ts: new Date(Date.now() - 2 * 60000), title: 'Bare review' }));
  await page.goto(`${fixture.url}#/~hub/inbox/reviews`);
  await page.locator('.hub-row', { hasText: 'Bare review' }).waitFor();
  const reportRow = page.locator('.hub-row', { hasText: 'Report-only review' });
  const bareRow = page.locator('.hub-row', { hasText: 'Bare review' });
  assert.equal(await reportRow.locator('a.hub-btn', { hasText: 'Open report' }).getAttribute('href'), 'https://example.test/section#/report');
  assert.equal(await reportRow.locator('a.hub-btn').count(), 1);
  assert.equal(await bareRow.locator('a.hub-btn').count(), 0, 'A review with no link has no link button.');
  assert.equal(await page.locator('.hub-row').count(), 3);
  assert.equal(await page.locator('.hub-row button', { hasText: 'Mark done' }).count(), 3, 'Every review can be marked done.');
  assert.equal(await page.locator('[data-readonly-note]').count(), 0);
  await noSideways(page, 'Reviews');
  await phone.goto(`${fixture.url}#/~hub/inbox/reviews`);
  await phone.locator('.hub-row', { hasText: 'Bare review' }).waitFor();
  assert.equal(await phone.locator('.hub-row button', { hasText: 'Mark done' }).count(), 3, 'The buttons stay on a phone.');
  await noSideways(phone, 'Reviews at phone width');
  const plainTitle = await bareRow.locator('.hub-row-title').boundingBox();
  const plainButton = await bareRow.locator('button', { hasText: 'Mark done' }).boundingBox();
  assert.ok(plainButton.y < plainTitle.y + plainTitle.height && plainButton.y + plainButton.height > plainTitle.y, 'Without a note the button sits beside the title.');
  await page.route('**/api/hub/reviews/*/done', route => route.fulfill({ status: 500, body: '{"error":"Test failure"}', contentType: 'application/json' }), { times: 1 });
  await bareRow.locator('button', { hasText: 'Mark done' }).click();
  await bareRow.locator('.hub-error', { hasText: 'Test failure' }).waitFor();
  await noteUnderTitle(bareRow, '.hub-error', 'a failed Mark done');
  assert.ok(await bareRow.locator('button', { hasText: 'Mark done' }).isEnabled(), 'Mark done stays available after an error.');
  assert.equal(doneEvents().length, 0, 'The failed click wrote nothing.');
  await page.unroute('**/api/hub/reviews/*/done');
  const badgeBefore = Number(await page.locator('[data-hub-inbox-badge]').innerText());
  assert.equal(Number(await page.locator('[data-hub-tab-badge]').textContent()), badgeBefore, 'Both badges agree before.');
  await bareRow.locator('button', { hasText: 'Mark done' }).click();
  await bareRow.waitFor({ state: 'detached' });
  await page.waitForFunction(n => document.querySelector('[data-hub-inbox-badge]')?.textContent === String(n) && document.querySelector('[data-hub-tab-badge]')?.textContent === String(n) && document.querySelector('[data-hub-badge]')?.textContent === String(n), badgeBefore - 1, { timeout: 5000 });
  assert.equal(doneEvents().length, 1);
  assert.equal(doneEvents()[0].review, bareFile);
  await page.reload();
  await page.locator('.hub-row', { hasText: 'Report-only review' }).waitFor();
  assert.equal(await page.locator('.hub-row', { hasText: 'Bare review' }).count(), 0, 'Still gone after a reload.');
  assert.equal(await page.locator('.hub-row').count(), 2);

  step('blocked: a link opens the session, the desktop link sits beside it, no link says where to go, and a later event clears the row');
  const LINKED = 'https://claude.ai/code/session_TESTabc123';
  const APP = 'claude://claude.ai/epitaxy/local_00000000-0000-0000-0000-000000000001';
  fixture.seed.event(eventJson({ kind: 'blocked', ts: new Date(Date.now() - 2 * 60000), session: 'sess-linked', title: 'Linked session needs permission', url: LINKED, appUrl: APP }));
  await page.goto(`${fixture.url}#/~hub/inbox/blocked`);
  const linked = page.locator('.hub-row[data-blocked]', { hasText: 'Linked session' });
  await linked.waitFor();
  assert.equal(await page.locator('.hub-row[data-blocked]').count(), 2);
  assert.equal(await linked.locator('[data-link="session"]').getAttribute('href'), LINKED);
  assert.equal(await linked.locator('[data-link="session"]').getAttribute('target'), '_blank');
  assert.equal(await linked.locator('[data-link="app"]').getAttribute('href'), APP);
  assert.equal(await linked.locator('[data-link="app"]').getAttribute('target'), null);
  assert.equal(await linked.locator('[data-blocked-hint]').count(), 0, 'A linked row has no hint.');
  assert.equal(await page.locator('.hub-row[data-blocked]', { hasText: 'Permission needed' }).locator('[data-link]').count(), 0);
  await noSideways(page, 'Blocked');
  await phone.goto(`${fixture.url}#/~hub/inbox/blocked`);
  const phoneLinked = phone.locator('.hub-row[data-blocked]', { hasText: 'Linked session' });
  await phoneLinked.waitFor();
  const phoneBare = phone.locator('.hub-row[data-blocked]', { hasText: 'Permission needed' });
  await phoneBare.locator('[data-blocked-hint]').waitFor({ state: 'visible' });
  assert.equal(await phoneLinked.locator('[data-link="session"]').isVisible(), true, 'The session button stays on a phone.');
  assert.equal(await phoneLinked.locator('[data-link="app"]').isVisible(), false, 'The desktop link is not offered on a touch screen.');
  await noSideways(phone, 'Blocked at phone width');
  fixture.seed.event(eventJson({ kind: 'resumed', ts: new Date(), session: 'sess-linked', title: 'probe: back at work' }));
  await page.reload();
  await page.locator('.hub-row[data-blocked]', { hasText: 'Permission needed' }).waitFor();
  assert.equal(await page.locator('.hub-row[data-blocked]', { hasText: 'Linked session' }).count(), 0, 'resumed clears it, even after a reload.');
  assert.equal(await page.locator('.hub-row[data-blocked]').count(), 1);

  // Part 4: Chat against the fake Hermes, and push-to-talk with a fake microphone.
  step('chat off: without Hermes there is no Chat row and the screen says so');
  assert.equal(await page.locator('[data-hub-link="chat"]').count(), 0);
  await go(page, '#/~hub/chat');
  await page.locator('.hub-empty', { hasText: 'Chat is not set up on this host.' }).waitFor();

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let chatFixture;
  chatFixture = await startHubFixture({
    hermes: true,
    hermesOptions: {
      onTurn: async body => {
        if (!String(body.messages.at(-1)?.content).includes('file a request')) return;
        const id = `${stamp}-probe-from-hermes-h222`;
        chatFixture.fake.seed(`sections/inbox/requests/${id}/request.json`, JSON.stringify({ id, project: 'probe', createdAt: new Date().toISOString(), by: 'hermes-main', text: 'Hermes filed this request', when: 'next-sprint' }), 'application/json');
      },
    },
  });
  const micBrowser = await chromium.launch({ headless: true, channel, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const context = await micBrowser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
    const talk = await context.newPage();
    talk.setDefaultTimeout(15000);
    talk.on('pageerror', error => { throw error; });
    await talk.goto(chatFixture.url);
    await talk.locator('[data-hub-link="chat"]').waitFor();

    step('chat: a message streams back as Hello there, and the conversation is listed and saved');
    await talk.locator('[data-hub-link="chat"]').click();
    await talk.locator('textarea[aria-label="Message"]').fill('What happened today?');
    await talk.keyboard.press('Enter');
    await talk.locator('.hub-bubble.assistant', { hasText: 'Hello there' }).waitFor();
    await talk.locator('[data-conversation]').waitFor();
    const saved = [...chatFixture.fake.objects.keys()].filter(key => /inbox\/chat\/[^/]+\.jsonl$/.test(key));
    assert.equal(saved.length, 1);
    assert.equal(chatFixture.fake.text(saved[0]).trim().split('\n').length, 2);
    assert.match(talk.url(), /#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/, 'The address names the conversation.');

    step('chat: something Hermes filed shows as a card, and Open lands on Inbox / Requests');
    await talk.locator('textarea[aria-label="Message"]').fill('Please file a request for me');
    await talk.locator('button:has-text("Send")').click();
    await talk.locator('[data-created="request"]').waitFor();
    await talk.locator('[data-created="request"] a:has-text("Open")').click();
    await talk.locator('.hub[data-screen="inbox"]').waitFor();
    assert.match(talk.url(), /#\/~hub\/inbox\/requests$/);
    await talk.locator('.hub-row', { hasText: 'Hermes filed this request' }).waitFor();

    step('push-to-talk: holding the microphone for about a second puts the text in the box, unsent');
    await go(talk, '#/~hub/chat');
    const mic = talk.locator('.hub-mic');
    await mic.waitFor();
    const box = await mic.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, 'The microphone button is at least 44 px.');
    await talk.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await talk.mouse.down();
    await talk.locator('.hub-listening').waitFor();
    await talk.waitForTimeout(1200);
    await talk.mouse.up();
    await talk.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]').value.includes('hello from the fake mic'));
    assert.equal(await talk.locator('.hub-bubble.user').count(), 0, 'The text is not sent by itself.');

    step('chat pictures: attach, remove, attach again, send; Hermes sees an image part and the bubble shows the picture');
    await go(talk, '#/~hub/chat');
    await talk.locator('textarea[aria-label="Message"]').fill('');
    const attach = talk.locator('.hub-attach');
    await attach.waitFor();
    assert.equal(await attach.getAttribute('aria-label'), 'Attach pictures');
    const sendButton = talk.locator('.hub-compose button:has-text("Send")');
    assert.equal(await sendButton.isDisabled(), true, 'Nothing to send yet.');
    const probe = { name: 'probe.png', mimeType: 'image/png', buffer: solidPng(60, 40) };
    await talk.locator('[data-attach-input]').setInputFiles(probe);
    await talk.locator('.hub-tray-item img').waitFor();
    assert.equal(await sendButton.isDisabled(), false, 'A picture alone can be sent.');
    await talk.locator('button[aria-label="Remove picture 1"]').click();
    assert.equal(await talk.locator('.hub-tray-item').count(), 0);
    assert.equal(await sendButton.isDisabled(), true);
    await talk.locator('[data-attach-input]').setInputFiles(probe);
    await talk.locator('.hub-tray-item img').waitFor();
    await sendButton.click();
    await talk.locator('.hub-bubble.assistant', { hasText: 'Hello there' }).waitFor();
    const seen = chatFixture.hermes.requests.at(-1).messages.at(-1).content;
    assert.ok(Array.isArray(seen) && seen.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')), 'Hermes saw an image part.');
    await talk.locator('.hub-bubble.user img').waitFor();
    assert.ok(await talk.locator('.hub-bubble.user img').first().evaluate(image => image.complete && image.naturalWidth > 0), 'The bubble shows the picture.');
    assert.equal(await talk.locator('.hub-tray-item').count(), 0, 'The tray is empty after sending.');

    step('chat pictures: pasting a picture into the message box puts it in the tray');
    await go(talk, '#/~hub/chat');
    await talk.locator('textarea[aria-label="Message"]').waitFor();
    await talk.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.querySelector('textarea[aria-label="Message"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, solidPng(30, 30).toString('base64'));
    await talk.locator('.hub-tray-item img').waitFor();

    step('chat pictures: Hermes refusing them shows the error and puts the text and the thumbnail back');
    const refusing = await startHubFixture({ hermes: true, hermesOptions: { refuseImages: true } });
    try {
      const refused = await context.newPage();
      refused.setDefaultTimeout(15000);
      refused.on('pageerror', error => { throw error; });
      await refused.goto(refusing.url);
      await refused.locator('[data-hub-link="chat"]').click();
      await refused.locator('textarea[aria-label="Message"]').fill('what is this?');
      await refused.locator('[data-attach-input]').setInputFiles(probe);
      await refused.locator('.hub-tray-item img').waitFor();
      await refused.locator('.hub-compose button:has-text("Send")').click();
      await refused.locator('.hub-error', { hasText: 'Hermes could not take the picture' }).waitFor();
      assert.equal(await refused.locator('textarea[aria-label="Message"]').inputValue(), 'what is this?');
      assert.equal(await refused.locator('.hub-tray-item img').count(), 1, 'The thumbnail is back.');
      assert.equal([...refusing.fake.objects.keys()].filter(key => key.includes('/chat/')).length, 0, 'Nothing was saved.');
      await refused.close();
    } finally {
      await refusing.close();
    }

    step('chat at phone width: the drawer opens and the message box and microphone fit');
    const small = await micBrowser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['microphone'] });
    const phoneChat = await small.newPage();
    phoneChat.setDefaultTimeout(15000);
    phoneChat.on('pageerror', error => { throw error; });
    await phoneChat.goto(chatFixture.url);
    await phoneChat.locator('.sidebar-list').waitFor();
    await go(phoneChat, '#/~hub/chat');
    await phoneChat.locator('.hub-chat').waitFor();
    await phoneChat.waitForTimeout(300);
    assert.equal(await phoneChat.locator('.hub-chat-list').isVisible(), false, 'The list is a drawer on a phone.');
    await phoneChat.locator('button:has-text("Chats")').click();
    await phoneChat.locator('.hub-chat-list').waitFor();
    await phoneChat.locator('button:has-text("Chats")').click();
    for (const selector of ['textarea[aria-label="Message"]', '.hub-mic']) {
      const where = await phoneChat.locator(selector).boundingBox();
      assert.ok(where && where.x >= 0 && where.x + where.width <= 390 && where.y + where.height <= 844, `${selector} fits on screen.`);
    }
    await noSideways(phoneChat, 'Chat');
    step('chat pictures at phone width: the compose row fits, buttons are 44 px, the tray wraps and holds four');
    await phoneChat.locator('[data-attach-input]').setInputFiles([1, 2, 3, 4, 5].map(n => ({ name: `p${n}.png`, mimeType: 'image/png', buffer: solidPng(50 + n, 40) })));
    await phoneChat.locator('.hub-tray-item').nth(3).waitFor();
    await phoneChat.locator('.hub-tray-note', { hasText: 'at most 4' }).waitFor();
    assert.equal(await phoneChat.locator('.hub-tray-item').count(), 4, 'A fifth picture is refused.');
    for (const selector of ['.hub-attach', '.hub-tray-remove']) {
      const where = await phoneChat.locator(selector).first().boundingBox();
      assert.ok(where.width >= 44 && where.height >= 44, `${selector} is at least 44 px.`);
    }
    const row = await Promise.all(['.hub-attach', 'textarea[aria-label="Message"]', '.hub-mic', '.hub-compose .hub-btn'].map(selector => phoneChat.locator(selector).boundingBox()));
    for (const where of row) assert.ok(where && where.x >= 0 && where.x + where.width <= 390, 'The compose row fits.');
    assert.ok(row.every((where, at) => at === 0 || where.x >= row[at - 1].x + row[at - 1].width - 1), 'The row is in order, attach first.');
    await noSideways(phoneChat, 'Chat with pictures');
    await small.close();
    await context.close();
  } finally {
    await micBrowser.close();
    await chatFixture.close();
  }

  step('Discord: an answer from a button says "via Discord", and an Ask that requires a passkey carries the tag');
  const discordFixture = await startHubFixture({ discordAsks: true });
  try {
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      const view = await open({ width, height });
      await view.goto(discordFixture.url);
      await view.locator('.sidebar-list').waitFor();
      await go(view, `#/~hub/ask/${DISCORD_ASK}`);
      await view.locator('.hub-answer').waitFor();
      const answered = await view.locator('.hub-answer').innerText();
      assert.match(answered, /by owner via Discord/);
      assert.match(answered, /A · Ship it/);
      assert.equal(await view.locator('.hub-steps li.tag').count(), 0, 'This Ask does not require a passkey.');
      await noSideways(view, `Discord answer at ${width}`);
      await go(view, `#/~hub/ask/${PASSKEY_ASK}`);
      await view.locator('.hub-steps li.tag', { hasText: 'Passkey only' }).waitFor();
      assert.equal(await view.locator('.hub-answer').count(), 0);
      await noSideways(view, `Passkey Ask at ${width}`);
    }
    const plain = await open({ width: 1280, height: 900 });
    await plain.goto(fixture.url);
    await go(plain, `#/~hub/ask/${FIXTURE_ASK}`);
    await plain.locator('.hub-steps').waitFor();
    assert.equal(await plain.locator('.hub-steps li.tag').count(), 0, 'An ordinary Ask has no tag.');
  } finally {
    await discordFixture.close();
  }

  console.log('hub-ui: parts 1 to 4 passed');
} catch (failure) {
  console.log('hub-ui diagnostics, last requests:', requestsSeen.slice(-12));
  throw failure;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
