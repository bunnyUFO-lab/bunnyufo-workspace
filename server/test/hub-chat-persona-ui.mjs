// Run after npm run build. The Talk-to picker of New chat through a real browser, over the fixture service with the fake Hermes
// on runs: Hermes by default; Teardown is sent as a persona (the run's history starts with the server's own text); the header and
// the replies show the agent; the chat reopens on it with no picker and a tag in the drawer; a new chat is Hermes again; Get help
// has no picker; "Start a job instead..." opens Spawn on the persona's preset; at 390 px nothing scrolls sideways.
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
try {
  const fx = await startHubFixture({ hermes: true, chatRuns: true });
  fixtures.push(fx);
  const page = await open({ width: 1280, height: 900 });

  step('New chat: the picker reads Hermes and lists the three agents; the header says Hermes');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-persona]').waitFor();
  assert.deepEqual(await page.locator('[data-chat-persona] option').evaluateAll(list => list.map(option => option.textContent)), ['Hermes', 'Researcher', 'Market researcher', 'Teardown']);
  assert.equal(await page.locator('[data-chat-persona]').inputValue(), 'hermes');
  assert.equal(await page.locator('[data-chat-with]').getAttribute('data-chat-with'), 'hermes');

  step('Teardown: the header changes, the run starts with the server text, the reply shows the agent');
  await page.locator('[data-chat-persona]').selectOption('teardown');
  assert.equal(await page.locator('[data-chat-with]').getAttribute('data-chat-with'), 'teardown');
  await page.locator('[data-chat-with] [data-who="teardown"] svg, [data-chat-with] [data-who="teardown"] div').first().waitFor();
  await page.locator('textarea[aria-label="Message"]').fill('How does Balatro teach its rules?');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant [data-who="teardown"]').waitFor();
  assert.equal(fx.hermes.runs.length, 1);
  const history = fx.hermes.runs[0].body.conversation_history;
  assert.match(history[0].content, /^You are Teardown/);
  assert.equal(fx.hermes.runs[0].body.input, 'How does Balatro teach its rules?');
  await page.waitForURL(/#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/);

  step('the chat reopens on Teardown: no picker, the header and the drawer name it');
  await page.reload();
  await page.locator('.hub-bubble.assistant').first().waitFor();
  await page.locator('[data-chat-with="teardown"] .hub-who-name', { hasText: 'Teardown' }).waitFor();
  assert.equal(await page.locator('[data-chat-persona]').count(), 0);
  assert.equal((await page.locator('[data-conversation-persona]').first().innerText()).trim(), 'Teardown');
  await page.locator('textarea[aria-label="Message"]').fill('And its shop?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.hub-bubble.assistant').length === 2);
  assert.match(fx.hermes.runs[1].body.conversation_history[0].content, /^You are Teardown/);

  step('a new chat is Hermes again and names no persona');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-persona]').waitFor();
  assert.equal(await page.locator('[data-chat-persona]').inputValue(), 'hermes');
  await page.locator('textarea[aria-label="Message"]').fill('Hi');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant').first().waitFor();
  assert.deepEqual(fx.hermes.runs[2].body, { input: 'Hi' });
  assert.equal(await page.locator('.hub-bubble [data-who]').count(), 0, 'Hermes replies carry no badge.');

  step('Start a job instead: Spawn opens on the persona\'s preset with the draft');
  await page.goto(`${fx.url}#/~hub/chat`);
  await page.locator('[data-chat-persona]').selectOption('market-researcher');
  await page.locator('textarea[aria-label="Message"]').fill('Tug-of-war card games');
  await page.locator('[data-chat-model]').selectOption({ label: 'Start a job instead…' });
  await page.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await page.locator('[data-spawn-text]').inputValue(), 'Tug-of-war card games');
  assert.match(await page.locator('[data-spawn-sheet]').innerText(), /Market research/);
  assert.equal(fx.hermes.runs.length, 3);

  step('Get help: no picker');
  await page.goto(`${fx.url}#/~hub/needs`);
  await page.locator('[data-get-help]').first().click();
  await page.locator('[data-chat-model]').waitFor();
  assert.equal(await page.locator('[data-chat-persona]').count(), 0);
  assert.equal((await page.locator('[data-chat-with] .hub-who-name').innerText()).trim(), 'Hermes');

  step('390 px: both menus and the aloud line fit, the page does not scroll sideways');
  const phone = await open({ width: 390, height: 800 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fx.url}#/~hub/chat`);
  await phone.locator('[data-chat-persona]').selectOption('market-researcher');
  const fit = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, right: Math.max(...[...document.querySelectorAll('.hub-chat-extras > *, .hub-top > *')].map(node => node.getBoundingClientRect().right)) }));
  assert.ok(fit.scroll <= fit.inner, `the page scrolls sideways (${fit.scroll} > ${fit.inner})`);
  assert.ok(fit.right <= fit.inner + 1, `something sticks out (${fit.right})`);
  console.log('ok');
} finally {
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
