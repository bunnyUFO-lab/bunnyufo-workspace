// Run after npm run build. The Hub polish from QA Run 2 (ws-rqc) through a real browser: the Today clock in the Hub's own
// format, a card opening on its first tab unless the address names one, Escape on a dots menu, the way back from a
// Needs you item landing on the chip it came from, the Answered chip without picked-up work and a submitted list read as
// Steps, the "Written by" warning only while a request can still be approved; and, over a stand-in for the signed-out
// site, chats with one title told apart by their time and a note where Chat would be for a visitor who may only read.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CHECKLIST, SUBMITTED_CHECKLIST, askId, startHubFixture } from './hub-fixture.mjs';
import { askJson, checklistJson, minutesAgo, plainOptions } from '../../site/api/test/hub-fixtures.mjs';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ checklists: true, cardTabs: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'en-US', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
let stub = null;

try {
  const page = await open({ width: 1280, height: 800 });

  step('Today: the eyebrow clock is in the same 12 hour format as every other time in the Hub');
  await page.goto(`${fixture.url}#/~hub/today`);
  const eyebrow = page.locator('[data-today-eyebrow]');
  await eyebrow.waitFor();
  const text = await eyebrow.innerText();
  assert.match(text, /· \d{2}:\d{2} (AM|PM)$/, `The clock reads like the rest of the Hub: ${text}`);

  step('a card opens on its first tab; the address can name another');
  await page.goto(`${fixture.url}#/hub`);
  await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Notes' }).waitFor();
  assert.equal(await page.locator('[role="tab"]').count(), 2);
  await page.goto(`${fixture.url}#/hub/1`);
  await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Old: Draft 1' }).waitFor();

  step('Escape closes a dots menu and the focus goes back to the button that opened it');
  await page.goto(`${fixture.url}#/hub`);
  const more = page.locator('button[aria-label="More for this card"]');
  await more.waitFor();
  await more.click();
  await page.locator('[role="menu"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[role="menu"]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'More for this card');
  assert.match(page.url(), /#\/hub$/, 'Escape closed the menu and did not also leave the card.');

  step('Needs you: back from a checklist lands on the Steps chip, not on All');
  await page.goto(`${fixture.url}#/~hub/needs/steps`);
  await page.locator(`.ni[data-need="checklist-${FIXTURE_CHECKLIST}"]`).waitFor();
  await page.locator(`.ni[data-need="checklist-${FIXTURE_CHECKLIST}"] .ni-t a`).click();
  await page.locator('[data-back-top]').click();
  await page.waitForURL(/#\/~hub\/needs\/steps$/);
  assert.equal(await page.locator('.hub-chip.on').getAttribute('data-filter'), 'steps');

  step('Answered: an answered Ask and a submitted list are there, picked-up work is not, and the list reads as Steps');
  const pickedAsk = askJson({ id: askId('picked-up-ask', 'p1p1'), now: minutesAgo(fixture.now, 60), question: 'Picked up question', options: plainOptions() });
  const answeredAsk = askJson({ id: askId('answered-ask', 'a1a1'), now: minutesAgo(fixture.now, 50), question: 'Answered question', options: plainOptions() });
  fixture.seed.ask(pickedAsk, { files: { 'answer.json': { at: minutesAgo(fixture.now, 40).toISOString(), by: 'owner', choice: 'A' }, 'pickup.json': { at: minutesAgo(fixture.now, 30).toISOString(), host: 'pc.example.test' } } });
  fixture.seed.ask(answeredAsk, { files: { 'answer.json': { at: minutesAgo(fixture.now, 20).toISOString(), by: 'owner', choice: 'A' } } });
  const pickedList = checklistJson({ id: `${SUBMITTED_CHECKLIST.slice(0, -4)}f3f3`, now: minutesAgo(fixture.now, 200), title: 'Picked up list', items: [{ text: 'One thing', group: 'A' }] });
  fixture.seed.checklist(pickedList, [{ item: '01', at: minutesAgo(fixture.now, 190) }]);
  fixture.seed.submit(pickedList.id, { at: minutesAgo(fixture.now, 100).toISOString(), done: ['01'], open: [] });
  fixture.seed.put(`checklists/${pickedList.id}/pickup.json`, { at: minutesAgo(fixture.now, 90).toISOString(), host: 'pc.example.test' });
  await page.goto(`${fixture.url}#/~hub/needs/answered`);
  await page.locator('.hub-row', { hasText: 'Answered question' }).waitFor();
  const rows = await page.locator('.hub-panel .hub-row').allInnerTexts();
  assert.ok(rows.some(row => row.includes('Update the router settings')), 'The submitted list is history.');
  assert.ok(!rows.some(row => /Picked up/.test(row)), `No picked-up row: ${rows.join(' | ')}`);
  assert.ok(!rows.some(row => /To do/.test(row)), 'A sent list is not "To do".');
  const submitted = page.locator('.hub-row', { hasText: 'Update the router settings' });
  assert.match(await submitted.innerText(), /Steps/);
  assert.match(await submitted.innerText(), /Submitted/);

  step('a request: the "Written by" warning is there while it can be approved, and gone once it is done');
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const proposal = (id, text) => ({ id, project: 'probe', createdAt: minutesAgo(fixture.now, 10).toISOString(), by: 'hermes', text, preset: 'code-task', repo: 'example/probe', target: 'at-pc', origin: { kind: 'agent', name: 'hermes' } });
  const waiting = `${day}-probe-polish-open-w1w1`;
  const finished = `${day}-probe-polish-done-w2w2`;
  fixture.seed.request(proposal(waiting, 'Still to approve'));
  fixture.seed.request(proposal(finished, 'Already done'));
  fixture.seed.put(`requests/${finished}/result.json`, { v: 1, outcome: 'manual', summary: 'Done by hand', by: 'hub', at: minutesAgo(fixture.now, 2).toISOString() });
  await page.goto(`${fixture.url}#/~hub/request/${waiting}`);
  await page.locator('[data-approval-warning]').waitFor();
  assert.match(await page.locator('[data-approval-warning]').innerText(), /Written by hermes, not by you/);
  await page.goto(`${fixture.url}#/~hub/request/${finished}`);
  await page.locator('h2, h3', { hasText: /Already done|done/i }).first().waitFor();
  await page.waitForTimeout(500);
  assert.match(await page.locator('.hub').innerText(), /Done by hand|done/i, 'The page loaded the finished request.');
  assert.equal(await page.locator('[data-approval-warning]').count(), 0, 'A finished request is not asked to be read before approving.');

  step('chat: two chats with one title carry the time they were last used; a lone title does not (over a stand-in site)');
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: true, reason: 'Read-only here: sign in at https://site.example.test to change cards.' },
    '/api/card-state': { cards: {} },
    '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
    '/w/one/workspace.json': { entities: [] },
    '/api/hub/chat': { conversations: [
      { id: '20261030-aaaaaa', title: 'Plan the week', updated: new Date().toISOString(), count: 4 },
      { id: '20261029-bbbbbb', title: 'Plan the week', updated: '2026-10-29T08:05:00.000Z', count: 2 },
      { id: '20261028-cccccc', title: 'Something else', updated: '2026-10-28T08:05:00.000Z', count: 1 },
    ] },
    '/api/hub/today': { counts: { needsYou: 0, running: 0, recent: 0, alerts: 0 }, needsYou: [], running: [], recent: [], alerts: [], at: new Date().toISOString() },
  };
  const dist = path.join(root, 'dist');
  stub = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://site');
    const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    if (canned[url.pathname]) return send(200, 'application/json', JSON.stringify(canned[url.pathname]));
    if (url.pathname.startsWith('/api/')) return send(404, 'application/json', '{"error":"none"}');
    try {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return send(200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', await readFile(path.join(process.env.BUW_FIXTURE_DIST || dist, file)));
    } catch { return send(200, 'text/html', await readFile(path.join(process.env.BUW_FIXTURE_DIST || dist, 'index.html'))); }
  });
  await listenOnGoodPort(stub, '127.0.0.1');
  const site = `http://127.0.0.1:${stub.address().port}`;
  const guest = await open({ width: 1280, height: 800 });
  await guest.goto(`${site}/one#/~hub/chat`);
  await guest.locator('[data-conversation]').first().waitFor();
  const times = await guest.locator('[data-conversation]').evaluateAll(list => list.map(item => item.querySelector('[data-conversation-time]')?.textContent ?? null));
  assert.ok(times[0] && times[1], `Both "Plan the week" chats show a time: ${times}`);
  assert.notEqual(times[0], times[1], 'The two times differ.');
  assert.equal(times[2], null, 'A title that is alone shows no time.');
  assert.match(times[0], /^\d{2}:\d{2} (AM|PM)$/, 'Today is just the time, in the Hub clock.');
  assert.match(times[1], /^Oct 2\d, \d{2}:\d{2} (AM|PM)$/, 'Another day carries its date.');

  step('read-only: a note where Chat would be, in the sidebar and in the phone\'s More sheet; none for a visitor who has Chat');
  canned['/api/capabilities'].chat = false;
  const readOnly = await open({ width: 1280, height: 800 });
  await readOnly.goto(`${site}/one#/~hub/today`);
  const note = readOnly.locator('.sidebar-hub [data-hub-chat-note]');
  await note.waitFor();
  assert.match(await note.innerText(), /Chat .*signed in/);
  assert.equal(await readOnly.locator('.sidebar-hub [data-hub-link="chat"]').count(), 0);
  const phone = await open({ width: 390, height: 800 });
  await phone.goto(`${site}/one#/~hub/today`);
  await phone.locator('[data-hub-tab="more"]').click();
  await phone.locator('.hub-more [data-hub-chat-note]').waitFor();
  const width = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(width.scroll <= width.inner, 'No sideways scroll at 390 px.');
  assert.equal(await guest.locator('[data-hub-chat-note]').count(), 0, 'A visitor who has Chat is not told it needs signing in.');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await new Promise(resolve => (stub ? stub.close(resolve) : resolve()));
  await fixture.close();
}
console.log('hub-polish-ui: passed');
