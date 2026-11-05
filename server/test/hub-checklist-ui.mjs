// Run after npm run build. A checklist (#/~hub/checklist/<id>) through a real browser on a phone (390 x 844, touch), over
// the fixture service with its two checklists: the Steps chip and the Needs you badge, the guide that starts open, 44 px tap
// targets, Copy (a plain PowerShell block as one line), ticks that show at once and survive a reload, an untick, a failed tick, Submit with its one warning,
// the submitted list, and the read-only host. Nothing is ever overwritten: the bucket only gains files.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_CHECKLIST, COMMAND_LONG, COMMAND_MARKUP, COMMAND_ONE_LINE, FIXTURE_CHECKLIST, SUBMITTED_CHECKLIST, startHubFixture } from './hub-fixture.mjs';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ checklists: true });
// A second service for the items that carry a `command`: its own list, so the counts above hold.
const commands = await startHubFixture({ seedData: false, commandChecklist: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
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
  await page.goto(`${fixture.url}#/~hub/needs`);
  await page.locator('[data-hub-tab-badge]').waitFor();

  step('the Steps chip lists the open list with "1 of 4", the submitted one is history, and the Needs you badge counts it');
  assert.equal(await page.locator('[data-hub-tab-badge]').innerText(), '4', 'Three things wait in the fixture, and the list is a fourth.');
  // At phone width the filter is a native select (one option per filter), not a row of chips.
  const filter = page.locator('[data-needs-filter-select]');
  await filter.waitFor();
  await filter.locator('option[value="steps"]').waitFor({ state: 'attached' });
  await page.waitForFunction(() => /\(\d+\)/.test(document.querySelector('[data-needs-filter-select] option[value="steps"]')?.textContent ?? ''));
  assert.deepEqual(await filter.locator('option').evaluateAll(list => list.map(item => item.getAttribute('value'))), ['all', 'question', 'steps', 'unstick', 'pr', 'answered'], 'Filters with nothing in them hide.');
  assert.match(await filter.locator('option[value="steps"]').textContent(), /^Steps \(1\)$/, 'The count is on Steps.');
  assert.ok(await page.locator('.ni', { hasText: 'Finish the Discord bot setup' }).count() >= 1, 'The list is in Needs you too.');
  await filter.selectOption('steps');
  const row = page.locator('.ni', { hasText: 'Finish the Discord bot setup' });
  await row.waitFor();
  assert.match(await row.locator('[data-four]').innerText(), /1 of 4 done/);
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 1);
  assert.deepEqual(await page.locator('.ni .ni-t').allInnerTexts(), ['Finish the Discord bot setup'], 'Only open lists wait on you.');
  await filter.selectOption('answered');
  const history = page.locator('.hub-row', { hasText: 'Update the router settings' });
  await history.waitFor();
  assert.match(await history.locator('.hub-row-meta').innerText(), /^Steps · probe · Submitted · 1 open · /);
  await filter.selectOption('steps');
  await row.waitFor();
  await noSideways(page, 'Steps');

  step('opening it: the first open item with a guide is expanded, and a done item shows its time');
  await row.locator('.ni-t a').tap();
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
  await page.locator('[data-item="02"] pre').first().waitFor();
  assert.match(await page.locator('[data-item="02"] pre').first().innerText(), /bunnylink-secret set discord-bot-token/);
  assert.equal(await page.locator('[data-item="02"] .hub-cl-more a', { hasText: 'Open details' }).getAttribute('href'), 'https://example.test/discord/bot');
  assert.equal(await page.locator('[data-item="02"] .hub-cl-more a', { hasText: 'the portal guide' }).getAttribute('target'), '_blank');
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await noSideways(page, 'checklist');
  assert.equal(await page.locator('[data-paste-tip]').count(), 0, 'No paste tip on a phone.');
  assert.equal(await page.locator('[data-item="02"]').evaluate(row => getComputedStyle(row).outlineStyle), 'none', 'No target outline on a touch device.');

  step('every checkbox, the expand toggle, Copy and Submit are at least 44 px tall');
  await tall(page.locator('[data-box]'), 'a checkbox');
  await tall(page.locator('[data-toggle]'), 'an expand toggle');
  await tall(page.locator('.hub-copy'), 'Copy');
  await tall(page.locator('[data-submit]'), 'Submit');
  await tall(page.locator('.hub-cl .hub-btn'), 'a button');
  for (const box of await page.locator('[data-box]').all()) assert.ok((await box.boundingBox()).width >= 44, 'and 44 px wide');

  step('Copy puts the block on the clipboard and says Copied; the ssh block keeps its lines');
  const [copyBash, copyPowerShell] = [page.locator('.hub-copy').nth(0), page.locator('.hub-copy').nth(1)];
  await copyBash.tap();
  await page.locator('.hub-copy', { hasText: /^Copied$/ }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard.split(/\r?\n/).join('\n'), 'ssh root@host.example.test\nbunnylink-secret set discord-bot-token');
  await page.locator('.hub-copy', { hasText: /^Copy$/ }).nth(1).waitFor({ timeout: ms(4000) });

  step('a plain multi-line PowerShell block is copied as one line, and the button says so');
  await copyPowerShell.tap();
  await page.locator('.hub-copy', { hasText: 'Copied as one line' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'cd C:\\Users\\owner\\discord-bot; npm run check');
  assert.match(await page.locator('[data-item="02"] pre').nth(1).innerText(), /discord-bot\nnpm run check/, 'The block still shows its two lines.');
  await page.locator('.hub-copy', { hasText: /^Copy$/ }).nth(1).waitFor({ timeout: ms(6000) });

  step('with a mouse, the first click on Copy copies (the step it is in becomes the target on pointerdown and re-renders)');
  const desk = await open({ width: 1100, height: 900 }, { permissions: ['clipboard-read', 'clipboard-write'] });
  await desk.goto(`${fixture.url}#/~hub/checklist/${FIXTURE_CHECKLIST}`);
  await desk.locator('[data-item="02"] pre').nth(1).waitFor();
  assert.equal(await desk.locator('.hub-cl-item.target').count(), 0, 'No step is the target yet, so the click below makes one.');
  await desk.locator('[data-item="02"] .hub-copy').nth(1).click();
  await desk.locator('.hub-copy', { hasText: 'Copied as one line' }).waitFor({ timeout: ms(3000) });
  assert.equal(await desk.evaluate(() => navigator.clipboard.readText()), 'cd C:\\Users\\owner\\discord-bot; npm run check');
  assert.equal(await desk.locator('[data-item="02"].target').count(), 1);

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
  await page.locator('[data-next-note]', { hasText: 'Submitted · next:' }).waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#\/~hub\/review\//, 'The next item in the queue is the review: its own page opens.');
  assert.equal(await page.locator('[data-next-back]').getAttribute('href'), `#/~hub/checklist/${FIXTURE_CHECKLIST}`);
  const submit = fixture.fake.json(`${prefix}submit.json`);
  assert.deepEqual({ note: submit.note, done: submit.done, open: submit.open, by: submit.by }, { note: 'Skipped the DMs.', done: ['01', '02'], open: ['03', '04'], by: 'local' });
  const events = [...fixture.fake.objects.keys()].filter(key => key.includes('/events/')).map(key => fixture.fake.json(key)).filter(event => event.kind === 'checklist-submitted');
  assert.equal(events.length, 1);
  assert.deepEqual({ checklist: events[0].checklist, summary: events[0].summary, title: events[0].title }, { checklist: FIXTURE_CHECKLIST, summary: '2 of 4 done', title: 'Submitted: Finish the Discord bot setup' });
  await page.waitForFunction(() => document.querySelector('[data-hub-tab-badge]')?.textContent === '3');
  await go(page, '#/~hub/needs');
  await page.locator('.ni').first().waitFor();
  assert.equal(await page.locator('.ni', { hasText: 'Finish the Discord bot setup' }).count(), 0, 'Gone from Needs you.');
  await filter.selectOption('answered');
  const submittedRow = page.locator('.hub-row', { hasText: 'Finish the Discord bot setup' });
  await submittedRow.waitFor();
  assert.match(await submittedRow.locator('.hub-row-meta').innerText(), /^Steps · probe · Submitted · 2 open · /);

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
  await page.locator('[data-needs-filter-select]').waitFor();
  assert.equal(await page.locator('[data-needs-filter-select]').inputValue(), 'steps');

  step('a read-only host shows the list, says "Sign in to tick items." and sends nothing');
  const dist = path.join(root, 'dist');
  const detail = {
    id: FIXTURE_CHECKLIST, project: 'probe', createdAt: new Date().toISOString(), from: { host: 'pc.example.test' }, title: 'A read-only list', state: 'open', done: 0, total: 2, files: [],
    items: [{ id: '01', text: 'First step', done: false }, { id: '02', text: 'Second step', done: false, guide: 'Do the **thing**.' }],
  };
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, reason: 'Read-only here: sign in at https://site.example.test to change cards.' },
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
  await listenOnGoodPort(stub, '127.0.0.1');
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

  step('an item with a command shows it under the text as a block with Copy; an item without one is unchanged (390 px)');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  await phone.goto(`${commands.url}#/~hub/checklist/${COMMAND_CHECKLIST}`);
  await phone.locator('[data-item="01"] [data-command] pre').waitFor();
  assert.equal(await phone.locator('[data-command]').count(), 4, 'Four items carry a command.');
  assert.equal(await phone.locator('[data-item="04"] [data-command]').count(), 0, 'The item without a command has no block.');
  assert.equal(await phone.locator('[data-item="04"] .hub-copy').count(), 0, 'and no Copy button.');
  assert.equal(await phone.locator('[data-item="04"] .hub-cl-title').innerText(), 'Tick this when it worked');
  assert.equal(await phone.locator('[data-item="01"] [data-command] pre').innerText(), COMMAND_ONE_LINE, 'The block holds the command and nothing else.');
  assert.equal(await phone.locator('[data-item="01"] [data-command] code').getAttribute('class'), 'language-bash');
  const order = await phone.locator('[data-item="01"]').evaluate(row => [row.querySelector('.hub-cl-line').getBoundingClientRect().bottom, row.querySelector('[data-command]').getBoundingClientRect().top]);
  assert.ok(order[1] >= order[0] - 1, 'The command sits under the item text.');
  await noSideways(phone, 'the command list');

  step('inline `code` in the item text is code, without a Copy button');
  assert.equal(await phone.locator('[data-item="01"] .hub-cl-title code').innerText(), 'gh');
  assert.equal(await phone.locator('[data-item="01"] .hub-cl-title .hub-copy').count(), 0);
  assert.ok(!(await phone.locator('[data-item="01"] .hub-cl-title').innerText()).includes('`'), 'The backticks are gone.');

  step('Copy puts exactly the command on the clipboard, and is at least 44 px square beside the text');
  await tall(phone.locator('[data-command] .hub-copy'), 'the Copy of a command');
  for (const button of await phone.locator('[data-command] .hub-copy').all()) assert.ok((await button.boundingBox()).width >= 44, 'and 44 px wide');
  const place = await phone.locator('[data-item="02"] [data-command]').evaluate(block => {
    const pre = block.querySelector('pre').getBoundingClientRect();
    const button = block.querySelector('.hub-copy').getBoundingClientRect();
    return { preHeight: pre.height, preWidth: pre.width, buttonWidth: button.width, buttonBottom: button.bottom, preTop: pre.top, buttonLeftEdge: button.left, buttonRight: button.right, view: innerWidth };
  });
  assert.ok(place.buttonBottom <= place.preTop + 1, 'On a narrow screen Copy sits above the command, not beside it.');
  assert.ok(Math.abs(place.buttonWidth - place.preWidth) <= 1, 'Copy is as wide as the command block.');
  assert.ok(place.preHeight >= 24, `The command block keeps its height (${Math.round(place.preHeight)} px).`);
  assert.ok(place.preWidth > 300, `The command gets the row (${Math.round(place.preWidth)} px).`);
  assert.ok(place.buttonRight <= place.view && place.buttonLeftEdge >= 0, 'and on the screen.');
  await phone.locator('[data-item="01"] .hub-copy').tap();
  await phone.locator('[data-item="01"] .hub-copy', { hasText: /^Copied$/ }).waitFor();
  assert.equal(await phone.evaluate(() => navigator.clipboard.readText()), COMMAND_ONE_LINE, 'No prompt, no newline, no prose.');
  await phone.locator('[data-item="02"] .hub-copy').tap();
  await phone.locator('[data-item="02"] .hub-copy', { hasText: /^Copied$/ }).waitFor();
  assert.equal(await phone.evaluate(() => navigator.clipboard.readText()), COMMAND_LONG);
  await phone.locator('[data-item="03"] .hub-copy').tap();
  await phone.locator('[data-item="03"] .hub-copy', { hasText: 'Copied as one line' }).waitFor();
  assert.equal(await phone.evaluate(() => navigator.clipboard.readText()), 'cd C:\\Users\\owner\\app; npm run check', 'A PowerShell command follows the PowerShell rule of Copy.');

  step('a long command scrolls sideways inside its block instead of wrapping, and the text stays selectable');
  const scroll = await phone.locator('[data-item="02"] [data-command] pre').evaluate(pre => ({ scroll: pre.scrollWidth, client: pre.clientWidth, white: getComputedStyle(pre).whiteSpace, overflow: getComputedStyle(pre).overflowX, select: getComputedStyle(pre).userSelect, lines: Math.round(pre.getBoundingClientRect().height / parseFloat(getComputedStyle(pre).lineHeight || '16')) }));
  assert.ok(scroll.scroll > scroll.client, 'The command is wider than the block.');
  assert.equal(scroll.white, 'pre');
  assert.equal(scroll.overflow, 'auto');
  assert.notEqual(scroll.select, 'none');
  assert.ok(scroll.lines <= 3, `One line of text, not wrapped (${scroll.lines} lines tall).`);
  await noSideways(phone, 'the long command');

  step('a command is text: markup in it is shown, not rendered');
  assert.equal(await phone.locator('[data-item="05"] [data-command] pre').innerText(), COMMAND_MARKUP);
  assert.equal(await phone.locator('[data-item="05"] [data-command] :is(b, img, em)').count(), 0, 'No element was made from the command.');

  step('on a wide screen Copy stays beside the command, at the top, as before');
  const wide = await open({ width: 1280, height: 900 }, { permissions: ['clipboard-read', 'clipboard-write'] });
  await wide.goto(`${commands.url}#/~hub/checklist/${COMMAND_CHECKLIST}`);
  await wide.locator('[data-item="02"] [data-command] pre').waitFor();
  const side = await wide.locator('[data-item="02"] [data-command]').evaluate(block => {
    const pre = block.querySelector('pre').getBoundingClientRect();
    const button = block.querySelector('.hub-copy').getBoundingClientRect();
    return { preRight: pre.right, buttonLeft: button.left, buttonTop: button.top, preTop: pre.top };
  });
  assert.ok(side.buttonLeft >= side.preRight - 1, 'The button does not overlap the text.');
  assert.ok(side.buttonTop <= side.preTop + 8, 'The button is at the top of the block.');
  await wide.locator('[data-item="02"] .hub-copy').click();
  await wide.locator('[data-item="02"] .hub-copy', { hasText: /^Copied$/ }).waitFor();
  assert.equal(await wide.evaluate(() => navigator.clipboard.readText()), COMMAND_LONG, 'Copy still copies exactly the command.');

  console.log('hub-checklist-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
  await commands.close();
}
