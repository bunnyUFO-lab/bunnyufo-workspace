// Run after npm run build. The agent details page (#/~hub/agent/<id>) through a real browser, over the hub fixture.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { askId, startHubFixture } from './hub-fixture.mjs';
import { askJson } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
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
const flat = text => text.replace(/\s+/g, ' ').trim();
const details = (page, id) => page.locator(`[data-agent-details="${id}"]`);
const visit = async (page, url, id) => {
  await page.goto(`${url}#/~hub/agent/${id}`);
  await details(page, id).locator('.ad-facts').waitFor();
};

const fresh = await startHubFixture({ pc: 'fresh', agentConfig: 'fresh' });
const stale = await startHubFixture({ agentConfig: 'stale' });
// An agent's proposal to edit the Planner's persona (ws-im1.4.1): applied only by the owner's answer.
const EDIT_ASK = askId('planner-edit', 'e1d1');
const EDIT_OPTIONS = [{ id: 'apply', label: 'Apply this edit' }, { id: 'skip', label: 'Leave it as it is' }];
fresh.seed.ask({ ...askJson({ id: EDIT_ASK, project: 'probe', question: 'Shorten the Planner prompt?', options: EDIT_OPTIONS, allowDrawing: false, kind: 'approval' }), requirePasskey: true, agentEdit: { op: 'persona', agent: 'planner', base: 'default', prompt: 'You are Planner. Ask one question at a time.', why: 'The chats ran long.' } });
await new Promise(resolve => setTimeout(resolve, 150));
const bare = await startHubFixture({});

