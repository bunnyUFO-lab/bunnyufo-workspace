// Run after npm run build. The Model menu of Chat and Get help through a real browser, over the fixture service with the fake
// Hermes on runs: New chat starts on Auto; Haiku is sent as a run on the Anthropic API; the chat reopens on Haiku with the
// footer under the reply and the tag in the drawer; Get help shows the menu on Auto; "Start a job instead..." opens the Spawn
// sheet with the draft and sends nothing; at 390 px the menu line does not wrap and the page does not scroll sideways.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const chatFiles = fixture => [...fixture.fake.objects.keys()].filter(key => /inbox\/chat\/[^/]+\.jsonl$/.test(key));
const selected = page => page.locator('[data-chat-model]').evaluate(select => select.options[select.selectedIndex].textContent);
try {
  const fx = await startHubFixture({ hermes: true, chatRuns: true });
  fixtures.push(fx);
  const page = await open({ width: 1280, height: 900 });

  step('New chat: the menu reads Auto and lists the choices and the job entry');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-model]').waitFor();
  assert.equal(await selected(page), 'Auto');
  const options = await page.locator('[data-chat-model] option').evaluateAll(list => list.map(option => option.textContent));
  assert.deepEqual(options, ['Auto', 'Sonnet · API', 'Haiku · API', 'DeepSeek Flash · API', '──────────', 'Start a job instead…']);
  assert.match(await page.locator('[data-chat-model-note]').innerText(), /Codex/);

  step('Haiku: the run names the Anthropic pair, the footer says Haiku, the chat reopens on Haiku and the drawer tags it');
  await page.locator('[data-chat-model]').selectOption('haiku');
  await page.locator('textarea[aria-label="Message"]').fill('Say hi');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant [data-bubble-model]', { hasText: 'Haiku' }).waitFor();
  assert.equal(fx.hermes.runs.length, 1);
  assert.equal(fx.hermes.runs[0].body.provider, 'anthropic');
  assert.equal(fx.hermes.runs[0].body.model, 'claude-haiku-5-5');
  assert.match(page.url(), /#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/);
  await page.reload();
  await page.locator('.hub-bubble.assistant').first().waitFor();
  await page.locator('[data-chat-model]').waitFor();
  assert.equal(await selected(page), 'Haiku · API');
  await page.locator('.hub-bubble.assistant [data-bubble-model]', { hasText: 'Haiku' }).waitFor();
  assert.equal((await page.locator('[data-conversation-model]').first().innerText()).trim(), 'Haiku');

  step('a new chat after that starts on Auto again, and an Auto turn names no provider');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-model]').waitFor();
  assert.equal(await selected(page), 'Auto');
  await page.locator('textarea[aria-label="Message"]').fill('Say hi again');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant').first().waitFor();
  await page.waitForURL(/#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/);
  assert.equal(fx.hermes.runs.length, 2);
  assert.ok(!('provider' in fx.hermes.runs[1].body) && !('model' in fx.hermes.runs[1].body));
  assert.equal(await page.locator('[data-bubble-model]').count(), 0, 'Auto shows no footer.');

  step('Start a job instead: the Spawn sheet opens with the draft, nothing is sent, the menu keeps its value');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-model]').waitFor();
  const filesBefore = chatFiles(fx).length;
  await page.locator('textarea[aria-label="Message"]').fill('Research tug-of-war card games');
  await page.locator('[data-chat-model]').selectOption({ label: 'Start a job instead…' });
  await page.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await page.locator('[data-spawn-text]').inputValue(), 'Research tug-of-war card games');
  assert.equal(chatFiles(fx).length, filesBefore);
  assert.equal(fx.hermes.runs.length, 2);
  assert.equal(await selected(page), 'Auto');

  step('Get help: the menu shows on Auto');
  await page.goto(`${fx.url}#/~hub/needs`);
  await page.locator('[data-get-help]').first().waitFor();
  await page.locator('[data-get-help]').first().click();
  await page.locator('[data-chat-model]').waitFor();
  assert.match(page.url(), /#\/~hub\/chat\/help\//);
  assert.equal(await selected(page), 'Auto');

  step('390 px: the menu line does not wrap and the page does not scroll sideways');
  const phone = await open({ width: 390, height: 800 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fx.url}#/~hub/chat`);
  await phone.locator('[data-chat-model]').waitFor();
  await phone.locator('[data-chat-model]').selectOption('deepseek-flash');
  const line = await phone.locator('.hub-chat-extras').evaluate(node => ({ height: node.getBoundingClientRect().height, scroll: document.scrollingElement.scrollWidth, inner: innerWidth, compose: document.querySelector('.hub-compose').getBoundingClientRect().height, noteShown: getComputedStyle(document.querySelector('[data-chat-model-note]')).display }));
  assert.ok(line.height <= 50, `the menu line wrapped (${line.height})`);
  assert.ok(line.scroll <= line.inner, `the page scrolls sideways (${line.scroll} > ${line.inner})`);
  assert.equal(line.noteShown, 'none', 'The note is hidden at phone width.');
  console.log('ok');
} finally {
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
