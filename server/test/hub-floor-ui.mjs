// Run after npm run build. The Floor view of the Team screen through a real browser over the hub fixture.
// The team, the sheets and the avatar choice are the real routes; the team response is patched in the page to add agents
// in other rooms and states, and /hub/events is answered by the page so the ticker has known lines to show.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { teamSheet } from '../../site/api/test/hub-fixtures.mjs';
import { AGENTS } from '../../site/api/hub-team.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const ROWS = ['idle', 'run-right', 'run-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const SHEET_ID = 'sheet-20261029T100000Z-ab12';
const sheet = teamSheet('briefs', { rows: ROWS.map(state => ({ state, frames: 4, fps: 8 })) });
assert.equal(sheet.id, SHEET_ID);

const fixture = await startHubFixture({ pc: 'fresh' });
for (const [name, body] of Object.entries(sheet.files)) fixture.seed.put(`team/briefs/${name}`, body, name.endsWith('.png') ? 'image/png' : 'application/json');
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];

const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const TICKER = [
  { kind: 'session-started', ts: minutesAgo(1), file: 'a.json', title: 'Wall-jump tutorial: session started', host: 'h', source: 's' },
  { kind: 'ask-created', ts: minutesAgo(2), file: 'b.json', title: 'Pick the jump arc', agent: 'hermes', host: 'h', source: 's' },
  { kind: 'ready-for-review', ts: minutesAgo(3), file: 'c.json', title: 'Sprite states: ready for review', host: 'h', source: 's' },
  { kind: 'pr-opened', ts: minutesAgo(0), file: 'd.json', title: 'Not for the ticker', host: 'h', source: 's' },
];

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const eventRequests = [];
  page.on('pageerror', error => { throw error; });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/hub/team', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const base = body.agents.find(agent => agent.id === 'briefs');
    body.agents.push(
      { ...base, id: 'sx-needs', name: 'Needs desk', room: 'Review', status: 'needs-you', task: 'Waiting for your pick on the jump arc', sprite: { kind: 'builtin', key: 'qa' } },
      { ...base, id: 'sx-idle', name: 'Idle desk', room: 'Review', status: 'idle', task: 'Nothing to do', sprite: { kind: 'builtin', key: 'lib_b' } },
      { ...base, id: 'sx-long', name: 'Market research and competitor analysis', room: 'Review', status: 'working', task: 'Reading the long report', sprite: { kind: 'builtin', key: 'qa' } },
      { ...base, id: 'sx-stray', name: 'Stray desk', room: 'Basement', status: 'working', task: 'In a room nobody drew', sprite: { kind: 'builtin', key: 'developer' } },
    );
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/hub/events**', route => {
    eventRequests.push(route.request().url());
    return route.fulfill({ json: { events: TICKER, truncated: false } });
  });
  return { page, errors, eventRequests };
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};
const floorOf = page => page.locator('[data-team-floor]');
const tickerText = page => page.locator('[data-floor-ticker]').innerText().then(text => text.replace(/\s+/g, ' ').trim());

