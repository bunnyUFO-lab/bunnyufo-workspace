// Run after npm run build. Sprites by state on the Team screen, and the Custom tab, through a real browser over the hub fixture.
// The team response and the sheets route are patched in the page, so this suite does not depend on the server side of custom sheets.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const ROWS = ['idle', 'run-right', 'run-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const SHEET_ID = 'sheet-20261029T100000-ab12';
const OLD_ID = 'sheet-20261028T100000-cd34';

// A 1536 x 1872 pet sheet a browser decodes: every row a hue, every column a step of brightness, so a frame can be told apart.
const sheetPng = () => {
  const width = 1536, height = 1872, stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    const row = Math.floor(y / 208);
    for (let x = 0; x < width; x++) {
      const col = Math.floor(x / 192);
      const at = y * stride + 1 + x * 4;
      raw[at] = 40 + row * 25; raw[at + 1] = 200 - row * 20; raw[at + 2] = 60 + col * 24; raw[at + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const PNG = sheetPng();
const rows = frames => ROWS.map((state, index) => ({ state, frames: frames[index] ?? 4, fps: 8 }));
const sheetOf = (id, frames) => ({ kind: 'custom', sheet: id, url: `/hub/file?path=team/claude/${id}.png`, frame: { w: 192, h: 208 }, cols: 8, rows: rows(frames) });

const fixture = await startHubFixture({ pc: 'fresh' });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => { throw error; });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const current = { sheet: SHEET_ID };
  await page.route('**/api/hub/file?path=team*', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/hub/team/*/sheets', route => route.fulfill({
    json: { sheets: [
      { sheet: SHEET_ID, at: new Date(Date.now() - 3600_000).toISOString(), rows: rows([4, 6, 6, 4, 6, 3, 2, 6, 4]), url: `/hub/file?path=team/claude/${SHEET_ID}.png`, current: current.sheet === SHEET_ID },
      { sheet: OLD_ID, at: new Date(Date.now() - 86_400_000).toISOString(), rows: rows([4]), url: `/hub/file?path=team/claude/${OLD_ID}.png`, current: current.sheet === OLD_ID },
    ] },
  }));
  await page.route('**/api/hub/team/*/avatar', async route => {
    const body = route.request().postDataJSON();
    if (body.kind === 'custom') current.sheet = body.sheet;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/hub/team', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const base = body.agents.find(agent => agent.id === 'briefs');
    const minutes = ago => new Date(Date.now() - ago * 60_000).toISOString();
    const extra = [
      { id: 'sx-needs', status: 'needs-you' }, { id: 'sx-failed', status: 'failed' }, { id: 'sx-done', status: 'idle', doneAt: minutes(1) },
      { id: 'sx-old', status: 'idle', doneAt: minutes(11) }, { id: 'sx-review', status: 'idle', review: true }, { id: 'sx-off', status: 'offline' },
    ].map(item => ({ ...base, ...item, name: item.id }));
    const claude = body.agents.find(agent => agent.id === 'claude');
    if (claude) claude.sprite = sheetOf(current.sheet, [4, 6, 6, 4, 6, 3, 2, 6, 4]);
    body.agents.push(...extra);
    await route.fulfill({ response, json: body });
  });
  return { page, errors };
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};
const spriteOf = (page, agent) => page.locator(`[data-agent="${agent}"] .team-tile [data-row]`);

try {
  step('each card draws the row for its state (reduced motion off)');
  const { page: desk, errors } = await open({ width: 1280, height: 900 });
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  const expected = { 'sx-needs': 'waiting', 'sx-failed': 'failed', 'sx-done': 'jumping', 'sx-old': 'idle', 'sx-review': 'review', 'sx-off': 'idle', claude: 'running' };
  for (const [agent, row] of Object.entries(expected)) assert.equal(await spriteOf(desk, agent).getAttribute('data-row'), row, `${agent} shows the ${row} row`);
  assert.equal(await spriteOf(desk, 'sx-done').getAttribute('data-state'), 'done');
  assert.equal(await spriteOf(desk, 'sx-off').getAttribute('data-state'), 'offline');
  assert.match(await spriteOf(desk, 'sx-needs').getAttribute('aria-label'), /^sx-needs, Needs you$/);

  step('a custom sheet plays its row with steps(); a built-in sprite has a CSS motion');
  const claude = spriteOf(desk, 'claude');
  assert.equal(await claude.evaluate(node => node.tagName), 'DIV', 'A custom sprite is a div.');
  const style = await claude.evaluate(node => { const s = getComputedStyle(node); return { name: s.animationName, timing: s.animationTimingFunction, duration: s.animationDuration, image: s.backgroundImage, size: s.backgroundSize, posY: s.backgroundPositionY, render: s.imageRendering, w: s.width, h: s.height }; });
  assert.equal(style.name, 'spr-play');
  assert.match(style.timing, /steps\(6/, 'steps over the running row\'s 6 frames');
  assert.equal(style.duration, '0.75s', '6 frames at 8 fps');
  assert.match(style.image, /\/api\/hub\/file\?path=team/);
  assert.equal(style.size, '384px 468px', '8 x 9 frames at 48 x 52');
  assert.equal(style.posY, `-${7 * 52}px`, 'the running row');
  assert.equal(style.render, 'pixelated', '52 px high is the art size, so nearest neighbour is exact');
  assert.equal(await spriteOf(desk, 'sx-needs').evaluate(node => getComputedStyle(node).animationName), 'spr-pulse');
  assert.equal(await spriteOf(desk, 'sx-failed').evaluate(node => getComputedStyle(node).animationName), 'spr-shake');

  step('the greeting plays waving once on pointer enter, then goes back to the state row');
  await desk.locator('[data-agent="claude"]').hover();
  await desk.waitForFunction(() => document.querySelector('[data-agent="claude"] .team-tile [data-row]')?.getAttribute('data-row') === 'waving');
  await desk.waitForFunction(() => document.querySelector('[data-agent="claude"] .team-tile [data-row]')?.getAttribute('data-row') === 'running');

  step('Working now rows follow the session state');
  await desk.goto(`${fixture.url}#/~hub/today`);
  await desk.locator('.wn-row').first().waitFor();
  const wn = await desk.locator('.wn-row').evaluateAll(list => list.map(row => [row.getAttribute('data-working'), row.querySelector('[data-row]')?.getAttribute('data-row')]));
  assert.ok(wn.length > 0);
  for (const [state, row] of wn) assert.equal(row, state === 'working' ? 'running' : state === 'needs-you' ? 'waiting' : 'idle');

  step('the Custom tab lists the sheets, the current one marked; Use this switches, Undo restores');
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('[data-sprite-open="claude"]').click();
  const sheet = desk.locator('dialog[data-sprite-sheet="claude"]');
  await sheet.waitFor();
  await sheet.locator('[data-sheet-mode="custom"]').click();
  const items = sheet.locator('[data-sheet-item]');
  await items.first().waitFor();
  assert.deepEqual(await items.evaluateAll(list => list.map(item => item.getAttribute('data-sheet-item'))), [SHEET_ID, OLD_ID], 'newest first');
  assert.equal(await sheet.locator(`[data-sheet-item="${SHEET_ID}"]`).getAttribute('class'), 'sheet-item on');
  assert.equal(await sheet.locator(`[data-sheet-use-custom="${SHEET_ID}"]`).isDisabled(), true, 'The current sheet is in use.');
  assert.equal(await sheet.locator(`[data-sheet-item="${OLD_ID}"] [data-row]`).getAttribute('data-row'), 'idle', 'A preview plays the idle row.');
  await sheet.locator(`[data-sheet-use-custom="${OLD_ID}"]`).click();
  await sheet.waitFor({ state: 'detached' });
  assert.match(await desk.locator('[data-team-toast]').innerText(), /new sprite/);
  await desk.locator('[data-team-undo]').click();
  await desk.getByText('has its old sprite back').waitFor();

  step('with no sheets the Custom tab says so');
  await desk.route('**/api/hub/team/*/sheets', route => route.fulfill({ json: { sheets: [] } }));
  await desk.locator('[data-sprite-open="hermes"]').click();
  const hermes = desk.locator('dialog[data-sprite-sheet="hermes"]');
  await hermes.locator('[data-sheet-mode="custom"]').click();
  await hermes.locator('[data-sheet-custom]').getByText('No custom sheets yet.').waitFor();
  assert.equal(await hermes.locator('[data-sheet-custom]').innerText(), 'No custom sheets yet. They arrive with the Agent avatar preset.');
  await desk.keyboard.press('Escape');

  step('reduced motion: no animation runs and frame 0 of the row shows');
  const { page: calm } = await open({ width: 1280, height: 900 }, { reducedMotion: 'reduce' });
  await calm.goto(`${fixture.url}#/~hub/team`);
  await calm.locator('.team-card').first().waitFor();
  assert.equal(await spriteOf(calm, 'claude').evaluate(node => { const s = getComputedStyle(node); return `${s.animationName}|${s.backgroundPositionX}`; }), 'none|0px');
  assert.equal(await spriteOf(calm, 'claude').getAttribute('data-row'), 'running', 'It still shows its state row.');
  for (const agent of ['sx-needs', 'sx-failed', 'sx-done', 'sx-review']) assert.equal(await spriteOf(calm, agent).evaluate(node => getComputedStyle(node).animationName), 'none', `${agent} is still`);
  await calm.locator('[data-agent="claude"]').hover();
  await calm.waitForTimeout(200);
  assert.equal(await spriteOf(calm, 'claude').getAttribute('data-row'), 'running', 'No greeting under reduced motion.');

  step('phone widths: no sideways scroll, with the sheet closed and open');
  for (const width of [375, 390]) {
    const { page: phone } = await open({ width, height: 844 }, { hasTouch: true, isMobile: true });
    await phone.goto(`${fixture.url}#/~hub/team`);
    await phone.locator('.team-card').first().waitFor();
    await noSideways(phone, `Team at ${width}`);
    await phone.locator('[data-sprite-open="claude"]').tap();
    await phone.locator('dialog[data-sprite-sheet="claude"] [data-sheet-mode="custom"]').tap();
    await phone.locator('[data-sheet-item]').first().waitFor();
    await noSideways(phone, `Custom tab at ${width}`);
    for (const target of await phone.locator('dialog.sprite-sheet button').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A button in the sheet is ${target} px high.`);
  }

  assert.deepEqual(errors.filter(text => !/Failed to load resource/.test(text)), [], 'no console errors');
  console.log('hub-sprites-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
