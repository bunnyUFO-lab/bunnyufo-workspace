// Run after npm run build. Sprites by state on the Team screen, and the Custom tab, through a real browser over the hub fixture.
// The sheets, the sheet PNGs and the avatar choice are the real routes over seeded sheets; only the team response is patched in the page, to add agents in every state.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo, teamSheet } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const ROWS = ['idle', 'run-right', 'run-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const SHEET_ID = 'sheet-20261029T100000Z-ab12';
const OLD_ID = 'sheet-20261028T100000Z-cd34';

const FRAMES = [4, 6, 6, 4, 6, 3, 2, 6, 4];
const rows = frames => ROWS.map((state, index) => ({ state, frames: frames[index] ?? 4, fps: 8 }));
const newest = teamSheet('claude', { rows: rows(FRAMES) });
const oldest = teamSheet('claude', { stamp: '20261028T100000Z', rand: 'cd34', rows: rows([4]), at: new Date('2026-10-28T10:00:00Z') });
assert.equal(newest.id, SHEET_ID);
assert.equal(oldest.id, OLD_ID);

const fixture = await startHubFixture({ pc: 'fresh' });
fixture.fake.seed('sections/sprite-studio/workspace.json', JSON.stringify({ name: 'sprite-studio', tracked: { repo: 'example/sprite-studio' }, entities: [] }), 'application/json');
fixture.seed.beads('sprite-studio', [beadsIssue({ id: 'ss-1', title: 'A task', created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: 'example/sprite-studio' });
await new Promise(resolve => setTimeout(resolve, 150));
for (const sheet of [newest, oldest]) for (const [name, body] of Object.entries(sheet.files)) fixture.seed.put(`team/claude/${name}`, body, name.endsWith('.png') ? 'image/png' : 'application/json');
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
  await page.route('**/api/hub/team', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const base = body.agents.find(agent => agent.id === 'briefs');
    const minutes = ago => new Date(Date.now() - ago * 60_000).toISOString();
    const extra = [
      { id: 'sx-needs', status: 'needs-you' }, { id: 'sx-failed', status: 'failed' }, { id: 'sx-done', status: 'idle', doneAt: minutes(1) },
      { id: 'sx-old', status: 'idle', doneAt: minutes(11) }, { id: 'sx-review', status: 'idle', review: true }, { id: 'sx-off', status: 'offline' },
    ].map(item => ({ ...base, ...item, name: item.id }));
    body.agents.push(...extra);
    await route.fulfill({ response, json: body });
  });
  return { page, errors };
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};
// Choose a sheet for Claude Code the way the owner does: Custom tab, Use this. The real avatar route saves it and the team response then carries a real custom sprite.
const chooseSheet = async (page, sheet) => {
  await page.goto(`${fixture.url}#/~hub/team`);
  await page.locator('[data-sprite-open="claude"]').click();
  const dialog = page.locator('dialog[data-sprite-sheet="claude"]');
  await dialog.locator('[data-sheet-mode="custom"]').click();
  await dialog.locator(`[data-sheet-use-custom="${sheet}"]`).click();
  await dialog.waitFor({ state: 'detached' });
};
const spriteOf = (page, agent) => page.locator(`[data-agent="${agent}"] .team-tile [data-row]`);

try {
  step('each card draws the row for its state (reduced motion off)');
  const { page: desk, errors } = await open({ width: 1280, height: 900 });
  await chooseSheet(desk, SHEET_ID);
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
  assert.match(style.image, /\/api\/hub\/file\?path=team(%2F|\/)claude(%2F|\/)sheet-20261029T100000Z-ab12\.png/);
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
  // Quick tab with a custom current sprite: it is the "Custom sprite" tile, not a randomized one.
  const first = sheet.locator('.sheet-tile').first();
  assert.equal(await first.getAttribute('data-sprite-tile'), 'custom');
  assert.equal(await first.getAttribute('aria-label'), 'Custom sprite, current');
  assert.equal(await first.getAttribute('aria-checked'), 'true');
  assert.equal(await sheet.locator('[data-sprite-tile^="random"]').count(), 0, 'No tile reads as randomized.');
  assert.equal(await sheet.locator('[data-sheet-note]').innerText(), 'This is the current sprite');
  assert.equal(await sheet.locator('[data-sheet-preview] [data-row]').count(), 1, 'The preview is the sheet.');
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
  assert.equal(await hermes.locator('[data-sheet-custom]').innerText(), 'No custom sheets yet.');

  step('Make a new one closes the sheet and opens Spawn with the Agent avatar preset, the project, the agent and the text filled');
  await hermes.locator('[data-sheet-make="hermes"]').click();
  await hermes.waitFor({ state: 'detached' });
  const spawn = desk.locator('[data-spawn-sheet]');
  await spawn.waitFor();
  assert.equal(await spawn.locator('[data-preset="agent-avatar"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await spawn.locator('[data-preset]').count(), 8, 'Opened for an agent, Spawn offers Agent avatar.');
  await desk.waitForFunction(() => document.querySelector('[data-spawn-project]')?.value === 'sprite-studio');
  assert.equal(await spawn.locator('[data-spawn-text]').inputValue(), 'Pixel sprite for Hermes: chats, plans and dispatches');
  assert.match(await spawn.locator('[data-spawn-agent]').innerText(), /Artist/);
  await spawn.locator('[data-spawn-machine]', { hasText: 'The PC' }).waitFor();
  await spawn.locator('[data-spawn-go]').click();
  await desk.locator('[data-spawn-toast]').waitFor();
  const made = [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/request\.json$/.test(key)).map(key => fixture.fake.json(key));
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].preset, made[0].project, made[0].agent, made[0].target], ['agent-avatar', 'sprite-studio', 'hermes', 'pc']);

  step('the button is hidden when the server lists no Agent avatar preset');
  await desk.route('**/api/hub/presets', route => route.fulfill({ json: { presets: [], rules: [] } }));
  await desk.reload();
  await desk.locator('[data-sprite-open="hermes"]').click();
  const bare = desk.locator('dialog[data-sprite-sheet="hermes"]');
  await bare.locator('[data-sheet-mode="custom"]').click();
  await bare.locator('[data-sheet-custom]').getByText('No custom sheets yet.').waitFor();
  assert.equal(await bare.locator('[data-sheet-make]').count(), 0);
  await desk.keyboard.press('Escape');
  await desk.unroute('**/api/hub/presets');

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
