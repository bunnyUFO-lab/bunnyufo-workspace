// Run after npm run build. The chat's default model through a real browser, over the fixture service with the fake Hermes on runs:
// the menu lists Auto (saying it tries Codex first) and Codex (the ChatGPT plan, no "API" tag); a research agent's chat starts on
// Codex and switching the agent moves the default; an explicit pick stays when the agent changes; the run names the openai-codex
// provider. At 390 px nothing scrolls sideways.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

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
try {
  const fx = await startHubFixture({ hermes: true, chatRuns: true });
  fixtures.push(fx);
  const page = await open({ width: 1280, height: 900 });

  step('New chat on Hermes: the menu reads Auto and says what it tries first; Codex is listed without an API tag');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-model]').waitFor();
  assert.equal(await selected(page), 'Auto · Codex first');
  assert.deepEqual(await page.locator('[data-chat-model] option').evaluateAll(list => list.map(option => option.textContent)), ['Auto · Codex first', 'Codex', 'Sonnet · API', 'Haiku · API', 'DeepSeek Flash · API', '──────────', 'Start a job instead…']);
  assert.match(await page.locator('[data-chat-model-note]').innerText(), /Codex on your ChatGPT plan, then Sonnet, then DeepSeek/);

  step('a research agent starts the chat on Codex, and switching the agent moves the default');
  await page.locator('[data-chat-persona]').selectOption('researcher');
  assert.equal(await selected(page), 'Codex');
  assert.equal(await page.locator('[data-chat-model-note]').innerText(), 'ChatGPT plan, no API cost');
  await page.locator('[data-chat-persona]').selectOption('hermes');
  assert.equal(await selected(page), 'Auto · Codex first', 'back to Hermes: back to Auto');
  await page.locator('[data-chat-persona]').selectOption('teardown');
  assert.equal(await selected(page), 'Codex');

  step('an explicit pick stays when the agent changes');
  await page.locator('[data-chat-model]').selectOption('sonnet');
  await page.locator('[data-chat-persona]').selectOption('market-researcher');
  assert.equal(await selected(page), 'Sonnet · API');
  await page.locator('[data-chat-persona]').selectOption('hermes');
  assert.equal(await selected(page), 'Sonnet · API');
  await page.locator('[data-chat-model]').selectOption('auto');
  await page.locator('[data-chat-persona]').selectOption('researcher');
  assert.equal(await selected(page), 'Auto · Codex first', 'picking Auto is a pick too');

  step('the default is what the run asks for: the openai-codex provider and gpt-6-sol');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-persona]').selectOption('researcher');
  await page.locator('textarea[aria-label="Message"]').fill('What is new in deckbuilders?');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant').first().waitFor();
  const body = fx.hermes.runs.at(-1).body;
  assert.equal(body.provider, 'openai-codex');
  assert.equal(body.model, 'gpt-6-sol');

  step('390 px: the menu fits');
  const phone = await open({ width: 390, height: 800 });
  await phone.goto(`${fx.url}#/~hub/chat`);
  await phone.locator('[data-chat-persona]').selectOption('researcher');
  assert.equal(await selected(phone), 'Codex');
  const widths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `the page scrolls sideways (${widths.scroll} > ${widths.inner})`);
  console.log('hub-chat-default-ui: passed');
} finally {
  await browser.close();
  for (const fx of fixtures) await fx.close();
}
