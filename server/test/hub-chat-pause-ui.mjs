// Run after npm run build. The chat's default model when the Hub saw a plan hit its usage limit (ws-q9y.9), through a real browser
// over the fixture service with the fake Hermes on runs. A request retried on quota (hermes-retry.json) pauses Codex: a research
// agent's chat starts on Sonnet and the menu says why; a model picked by hand stays picked, with the note beside it; with no reset
// time the note says when the limit was seen. The note shows at 1280 px and at 390 px, where nothing scrolls sideways.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const selected = page => page.locator('[data-chat-model] option:checked').innerText();
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const noteOf = page => page.locator('[data-chat-model-pause]');
const seedRetry = (fx, id, extra) => fx.seed.put(`requests/${day}-${id}/hermes-retry.json`, { runId: 'r2', at: minutesAgo(fx.now, 12).toISOString(), provider: 'anthropic', model: 'claude-sonnet-5-5', reason: 'quota', ...extra });
try {
  const reset = new Date(Date.now() + 80 * 60_000).toISOString();
  const fx = await startHubFixture({ hermes: true, chatRuns: true, seedData: false });
  fixtures.push(fx);
  seedRetry(fx, 'magic-loops-retried-d4d4', { until: reset });
  const page = await open({ width: 1280, height: 900 });

  step('Hermes (Auto) is not moved: Auto has its own chain, and no note shows');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-model]').waitFor();
  assert.equal(await selected(page), 'Auto · Codex first');
  assert.equal(await noteOf(page).count(), 0);

  step('a research agent starts on Sonnet while Codex is paused, and the menu says why and until when');
  await page.locator('[data-chat-persona]').selectOption('researcher');
  assert.equal(await selected(page), 'Sonnet 5.5 · API');
  assert.match(await noteOf(page).innerText(), /^Codex 6.1 Sol is paused by its usage limit until (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d(?: [AP]M)? · using Sonnet 5.5$/);
  assert.equal(await noteOf(page).getAttribute('data-pause-model'), 'codex');

  step('picking Codex by hand keeps Codex, with the same note and no "using"');
  await page.locator('[data-chat-model]').selectOption('codex');
  assert.equal(await selected(page), 'Codex 6.1 Sol');
  assert.match(await noteOf(page).innerText(), /^Codex 6.1 Sol is paused by its usage limit until [^·]+$/);
  await page.locator('[data-chat-persona]').selectOption('teardown');
  assert.equal(await selected(page), 'Codex 6.1 Sol', 'the pick survives a change of agent');
  await page.locator('[data-chat-model]').selectOption('sonnet');
  assert.equal(await noteOf(page).count(), 0, 'a model that is not paused has no note');

  step('the turn asks for the model the menu shows');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-persona]').selectOption('researcher');
  await page.locator('textarea[aria-label="Message"]').fill('What is new in deckbuilders?');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant').first().waitFor();
  const body = fx.hermes.runs.at(-1).body;
  assert.equal(body.provider, 'anthropic');
  assert.equal(body.model, 'claude-sonnet-5-5');

  step('390 px: the note shows on its own line and nothing scrolls sideways');
  const phone = await open({ width: 390, height: 800 });
  await phone.goto(`${fx.url}#/~hub/chat`);
  await phone.locator('[data-chat-persona]').selectOption('researcher');
  assert.equal(await selected(phone), 'Sonnet 5.5 · API');
  await noteOf(phone).waitFor();
  const box = await noteOf(phone).boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'the note fits the screen');
  const widths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `the page scrolls sideways (${widths.scroll} > ${widths.inner})`);

  step('no reset time: the note says when the limit was seen');
  const guess = await startHubFixture({ hermes: true, chatRuns: true, seedData: false });
  fixtures.push(guess);
  seedRetry(guess, 'magic-loops-retried-e5e5');
  const guessed = await open({ width: 1280, height: 900 });
  await guessed.goto(`${guess.url}#/~hub/chat`);
  await guessed.locator('[data-chat-persona]').selectOption('researcher');
  assert.equal(await selected(guessed), 'Sonnet 5.5 · API');
  assert.match(await noteOf(guessed).innerText(), /^Codex 6.1 Sol is paused by its usage limit \(seen (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d(?: [AP]M)?\) · using Sonnet 5.5$/);

  step('no evidence: the default is the agent\'s own');
  const calm = await startHubFixture({ hermes: true, chatRuns: true, seedData: false });
  fixtures.push(calm);
  const quiet = await open({ width: 1280, height: 900 });
  await quiet.goto(`${calm.url}#/~hub/chat`);
  await quiet.locator('[data-chat-persona]').selectOption('researcher');
  assert.equal(await selected(quiet), 'Codex 6.1 Sol');
  assert.equal(await noteOf(quiet).count(), 0);
  console.log('hub-chat-pause-ui: passed');
} finally {
  await browser.close();
  for (const fx of fixtures) await fx.close();
}
