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
const withPlugins = startHubFixture({ pc: 'fresh', hermes: true });
const slash = await withSlash;
const plugged = await withPlugins;
seedAgentConfig(slash.fake, agentConfigJson({ now: new Date(), extraProfile: { skills: { autoLoad: [], installed: ['games/wall-jump', 'brief-writer'] } } }));
// An export with plugins (on for one profile, off for the other) and skills in folders.
const pluggedDoc = agentConfigJson({ now: new Date() });
pluggedDoc.profiles.main.skills = { autoLoad: ['simplify-text'], installed: ['creative/draw', 'research/dig', 'research/scan', 'brief-writer'] };
pluggedDoc.profiles.main.plugins = [
  { name: 'disk-cleanup', status: 'enabled', version: '2.0.0', source: 'bundled', description: 'Clean up temp files.' },
  { name: 'chronos', status: 'not enabled', version: '1.0.0', source: 'bundled', description: 'Managed cron.' },
];
pluggedDoc.profiles.briefs.plugins = [{ name: 'disk-cleanup', status: 'disabled', version: '2.0.0', source: 'bundled', description: 'Clean up temp files.' }];
seedAgentConfig(plugged.fake, pluggedDoc);
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
// The same list read by skill: one row for each skill, with its page.
const bySkill = async page => {
  if (await page.locator('[data-skills-by="skill"]').count()) return;
  await page.getByRole('button', { name: 'By skill' }).click();
  await page.locator('[data-skills-by="skill"]').waitFor();
};

