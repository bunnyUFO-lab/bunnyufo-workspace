// Run after npm run build. Back, on hash routing: every screen is one step, in-app Back walks the same history as the browser's
// back, a sheet is an entry that Back closes, a filter chip adds none, and a card page inside the Hub (a frame) behaves as the
// design says. Over the Hub fixture service with a fake Hermes. The design's requirement is in redesign/design.md, "Requirement for the build: back".
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startHubFixture } from './hub-fixture.mjs';
import { entryOf, hashOf } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ hermes: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const length = page => page.evaluate(() => history.length);
const settle = page => page.waitForTimeout(250);
/** The hash inside the card's frame. The frame is on another origin, so only the browser's own frame object can read it. */
const innerHash = page => page.frames().find(frame => frame.url().includes('/frame/index.html'))?.evaluate(() => location.hash);
const innerIs = async (page, want) => {
  for (let tries = 0; tries < 60; tries++) {
    if (await innerHash(page) === want) return;
    await page.waitForTimeout(100);
  }
  assert.equal(await innerHash(page), want, `The frame's hash never became ${JSON.stringify(want)}.`);
};

// A card whose page is a frame with a link inside it that changes the frame's own hash.
await mkdir(path.join(fixture.dir, 'frame'), { recursive: true });
await writeFile(path.join(fixture.dir, 'frame', 'index.html'), '<!doctype html><title>Frame</title><h1>Framed card</h1><a id="inner-link" href="#inner">Go inside</a><p id="inner">Inner</p>');
const list = JSON.parse(await readFile(path.join(fixture.dir, 'workspace.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);
list.entities.push({ id: 'frame', folder: 'frame', title: 'Framed card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Page', path: 'index.html' }] });
await writeFile(path.join(fixture.dir, 'workspace.json'), JSON.stringify(list, null, 2));

try {
  step('one step per screen: Today to Needs you to Today, and the browser agrees with the Back button');
  const phone = await open({ width: 390, height: 800 });
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  const start = await entryOf(phone);
  const startLength = await length(phone);
  await phone.locator('a[data-today-open]').click();
  await phone.locator('.hub[data-screen="needs"]').waitFor();
  assert.equal(await length(phone), startLength + 1, 'Opening a screen adds exactly one entry.');
  await phone.locator('[data-top="detail"] [data-back]').click();
  await phone.locator('.hub[data-screen="today"]').waitFor();
  assert.equal((await entryOf(phone)).serial, start.serial, 'In-app Back is browser back: the same entry.');
  await phone.goForward();
  await phone.locator('.hub[data-screen="needs"]').waitFor();
  await phone.goBack();
  await phone.locator('.hub[data-screen="today"]').waitFor();
  assert.equal((await entryOf(phone)).serial, start.serial, 'Alt+Left (browser back) lands on the same entry as the Back button did.');

  step('Back from a link with nothing of ours behind it stays in the app: the parent screen');
  const shared = await open({ width: 390, height: 800 });
  await shared.goto(`${fixture.url}#/~hub/needs`);
  await shared.locator('.hub[data-screen="needs"]').waitFor();
  await shared.locator('[data-top="detail"] [data-back]').click();
  await shared.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(new URL(shared.url()).origin, new URL(fixture.url).origin);
  assert.equal(await hashOf(shared), '#/~hub/today');

  step('a filter chip adds no step, and Back still leaves the screen');
  const desk = await open({ width: 1280, height: 900 });
  await desk.goto(`${fixture.url}#/~hub/today`);
  await desk.locator('.hub[data-screen="today"]').waitFor();
  await desk.goto(`${fixture.url}#/~hub/needs`);
  await desk.locator('.hub-chip[data-filter="all"]').waitFor();
  const needsEntry = await entryOf(desk);
  const needsLength = await length(desk);
  await desk.locator('.hub-chip[data-filter="all"]').click();
  await desk.locator('.hub-chip[data-filter="all"].on').waitFor();
  const chips = await desk.locator('.hub-chip[data-filter]').evaluateAll(list => list.map(chip => chip.getAttribute('data-filter')));
  const other = chips.find(name => name !== 'all' && name !== 'answered');
  await desk.locator(`.hub-chip[data-filter="${other}"]`).click();
  await desk.locator(`.hub-chip[data-filter="${other}"].on`).waitFor();
  assert.equal(await length(desk), needsLength, 'A chip adds no entry.');
  assert.equal((await entryOf(desk)).serial, needsEntry.serial, 'It stays on the same entry.');
  assert.match(await hashOf(desk), new RegExp(`~hub/needs/${other}`), 'The chip is in the address, so a reload keeps it.');

  step('a sheet is an entry: it closes on Back and the screen under it stays');
  await desk.goto(`${fixture.url}#/~hub/today`);
  await desk.locator('.hub[data-screen="today"]').waitFor();
  await desk.evaluate(() => { document.querySelector('.hub[data-screen="today"]').__same = true; });
  const beforeSheet = await length(desk);
  await desk.locator('[data-spawn-open]').click();
  await desk.locator('[data-spawn-sheet]').waitFor();
  await settle(desk);
  assert.match(await hashOf(desk), /~hub\/today\/~o$/, 'The open sheet is the same address plus /~o.');
  assert.equal(await length(desk), beforeSheet + 1);
  await desk.goBack();
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  assert.equal(await hashOf(desk), '#/~hub/today');
  assert.equal(await desk.evaluate(() => document.querySelector('.hub[data-screen="today"]').__same === true), true, 'The screen under the sheet was not remounted.');
  step('a sheet closed from its own button takes its entry off');
  await desk.locator('[data-spawn-open]').click();
  await desk.locator('[data-spawn-sheet]').waitFor();
  await settle(desk);
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  await settle(desk);
  assert.equal(await hashOf(desk), '#/~hub/today');

  step("a sheet's action removes its entry: after Open chat, Back is Today, not the sheet");
  const before = await entryOf(desk);
  await desk.locator('[data-spawn-open]').click();
  await desk.locator('[data-spawn-chat]').click();
  await desk.locator('[data-spawn-text]').fill('A question for the assistant');
  await desk.locator('[data-spawn-go]').click();
  await desk.waitForURL(/#\/~hub\/chat$/);
  await desk.locator('[data-chat-thread]').waitFor();
  await desk.goBack();
  await desk.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/today');
  assert.equal((await entryOf(desk)).serial, before.serial, 'One Back from Chat is the entry before the sheet: the sheet left no entry of its own.');
  assert.equal(await desk.locator('[data-spawn-sheet]').count(), 0, 'Back cannot reopen a finished sheet.');

  step('search: Ctrl+K adds one entry, and a result opened from it leaves search behind it in history');
  const beforeSearch = await entryOf(desk);
  await desk.keyboard.press('Control+k');
  await desk.locator('dialog[data-search="dialog"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/search');
  await desk.locator('dialog[data-search="dialog"] input').fill('hub card');
  await desk.locator('[data-search-chip="library"]').click();
  assert.equal(await hashOf(desk), '#/~hub/search', 'A filter chip leaves search where it is.');
  await desk.locator('dialog[data-search="dialog"] [role="option"]', { hasText: 'The hub card' }).first().click();
  await desk.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  await desk.goBack();
  await desk.locator('dialog[data-search="dialog"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/search', 'Back from a result returns to search.');
  assert.equal(await desk.locator('dialog[data-search="dialog"] input').inputValue(), 'hub card', 'With its text.');
  assert.equal(await desk.locator('[data-search-chip="library"]').getAttribute('aria-pressed'), 'true', 'And its chip.');
  await desk.goBack();
  await desk.locator('dialog[data-search="dialog"]').waitFor({ state: 'detached' });
  assert.equal(await hashOf(desk), '#/~hub/today');
  assert.equal((await entryOf(desk)).serial, beforeSearch.serial, 'Search was one entry: two Backs (result, then search) are where it began.');

  step('a card opened from the Library adds exactly one entry');
  await desk.locator('[data-rail] [data-nav="library"]').click();
  await desk.locator('[data-library] .lib-scroll').waitFor();
  const inLibrary = await entryOf(desk);
  await desk.locator('.lib-row-main', { hasText: 'Framed card' }).click();
  const frame = desk.frameLocator('iframe.report-frame');
  await frame.getByRole('heading', { name: 'Framed card' }).waitFor();

  step('card frame: a link inside the page is walked back first by Back (the top address does not move); the next Back leaves the card');
  await frame.locator('#inner-link').click();
  await innerIs(desk, '#inner');
  assert.equal(await hashOf(desk), '#/frame', 'The frame moved, the top address did not.');
  await desk.locator('.topbar [data-back]').click();
  await innerIs(desk, '');
  assert.equal(await hashOf(desk), '#/frame', 'The first Back undid the move inside the frame.');
  await desk.locator('.topbar [data-back]').click();
  await desk.locator('[data-library] .lib-scroll').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/library', 'The second Back left the card.');
  assert.equal((await entryOf(desk)).serial, inLibrary.serial, 'Opening the card added exactly one entry: two Backs (one inside the frame) are back at the Library.');

  step('a card opened from a shared link: Back has nothing behind it and goes to the Library');
  const link = await open({ width: 1280, height: 900 });
  await link.goto(`${fixture.url}#/frame`);
  await link.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Framed card' }).waitFor();
  await link.locator('.topbar [data-back]').click();
  await link.locator('[data-library] .lib-scroll').waitFor();
  assert.equal(await hashOf(link), '#/~hub/library');
  assert.equal(new URL(link.url()).origin, new URL(fixture.url).origin);

  step('Esc on a card is Back too: it walks the same history');
  await desk.locator('.lib-row-main', { hasText: 'Framed card' }).click();
  await desk.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Framed card' }).waitFor();
  await desk.keyboard.press('Escape');
  await desk.locator('[data-library] .lib-scroll').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/library');

  step('a leftover sheet marker with no sheet open (a reload) is dropped from the address');
  await desk.goto(`${fixture.url}#/~hub/today/~o`);
  await desk.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/today');
  step('a chat thread is one step; Back returns to the list with its text, whether it was opened by a row or by a message hit');
  const chatId = `${today.replace(/-/g, '')}-back01`;
  const at = new Date().toISOString();
  fixture.fake.seed(`sections/inbox/chat/${chatId}.jsonl`, [{ role: 'user', text: 'Plan the redesign', at }, { role: 'assistant', text: 'We agreed on the lantern festival schedule for spring.', at }].map(line => JSON.stringify(line) + String.fromCharCode(10)).join(''), 'application/x-ndjson');
  const talk = await open({ width: 390, height: 800 });
  await talk.goto(`${fixture.url}#/~hub/chat`);
  await talk.locator('[data-chat-list] [data-conversation]').first().waitFor();
  const listAt = await entryOf(talk);
  await talk.locator(`[data-conversation="${chatId}"]`).click();
  await talk.locator('[data-chat-thread]').waitFor();
  assert.equal((await entryOf(talk)).serial, listAt.serial + 1, 'Opening a chat adds one entry.');
  assert.equal(await talk.locator('[data-tabs]').count(), 0, 'A thread has no tab bar.');
  await talk.locator('[data-back]').first().click();
  await talk.locator('[data-chat-list]').waitFor();
  assert.equal((await entryOf(talk)).serial, listAt.serial, 'Back is the list entry again, not a new one.');
  await talk.locator('[data-chat-search]').fill('lantern');
  await talk.locator('[data-chat-hit]').first().click();
  await talk.waitForURL(new RegExp(`${chatId}/m/1$`));
  await talk.waitForFunction(() => history.state?.hubEntry);
  const hitAt = await entryOf(talk);
  assert.ok(hitAt.serial > listAt.serial, `A message hit adds an entry too (${JSON.stringify([listAt, hitAt])}).`);
  await talk.locator('[data-back]').first().click();
  await talk.locator('[data-chat-list]').waitFor();
  assert.equal(await talk.locator('[data-chat-search]').inputValue(), 'lantern', 'Back to the list finds its text again.');
  assert.equal((await entryOf(talk)).serial, listAt.serial);
  console.log('shell-back-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