try {
  step('Team: every card has a Details link, and the one for Hermes opens #/~hub/agent/hermes');
  const desk = await open({ width: 1280, height: 800 });
  await desk.goto(`${fresh.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('[data-details-open]').count(), 7);
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

  step('Teardown: an Edit link in the head and a Chat model row; Hermes has neither');
  assert.equal(await teardown.locator('[data-edit-open="teardown"]').getAttribute('href'), '#/~hub/agent-edit/teardown');
  assert.equal(flat(await teardown.locator('[data-details-chat-model]').innerText()), 'Codex');
  await visit(desk, fresh.url, 'hermes');
  assert.equal(await details(desk, 'hermes').locator('[data-edit-open], [data-details-chat-model]').count(), 0);
  await visit(desk, fresh.url, 'teardown');

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

  step('Edit: the page opens from Details with the current text; Save is off until something changes');
  const edit = desk.locator('[data-agent-edit="teardown"]');
  await details(desk, 'teardown').locator('[data-edit-open="teardown"]').click();
  await edit.locator('[data-edit-form]').waitFor();
  assert.equal(new URL(desk.url()).hash, '#/~hub/agent-edit/teardown');
  assert.equal(await desk.locator('[data-hub-link="team"]').getAttribute('aria-current'), 'page', 'Team stays the current row in the sidebar.');
  assert.match(await edit.locator('[data-edit-prompt]').inputValue(), /^You are Teardown, one of the owner's agents: how a public game works/);
  assert.equal(await edit.locator('[data-edit-model]').inputValue(), 'codex');
  assert.equal(flat(await edit.locator('[data-edit-model-note]').innerText()), "Chat only. Jobs use the profile's model.");
  assert.equal(await edit.locator('[data-edit-save]').isDisabled(), true);
  assert.deepEqual(await edit.locator('[data-version]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-version'))), ['default']);
  assert.equal(await edit.locator('[data-revert]').count(), 0, 'The only version is the current one.');
  assert.match(flat(await edit.locator('.ad-head').innerText()), /Toolsets, skills, SOUL\.md and scheduled jobs stay view-only/);
  await noSideways(desk, 'Edit at 1280');

  step('Edit: Save keeps the old version; the list shows both, with Revert on the older, and the Team card names the chat model');
  await edit.locator('[data-edit-prompt]').fill('You are Teardown. Keep it brief.');
  await edit.locator('[data-edit-model]').selectOption('haiku');
  await edit.locator('[data-edit-note]').fill('Shorter answers');
  assert.equal(await edit.locator('[data-edit-save]').isEnabled(), true);
  await edit.locator('[data-edit-save]').click();
  await edit.locator('[data-edit-saved]').waitFor();
  assert.equal(await edit.locator('[data-edit-save]').isDisabled(), true, 'Nothing is left to save.');
  assert.equal(await edit.locator('[data-version]').count(), 2);
  assert.match(flat(await edit.locator('[data-version][data-current] .ae-version-who').innerText()), /^Edited .* by .+/);
  assert.equal(flat(await edit.locator('[data-version][data-current] .ae-version-note').innerText()), 'Shorter answers');
  assert.equal(await edit.locator('[data-version="default"] [data-revert]').innerText(), "Back to the app's text");
  await edit.locator('[data-version="default"] summary').click();
  assert.match(await edit.locator('[data-version="default"] pre').innerText(), /^You are Teardown, one of the owner's agents/);
  await desk.goto(`${fresh.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.match(flat(await desk.locator('[data-agent="teardown"] .team-facts').innerText()), /chat: Haiku/);

  step("Edit: a 409 keeps what was typed and offers a reload; Back to the app's text follows the app again");
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await edit.locator('[data-edit-form]').waitFor();
  await edit.locator('[data-edit-role]').fill('a role I typed');
  await desk.route('**/api/hub/team/teardown/persona', route => (route.request().method() === 'POST' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This persona changed while you were looking.' }) }) : route.continue()));
  await edit.locator('[data-edit-save]').click();
  await edit.locator('[data-edit-error]').waitFor();
  assert.match(flat(await edit.locator('[data-edit-error]').innerText()), /This persona changed while you were looking\. What you typed is kept\./);
  assert.equal(await edit.locator('[data-edit-role]').inputValue(), 'a role I typed');
  await desk.unroute('**/api/hub/team/teardown/persona');
  await edit.locator('[data-edit-reload]').click();
  await edit.locator('[data-edit-error]').waitFor({ state: 'detached' });
  assert.equal(await edit.locator('[data-edit-role]').inputValue(), 'a role I typed', 'Reload moves the base and keeps the text.');
  await edit.locator('[data-edit-discard]').click();
  await edit.locator('[data-version="default"] [data-revert]').click();
  await edit.locator('[data-edit-saved]').waitFor();
  assert.equal(await edit.locator('[data-version]').count(), 3, 'A revert is a new version; nothing is deleted.');
  assert.match(await edit.locator('[data-edit-prompt]').inputValue(), /^You are Teardown, one of the owner's agents/);
  assert.equal(await edit.locator('[data-edit-model]').inputValue(), 'codex');
  assert.equal(await edit.locator('[data-version]').nth(2).locator('[data-revert]').count(), 1, 'The edited version can be reverted to.');

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

  step('no export: the note says the host has not published yet, and points to the app prompts only when there are some');
  await visit(desk, bare.url, 'hermes');
  assert.equal(flat(await details(desk, 'hermes').locator('[data-details-freshness]').innerText()), 'The Hermes host has not published its settings yet.');
  assert.equal(await details(desk, 'hermes').locator('[data-prompt]').count(), 0, 'Hermes has no app prompts, so none are promised.');
  assert.equal(await details(desk, 'hermes').locator('[data-details-model]').count(), 0);
  await visit(desk, bare.url, 'researcher');
  assert.equal(flat(await details(desk, 'researcher').locator('[data-details-freshness]').innerText()), 'The Hermes host has not published its settings yet. The prompts from the app are below.');
  assert.deepEqual(await details(desk, 'researcher').locator('[data-prompt]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-prompt'))), ['persona', 'job']);

  step('an unknown agent says so, and Back goes to Team');
  await desk.goto(`${bare.url}#/~hub/agent/stranger`);
  await desk.locator('.hub-error').waitFor();
  await desk.locator('[data-details-back]').click();
  await desk.locator('.team-card').first().waitFor();

  step('Ask: an agent-edit Ask shows the old and the new text in full, the agent\'s words under their label, and Apply writes one version');
  await desk.goto(`${fresh.url}#/~hub/ask/${EDIT_ASK}`);
  const proposal = desk.locator('[data-agent-edit-ask="planner"]');
  await proposal.waitFor();
  assert.equal(await desk.locator('[data-agent-edit-tag]').innerText(), 'Changes a persona');
  assert.equal(flat(await proposal.locator('[data-edit-ask-says]').innerText()), 'The agent says: Shorten the Planner prompt?');
  assert.equal(flat(await proposal.locator('[data-edit-ask-why]').innerText()), 'Why: The chats ran long.');
  await desk.waitForFunction(() => !/loading/.test(document.querySelector('[data-edit-ask-old="prompt"]')?.textContent ?? 'loading'));
  assert.match(await proposal.locator('[data-edit-ask-old="prompt"]').innerText(), /^You are Planner, one of the owner's agents/);
  assert.equal(await proposal.locator('[data-edit-ask-new="prompt"]').innerText(), 'You are Planner. Ask one question at a time.');
  assert.equal(await proposal.locator('[data-edit-ask-same="role"]').count(), 1, 'The role line is unchanged.');
  assert.equal(await proposal.locator('script, img, a').count(), 0, 'The text is plain text.');
  await noSideways(desk, 'Agent-edit Ask at 1280');
  await desk.locator('[data-option="apply"] button').click();
  await desk.locator('[data-send]').click();
  await desk.locator('[data-avatar-notice]').waitFor();
  assert.match(await desk.locator('[data-avatar-notice]').innerText(), /^Applied\. The persona has a new version/);
  await desk.goto(`${fresh.url}#/~hub/agent-edit/planner`);
  await desk.locator('[data-agent-edit="planner"] [data-edit-form]').waitFor();
  assert.equal(await desk.locator('[data-edit-prompt]').inputValue(), 'You are Planner. Ask one question at a time.');
  assert.equal(await desk.locator('[data-version]').count(), 2);
  assert.match(flat(await desk.locator('[data-version][data-current] .ae-version-who').innerText()), /^Agent edit/);

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
  const editLink = await phone.locator('[data-edit-open="teardown"]').boundingBox();
  assert.ok(editLink.height >= 44, 'The Edit link is a touch target.');
  await phone.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await phone.locator('[data-edit-form]').waitFor();
  await phone.locator('[data-edit-prompt]').fill('You are Teardown. '.repeat(40));
  for (const summary of await phone.locator('[data-edit-versions] details > summary').all()) await summary.click();
  await noSideways(phone, 'Edit at 390');
  assert.ok((await phone.locator('[data-edit-save]').boundingBox()).height >= 44, 'Save is a touch target.');
  step('Edit: an agent with no persona says so');
  await phone.goto(`${fresh.url}#/~hub/agent-edit/hermes`);
  await phone.locator('[data-edit-none]').waitFor();
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await fresh.close();
  await stale.close();
  await bare.close();
}
console.log('hub-agent-details-ui: passed');
