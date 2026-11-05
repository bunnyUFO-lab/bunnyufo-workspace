// Run after npm run build. The Mockup preset and the model per run on the Spawn sheet (ws-qdh.4), through a real browser over the fixture
// service: Mockup is a Hermes job whose model menu starts on Codex and calls DeepSeek Flash "cheapest"; the question and research jobs
// start on Codex too; Code task and Docs show Claude only, with the line that says why; a Hermes-less project is not offered a menu on
// them. Phone width has no sideways scroll. Set BUW_SHOTS=<folder> to save the PR screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { pickOption } from './combobox.mjs';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const shots = process.env.BUW_SHOTS;
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, inner: innerWidth, sheet: document.querySelector('[data-spawn-sheet]').scrollWidth, sheetInner: document.querySelector('[data-spawn-sheet]').clientWidth }));
  assert.ok(widths.page <= widths.inner && widths.sheet <= widths.sheetInner, `${what}: sideways scroll ${JSON.stringify(widths)}`);
};
const requestsIn = fixture => [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\//.test(key));

try {
  const fixture = await startHubFixture({ hermes: true });
  fixtures.push(fixture);
  fixture.fake.seed('sections/magic-loops/workspace.json', JSON.stringify({ name: 'magic-loops', tracked: { repo: 'example/magic-loops' }, entities: [] }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/today`);
  const openSheet = async (target, preset) => {
    await target.locator('[data-spawn-open]').first().click();
    await target.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
    await pickOption(target.locator('[data-spawn-project]'), 'magic-loops');
    await target.locator(`[data-preset="${preset}"]`).click();
    await target.locator('[data-spawn-why], [data-spawn-machine]').first().waitFor();
  };

  step('Mockup: a Hermes job by the Researcher; the menu starts on Codex and DeepSeek Flash says it is the cheapest');
  await openSheet(page, 'mockup');
  await page.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  assert.match(await page.locator('[data-spawn-agent]').innerText(), /Researcher/);
  const menu = page.locator('[data-spawn-model]');
  assert.equal(await menu.inputValue(), 'auto', 'No model is pinned: Hermes starts on Codex.');
  assert.deepEqual(await menu.locator('option').allInnerTexts(), ['Codex', 'Sonnet 5.5 · API', 'Haiku 5.5 · API', 'DeepSeek Flash · cheapest']);
  assert.match(await page.locator('[data-spawn-model-note]').innerText(), /Codex on your ChatGPT plan/);
  assert.match(await page.locator('[data-spawn-estimate]').innerText(), /Codex plan · about 0\.5 M tokens/);
  assert.match(await page.locator('[data-spawn-estimate]').innerText(), /a card in the project's section, or in assistant, with an HTML mockup and up to 3 pictures/);
  assert.equal(await page.locator('[data-spawn-model-claude]').count(), 0);
  await shot(page, 'spawn-mockup-desktop');
  await menu.selectOption('deepseek-flash');
  assert.match(await page.locator('[data-spawn-estimate]').innerText(), /DeepSeek Flash · API key · about 0\.5 M tokens/);
  assert.deepEqual(requestsIn(fixture), [], 'Looking at the menu files nothing.');

  step('Research and Resolve a question start on Codex too');
  for (const preset of ['research', 'question']) {
    await page.locator(`[data-preset="${preset}"]`).click();
    assert.equal((await page.locator('[data-spawn-model] option').first().innerText()).trim(), 'Codex', preset);
  }

  step('Code task and Docs show Claude only, with the line that says Codex and DeepSeek come later; no menu');
  for (const preset of ['code-task', 'docs']) {
    await page.locator(`[data-preset="${preset}"]`).click();
    await page.locator('[data-spawn-model-claude]').waitFor();
    assert.equal((await page.locator('[data-spawn-model-claude] b').innerText()).trim(), 'Claude', preset);
    assert.match(await page.locator('[data-spawn-model-claude] .sp-faint').innerText(), /Codex and DeepSeek for code come after the OpenCode check/);
    assert.equal(await page.locator('[data-spawn-model]').count(), 0, `${preset} has no model menu.`);
    if (preset === 'code-task') await shot(page, 'spawn-code-task-desktop');
  }
  await page.locator('[data-preset="sprite-set"]').click();
  assert.equal(await page.locator('[data-spawn-model-claude]').count(), 0, 'Only code and docs say it.');

  step('Phone: Mockup is there with its menu, and the sheet does not scroll sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.locator('.needs-actions [data-spawn-open]').click();
  await phone.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await pickOption(phone.locator('[data-spawn-project]'), 'magic-loops');
  await phone.locator('[data-preset="mockup"]').click();
  await phone.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  await phone.locator('[data-spawn-model]').scrollIntoViewIfNeeded();
  const box = await phone.locator('[data-spawn-model]').boundingBox();
  assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, 'The menu fits and is tappable.');
  await noSideways(phone, 'mockup at 390');
  await shot(phone, 'spawn-mockup-phone');

  console.log('hub-spawn-mockup-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
