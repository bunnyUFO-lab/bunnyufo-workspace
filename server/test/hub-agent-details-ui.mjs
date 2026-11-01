// Run after npm run build. The agent details page (#/~hub/agent/<id>) through a real browser, over the hub fixture.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};
const flat = text => text.replace(/\s+/g, ' ').trim();
const details = (page, id) => page.locator(`[data-agent-details="${id}"]`);
const visit = async (page, url, id) => {
  await page.goto(`${url}#/~hub/agent/${id}`);
  await details(page, id).locator('.ad-facts').waitFor();
};

const fresh = await startHubFixture({ pc: 'fresh', agentConfig: 'fresh' });
const stale = await startHubFixture({ agentConfig: 'stale' });
const bare = await startHubFixture({});

try {
  step('Team: every card has a Details link, and the one for Hermes opens #/~hub/agent/hermes');
  const desk = await open({ width: 1280, height: 800 });
  await desk.goto(`${fresh.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('[data-details-open]').count(), 6);
  assert.equal(await desk.locator('[data-details-open="claude"]').getAttribute('href'), '#/~hub/agent/claude');
  await desk.locator('[data-details-open="hermes"]').click();
  await details(desk, 'hermes').locator('.ad-facts').waitFor();
  assert.equal(new URL(desk.url()).hash, '#/~hub/agent/hermes');
  assert.equal(await desk.locator('[data-hub-link="team"]').getAttribute('aria-current'), 'page', 'Team stays the current row in the sidebar.');

  step('who it is, and the profile it runs on');
  const page = details(desk, 'hermes');
  assert.equal(await page.locator('h2').innerText(), 'Hermes');
  assert.equal(flat(await page.locator('.ad-facts').innerText()), 'Room Command Runs as Hermes profile main Profile main');
  assert.match(await page.locator('[data-details-status]').innerText(), /Idle|Offline|Working/);

  step('the model, in order, from the seeded export');
  assert.equal(flat(await page.locator('[data-model-primary]').innerText()), 'openai-codex · gpt-6-sol');
  assert.deepEqual((await page.locator('[data-model-fallbacks] li').allInnerTexts()).map(flat), ['then anthropic · claude-sonnet-5-5', 'then deepseek · deepseek-v4-pro']);

  step('the profile: toolsets, platforms, skills and the sandbox');
  const profile = flat(await page.locator('[data-details-profile]').innerText());
  assert.match(profile, /Toolsets web terminal/);
  assert.match(profile, /Per platform discord web/);
  assert.match(profile, /Skills loaded on every reply simplify-text/);
  assert.match(profile, /Installed skills spend-digest brief-writer/);
  assert.match(profile, /Sandbox docker · 512 MB/);

  step('fresh: a muted line with how long ago it was checked and changed');
  assert.match(flat(await page.locator('[data-details-freshness]').innerText()), /^Settings checked 12 min ago · last changed 2 days ago$/);
  assert.equal(await page.locator('[data-details-freshness]').getAttribute('data-details-freshness'), 'fresh');
  assert.equal(await page.locator('.hub-banner[data-details-freshness]').count(), 0, 'No warning when fresh.');

  step('the SOUL prompt is closed, opens on a click, shows the seeded line, and the fake key never reaches the page');
  const soul = page.locator('[data-prompt="soul"]');
  assert.equal(await soul.evaluate(node => node.open), false);
  assert.match(await soul.locator('summary').innerText(), /SOUL\.md \(profile main\)\s*Hermes host/);
  await soul.locator('summary').click();
  assert.equal(await soul.evaluate(node => node.open), true);
  assert.match(await soul.locator('pre').innerText(), /Always answer in plain words\./);
  const whole = await desk.locator('body').innerText();
  assert.ok(!/sk-ant/.test(whole), 'The fake secret is not on the page.');
  assert.ok(!/FAKEFAKE/.test(await desk.content()), 'Nor anywhere in the markup.');
  assert.match(await soul.locator('pre').innerText(), /\[redacted\]/);
  assert.match(await soul.locator('.ad-prompt-note').innerText(), /1 secret-like text was replaced/);
  await noSideways(desk, 'Hermes details at 1280');

  step('Briefs lists its scheduled job with the prompt in a details');
  await visit(desk, fresh.url, 'briefs');
  const job = details(desk, 'briefs').locator('[data-job="Daily brief"]');
  assert.match(flat(await job.innerText()), /Daily brief 0 8 \* \* \* On/);
  await job.locator('summary').click();
  assert.match(await job.locator('pre').innerText(), /Write the daily projects brief\./);
  assert.equal(await details(desk, 'hermes').count(), 0);

  step('Teardown shows the persona and the job template from the app, with the placeholders as they are');
  await visit(desk, fresh.url, 'teardown');
  const teardown = details(desk, 'teardown');
  assert.deepEqual(await teardown.locator('[data-prompt]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-prompt'))), ['soul', 'persona', 'job']);
  await teardown.locator('[data-prompt="persona"] summary').click();
  assert.match(await teardown.locator('[data-prompt="persona"] pre').innerText(), /You are Teardown, one of the owner's agents/);
  assert.match(await teardown.locator('[data-prompt="persona"] summary').innerText(), /App$/);
  await teardown.locator('[data-prompt="job"] summary').click();
  assert.match(await teardown.locator('[data-prompt="job"] summary').innerText(), /Job template \(.+\)\s*App/);
  assert.match(await teardown.locator('[data-prompt="job"] pre').innerText(), /\{\{requestId\}\}/);
  assert.match(await teardown.locator('[data-prompt="job"] .ad-prompt-note').innerText(), /Placeholders are filled in when a job starts\./);

  step('keyboard: Tab reaches each details summary, and Enter opens it');
  await visit(desk, fresh.url, 'teardown');
  await desk.locator('[data-details-back]').focus();
  const reached = new Set();
  for (let i = 0; i < 20 && reached.size < 3; i += 1) {
    await desk.keyboard.press('Tab');
    const id = await desk.evaluate(() => (document.activeElement?.tagName === 'SUMMARY' ? document.activeElement.parentElement.getAttribute('data-prompt') : null));
    if (id) reached.add(id);
  }
  assert.deepEqual([...reached].sort(), ['job', 'persona', 'soul']);
  await desk.keyboard.press('Enter');
  assert.equal(await desk.evaluate(() => document.activeElement.parentElement.open), true, 'Enter opens the focused prompt.');

  step('Claude Code: the settings live on the PC, no warning, no prompts');
  await visit(desk, fresh.url, 'claude');
  const claude = details(desk, 'claude');
  assert.equal(flat(await claude.locator('[data-details-freshness]').innerText()), "Claude Code's settings live on the PC and are not shown here yet.");
  assert.equal(await claude.locator('.hub-banner').count(), 0);
  assert.equal(await claude.locator('[data-prompt]').count(), 0);
  assert.equal(await claude.locator('[data-details-model]').count(), 0);
  assert.equal(await claude.locator('[data-details-profile-name]').innerText(), 'None');

  step('stale: an amber note says when the host was last read');
  await visit(desk, stale.url, 'hermes');
  const note = details(desk, 'hermes').locator('.hub-banner[data-details-freshness="stale"]');
  assert.match(flat(await note.innerText()), /^Last read from the Hermes host 9 h ago\. Its export may have stopped, so these settings may be out of date\.$/);
  assert.equal(await details(desk, 'hermes').locator('[data-model-primary]').count(), 1, 'The old settings are still shown.');

  step('no export: the note says the host has not published yet, and the app prompts are below');
  await visit(desk, bare.url, 'hermes');
  assert.equal(flat(await details(desk, 'hermes').locator('[data-details-freshness]').innerText()), 'The Hermes host has not published its settings yet. The prompts from the app are below.');
  assert.equal(await details(desk, 'hermes').locator('[data-details-model]').count(), 0);
  await visit(desk, bare.url, 'researcher');
  assert.deepEqual(await details(desk, 'researcher').locator('[data-prompt]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-prompt'))), ['persona', 'job']);

  step('an unknown agent says so, and Back goes to Team');
  await desk.goto(`${bare.url}#/~hub/agent/stranger`);
  await desk.locator('.hub-error').waitFor();
  await desk.locator('[data-details-back]').click();
  await desk.locator('.team-card').first().waitFor();

  step('390 px: no sideways scroll with every prompt open');
  const phone = await open({ width: 390, height: 800 });
  for (const id of ['hermes', 'briefs', 'teardown']) {
    await visit(phone, fresh.url, id);
    for (const summary of await phone.locator(`[data-agent-details="${id}"] details > summary`).all()) await summary.click();
    await noSideways(phone, `${id} details at 390`);
  }
  await phone.goto(`${fresh.url}#/~hub/team`);
  await phone.locator('.team-card').first().waitFor();
  await noSideways(phone, 'Team at 390');
  const link = await phone.locator('[data-details-open="hermes"]').boundingBox();
  assert.ok(link.height >= 44, 'The Details link is a touch target.');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await fresh.close();
  await stale.close();
  await bare.close();
}
console.log('hub-agent-details-ui: passed');
