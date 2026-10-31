// Run after npm run build. Wake the PC through a real browser, over the fixture service: the Gaming PC tile offers "Wake the PC"
// when the PC's status is stale and a wake is set up (a stand-in controller on 127.0.0.1 counts the POST), an approved PC request
// says it starts within a few minutes and offers the same button, and with no wake set up neither shows it. Tests use fake S3 only.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHubFixture } from './hub-fixture.mjs';
import { minutesAgo, pcStatusJson, seedPcStatus } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const servers = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const controller = async () => {
  const calls = [];
  const server = http.createServer((request, response) => { request.resume(); request.on('end', () => { calls.push(request.method); response.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { calls, url: `http://127.0.0.1:${server.address().port}/hook/placeholder` };
};
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const PC_REQUEST = `${day}-magic-loops-wake-the-pc-a1a1`;
const staleFixture = async env => {
  const fixture = await startHubFixture({ signing: true, env });
  fixtures.push(fixture);
  seedPcStatus(fixture.fake, pcStatusJson({ now: fixture.now, minutesOld: 20 }));
  fixture.seed.request({ id: PC_REQUEST, project: 'magic-loops', createdAt: minutesAgo(fixture.now, 5).toISOString(), by: 'owner', text: 'Fix the wall-jump input buffer', preset: 'code-task', target: 'pc', repo: 'example/magic-loops', origin: { kind: 'owner', name: 'owner' } });
  await new Promise(resolve => setTimeout(resolve, 100));
  return fixture;
};

try {
  step('A stale status and a wake set up: the tile says asleep or off and offers Wake the PC; one tap sends one POST and the tile says Waking');
  const hook = await controller();
  const fixture = await staleFixture({ HUB_WAKE_URL: hook.url });
  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/today`);
  const tile = page.locator('[data-pc]');
  await tile.waitFor();
  assert.match(await tile.locator('[data-pc-headline]').innerText(), /Asleep or off/);
  const button = tile.locator('[data-wake-button]');
  assert.equal(await button.innerText(), 'Wake the PC');
  await button.click();
  await tile.locator('[data-wake="waking"]').waitFor();
  assert.match(await tile.locator('[data-wake="waking"]').innerText(), /Waking…/);
  assert.equal(await tile.locator('[data-wake-button]').count(), 0, 'No second tap while it wakes.');
  assert.deepEqual(hook.calls, ['POST']);

  step('An approved PC request says it starts within a few minutes and, with the PC asleep, offers Wake the PC in its drawer');
  const second = await controller();
  const drawerFixture = await staleFixture({ HUB_WAKE_URL: second.url });
  const view = await open({ width: 1280, height: 900 });
  await view.goto(`${drawerFixture.url}#/~hub/needs`);
  const card = view.locator(`[data-need="approval-${PC_REQUEST}"]`);
  await card.waitFor();
  assert.match(await card.locator('[data-approval-starts]').innerText(), /within a few minutes/);
  assert.doesNotMatch(await card.innerText(), /dispatcher|5 minutes/);
  await card.locator('[data-approval-approve]').click();
  await view.locator('[data-next-note]').waitFor();
  await view.goto(`${drawerFixture.url}#/~hub/needs/requests`);
  await view.locator(`[data-request-open="${PC_REQUEST}"]`).click();
  const drawer = view.locator('[data-run-drawer]');
  await drawer.waitFor();
  assert.match(await drawer.locator('[data-run-pc-start]').innerText(), /Starts on the PC within a few minutes/);
  await drawer.locator('[data-wake-button]').waitFor();
  assert.equal(await drawer.locator('[data-wake-button]').innerText(), 'Wake the PC');
  await drawer.locator('[data-wake-button]').click();
  await drawer.locator('[data-wake="waking"]').waitFor();
  assert.deepEqual(second.calls, ['POST']);

  step('No wake set up: the same screens show no Wake button, only the copy');
  const bare = await staleFixture({});
  const plain = await open({ width: 1280, height: 900 });
  await plain.goto(`${bare.url}#/~hub/today`);
  await plain.locator('[data-pc]').waitFor();
  assert.equal(await plain.locator('[data-wake], [data-wake-button]').count(), 0);
  await plain.goto(`${bare.url}#/~hub/needs`);
  await plain.locator(`[data-need="approval-${PC_REQUEST}"] [data-approval-approve]`).click();
  await plain.locator('[data-next-note]').waitFor();
  await plain.goto(`${bare.url}#/~hub/needs/requests`);
  await plain.locator(`[data-request-open="${PC_REQUEST}"]`).click();
  await plain.locator('[data-run-pc-start]').waitFor();
  assert.equal(await plain.locator('[data-wake-button]').count(), 0);

  step('Phone: the tile and its button fit the width, no sideways scroll, the button is easy to tap');
  const hook3 = await controller();
  const phoneFixture = await staleFixture({ HUB_WAKE_URL: hook3.url });
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${phoneFixture.url}#/~hub/today`);
  await phone.locator('[data-wake-button]').waitFor();
  const widths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `the page scrolls sideways (${widths.scroll} > ${widths.inner})`);
  const box = await phone.locator('[data-wake-button]').boundingBox();
  assert.ok(box.height >= 36 && box.x >= 0 && box.x + box.width <= 390, 'the button fits and is tall enough');

  console.log('hub-wake-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
  for (const server of servers) server.close();
}
