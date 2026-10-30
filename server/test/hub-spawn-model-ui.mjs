// Run after npm run build. The Model menu on the Spawn sheet (ws-2oo, T3), through a real browser over the fixture service:
// it shows for a Hermes job only, defaults to Auto, sends an id with the request, and a signed approval carries it into the
// run block and the Hermes run. A PC, cloud or at-the-PC job shows no menu. Phone width has no sideways scroll.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const requestsIn = fixture => [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/request\.json$/.test(key));
const until = async (check, what) => {
  for (let i = 0; i < 200; i += 1) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(`Timed out waiting for ${what}`);
};

try {
  const fixture = await startHubFixture({ signing: true, hermes: true });
  fixtures.push(fixture);
  fixture.seed.beads('bunnylink', [beadsIssue({ id: 'bl-1', title: 'A task', created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: 'example/bunnylink' });
  for (const [project, repo] of [['magic-loops', 'example/magic-loops']]) fixture.fake.seed(`sections/${project}/workspace.json`, JSON.stringify({ name: project, tracked: { repo }, entities: [] }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/today`);
  const openSheet = async (preset, project = 'magic-loops') => {
    await page.locator('[data-spawn-open]').click();
    await page.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
    await page.locator('[data-spawn-project]').selectOption(project);
    await page.locator(`[data-preset="${preset}"]`).click();
    await page.locator('[data-spawn-why], [data-spawn-machine]').first().waitFor();
  };

  step('A Hermes preset shows the Model menu on Auto, with the chat list and no Opus');
  await openSheet('research');
  await page.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  const menu = page.locator('[data-spawn-model]');
  assert.equal(await menu.inputValue(), 'auto');
  assert.deepEqual(await menu.locator('option').allInnerTexts(), ['Auto', 'Sonnet · API', 'Haiku · API', 'DeepSeek Flash · API']);
  assert.equal(await page.locator('[data-spawn-model-note]').count(), 1);
  assert.equal(await menu.getAttribute('id') !== null, true);
  assert.equal(await page.locator('label', { hasText: /^Model$/ }).count(), 1, 'The menu has a label.');

  step('A PC or cloud job (a code task) shows no menu; a Bunnylink job shows none either');
  await page.locator('[data-preset="code-task"]').click();
  await page.locator('[data-spawn-machine]', { hasText: 'The PC' }).waitFor();
  assert.equal(await page.locator('[data-spawn-model]').count(), 0, 'Code goes to the PC: no menu.');
  await page.locator('[data-spawn-target]').selectOption('cloud');
  await page.locator('[data-spawn-why]').getByText('your choice').waitFor();
  assert.equal(await page.locator('[data-spawn-model]').count(), 0, 'Cloud: no menu.');
  await page.locator('[data-preset="research"]').click();
  await page.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  assert.equal(await page.locator('[data-spawn-model]').count(), 1, 'Back on Hermes the menu is back.');
  await page.locator('[data-spawn-project]').selectOption('bunnylink');
  await page.locator('[data-spawn-machine]', { hasText: 'You, at the PC' }).waitFor();
  assert.equal(await page.locator('[data-spawn-model]').count(), 0, 'Bunnylink is started at the PC: no menu.');
  await page.locator('[data-spawn-project]').selectOption('magic-loops');
  await page.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();

  step('Auto sends no model: the stored request and the signed block are as they were');
  await page.locator('[data-spawn-text]').fill('Why do runs end early');
  await page.locator('[data-spawn-go]').click();
  await page.locator('[data-spawn-toast]').waitFor();
  const autoKey = (await until(() => requestsIn(fixture)[0], 'the Auto request'));
  assert.equal('model' in fixture.fake.json(autoKey), false);
  const autoApproved = fixture.fake.json(autoKey.replace('request.json', 'approved.json'));
  assert.equal(autoApproved.run.model, null);

  step('Haiku: the request carries the id, the approval signs it and the Hermes run is started with the Anthropic Haiku pair');
  await openSheet('research');
  await page.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  await page.locator('[data-spawn-model]').selectOption('haiku');
  assert.match(await page.locator('[data-spawn-model-note]').innerText(), /Anthropic API/);
  await page.locator('[data-spawn-text]').fill('A look at how card games teach their rules');
  const [created] = await Promise.all([
    page.waitForRequest(request => request.method() === 'POST' && /\/api\/hub\/requests$/.test(request.url())),
    page.locator('[data-spawn-go]').click(),
  ]);
  assert.equal(JSON.parse(created.postData()).model, 'haiku');
  await page.locator('[data-spawn-toast]').waitFor();
  const haikuKey = await until(() => requestsIn(fixture).find(key => fixture.fake.json(key).model === 'haiku'), 'the Haiku request');
  assert.equal(fixture.fake.json(haikuKey).target, 'hermes');
  const signed = await until(() => fixture.fake.objects.has(haikuKey.replace('request.json', 'approved.json')) && fixture.fake.json(haikuKey.replace('request.json', 'approved.json')), 'approved.json');
  assert.equal(signed.run.model, 'haiku');
  assert.ok(signed.signature);
  const run = await until(() => fixture.hermes?.runs.find(item => item.body.provider === 'anthropic'), 'the Hermes run');
  assert.equal(run.body.model, 'claude-haiku-5-5');

  step('The approval view names the choice');
  const id = haikuKey.split('/').at(-2);
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(id)}`);
  await page.locator('[data-approval-model]').waitFor();
  assert.equal((await page.locator('[data-approval-model]').innerText()).trim(), 'Model: Haiku · API');

  step('Phone: the menu is there and the sheet does not scroll sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.locator('.needs-actions [data-spawn-open]').click();
  await phone.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await phone.locator('[data-spawn-project]').selectOption('magic-loops');
  await phone.locator('[data-preset="research"]').click();
  await phone.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  await phone.locator('[data-spawn-model]').scrollIntoViewIfNeeded();
  const widths = await phone.evaluate(() => ({ page: document.scrollingElement.scrollWidth, inner: innerWidth, sheet: document.querySelector('[data-spawn-sheet]').scrollWidth, sheetInner: document.querySelector('[data-spawn-sheet]').clientWidth }));
  assert.ok(widths.page <= widths.inner && widths.sheet <= widths.sheetInner, `Sideways scroll: ${JSON.stringify(widths)}`);
  const box = await phone.locator('[data-spawn-model]').boundingBox();
  assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, 'The menu fits and is tappable.');

  console.log('hub-spawn-model-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
