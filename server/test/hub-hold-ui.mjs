// Run after npm run build. The hold (ws-cl0.6.5): an answer waits seven seconds in the browser, with Undo, before it reaches an agent.
// This file uses the REAL seven seconds, through a real browser over the fixture service, at 390 and at 1280:
//   - the toast names what was answered, and no POST leaves in the first seconds;
//   - the item is out of Today, the Needs you list and the badge while it waits, and Undo puts it and the count back;
//   - after seven seconds exactly one POST; a double tap makes one;
//   - a hidden tab sends at once; a failed send brings the item back with the words of the error;
//   - leaving the screen keeps the hold;
//   - a passkey-only Ask is not held;
//   - the item page stays on the item, with Next item (nothing moves by itself), and Settings turns auto-advance on.
// The other ported tests set localStorage['hub.undoMs'] to 0 so they prove the same writes without waiting.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture, askId, FIXTURE_ASK, PASSKEY_ASK } from './hub-fixture.mjs';
import { askJson, minutesAgo, plainOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ discordAsks: true });
const SECOND = askId('second-arc', 'a1a1');
const THIRD = askId('third-arc', 'b2b2');
const FOURTH = askId('fourth-arc', 'c3c3');
const NOTE_FAIL = askId('note-fail', 'e5e5');
const NOTE_UNDO = askId('note-undo', 'f6f6');
const NOTE_PAGE = askId('note-page', 'a7a7');
for (const [id, question] of [[SECOND, 'Which landing sound?'], [THIRD, 'Which coyote time?'], [FOURTH, 'Which dust puff?'], [NOTE_FAIL, 'Which rim light?'], [NOTE_UNDO, 'Which fog?'], [NOTE_PAGE, 'Which bloom?']]) {
  fixture.seed.ask(askJson({ id, bead: 'bd-7f3c', now: minutesAgo(fixture.now, 5), question, options: plainOptions(), allowDrawing: false }));
}
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const posts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: viewport.width < 600, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/hub\/asks\/[^/]+\/answer$/.test(request.url())) posts.push({ id: request.url().split('/').at(-2), at: Date.now() }); });
  return page;
};
const eventually = async (check, limit = ms(15000)) => {
  const end = Date.now() + limit;
  for (;;) {
    try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
};
const badge = async page => Number(await page.locator('[data-hub-badge]').first().innerText().catch(() => '0'));
const postsFor = id => posts.filter(post => post.id === id).length;
const stored = id => fixture.fake.json(`sections/inbox/asks/${id}/answer.json`);
const title = page => page.locator('[data-today-title]').innerText();
const answerOn = async (page, id, letter) => {
  await page.evaluate(value => { location.hash = value; }, `#/~hub/ask/${id}`);
  await page.locator(`[data-option="${letter}"] button`).click();
  await page.locator('[data-send]').click();
};

try {
  const phone = await open({ width: 390, height: 844 });
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('[data-today-title]').waitFor();
  step('phone: Today says how many need you; the PC and Away line is one tap to Settings');
  const start = await eventually(async () => { const text = await title(phone); assert.match(text, /^\d+ need you$/); return Number(text.split(' ')[0]); });
  assert.equal(await badge(phone), start, 'The badge agrees with the title.');
  assert.equal(await phone.locator('[data-today-status]').getAttribute('href'), '#/~hub/settings');
  assert.equal(await phone.locator('.hub-kpis, [data-today-project], [data-today-eyebrow]').count(), 0, 'No tiles, no project picker, no eyebrow.');

  step('phone: answer an Ask from its page. A toast names it, you stay on it, and nothing is sent in the first seconds');
  await phone.evaluate(id => { location.hash = `#/~hub/ask/${id}`; }, FIXTURE_ASK);
  await phone.locator('[data-option="B"] button').waitFor();
  await phone.locator('[data-option="B"] button').tap();
  await phone.locator('[data-send]').tap();
  const toast = phone.locator('[data-undo-toast]');
  await toast.waitFor();
  assert.match(await toast.innerText(), /^Answered: Which jump arc feels right\?/);
  assert.equal(await toast.getByRole('button', { name: 'Undo' }).count(), 1);
  await phone.locator('[data-settled-bar][data-settled-phase="held"]').waitFor();
  assert.equal(await phone.locator('[data-send]').isVisible(), false, 'The form is out of the way while the answer is held.');
  assert.equal(await phone.evaluate(() => location.hash), `#/~hub/ask/${FIXTURE_ASK}`, 'You stay on the item.');
  await phone.waitForTimeout(2500);
  assert.equal(postsFor(FIXTURE_ASK), 0, 'No POST in the first seconds.');
  assert.equal(fixture.fake.objects.has(`sections/inbox/asks/${FIXTURE_ASK}/answer.json`), false);

  step('phone: the item is out of Today and the badge while it waits (one source of state)');
  await phone.evaluate(() => { location.hash = '#/~hub/today'; });
  await eventually(async () => assert.equal(await title(phone), `${start - 1 === 0 ? 'All clear' : `${start - 1} ${start - 1 === 1 ? 'needs' : 'need'} you`}`));
  assert.equal(await badge(phone), start - 1);
  assert.equal(await phone.locator('[data-nrow]', { hasText: 'Which jump arc feels right?' }).count(), 0);
  await phone.evaluate(() => { location.hash = '#/~hub/needs'; });
  await phone.locator('.ni').first().waitFor();
  assert.equal(await phone.locator('.ni', { hasText: 'Which jump arc feels right?' }).count(), 0, 'The Needs you list agrees.');
  await phone.evaluate(() => { location.hash = '#/~hub/today'; });

  step('phone: Undo puts it and the count back, flashes it, and the agent got nothing');
  await toast.getByRole('button', { name: 'Undo' }).tap();
  await eventually(async () => assert.equal(await title(phone), `${start} ${start === 1 ? 'needs' : 'need'} you`));
  assert.equal(await badge(phone), start);
  assert.match(await phone.locator('[data-undo-toast]').innerText(), /^Back in Needs you: Which jump arc feels right\?/);
  await phone.waitForTimeout(ms(500));
  assert.equal(postsFor(FIXTURE_ASK), 0, 'Undo means no POST, ever.');
  await phone.locator('[data-nrow]').first().tap();
  assert.match(await phone.evaluate(() => location.hash), /^#\/~hub\/(ask|review|checklist|request|needs)/, 'A Today row opens its item.');
  await phone.evaluate(id => { location.hash = `#/~hub/ask/${id}`; }, FIXTURE_ASK);
  await phone.locator('[data-option="B"] button').waitFor();
  assert.equal(await phone.locator('[data-settled-bar]').count(), 0, 'The page is the open item again.');

  step('phone: answer again and leave the screen. After seven seconds exactly one POST');
  await phone.locator('[data-option="B"] button').tap();
  const second = Date.now();
  await phone.locator('[data-send]').tap();
  await phone.locator('[data-settled-bar]').waitFor();
  await phone.evaluate(() => { location.hash = '#/~hub/library'; });
  await phone.waitForTimeout(3000);
  assert.equal(postsFor(FIXTURE_ASK), 0, 'Still held after leaving the screen.');
  await eventually(() => assert.equal(postsFor(FIXTURE_ASK), 1), ms(15000));
  const waited = posts.find(post => post.id === FIXTURE_ASK).at - second;
  assert.ok(waited >= 6500 && waited < 9500, `Sent after about seven seconds, not ${waited} ms.`);
  await eventually(() => assert.equal(stored(FIXTURE_ASK).choice, 'B'));
  assert.equal(postsFor(FIXTURE_ASK), 1, 'Exactly one POST.');

  step('phone: back on the item it says Answered, with Next item; nothing moved by itself');
  await phone.evaluate(id => { location.hash = `#/~hub/ask/${id}`; }, FIXTURE_ASK);
  await phone.locator('[data-settled-bar]').waitFor({ state: 'detached', timeout: ms(2000) }).catch(() => undefined);
  await phone.locator('.hub-answer').waitFor();
  const here = await phone.evaluate(() => location.hash);
  assert.equal(here, `#/~hub/ask/${FIXTURE_ASK}`);

  step('phone: answering stays on the item with Next item; tapping it opens another item');
  await answerOn(phone, SECOND, 'A');
  await phone.locator('[data-settled-bar] [data-next-item]').waitFor();
  assert.equal(await phone.evaluate(() => location.hash), `#/~hub/ask/${SECOND}`, 'No auto-advance by default.');
  await phone.locator('[data-settled-bar] [data-next-item]').tap();
  await phone.waitForFunction(id => !location.hash.includes(id), SECOND);
  assert.match(await phone.evaluate(() => location.hash), /^#\/~hub\/(ask|review|needs|checklist)/);
  await eventually(() => assert.equal(postsFor(SECOND), 1));

  step('phone: a hidden tab sends at once and Undo is no longer offered');
  await answerOn(phone, THIRD, 'C');
  await phone.locator('[data-settled-bar][data-settled-phase="held"]').waitFor();
  assert.equal(postsFor(THIRD), 0);
  await phone.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await eventually(() => assert.equal(postsFor(THIRD), 1), ms(3000));
  assert.equal(await phone.locator('[data-undo-toast] button', { hasText: 'Undo' }).count(), 0, 'No Undo after the flush.');
  await eventually(() => assert.equal(stored(THIRD).choice, 'C'));
  await phone.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });

  step('phone: a passkey-only Ask is not held: the owner\'s check happens in the moment');
  await phone.evaluate(id => { location.hash = `#/~hub/ask/${id}`; }, PASSKEY_ASK);
  await phone.locator('[data-option="A"] button').tap();
  await phone.locator('[data-send]').tap();
  await eventually(() => assert.equal(postsFor(PASSKEY_ASK), 1), ms(3000));
  assert.equal(await phone.locator('[data-settled-phase="held"]').count(), 0);
  assert.equal(await phone.locator('[data-undo-toast]', { hasText: 'Answered:' }).count(), 0, 'No Undo toast for what already went.');

  step('desktop: a send that fails brings the item back to the list, with a toast that says it was not sent and why');
  // The seam only shortens the hold: this part waits 1.5 s instead of 7.
  const desk = await open({ width: 1280, height: 800 });
  await desk.addInitScript(() => localStorage.setItem('hub.undoMs', '1500'));
  await desk.route(`**/api/hub/asks/${FOURTH}/answer`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The store said no.' }) }));
  await desk.goto(`${fixture.url}#/~hub/needs`);
  const card = desk.locator('.ni', { hasText: 'Which dust puff?' });
  await card.waitFor();
  await card.locator('[data-option="A"] button').click();
  await card.getByRole('button', { name: 'Send answer' }).dblclick();
  await desk.locator('[data-undo-toast]', { hasText: 'Answered: Which dust puff?' }).waitFor();
  await desk.waitForTimeout(400);
  assert.equal(await desk.locator('.ni:not(.leaving)', { hasText: 'Which dust puff?' }).count(), 0, 'The card is out of the list while it is held, with a double tap too.');
  await desk.locator('[data-undo-toast]', { hasText: 'Not sent: Which dust puff?. The store said no.' }).waitFor();
  await desk.locator('.ni', { hasText: 'Which dust puff?' }).waitFor();
  assert.equal(postsFor(FOURTH), 1, 'A double tap made one POST.');
  assert.equal(fixture.fake.objects.has(`sections/inbox/asks/${FOURTH}/answer.json`), false);

  step('desktop: a typed note survives a failed send from the Needs list, and Undo from the list');
  await desk.route(`**/api/hub/asks/${NOTE_FAIL}/answer`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The store said no.' }) }));
  const failing = desk.locator('.ni', { hasText: 'Which rim light?' });
  await failing.waitFor();
  await failing.locator('[data-option="A"] button').click();
  await failing.locator('textarea').fill('Keep this note');
  await failing.getByRole('button', { name: 'Send answer' }).click();
  await desk.locator('[data-undo-toast]', { hasText: 'Not sent: Which rim light?' }).waitFor();
  const back = desk.locator('.ni', { hasText: 'Which rim light?' });
  await back.waitFor();
  assert.equal(await back.locator('textarea').inputValue(), 'Keep this note', 'The note is still in the card after a failed send.');
  assert.equal(await back.locator('[data-option="A"].sel').count(), 1, 'The picked option is still picked.');
  await desk.evaluate(() => localStorage.setItem('hub.undoMs', '6000'));
  const undoing = desk.locator('.ni', { hasText: 'Which fog?' });
  await undoing.waitFor();
  await undoing.locator('[data-option="A"] button').click();
  await undoing.locator('textarea').fill('Undo keeps this');
  await undoing.getByRole('button', { name: 'Send answer' }).click();
  await desk.locator('[data-undo-toast]', { hasText: 'Answered: Which fog?' }).getByRole('button', { name: 'Undo' }).click();
  const undone = desk.locator('.ni', { hasText: 'Which fog?' });
  await undone.waitFor();
  assert.equal(await undone.locator('textarea').inputValue(), 'Undo keeps this', 'The note is still in the card after Undo.');
  assert.equal(postsFor(NOTE_UNDO), 0, 'Undo sent nothing.');

  step('desktop: a typed note survives a failed send and Undo when the answer was given on the item page and the owner left it');
  await desk.evaluate(() => localStorage.setItem('hub.undoMs', '1500'));
  await desk.route(`**/api/hub/asks/${NOTE_PAGE}/answer`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The store said no.' }) }));
  await desk.evaluate(id => { location.hash = `#/~hub/ask/${id}`; }, NOTE_PAGE);
  await desk.locator('[data-option="A"] button').click();
  await desk.locator('.hub-field textarea').fill('Page note');
  await desk.locator('[data-send]').click();
  await desk.evaluate(() => { location.hash = '#/~hub/library'; });
  await desk.locator('[data-undo-toast]', { hasText: 'Not sent: Which bloom?' }).waitFor();
  await desk.evaluate(id => { location.hash = `#/~hub/ask/${id}`; }, NOTE_PAGE);
  await desk.locator('.hub-field textarea').waitFor();
  assert.equal(await desk.locator('.hub-field textarea').inputValue(), 'Page note', 'The item page opens with the note after a failed send.');

  step('desktop: Settings turns "Next item after answering" on; then answering moves on by itself');
  const FIFTH = askId('fifth-arc', 'd4d4');
  fixture.seed.ask(askJson({ id: FIFTH, bead: 'bd-7f3c', now: minutesAgo(fixture.now, 3), question: 'Which hit stop?', options: plainOptions(), allowDrawing: false }));
  await desk.evaluate(() => { location.hash = '#/~hub/settings'; });
  const next = desk.locator('[data-next-item-setting]');
  await next.waitFor();
  assert.equal(await next.isChecked(), false, 'Off by default.');
  assert.ok((await desk.locator('[data-settings-next]').boundingBox()).height >= 44);
  await desk.locator('[data-settings-away] [data-away-toggle]').waitFor();
  await desk.locator('[data-settings-pc]').waitFor();
  await next.check();
  assert.equal(await desk.evaluate(() => localStorage.getItem('hub.autoNext')), '1');
  await desk.evaluate(id => { location.hash = `#/~hub/ask/${id}`; }, FIFTH);
  await desk.locator('[data-option="A"] button').click();
  await desk.locator('[data-send]').click();
  await desk.waitForFunction(id => !location.hash.includes(id), FIFTH, { timeout: ms(10000) });
  await eventually(() => assert.equal(postsFor(FIFTH), 1));

  step('read-only: a guest reads an item, with no answer controls and no project picker on Today');
  const http = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { listenOnGoodPort } = await import('../listen.mjs');
  const dist = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), 'dist');
  const when = new Date().toISOString();
  const ask = { id: '20261026-probe-x-a1b2', project: 'probe', createdAt: when, expiresAt: when, from: { host: 'h', tool: 'claude-code' }, question: 'A read-only question', options: [{ id: 'A', label: 'one' }], allowNote: true, allowDrawing: true, state: 'open', files: ['ask.json'] };
  const row = { kind: 'ask', id: ask.id, title: ask.question, at: when, state: 'open', project: 'probe' };
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, reason: 'Read-only here: sign in at https://site.example.test to change cards.' },
    '/api/card-state': { cards: {} },
    '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
    '/w/one/workspace.json': { entities: [] },
    '/api/hub/today': { counts: { needsYou: 1, running: 0, recent: 0, alerts: 0 }, needsYou: [row], running: [], recent: [], alerts: [], at: when },
    '/api/hub/inbox': { items: [row] },
    '/api/hub/jobs': { counts: { running: 0, finished: 0 }, jobs: [], window: '7 days' },
    '/api/hub/projects': { projects: [{ id: 'probe', name: 'Probe', beads: true }] },
    [`/api/hub/asks/${ask.id}`]: ask,
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
  await listenOnGoodPort(stub, '127.0.0.1');
  try {
    const guest = await open({ width: 390, height: 844 });
    await guest.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/today`);
    await guest.locator('.hub-banner', { hasText: 'Read-only here' }).waitFor();
    assert.equal(await guest.locator('[data-today-title]').innerText(), '1 needs you');
    assert.equal(await guest.locator('[data-today-project], [data-spawn-open]').count(), 0, 'No project picker and no New job.');
    await guest.locator('[data-nrow]').tap();
    await guest.locator('.hub-option').waitFor();
    assert.equal(await guest.locator('[data-send], [data-settled-bar], .hub-field textarea').count(), 0, 'No answer controls.');
    assert.equal(await guest.locator('[data-readonly-note]').count(), 1, 'The read-only line is there.');
  } finally {
    stub.close();
  }
  console.log('hub-hold-ui: ok');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await fixture.close();
}