try {
  step('390: Team opens on the Floor, List is a switch, the choice survives a reload; Agents and Skills and plugins are links, one step each');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fresh.url}#/~hub/team`);
  await phone.locator('[data-room]').first().waitFor();
  assert.equal(await phone.locator('[data-team-view="floor"]').getAttribute('aria-pressed'), 'true', 'The Floor is the default.');
  assert.equal(await phone.evaluate(() => localStorage.getItem('hub.team.view')), null, 'Nothing was chosen yet.');
  assert.equal(await phone.locator('[data-team-tab="agents"]').getAttribute('aria-selected'), 'true');
  assert.equal(await phone.locator('[data-team-tab="agents"]').getAttribute('href'), '#/~hub/team');
  assert.equal(await phone.locator('[data-team-tab="skills"]').getAttribute('href'), '#/~hub/team/skills');
  await noSideways(phone, 'Floor at 390');
  const steps = await phone.evaluate(() => history.length);
  await phone.locator('[data-team-view="roster"]').tap();
  await phone.locator('.team-row').first().waitFor();
  assert.equal(await phone.evaluate(() => history.length), steps, 'List adds no back step.');
  await phone.reload();
  await phone.locator('.team-row').first().waitFor();
  assert.equal(await phone.evaluate(() => localStorage.getItem('hub.team.view')), 'roster', 'Reload: still the list.');
  await phone.locator('[data-team-view="floor"]').tap();
  await phone.locator('[data-room]').first().waitFor();
  await phone.reload();
  await phone.locator('[data-room]').first().waitFor();

  step('390: skills read by agent, groups share a profile, no switch, install commands gone, plugins not listed yet');
  const before = await phone.evaluate(() => history.length);
  await phone.locator('[data-team-tab="skills"]').tap();
  await phone.locator('[data-agent-group]').first().waitFor();
  assert.equal(await hashOf(phone), '#/~hub/team/skills');
  assert.equal(await phone.evaluate(() => history.length), before + 1, 'One step into Skills and plugins.');
  assert.deepEqual(await phone.locator('[data-agent-group]').evaluateAll(list => list.map(item => item.getAttribute('data-agent-group'))), ['main', 'briefs', 'claude']);
  assert.equal(await phone.getByRole('button', { name: 'By agent' }).getAttribute('aria-pressed'), 'true', 'By agent is the default.');
  const main = phone.locator('[data-agent-group="main"]');
  assert.match(flat(await main.locator('[data-group-shared]').innerText()), /^Hermes, .* and Planner share one list\. 3 skills\.$/);
  assert.deepEqual(await main.locator('[data-skill]').evaluateAll(list => list.map(row => row.getAttribute('data-skill'))), ['brief-writer', 'simplify-text', 'spend-digest']);
  assert.match(flat(await main.locator('[data-skill="simplify-text"]').innerText()), /Every reply/);
  assert.match(flat(await main.locator('[data-skill="simplify-text"]').innerText()), /Yours/);
  assert.doesNotMatch(flat(await main.locator('[data-skill="spend-digest"]').innerText()), /Every reply/);
  assert.match(flat(await main.locator('[data-skill="spend-digest"]').innerText()), /Yours/);
  assert.doesNotMatch(flat(await main.locator('[data-skill="brief-writer"]').innerText()), /Every reply|Yours/);
  assert.equal(await phone.locator('[data-agent-group="briefs"] [data-group-shared]').count(), 0, 'Briefs shares with nobody, so no line says so.');
  assert.match(flat(await phone.locator('[data-agent-group="claude"] [data-group-unknown]').innerText()), /Claude Code's plugins and skills live on the PC/);
  assert.equal(await phone.locator('[role="switch"], input[type="checkbox"]').count(), 0, 'No switch anywhere: nothing holds one list of who can use what.');
  assert.equal(flat(await phone.locator('[data-plugins-line]').innerText()), "Claude Code's plugins and skills live on the PC. The Hub has no list of them.");
  assert.equal(flat(await phone.locator('[data-plugins-unknown]').innerText()), "The Hermes host's export does not list plugins yet.");
  assert.equal(await phone.locator('[data-group-plugins]').count(), 0, 'No empty Plugins heading.');
  assert.equal(await phone.locator('.site-skill').count(), 0, 'The install commands are in Settings now.');
  assert.match(await phone.locator('[data-skills-freshness]').getAttribute('data-skills-freshness'), /fresh/);
  assert.match(flat(await phone.locator('[data-skills-freshness]').innerText()), /^Read from the Hermes host 12 min ago\.$/);
  await noSideways(phone, 'Skills by agent at 390');
  for (const target of await phone.locator('[data-skill], [data-team-tab], [data-skills-by] button, [data-skills-search]').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A row, a tab or the search is ${target} px high.`);

  step('390: the search narrows every group; By skill is a switch with no back step, remembered');
  await phone.locator('[data-skills-search]').fill('spend');
  assert.deepEqual(await phone.locator('[data-skill]').evaluateAll(list => list.map(row => row.getAttribute('data-skill'))), ['spend-digest', 'spend-digest']);
  await phone.locator('[data-skills-search]').fill('zzz');
  assert.equal(await phone.locator('[data-skill]').count(), 0);
  assert.equal(await phone.locator('[data-group-none]').count(), 2, 'Each Hermes group says nothing matches.');
  await phone.locator('[data-skills-search]').fill('');
  const flipped = await phone.evaluate(() => history.length);
  await phone.getByRole('button', { name: 'By skill' }).tap();
  await phone.locator('[data-skills-by="skill"]').waitFor();
  assert.equal(await phone.evaluate(() => history.length), flipped, 'The switch adds no back step.');
  assert.equal(await hashOf(phone), '#/~hub/team/skills');
  assert.equal(await phone.evaluate(() => localStorage.getItem('hub.team.skillsBy')), 'skill');
  assert.deepEqual(await phone.locator('[data-skill]').evaluateAll(list => list.map(row => row.getAttribute('data-skill'))), ['brief-writer', 'simplify-text', 'spend-digest']);
  await phone.locator('[data-skills-search]').fill('brief');
  assert.equal(await phone.locator('[data-skill]').count(), 1);
  await phone.locator('[data-skills-search]').fill('');
  await noSideways(phone, 'Skills by skill at 390');
  for (const target of await phone.locator('[data-skill], [data-team-tab]').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A row or a tab is ${target} px high.`);
  await phone.reload();
  await phone.locator('[data-skills-by="skill"]').waitFor();

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

  step('1280: by agent fills the pane with the groups side by side; by skill has the list and the first skill open; Floor is the default');
  const desk = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await skillsList(desk, fresh.url);
  assert.equal(await desk.locator('[data-skill-page]').count(), 0, 'By agent has no page beside it.');
  assert.equal(await desk.locator('.ui-placeholder').count(), 0, 'No empty right side.');
  const skillsPane = await desk.locator('[data-team-half="skills"]').boundingBox();
  const shown = await desk.locator('[data-skills-by="agent"]').boundingBox();
  assert.ok(shown.width >= skillsPane.width - 100, `The groups use the pane (${shown.width} of ${skillsPane.width}).`);
  const first = await desk.locator('[data-agent-group="main"]').boundingBox();
  const second = await desk.locator('[data-agent-group="briefs"]').boundingBox();
  assert.ok(second.x > first.x + first.width - 1 && Math.abs(second.y - first.y) < 2, 'Two groups sit side by side.');
  await noSideways(desk, 'Skills by agent at 1280');
  await bySkill(desk);
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
  await desk.getByRole('button', { name: 'By agent' }).click();
  await desk.locator('[data-skills-by="agent"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/team/skills', 'Back to By agent leaves the skill address.');
  await desk.goto(`${fresh.url}#/~hub/team`);
  await desk.locator('[data-room]').first().waitFor();
  const pane = await desk.locator('[data-team-half="agents"]').boundingBox();
  const floor = await desk.locator('.floor').boundingBox();
  assert.ok(floor.x >= pane.x && floor.x + floor.width <= pane.x + pane.width + 1, 'The floor is inside the pane.');
  assert.ok(floor.width >= pane.width - 80, `The floor fills the pane (${floor.width} of ${pane.width}).`);
  await noSideways(desk, 'Floor at 1280');
  assert.equal(await desk.locator('[role="switch"]').count(), 0);
  await desk.locator('[data-team-view="roster"]').click();
  await desk.locator('.team-row').first().waitFor();
  assert.equal(await desk.locator('[data-agent-details]').count(), 1, 'Agents: the list and the first agent beside it.');
  await desk.locator('[data-team-view="floor"]').click();

  step('plugins from the export, skills in folders, and the search over both');
  await desk.goto(`${plugged.url}#/~hub/team/skills`);
  await desk.locator('[data-agent-group]').first().waitFor();
  assert.equal(await desk.locator('[data-plugins-unknown]').count(), 0, 'The export lists plugins, so no "not yet" line.');
  const hermes = desk.locator('[data-agent-group="main"]');
  assert.deepEqual(await hermes.locator('[data-folder]').evaluateAll(list => list.map(item => item.getAttribute('data-folder'))), ['creative', 'research', '']);
  assert.deepEqual(await hermes.locator('[data-folder="research"] [data-skill]').evaluateAll(list => list.map(row => row.getAttribute('data-skill'))), ['research/dig', 'research/scan']);
  assert.equal(flat(await hermes.locator('[data-folder="research"] [data-skill="research/dig"] b').innerText()), 'dig', 'A skill in a folder shows its own name under the folder heading.');
  assert.deepEqual(await hermes.locator('[data-plugin]').evaluateAll(list => list.map(row => [row.getAttribute('data-plugin'), row.getAttribute('data-plugin-status')])), [['disk-cleanup', 'enabled'], ['chronos', 'not enabled']], 'Enabled plugins first.');
  assert.equal(await desk.locator('[data-agent-group="briefs"] [data-plugin="disk-cleanup"]').getAttribute('data-plugin-status'), 'disabled', 'The same plugin reads off on the other profile.');
  assert.equal(await desk.locator('[data-agent-group="claude"] [data-plugin]').count(), 0);
  await desk.locator('[data-skills-search]').fill('chron');
  assert.equal(await desk.locator('[data-plugin]').count(), 1, 'The search covers plugins.');
  assert.equal(await desk.locator('[data-skill]').count(), 0);
  await desk.locator('[data-skills-search]').fill('RESEARCH');
  assert.equal(await desk.locator('[data-skill]').count(), 2, 'The search ignores case and matches the folder.');
  await desk.locator('[data-skills-search]').fill('');
  await bySkill(desk);
  assert.deepEqual(await desk.locator('[data-plugin]').evaluateAll(list => list.map(row => row.getAttribute('data-plugin'))), ['chronos', 'disk-cleanup']);
  assert.match(flat(await desk.locator('[data-plugin="disk-cleanup"]').innerText()), /On for Hermes, .*Planner/);
  assert.doesNotMatch(flat(await desk.locator('[data-plugin="disk-cleanup"]').innerText()), /Briefs/, 'Off on the Briefs profile, so Briefs is not listed.');
  assert.match(flat(await desk.locator('[data-plugin="chronos"]').innerText()), /Not on for any agent/);
  await noSideways(desk, 'Plugins at 1280');
  await desk.getByRole('button', { name: 'By agent' }).click();

  step('Settings holds the install commands, and search finds them');
  await desk.goto(`${fresh.url}#/~hub/settings`);
  await desk.locator('[data-settings]').waitFor();
  await desk.getByRole('heading', { name: 'Install skills on a PC' }).waitFor();
  assert.ok(await desk.locator('[data-settings] .site-skill').count() >= 1, 'The install commands are in Settings.');
  await desk.keyboard.press('Control+k');
  await desk.getByRole('combobox').or(desk.getByRole('searchbox')).first().fill('install skills');
  await desk.getByText('Install skills on a PC').first().waitFor();
  await desk.keyboard.press('Escape');

  step('a skill in a category has an encoded address, and the page finds it');
  await skillsList(desk, slash.url);
  await bySkill(desk);
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
  await bySkill(desk);
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
  await guest.locator('[data-room]').first().waitFor();
  assert.ok(await guest.locator('[data-desk]').count() >= 7, 'The floor is there, as the default.');
  await guest.locator('[data-team-view="roster"]').click();
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
  for (const fixture of [slash, fresh, stale, bare, plugged]) await fixture.close();
}
