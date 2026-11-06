// Run after npm run build. Team's two halves through a real browser: Agents (list, page, Floor) and Skills and plugins, read-only.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { agentConfigJson, seedAgentConfig } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const flat = text => text.replace(/\s+/g, ' ').trim();

// An export with a skill in a category, so the page's address holds an encoded slash.
const withSlash = startHubFixture({ pc: 'fresh', hermes: true });
const fresh = await startHubFixture({ pc: 'fresh', hermes: true, agentConfig: 'fresh' });
const stale = await startHubFixture({ agentConfig: 'stale' });
const bare = await startHubFixture({});
const slash = await withSlash;
seedAgentConfig(slash.fake, agentConfigJson({ now: new Date(), extraProfile: { skills: { autoLoad: [], installed: ['games/wall-jump', 'brief-writer'] } } }));
await new Promise(resolve => setTimeout(resolve, 150));

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};
const hashOf = page => page.evaluate(() => location.hash);
const skillsList = async (page, url) => {
  await page.goto(`${url}#/~hub/team/skills`);
  await page.locator('[data-skill]').first().waitFor();
};

try {
  step('390: Team has Agents and Skills and plugins as links, one step each; Floor is a view and survives a reload');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fresh.url}#/~hub/team`);
  await phone.locator('.team-row').first().waitFor();
  assert.equal(await phone.locator('[data-team-tab="agents"]').getAttribute('aria-selected'), 'true');
  assert.equal(await phone.locator('[data-team-tab="agents"]').getAttribute('href'), '#/~hub/team');
  assert.equal(await phone.locator('[data-team-tab="skills"]').getAttribute('href'), '#/~hub/team/skills');
  const steps = await phone.evaluate(() => history.length);
  await phone.locator('[data-team-view="floor"]').tap();
  await phone.locator('[data-room]').first().waitFor();
  assert.equal(await phone.evaluate(() => history.length), steps, 'Floor adds no back step.');
  await phone.reload();
  await phone.locator('[data-room]').first().waitFor();
  assert.equal(await phone.evaluate(() => localStorage.getItem('hub.team.view')), 'floor', 'Reload: still Floor.');
  await noSideways(phone, 'Floor at 390');
  await phone.locator('[data-team-view="roster"]').tap();
  await phone.locator('.team-row').first().waitFor();

  step('390: the skills list has rows with tags and no switch; plugins are one line; the install commands are below');
  await phone.locator('[data-team-tab="skills"]').tap();
  await phone.locator('[data-skill]').first().waitFor();
  assert.equal(await hashOf(phone), '#/~hub/team/skills');
  assert.equal(await phone.evaluate(() => history.length), steps + 1, 'One step into Skills and plugins.');
  assert.deepEqual(await phone.locator('[data-skill]').evaluateAll(list => list.map(row => row.getAttribute('data-skill'))), ['brief-writer', 'simplify-text', 'spend-digest']);
  assert.match(flat(await phone.locator('[data-skill="simplify-text"]').innerText()), /Every reply/);
  assert.match(flat(await phone.locator('[data-skill="simplify-text"]').innerText()), /Yours/);
  assert.doesNotMatch(flat(await phone.locator('[data-skill="spend-digest"]').innerText()), /Every reply/);
  assert.match(flat(await phone.locator('[data-skill="spend-digest"]').innerText()), /Yours/);
  assert.doesNotMatch(flat(await phone.locator('[data-skill="brief-writer"]').innerText()), /Every reply|Yours/);
  assert.equal(await phone.locator('[role="switch"], input[type="checkbox"]').count(), 0, 'No switch anywhere: nothing holds one list of who can use what.');
  assert.equal(flat(await phone.locator('[data-plugins-line]').innerText()), "Claude Code's plugins and skills live on the PC. The Hub has no list of them.");
  assert.ok(await phone.locator('.site-skill').count() >= 1, 'The install commands are on the page.');
  assert.match(await phone.locator('[data-skills-freshness]').getAttribute('data-skills-freshness'), /fresh/);
  assert.match(flat(await phone.locator('[data-skills-freshness]').innerText()), /^Read from the Hermes host 12 min ago\.$/);
  await noSideways(phone, 'Skills at 390');
  for (const target of await phone.locator('[data-skill], [data-team-tab]').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A row or a tab is ${target} px high.`);

  step('390: a skill page names the agents on the profiles that have it, and says profiles share a list');
  await phone.locator('[data-skill="simplify-text"]').tap();
  const page = phone.locator('[data-skill-page="simplify-text"]');
  await page.waitFor();
  assert.equal(await hashOf(phone), '#/~hub/team/skills/simplify-text');
  assert.equal(await phone.locator('[data-skill]').first().isVisible(), false, 'On a phone the page is alone.');
  const names = await page.locator('.ui-row b').allInnerTexts();
  assert.ok(names.includes('Hermes') && names.includes('Briefs'), `The agents on main and briefs are listed: ${names.join(', ')}.`);
  assert.ok(!names.includes('Claude Code'), 'Claude Code is not on a Hermes profile, so it is not claimed.');
  assert.equal(flat(await page.locator('[data-skill-shared]').innerText()), 'Agents on one profile share a list.');
  assert.match(flat(await page.locator('[data-skill-plugins]').innerText()), /live on the PC/);
  assert.equal(await phone.locator('[role="switch"]').count(), 0);
  await noSideways(phone, 'Skill page at 390');
  await page.locator('.ui-row', { hasText: 'Briefs' }).tap();
  await phone.locator('[data-agent-details="briefs"] .ad-head').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/agent/briefs');
  await phone.goBack();
  await page.waitFor();
  await phone.goBack();
  await phone.locator('[data-skill]').first().waitFor();
  assert.equal(await hashOf(phone), '#/~hub/team/skills', 'Back from a skill is the list.');

  step('390: an agent page shows what it can use as rows, and says Claude Code keeps its own on the PC');
  await phone.goto(`${fresh.url}#/~hub/agent/hermes`);
  await phone.locator('[data-agent-details="hermes"] [data-can-use]').first().waitFor();
  assert.equal(await phone.locator('[data-can-use]').count(), 3);
  assert.equal(await phone.locator('[role="switch"]').count(), 0);
  await phone.goto(`${fresh.url}#/~hub/agent/claude`);
  await phone.locator('[data-agent-details="claude"] [data-can-use-unknown]').waitFor();
  assert.match(flat(await phone.locator('[data-can-use-unknown]').innerText()), /Claude Code's plugins and skills live on the PC/);
  await noSideways(phone, 'Claude Code page at 390');
  await phone.setViewportSize({ width: 320, height: 700 });
  await skillsList(phone, fresh.url);
  await noSideways(phone, 'Skills at 320');
  await phone.goto(`${fresh.url}#/~hub/agent/hermes`);
  await phone.locator('[data-can-use]').first().waitFor();
  await noSideways(phone, 'Agent page at 320');

  step('1280: list and detail side by side, the first skill open, and the Floor fills the pane');
  const desk = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await skillsList(desk, fresh.url);
  await desk.locator('[data-skill-page]').waitFor();
  const list = await desk.locator('[data-skill]').first().boundingBox();
  const detail = await desk.locator('[data-skill-page]').boundingBox();
  assert.ok(list.x + list.width <= detail.x + 1, 'The list is left of the page.');
  assert.equal(await desk.locator('[data-skill-page]').getAttribute('data-skill-page'), 'brief-writer', 'The first skill is open.');
  assert.equal(await desk.locator('[data-skill="brief-writer"]').getAttribute('aria-current'), 'page');
  await desk.locator('[data-skill="spend-digest"]').click();
  await desk.locator('[data-skill-page="spend-digest"]').waitFor();
  assert.equal(await desk.locator('[data-skill]').count(), 3, 'The list stays while a page is open.');
  await noSideways(desk, 'Skills at 1280');
  await desk.goto(`${fresh.url}#/~hub/team`);
  await desk.locator('.team-row').first().waitFor();
  assert.equal(await desk.locator('[data-agent-details]').count(), 1, 'Agents: the list and the first agent beside it.');
  await desk.locator('[data-team-view="floor"]').click();
  await desk.locator('[data-room]').first().waitFor();
  const pane = await desk.locator('[data-team-half="agents"]').boundingBox();
  const floor = await desk.locator('.floor').boundingBox();
  assert.ok(floor.x >= pane.x && floor.x + floor.width <= pane.x + pane.width + 1, 'The floor is inside the pane.');
  assert.ok(floor.width >= pane.width - 80, `The floor fills the pane (${floor.width} of ${pane.width}).`);
  await noSideways(desk, 'Floor at 1280');
  assert.equal(await desk.locator('[role="switch"]').count(), 0);
  await desk.locator('[data-team-view="roster"]').click();

  step('a skill in a category has an encoded address, and the page finds it');
  await skillsList(desk, slash.url);
  await desk.locator('[data-skill="games/wall-jump"]').click();
  await desk.locator('[data-skill-page="games/wall-jump"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/team/skills/games%2Fwall-jump');
  await desk.reload();
  await desk.locator('[data-skill-page="games/wall-jump"]').waitFor();
  await desk.goto(`${fresh.url}#/~hub/team/skills/not-a-skill`);
  await desk.locator('[data-skill-gone]').waitFor();

  step('an old export says when it is from, and no export says so');
  await skillsList(desk, stale.url);
  const old = desk.locator('[data-skills-freshness]');
  assert.equal(await old.getAttribute('data-skills-freshness'), 'stale');
  assert.match(flat(await old.innerText()), /^Last read from the Hermes host 9 h ago\. Its export may have stopped/);
  await desk.goto(`${bare.url}#/~hub/team/skills`);
  await desk.locator('[data-skills-freshness="none"]').waitFor();
  assert.match(flat(await desk.locator('[data-skills-freshness]').innerText()), /has not published its settings yet/);
  assert.equal(await desk.locator('[data-skill]').count(), 0);
  assert.equal(await desk.locator('[data-skills-none]').count(), 1);

  step('a guest sees the agents and the floor, and a line saying skills need sign-in');
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(guestContext);
  await guestContext.route('**/api/hub/team/skills', route => route.fulfill({ status: 401, json: { error: 'Sign in to see this.' } }));
  await guestContext.route('**/api/hub/team/*/details', route => route.fulfill({ status: 401, json: { error: 'Sign in to see this.' } }));
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(ms(15000));
  await guest.goto(`${fresh.url}#/~hub/team/skills`);
  await guest.locator('[data-skills-signin]').waitFor();
  assert.equal(flat(await guest.locator('[data-skills-signin]').innerText()), 'Skills need sign-in. Agents and the floor are open to everyone.');
  assert.equal(await guest.locator('[data-skill]').count(), 0);
  assert.equal(await guest.locator('[role="switch"]').count(), 0);
  await guest.locator('[data-team-tab="agents"]').click();
  await guest.locator('.team-row').first().waitFor();
  assert.equal(await guest.locator('.team-row').count(), 7, 'The agents are there.');
  await guest.locator('[data-agent-details] [data-details-skills-signin]').waitFor();
  await guest.locator('[data-team-view="floor"]').click();
  await guest.locator('[data-room]').first().waitFor();
  assert.ok(await guest.locator('[data-desk]').count() >= 7, 'The floor is there.');

  console.log('hub-team-skills-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of [slash, fresh, stale, bare]) await fixture.close();
}