try {
  step('Roster is the default; Floor puts every agent in its room, unknown rooms in Ops, and the choice survives a reload');
  const { page: desk, errors } = await open({ width: 1920, height: 1080 });
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('[data-team-view="roster"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await floorOf(desk).count(), 0);
  await desk.locator('[data-team-view="floor"]').click();
  await floorOf(desk).waitFor();
  assert.equal(await desk.locator('[data-team-view="floor"]').getAttribute('aria-pressed'), 'true');
  for (const agent of AGENTS) assert.equal(await desk.locator(`[data-room="${agent.room}"] [data-desk="${agent.id}"]`).count(), 1, `${agent.id} is in ${agent.room}`);
  assert.equal(await desk.locator('[data-room="Review"] [data-desk="sx-needs"]').count(), 1);
  assert.equal(await desk.locator('[data-room="Ops"] [data-desk="sx-stray"]').count(), 1, 'An unknown room is Ops.');
  assert.deepEqual(await desk.locator('[data-room]').evaluateAll(list => list.map(room => room.getAttribute('data-room'))), ['Command', 'Research', 'Build', 'Review', 'Ops'], 'Empty rooms are left out; the rest keep their order.');
  await noSideways(desk, 'Floor at 1920');
  await desk.reload();
  await floorOf(desk).waitFor();
  assert.equal(await desk.evaluate(() => localStorage.getItem('hub.team.view')), 'floor');

  step('a needs-you desk shows !; hover and keyboard focus show the task bubble');
  assert.equal(await desk.locator('[data-desk="sx-needs"] [data-desk-excl]').innerText(), '!');
  assert.equal(await desk.locator('[data-desk="hermes"] [data-desk-excl]').count(), 0);
  const bubble = desk.locator('[data-desk="sx-needs"] [data-desk-bubble]');
  assert.equal(await bubble.evaluate(node => getComputedStyle(node).opacity), '0');
  await desk.locator('[data-desk="sx-needs"]').hover();
  await desk.waitForFunction(() => getComputedStyle(document.querySelector('[data-desk="sx-needs"] [data-desk-bubble]')).opacity === '1');
  assert.match(await bubble.innerText(), /Waiting for your pick on the jump arc/);
  await desk.mouse.move(5, 5);
  await desk.locator('[data-team-view="floor"]').focus();
  await desk.keyboard.press('Tab');
  assert.equal(await desk.evaluate(() => document.activeElement?.getAttribute('data-desk')), AGENTS[0].id, 'Tab goes to the first desk.');
  await desk.waitForFunction(id => getComputedStyle(document.querySelector(`[data-desk="${id}"] [data-desk-bubble]`)).opacity === '1', AGENTS[0].id);

  step('a long desk name ends in an ellipsis, and a mouse sees no task line under it');
  const longName = desk.locator('[data-desk="sx-long"] .floor-name');
  const cut = await longName.evaluate(node => ({ over: node.scrollWidth > node.clientWidth, overflow: getComputedStyle(node).textOverflow, shown: node.getBoundingClientRect().right <= node.closest('.floor-desk').getBoundingClientRect().right }));
  assert.deepEqual(cut, { over: true, overflow: 'ellipsis', shown: true }, 'The plate cuts the name with an ellipsis, inside the desk.');
  assert.equal(await desk.locator('[data-desk="sx-needs"] [data-desk-task]').isVisible(), false, 'A mouse has the bubble, not the task line.');

  step('an idle custom-sheet agent walks under CSS only: three sheet layers and a floor-walk animation');
  await desk.locator('[data-team-view="roster"]').click();
  await desk.locator('[data-sprite-open="briefs"]').click();
  const dialog = desk.locator('dialog[data-sprite-sheet="briefs"]');
  await dialog.locator('[data-sheet-mode="custom"]').click();
  await dialog.locator(`[data-sheet-use-custom="${SHEET_ID}"]`).click();
  await dialog.waitFor({ state: 'detached' });
  await desk.locator('[data-team-view="floor"]').click();
  const walker = desk.locator('[data-desk="briefs"] [data-floor-walk]');
  await walker.waitFor();
  assert.deepEqual(await walker.locator('[data-row]').evaluateAll(list => list.map(node => node.getAttribute('data-row'))), ['idle', 'run-right', 'run-left']);
  const names = await walker.evaluate(node => [getComputedStyle(node).animationName, ...[...node.children].map(child => getComputedStyle(child).animationName)]);
  assert.deepEqual(names, ['floor-walk', 'floor-idle', 'floor-right', 'floor-left']);
  assert.equal(await desk.locator('[data-desk="hermes"] [data-floor-walk]').count(), 0, 'A built-in sprite does not walk.');
  assert.equal(await desk.locator('[data-desk="sx-idle"] .floor-spr').getAttribute('class'), 'floor-spr bob', 'An idle quick default bobs.');

  step('a desk opens the agent\'s Roster card, focused, without changing the chosen view');
  await desk.locator('[data-desk="briefs"]').click();
  await desk.locator('.team-card[data-agent="briefs"]').waitFor();
  await desk.waitForFunction(() => document.activeElement?.getAttribute('data-agent') === 'briefs');
  assert.equal(await desk.evaluate(() => localStorage.getItem('hub.team.view')), 'floor');
  await desk.reload();
  await floorOf(desk).waitFor();

  step('reduced motion: the walker stands still on the idle layer');
  const { page: calm, eventRequests: calmRequests } = await open({ width: 1280, height: 900 }, { reducedMotion: 'reduce' });
  await calm.goto(`${fixture.url}#/~hub/team`);
  await calm.locator('[data-team-view="floor"]').click();
  const stand = calm.locator('[data-desk="briefs"] [data-floor-walk]');
  await stand.waitFor();
  assert.deepEqual(await stand.evaluate(node => [getComputedStyle(node).animationName, ...[...node.children].map(child => `${getComputedStyle(child).animationName}:${getComputedStyle(child).opacity}`)]), ['none', 'none:1', 'none:0', 'none:0']);
  assert.equal(await calm.locator('[data-desk="sx-idle"] .floor-spr').evaluate(node => getComputedStyle(node).animationName), 'none');
  await calm.locator('[data-floor-ticker] .floor-tick').waitFor();
  assert.ok(calmRequests.length >= 1);

  step('the ticker lists only session, review and ask events, newest first, one at a time, each with its agent');
  const { page: tick, errors: tickErrors, eventRequests } = await open({ width: 1280, height: 900 });
  await tick.clock.install({ time: new Date() });
  await tick.goto(`${fixture.url}#/~hub/team`);
  await tick.locator('[data-team-view="floor"]').click();
  await tick.locator('[data-floor-ticker] .floor-tick').waitFor();
  assert.match(await tickerText(tick), /^Claude Code Wall-jump tutorial: session started · 1 min ago$/);
  const seen = [await tickerText(tick)];
  for (let turn = 0; turn < 2; turn += 1) { await tick.clock.runFor(4000); seen.push(await tickerText(tick)); }
  assert.match(seen[1], /^Hermes Pick the jump arc/, 'An event that names its agent shows that agent.');
  assert.match(seen[2], /^Claude Code Sprite states: ready for review/);
  assert.ok(!seen.some(text => /Not for the ticker/.test(text)), 'A PR event is not a ticker line.');
  await tick.clock.runFor(4000);
  assert.equal(await tickerText(tick), seen[0], 'It comes back round to the newest.');
  assert.equal(await tick.locator('[data-floor-ticker] [data-ticker-agent]').count(), 1, 'One line at a time.');

  step('it polls once a minute with since=, and switching to Roster stops the timers');
  const asked = eventRequests.length;
  assert.ok(asked >= 1);
  await tick.clock.runFor(61_000);
  assert.ok(eventRequests.length > asked, 'A minute later it asked again.');
  assert.match(eventRequests.at(-1), /[?&]since=\d{4}-/, 'The later poll asks only for what is newer.');
  await tick.locator('[data-team-view="roster"]').click();
  await tick.locator('.team-card').first().waitFor();
  assert.equal(await floorOf(tick).count(), 0);
  const stopped = eventRequests.length;
  await tick.clock.runFor(70_000);
  assert.equal(eventRequests.length, stopped, 'No /hub/events request after 65 s on Roster.');
  assert.deepEqual(tickErrors.filter(text => !/Failed to load resource/.test(text)), [], 'no console errors');

  step('reduced motion: the ticker does not rotate');
  const { page: still } = await open({ width: 1280, height: 900 }, { reducedMotion: 'reduce' });
  await still.clock.install({ time: new Date() });
  await still.goto(`${fixture.url}#/~hub/team`);
  await still.locator('[data-team-view="floor"]').click();
  await still.locator('[data-floor-ticker] .floor-tick').waitFor();
  const first = await tickerText(still);
  await still.clock.runFor(9000);
  assert.equal(await tickerText(still), first);

  step('the ticker still shows an event when claude is not on the team, without a name or a sprite');
  const { page: bare } = await open({ width: 1280, height: 900 });
  await bare.route('**/api/hub/team', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.agents = body.agents.filter(agent => agent.id !== 'claude');
    await route.fulfill({ response, json: body });
  });
  await bare.goto(`${fixture.url}#/~hub/team`);
  await bare.locator('[data-team-view="floor"]').click();
  await bare.locator('[data-floor-ticker] .floor-tick').waitFor();
  assert.equal(await bare.locator('[data-desk="claude"]').count(), 0, 'claude is not on this team.');
  assert.match(await tickerText(bare), /^Wall-jump tutorial: session started · [12] min ago$/);
  assert.doesNotMatch(await tickerText(bare), /Nothing has happened/);
  assert.equal(await bare.locator('.floor-tick-sprite').count(), 0);

  step('phone widths: rooms stack and nothing scrolls sideways');
  for (const width of [375, 390]) {
    const { page: phone } = await open({ width, height: 844 }, { hasTouch: true, isMobile: true });
    await phone.goto(`${fixture.url}#/~hub/team`);
    await phone.locator('[data-team-view="floor"]').tap();
    await floorOf(phone).waitFor();
    await noSideways(phone, `Floor at ${width}`);
    const rooms = await phone.locator('[data-room]').evaluateAll(list => list.map(room => { const box = room.getBoundingClientRect(); return { x: Math.round(box.x), right: Math.round(box.right), y: Math.round(box.y) }; }));
    assert.ok(rooms.length >= 4);
    assert.ok(rooms.every(room => room.x === rooms[0].x && room.right <= width), 'One column, inside the screen.');
    assert.deepEqual([...rooms].map(room => room.y), [...rooms].map(room => room.y).sort((a, b) => a - b), 'Rooms stack top to bottom.');
    for (const target of await phone.locator('[data-desk], [data-team-view]').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A target is ${target} px high.`);
    const touch = await phone.locator('[data-desk="sx-needs"]').evaluate(node => {
      const task = node.querySelector('[data-desk-task]'); const box = task.getBoundingClientRect(); const desk = node.getBoundingClientRect();
      return { text: task.textContent, shown: getComputedStyle(task).display !== 'none' && box.height > 0, inside: box.left >= desk.left && box.right <= desk.right && box.bottom <= desk.bottom, bubble: getComputedStyle(node.querySelector('[data-desk-bubble]')).display };
    });
    assert.deepEqual(touch, { text: 'Waiting for your pick on the jump arc', shown: true, inside: true, bubble: 'none' }, `A touch screen shows the task under the name at ${width}.`);
    assert.equal(await phone.locator('[data-desk="sx-long"] .floor-name').evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis'), true, 'The long name is cut with an ellipsis.');
    await phone.locator('[data-desk="sx-needs"]').tap();
    await phone.locator('.team-card[data-agent="sx-needs"]').waitFor();
    await noSideways(phone, `Roster after a desk at ${width}`);
  }

  assert.deepEqual(errors.filter(text => !/Failed to load resource/.test(text)), [], 'no console errors');
  console.log('hub-floor-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
