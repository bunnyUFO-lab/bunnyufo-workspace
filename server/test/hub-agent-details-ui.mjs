// Run after npm run build. The agent details page (#/~hub/agent/<id>) through a real browser, over the hub fixture.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { askId, startHubFixture } from './hub-fixture.mjs';
import { sign } from '../../site/api/signing.mjs';
import { agentConfigJson, askJson, seedAgentConfig } from '../../site/api/test/hub-fixtures.mjs';

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

// The lists the Hermes host would publish with its export (the same as the fixture's first one), for the export the test makes later.
const ref = (provider, name) => ({ provider, model: name });
const MODEL_OPTIONS = {
  main: [ref('openai-codex', 'gpt-6-sol'), ref('anthropic', 'claude-sonnet-5-5'), ref('anthropic', 'claude-haiku-5-5'), ref('deepseek', 'deepseek-v4-pro'), ref('deepseek', 'deepseek-flash')],
  briefs: [ref('anthropic', 'claude-sonnet-5-5'), ref('anthropic', 'claude-haiku-5-5'), ref('deepseek', 'deepseek-v4-pro'), ref('deepseek', 'deepseek-flash')],
};
// signing: the owner's Apply on a model change signs it.
const fresh = await startHubFixture({ pc: 'fresh', agentConfig: 'fresh', signing: true });
const stale = await startHubFixture({ agentConfig: 'stale' });
// An agent's proposal to edit the Planner's persona (ws-im1.4.1): applied only by the owner's answer.
const EDIT_ASK = askId('planner-edit', 'e1d1');
const EDIT_OPTIONS = [{ id: 'apply', label: 'Apply this edit' }, { id: 'skip', label: 'Leave it as it is' }];
fresh.seed.ask({ ...askJson({ id: EDIT_ASK, project: 'probe', question: 'Shorten the Planner prompt?', options: EDIT_OPTIONS, allowDrawing: false, kind: 'approval' }), requirePasskey: true, agentEdit: { op: 'persona', agent: 'planner', base: 'default', prompt: 'You are Planner. Ask one question at a time.', why: 'The chats ran long.' } });
// An agent's proposals to change a profile's order (ws-im1.4.2): still Asks, still answered by the owner's Apply. The press on the Edit page makes none.
const PROFILE_ASK = askId('profile-edit', 'e2d2');
const OPUS_ASK = askId('opus-edit', 'e3d3');
const agentProfileAsk = (id, question, agentEdit) => ({ ...askJson({ id, project: 'probe', question, options: EDIT_OPTIONS, allowDrawing: false, kind: 'approval' }), requirePasskey: true, agentEdit });
fresh.seed.ask(agentProfileAsk(PROFILE_ASK, 'Change the model of the Hermes main profile?', { op: 'profile', profile: 'main', primary: ref('anthropic', 'claude-sonnet-5-5'), fallbacks: [ref('anthropic', 'claude-haiku-5-5'), ref('openai-codex', 'gpt-6-sol')], why: 'Codex is slow today.' }));
fresh.seed.ask(agentProfileAsk(OPUS_ASK, 'Try Opus as a fallback?', { op: 'profile', profile: 'main', primary: ref('anthropic', 'claude-sonnet-5-5'), fallbacks: [ref('openai-codex', 'gpt-6-sol'), ref('anthropic', 'claude-opus-5-5')] }));
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

  step('Teardown: an Edit link in the head and a Chat model row; Hermes has an Edit link for its model and no Chat model row');
  assert.equal(await teardown.locator('[data-edit-open="teardown"]').getAttribute('href'), '#/~hub/agent-edit/teardown');
  assert.equal(flat(await teardown.locator('[data-details-chat-model]').innerText()), 'Codex 6.1 Sol');
  await visit(desk, fresh.url, 'hermes');
  assert.equal(await details(desk, 'hermes').locator('[data-edit-open]').innerText(), 'Edit the model');
  assert.equal(await details(desk, 'hermes').locator('[data-details-chat-model]').count(), 0);
  assert.equal(await details(desk, 'teardown').count(), 0);
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
  assert.equal(flat(await edit.locator('[data-edit-model-note]').innerText()), "Chat only, this agent only. Jobs and Auto use the profile's model below.");
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

  step('Profile: Teardown Edit says the profile is shared by five agents, lists the host\'s own models and keeps the button off until something changes');
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  const model = desk.locator('[data-edit-profile="main"]');
  await model.waitFor();
  assert.equal(flat(await model.locator('[data-profile-shared]').innerText()), 'Profile main. Shared by Hermes, Researcher, Market researcher, Teardown and Planner');
  assert.equal(await model.locator('[data-profile-briefs]').count(), 0, 'the weekly jobs line is Briefs only');
  assert.deepEqual((await model.locator('[data-profile-primary] option').allInnerTexts()).map(flat), ['openai-codex · gpt-6-sol', 'anthropic · claude-sonnet-5-5', 'anthropic · claude-haiku-5-5', 'deepseek · deepseek-v4-pro', 'deepseek · deepseek-flash']);
  assert.equal(flat(await model.locator('[data-profile-primary] option:checked').innerText()), 'openai-codex · gpt-6-sol');
  assert.deepEqual((await model.locator('[data-profile-fallbacks] select option:checked').allInnerTexts()).map(flat), ['anthropic · claude-sonnet-5-5', 'deepseek · deepseek-v4-pro']);
  assert.equal(await model.locator('[data-profile-send]').isDisabled(), true);
  assert.equal(await model.locator('[data-profile-nochain]').count(), 0);
  assert.equal(flat(await model.locator('[data-profile-restart]').innerText()), "Changing this restarts Hermes main. Usually done in about a minute, at most 5 if the host's quick check is off. A chat or job running then stops.");
  assert.equal(flat(await model.locator('h3').first().textContent()), 'Model and fallbacks of profile main');
  assert.equal(flat(await model.locator('[data-profile-auto]').innerText()), 'A chat set to Auto follows this. A chat set to a named model stays on that model.');
  assert.equal(await model.locator('[data-profile-briefs-wait]').count(), 0, 'the weekly-jobs wait is Briefs only');
  await noSideways(desk, 'Edit with the model section at 1280');

  step("Profile Ask: an agent's proposal still reads as a plain-text Ask with the order now, the order proposed, the passkey tag and what Apply does");
  const reader = await open({ width: 1280, height: 800 });
  await reader.goto(`${fresh.url}#/~hub/ask/${PROFILE_ASK}`);
  const modelAsk = reader.locator('[data-agent-edit-ask="profile-main"]');
  await modelAsk.waitFor();
  assert.equal(await reader.locator('[data-agent-edit-tag]').innerText(), 'Changes a model');
  await reader.waitForFunction(() => !/loading/.test(document.querySelector('[data-profile-ask-chain="old"]')?.textContent ?? 'loading'));
  assert.deepEqual((await modelAsk.locator('[data-profile-ask-chain="old"] li').allInnerTexts()).map(flat), ['openai-codex · gpt-6-sol', 'then anthropic · claude-sonnet-5-5', 'then deepseek · deepseek-v4-pro']);
  assert.deepEqual((await modelAsk.locator('[data-profile-ask-chain="new"] li').allInnerTexts()).map(flat), ['anthropic · claude-sonnet-5-5', 'then anthropic · claude-haiku-5-5', 'then openai-codex · gpt-6-sol']);
  assert.equal(flat(await modelAsk.locator('[data-edit-ask-why]').innerText()), 'Why: Codex is slow today.');
  assert.match(flat(await modelAsk.locator('[data-profile-ask-restart]').innerText()), /^Apply signs the change and sends it to the Hermes host\. Changing this restarts Hermes main\. Usually done in about a minute, at most 5 if the host's quick check is off\. A chat or job running then stops\. If anything fails, the old settings/);
  assert.equal(await modelAsk.locator('script, img, a').count(), 0, 'the text is plain text');
  await noSideways(reader, 'Model Ask at 1280');

  step('Profile: the URL gives the page no draft, and the page shows the order in use with the button off');
  const withDraft = new URL(fresh.url);
  withDraft.searchParams.set('primary', 'claude-haiku-5-5');
  withDraft.searchParams.set('fallbacks', 'none');
  withDraft.hash = '#/~hub/agent-edit/teardown';
  await desk.goto(withDraft.href);
  await model.waitFor();
  await desk.waitForFunction(() => /gpt-6-sol/.test(document.querySelector('[data-profile-primary] option:checked')?.textContent ?? ''));
  assert.equal(flat(await model.locator('[data-profile-primary] option:checked').innerText()), 'openai-codex · gpt-6-sol');
  assert.equal(await model.locator('[data-profile-send]').isDisabled(), true);
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown?primary=anthropic%20claude-haiku-5-5`);
  await desk.locator('[data-agent-edit] [role="alert"]').waitFor();
  assert.equal(await desk.locator('[data-profile-send]').count(), 0, 'a made-up address shows no agent and no button');
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await model.waitFor();
  await desk.waitForFunction(() => /gpt-6-sol/.test(document.querySelector('[data-profile-primary] option:checked')?.textContent ?? ''));

  step('Profile: a new primary leaves the chain; Remove empties it and says what that means; Add and Down reorder');
  await model.locator('[data-profile-primary]').selectOption({ label: 'anthropic · claude-sonnet-5-5' });
  assert.deepEqual((await model.locator('[data-profile-fallbacks] select option:checked').allInnerTexts()).map(flat), ['deepseek · deepseek-v4-pro'], 'the new primary is not also a fallback');
  assert.equal(await model.locator('[data-profile-send]').isEnabled(), true);
  await model.locator('[data-fallback-remove]').click();
  assert.equal(flat(await model.locator('[data-profile-nochain]').innerText()), 'With no fallbacks, a Codex limit means no reply.');
  await model.locator('[data-fallback-add]').click();
  await model.locator('[data-fallback-add]').click();
  assert.deepEqual((await model.locator('[data-profile-fallbacks] select option:checked').allInnerTexts()).map(flat), ['openai-codex · gpt-6-sol', 'anthropic · claude-haiku-5-5']);
  assert.equal(await model.locator('[data-profile-fallback="0"] [data-fallback-up]').isDisabled(), true, 'the first row cannot go up');
  await model.locator('[data-profile-fallback="0"] [data-fallback-down]').click();
  assert.deepEqual((await model.locator('[data-profile-fallbacks] select option:checked').allInnerTexts()).map(flat), ['anthropic · claude-haiku-5-5', 'openai-codex · gpt-6-sol']);
  assert.equal(await model.locator('[data-profile-nochain]').count(), 0);
  for (const control of await model.locator('[data-profile-fallback] .hub-btn').all()) assert.ok((await control.boundingBox()).height >= 44, 'a touch target');

  step('Profile: above the button the page says what changes, who it moves and the restart; there is no Why box; Enter changes nothing');
  const summary = model.locator('[data-profile-summary]');
  await summary.waitFor();
  assert.equal(flat(await summary.innerText()), 'Now: gpt-6-sol, then claude-sonnet-5-5, then deepseek-v4-pro. New: claude-sonnet-5-5, then claude-haiku-5-5, then gpt-6-sol. This moves Hermes, Researcher, Market researcher, Teardown and Planner, who share profile main. Hermes main restarts about 10 to 40 seconds after you press. A chat or job running then stops. Usually done in about a minute.');
  assert.equal(flat(await model.locator('[data-profile-send]').innerText()), 'Change and restart Hermes main');
  assert.equal(await model.locator('[data-profile-restart]').count(), 0, 'the summary replaces the plain restart line');
  assert.equal(await model.locator('[data-profile-why], [data-profile-sent], [data-profile-ask]').count(), 0, 'no Why box, no request');
  assert.equal(await model.locator('input[type="text"]').count(), 0, 'no text field is left in the model section');
  assert.doesNotMatch(await model.innerText(), /Send for approval/);
  const posts = [];
  desk.on('request', request => { if (request.method() === 'POST' && request.url().includes('/profile-change')) posts.push(request.url()); });
  await model.locator('[data-profile-primary]').focus();
  await desk.keyboard.press('Enter');
  await desk.waitForTimeout(ms(400));
  assert.deepEqual(posts, [], 'Enter on a select sends no request');
  assert.equal(await model.locator('[data-profile-change]').count(), 0);
  // The summary is on screen with the button, at the phone width too.
  const askPhone = await open({ width: 390, height: 800 });
  await askPhone.goto(`${fresh.url}#/~hub/agent-edit/hermes`);
  await askPhone.locator('[data-edit-profile="main"] [data-profile-form]').waitFor();
  await askPhone.waitForFunction(() => /gpt-6-sol/.test(document.querySelector('[data-profile-primary] option:checked')?.textContent ?? ''));
  await askPhone.locator('[data-profile-primary]').selectOption({ label: 'anthropic · claude-sonnet-5-5' });
  await askPhone.locator('[data-profile-summary]').waitFor();
  await askPhone.locator('[data-profile-send]').scrollIntoViewIfNeeded();
  const boxes = { summary: await askPhone.locator('[data-profile-summary]').boundingBox(), restart: await askPhone.locator('[data-profile-summary-restart]').boundingBox(), button: await askPhone.locator('[data-profile-send]').boundingBox() };
  assert.ok(boxes.restart.y + boxes.restart.height <= boxes.button.y + 1, 'the restart line sits above the button');
  assert.ok(boxes.summary.y >= 0, 'with the button in view, the top of the summary is in view too: nothing to scroll past');
  assert.ok(boxes.button.height >= 44, 'the button is a touch target');
  await noSideways(askPhone, 'the summary at 390');

  step('Profile: the press signs at once: no Ask, no Needs you item, the page waits, and the host\'s file is the Hub\'s own signed one');
  const needsRows = async () => {
    await reader.goto(`${fresh.url}#/~hub/needs`);
    await reader.locator('[data-hub-link="needs"]').waitFor();
    await reader.waitForTimeout(ms(800));
    return ((await reader.locator('body').innerText()).match(/Change the model of the Hermes main profile\?/g) ?? []).length;
  };
  const rowsBefore = await needsRows();
  assert.ok(rowsBefore >= 1, 'the agent Ask is there to count');
  const asksBefore = [...fresh.fake.objects.keys()].filter(name => /\/asks\/[^/]+\/ask\.json$/.test(name)).length;
  await model.locator('[data-profile-send]').click();
  await model.locator('[data-profile-off]').waitFor();
  const changeId = await model.locator('[data-profile-change]').first().getAttribute('data-profile-change');
  assert.match(changeId, /^\d{8}-profile-main-[a-z0-9]{4}$/);
  assert.equal(posts.length, 1);
  assert.equal([...fresh.fake.objects.keys()].filter(name => /\/asks\/[^/]+\/ask\.json$/.test(name)).length, asksBefore, 'no Ask was written');
  assert.ok(fresh.fake.objects.has(`sections/inbox/agent-config/changes/${changeId}/approved.json`), 'the change is signed');
  assert.equal(await model.locator('[data-profile-summary]').count(), 0, 'the summary goes when there is nothing left to send');
  assert.equal(await model.locator('[data-change-undo]').count(), 0, 'no way back while the change waits');
  assert.equal(await needsRows(), rowsBefore, 'the press left no new item on Needs you');
  const sentEvent = [...fresh.fake.objects.keys()].map(name => (/\/events\/.*-hub-.*\.json$/.test(name) ? fresh.fake.json(name) : null)).find(event => event?.kind === 'profile-change-sent');
  assert.equal(sentEvent?.title, 'Model change sent: Hermes main to claude-sonnet-5-5');

  step('Waiting: Details of any agent on the profile says the change is waiting for the host, and a second request is off');
  await visit(desk, fresh.url, 'teardown');
  assert.match(flat(await details(desk, 'teardown').locator('[data-details-change="waiting"]').innerText()), /^Changing Hermes main to claude-sonnet-5-5\. Sent .*\. Not running yet: the old model answers until the restart, usually within 40 seconds of pressing\. This says Running when the new model is confirmed\.$/);
  await desk.goto(`${fresh.url}#/~hub/agent-edit/hermes`);
  await desk.locator('[data-edit-profile="main"]').waitFor();
  assert.equal(flat(await desk.locator('[data-profile-off]').innerText()), 'Hermes main is changing to claude-sonnet-5-5. That covers Hermes, Researcher, Market researcher, Teardown and Planner, so this order can be changed again once it finishes. Profile briefs is not affected.');
  assert.equal(await desk.locator('[data-profile-send]').isDisabled(), true);
  assert.equal(await desk.locator('[data-profile-change] [data-change-state]').innerText(), 'Sent, not running yet');
  assert.equal(await desk.locator('[data-edit-profile="main"] [data-edit-form], [data-edit-versions]').count(), 0, 'Hermes has no persona form');
  assert.doesNotMatch(await desk.locator('[data-agent-edit]').innerText(), /Applied/, 'nothing says Applied for a change the host has not confirmed');
  // Briefs is its own profile: the same change does not block it, and its page says how long its wait can be.
  await desk.goto(`${fresh.url}#/~hub/agent-edit/briefs`);
  await desk.locator('[data-edit-profile="briefs"]').waitFor();
  assert.equal(flat(await desk.locator('[data-profile-briefs-wait]').innerText()), 'If the weekly jobs are running, it waits until they end, up to an hour.');
  assert.equal(await desk.locator('[data-profile-off]').count(), 0, 'a main change does not block briefs');
  // Teardown has a persona section: its chat model is not blocked, and the banner on its profile section says so.
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await desk.locator('[data-edit-profile="main"] [data-profile-off]').waitFor();
  assert.match(flat(await desk.locator('[data-profile-off]').innerText()), / Profile briefs is not affected\. Chat models above still save\.$/);
  assert.equal(await desk.locator('[data-edit-save]').count(), 1, 'the chat model form is there');
  await desk.locator('[data-edit-model]').selectOption('sonnet');
  assert.equal(await desk.locator('[data-edit-save]').isEnabled(), true, 'a chat model still saves while the profile waits');
  await desk.goto(`${fresh.url}#/~hub/agent-edit/hermes`);
  await desk.locator('[data-profile-off]').waitFor();

  step('The host answers while the page is open: within a few seconds, with no reload, the block is gone and the row says Running; then the page stops asking');
  const resultAt = new Date();
  const detailsReads = [];
  desk.on('request', request => { if (request.url().includes('/api/hub/team/hermes/details')) detailsReads.push(Date.now()); });
  fresh.fake.seed(`sections/inbox/agent-config/changes/${changeId}/result.json`, JSON.stringify({ v: 1, change: changeId, outcome: 'applied', code: 'ok', rolledBack: false, at: resultAt.toISOString() }), 'application/json', { writer: 'hermes-config' });
  await desk.locator('[data-profile-off]').waitFor({ state: 'detached', timeout: ms(12000) });
  await desk.locator('[data-profile-change][data-state="applied"] [data-change-state]').waitFor();
  assert.equal(await desk.locator('[data-profile-change] [data-change-state]').innerText(), 'Running');
  assert.match(flat(await desk.locator('[data-details-change="applied"]').innerText()), /^Running: claude-sonnet-5-5, since .+\. The settings below catch up within seconds\.$/);
  assert.doesNotMatch(await desk.locator('[data-agent-edit]').innerText(), /Applied/);
  const settled = detailsReads.length;
  await desk.waitForTimeout(ms(6500));
  assert.equal(detailsReads.length, settled, 'no more reads once the change is no longer waiting');

  step('The host answers: applied, then a newer export shows the new order and Details says live; the Team card follows');
  await visit(desk, fresh.url, 'teardown');
  await details(desk, 'teardown').locator('[data-details-change="applied"]').waitFor();
  const after = agentConfigJson({ now: new Date(resultAt.getTime() + 2000), exportedMinutesAgo: 0, modelOptions: MODEL_OPTIONS });
  after.profiles.main.model = { provider: 'anthropic', default: 'claude-sonnet-5-5' };
  after.profiles.main.fallbacks = [{ provider: 'anthropic', model: 'claude-haiku-5-5' }, { provider: 'openai-codex', model: 'gpt-6-sol' }];
  seedAgentConfig(fresh.fake, after);
  await visit(desk, fresh.url, 'teardown');
  await details(desk, 'teardown').locator('[data-details-change="live"]').waitFor();
  assert.match(flat(await details(desk, 'teardown').locator('[data-details-change]').innerText()), /^Running: claude-sonnet-5-5, since .+\.$/);
  assert.equal(flat(await details(desk, 'teardown').locator('[data-model-primary]').innerText()), 'anthropic · claude-sonnet-5-5');
  assert.deepEqual((await details(desk, 'teardown').locator('[data-model-fallbacks] li').allInnerTexts()).map(flat), ['then anthropic · claude-haiku-5-5', 'then openai-codex · gpt-6-sol']);
  await desk.goto(`${fresh.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  // A screen seen before shows its last answer at once, so wait for the fresh one (ws-ubo.1.1).
  await desk.waitForFunction(() => /Model claude-sonnet-5-5 · then claude-haiku-5-5, gpt-6-sol/.test((document.querySelector('[data-agent="teardown"] .team-facts')?.innerText ?? '').replace(/\s+/g, ' ')));
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await desk.locator('[data-edit-profile="main"]').waitFor();
  // The same here: the last answer shows first, and the export the test just made arrives with the refresh.
  await desk.locator('[data-profile-change][data-state="live"]').waitFor();
  assert.equal(await desk.locator('[data-profile-change][data-state="live"]').count(), 1, 'the Edit page lists it as live');
  assert.equal(await desk.locator('[data-profile-send]').isDisabled(), true, 'and there is nothing new to send');

  step('Replaced: the host is edited after the change, so the row and the banner stop saying Running although data-state stays');
  const edited = agentConfigJson({ now: new Date(Date.now() + 1000), exportedMinutesAgo: 0, modelOptions: MODEL_OPTIONS });
  edited.profiles.main.model = { provider: 'deepseek', default: 'deepseek-v4-pro' };
  edited.profiles.main.fallbacks = [];
  seedAgentConfig(fresh.fake, edited);
  await desk.goto(`${fresh.url}#/~hub/agent/teardown`);
  await details(desk, 'teardown').locator('[data-details-change][data-replaced]').waitFor();
  assert.match(flat(await details(desk, 'teardown').locator('[data-details-change]').innerText()), /^The change to claude-sonnet-5-5 was confirmed .+\. The host has been changed since, so it no longer runs\. The settings below are what it has now\.$/);
  assert.equal(await details(desk, 'teardown').locator('[data-details-change]').getAttribute('data-details-change'), 'applied', 'data-state keeps its value');
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await desk.locator('[data-profile-change][data-replaced]').waitFor();
  assert.equal(await desk.locator('[data-profile-change][data-replaced] [data-change-state]').innerText(), 'Replaced');
  assert.equal(await desk.locator('[data-profile-change][data-replaced] [data-change-state].on').count(), 0, 'no green tag');
  assert.doesNotMatch(await desk.locator('[data-profile-change]').innerText(), /Running/);

  step('Way back: a Replaced row has no button; once the host runs the change again, one press goes back to the order it replaced, signed the same way');
  assert.equal(await desk.locator('[data-change-undo]').count(), 0, 'a Replaced row offers no way back: it would undo the host edit');
  const again = agentConfigJson({ now: new Date(Date.now() + 1500), exportedMinutesAgo: 0, modelOptions: MODEL_OPTIONS });
  again.profiles.main.model = { provider: 'anthropic', default: 'claude-sonnet-5-5' };
  again.profiles.main.fallbacks = [ref('anthropic', 'claude-haiku-5-5'), ref('openai-codex', 'gpt-6-sol')];
  seedAgentConfig(fresh.fake, again);
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  // A screen seen before shows its last answer first: wait for the row to stop saying Replaced.
  const back = desk.locator('[data-change-undo]');
  await back.waitFor();
  assert.equal(await desk.locator(`[data-profile-change="${changeId}"][data-replaced]`).count(), 0);
  assert.equal(flat(await back.innerText()), 'Go back to gpt-6-sol, then claude-sonnet-5-5, then deepseek-v4-pro');
  assert.equal(flat(await desk.locator('[data-change-undo-restart]').innerText()), 'This restarts Hermes main too.');
  await back.click();
  await desk.locator('[data-profile-off]').waitFor();
  const backId = await desk.locator('[data-profile-change]').first().getAttribute('data-profile-change');
  assert.notEqual(backId, changeId);
  const backFile = fresh.fake.json(`sections/inbox/agent-config/changes/${backId}/approved.json`);
  assert.deepEqual([backFile.to.model, backFile.from.model, backFile.ask === backFile.change], ['gpt-6-sol', 'claude-sonnet-5-5', true], 'signed in the same format, to the order the change replaced');
  assert.equal(await desk.locator('[data-change-undo]').count(), 0, 'no way back while the way back waits');
  const undoEvent = [...fresh.fake.objects.keys()].map(name => (/\/events\/.*-hub-.*\.json$/.test(name) ? fresh.fake.json(name) : null)).find(event => event?.undoOf === changeId);
  assert.equal(undoEvent?.title, 'Model change sent: Hermes main to gpt-6-sol');
  await desk.waitForTimeout(ms(2500)); // the host's answer lands after the export above, by whole seconds
  fresh.fake.seed(`sections/inbox/agent-config/changes/${backId}/result.json`, JSON.stringify({ v: 1, change: backId, outcome: 'applied', code: 'ok', rolledBack: false, at: new Date().toISOString() }), 'application/json', { writer: 'hermes-config' });
  await desk.locator('[data-profile-off]').waitFor({ state: 'detached', timeout: ms(12000) });
  await desk.locator(`[data-profile-change="${changeId}"][data-replaced]`).waitFor();
  assert.equal(await desk.locator(`[data-profile-change="${backId}"] [data-change-state]`).innerText(), 'Running');
  assert.equal(await desk.locator(`[data-profile-change="${changeId}"] [data-change-state]`).innerText(), 'Replaced', 'the change it undid is not running any more');
  // The form shows the order the way back restored, not the one just undone, and nothing is armed: a stray press changes nothing.
  assert.equal(flat(await desk.locator('[data-profile-primary] option:checked').innerText()), 'openai-codex · gpt-6-sol', 'the form holds the order gone back to');
  assert.equal(await desk.locator('[data-profile-send]').isDisabled(), true, 'the button is off: the owner picked nothing');
  assert.equal(await desk.locator('[data-profile-summary]').count(), 0, 'no summary for an order nobody chose');

  step('Failed: Details says the change failed with the reason in words and that the old settings stay; a failed rollback says Hermes may be down');
  const failedId = `${changeId.slice(0, 8)}-profile-briefs-f1f1`;
  const briefsAt = new Date(Date.now() - 600000);
  const side = (provider, name, fallbacks) => ({ provider, model: name, fallbacks });
  fresh.fake.seed(`sections/inbox/agent-config/changes/${failedId}/approved.json`, JSON.stringify(sign({ v: 1, kind: 'profile-change', change: failedId, profile: 'briefs', from: side('openai-codex', 'claude-haiku-5-5', [{ provider: 'deepseek', model: 'deepseek-v4-pro' }]), to: side('anthropic', 'claude-sonnet-5-5', []), expires: new Date(briefsAt.getTime() + 86400000).toISOString(), nonce: 'AAAAAAAAAAAAAAAAAAAAAA', at: briefsAt.toISOString(), by: 'owner', ask: failedId }, fresh.signingKey)), 'application/json');
  fresh.fake.seed(`sections/inbox/agent-config/changes/${failedId}/result.json`, JSON.stringify({ v: 1, change: failedId, outcome: 'failed', code: 'health', rolledBack: true, at: new Date(briefsAt.getTime() + 120000).toISOString() }), 'application/json', { writer: 'hermes-config' });
  await visit(desk, fresh.url, 'briefs');
  const failed = details(desk, 'briefs').locator('[data-details-change="failed"]');
  assert.match(flat(await failed.innerText()), /^The change to claude-sonnet-5-5 failed: The gateway did not stay up after the restart\. The old settings stay\./);
  await desk.goto(`${fresh.url}#/~hub/agent-edit/briefs`);
  assert.equal(flat(await desk.locator('[data-profile-briefs]').innerText()), 'The three weekly jobs are pinned to Sonnet and do not follow this.');
  assert.deepEqual((await desk.locator('[data-profile-primary] option').allInnerTexts()).map(flat).slice(0, 1), ['anthropic · claude-sonnet-5-5'], 'Briefs cannot pick Codex: the host does not offer it there');
  await desk.route('**/api/hub/team/briefs/details', async route => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, change: { ...real.change, code: 'rollback-failed', reason: 'The host could not put the old settings back' } } });
  });
  await visit(desk, fresh.url, 'briefs');
  assert.match(flat(await details(desk, 'briefs').locator('[data-details-change="failed"]').innerText()), /The host could not put the old settings back\. Hermes may be down\./);
  await desk.unroute('**/api/hub/team/briefs/details');

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
  // Answering leaves the Ask page for the next item, so the line under Send is gone within a moment; the same line stays in the note there.
  await desk.locator('[data-next-detail]').waitFor();
  assert.match(await desk.locator('[data-next-detail]').innerText(), /^Applied\. The persona has a new version/);
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
  step('Edit: Teardown at 390 px keeps the model rows inside the page; an agent with nothing to edit says so');
  await phone.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await phone.locator('[data-edit-profile="main"]').waitFor();
  await phone.locator('[data-fallback-add]').click();
  await noSideways(phone, 'Edit with the model section at 390');
  await phone.goto(`${fresh.url}#/~hub/agent-edit/claude`);
  await phone.locator('[data-edit-none]').waitFor();

  step('Opus (ws-ubo.3.4): Add a fallback never adds it, a deliberate pick is allowed and told it bills through the API, on the Edit page and on the Ask');
  const billedTo = 'anthropic · claude-opus-5-5 · billed through the API';
  const withOpus = agentConfigJson({ now: new Date(), exportedMinutesAgo: 0, modelOptions: { main: [ref('anthropic', 'claude-opus-5-5'), ref('openai-codex', 'gpt-6-sol'), ref('anthropic', 'claude-sonnet-5-5'), ref('anthropic', 'claude-haiku-5-5')], briefs: MODEL_OPTIONS.briefs } });
  withOpus.profiles.main.model = { provider: 'anthropic', default: 'claude-sonnet-5-5' };
  withOpus.profiles.main.fallbacks = [ref('anthropic', 'claude-haiku-5-5'), ref('openai-codex', 'gpt-6-sol')];
  seedAgentConfig(fresh.fake, withOpus);
  await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  const opus = desk.locator('[data-edit-profile="main"]');
  await opus.locator('[data-profile-form]').waitFor();
  // A screen seen before shows its last answer first: wait for the export that lists Opus.
  await desk.waitForFunction(() => /billed through the API/.test(document.querySelector('[data-profile-primary]')?.textContent ?? ''));
  assert.deepEqual((await opus.locator('[data-profile-primary] option').allInnerTexts()).map(flat), [billedTo, 'openai-codex · gpt-6-sol', 'anthropic · claude-sonnet-5-5', 'anthropic · claude-haiku-5-5']);
  assert.equal(await opus.locator('[data-profile-opus-note]').count(), 0, 'no note while Opus is not in the order');
  assert.equal(await opus.locator('[data-fallback-add]').isDisabled(), true, 'only Opus is left, so the button is off');
  await opus.locator('[data-profile-fallback="1"] [data-fallback-remove]').click();
  assert.equal(await opus.locator('[data-fallback-add]').isEnabled(), true);
  await opus.locator('[data-fallback-add]').click();
  assert.deepEqual((await opus.locator('[data-profile-fallbacks] select option:checked').allInnerTexts()).map(flat), ['anthropic · claude-haiku-5-5', 'openai-codex · gpt-6-sol'], 'Opus was first in the list and was skipped');
  assert.equal(await opus.locator('[data-profile-opus-note]').count(), 0);
  assert.equal(await opus.locator('[data-fallback-add]').isDisabled(), true);
  await opus.locator('[data-profile-fallback="0"] select').selectOption({ label: billedTo });
  assert.equal(flat(await opus.locator('[data-profile-opus-note]').innerText()), 'Opus is a fallback: when the models before it fail, replies bill through the Anthropic API without asking.');
  await opus.locator('[data-profile-primary]').selectOption({ label: billedTo });
  assert.equal(flat(await opus.locator('[data-profile-opus-note]').innerText()), 'Opus is the primary: every reply on this profile bills through the Anthropic API.');
  await opus.locator('[data-profile-primary]').selectOption({ label: 'anthropic · claude-sonnet-5-5' });
  assert.equal(await opus.locator('[data-profile-opus-note]').count(), 0, 'Opus left the order when the primary went back to Sonnet');
  await opus.locator('[data-fallback-add]').click();
  assert.deepEqual((await opus.locator('[data-profile-fallbacks] select option:checked').allInnerTexts()).map(flat), ['openai-codex · gpt-6-sol', 'anthropic · claude-haiku-5-5'], 'Add skipped Opus again');
  await opus.locator('[data-profile-fallback="1"] select').selectOption({ label: billedTo });
  assert.match(flat(await opus.locator('[data-profile-opus-note]').innerText()), /^Opus is a fallback/);
  await noSideways(desk, 'Edit with the Opus note at 1280');
  const signedCount = () => [...fresh.fake.objects.keys()].filter(name => /\/agent-config\/changes\/[^/]+\/approved\.json$/.test(name)).length;
  const signedBefore = signedCount();
  // One press for every model (the owner's decision): the note is on the page before the press, and the press signs.
  assert.equal(await opus.locator('[data-profile-opus-confirm], [data-profile-opus-yes], [data-profile-opus-no]').count(), 0, 'no second step');
  await opus.locator('[data-profile-send]').click();
  await opus.locator('[data-profile-off]').waitFor();
  assert.equal(signedCount(), signedBefore + 1, 'one press signs');
  const opusId = await opus.locator('[data-profile-change]').first().getAttribute('data-profile-change');
  assert.ok(fresh.fake.json(`sections/inbox/agent-config/changes/${opusId}/approved.json`).to.fallbacks.some(item => item.model === 'claude-opus-5-5'), 'the pick is kept as chosen');
  // An agent's Ask that names Opus still carries the warning on the Ask page.
  const opusReader = await open({ width: 1280, height: 800 });
  await opusReader.goto(`${fresh.url}#/~hub/ask/${OPUS_ASK}`);
  const opusAsk = opusReader.locator('[data-agent-edit-ask="profile-main"]');
  await opusAsk.waitFor();
  assert.equal(flat(await opusAsk.locator('[data-profile-ask-opus]').innerText()), 'Opus is a fallback: when the models before it fail, replies bill through the Anthropic API without asking.');
  assert.ok((await opusAsk.locator('[data-profile-ask-chain="new"] li').allInnerTexts()).some(line => /claude-opus-5-5/.test(line)), 'the pick is kept as chosen');
  await noSideways(opusReader, 'Opus Ask at 1280');
  await phone.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
  await phone.locator('[data-edit-profile="main"] [data-profile-form]').waitFor();
  await phone.waitForFunction(() => /billed through the API/.test(document.querySelector('[data-profile-primary]')?.textContent ?? ''));
  await phone.locator('[data-profile-fallback="0"] select').selectOption({ label: billedTo });
  await phone.locator('[data-profile-opus-note]').waitFor();
  await noSideways(phone, 'Edit with the Opus note at 390');
  await phone.goto(`${fresh.url}#/~hub/ask/${OPUS_ASK}`);
  await phone.locator('[data-profile-ask-opus]').waitFor();
  await noSideways(phone, 'Opus Ask at 390');
  step('Opus way back: the note names the billing before the press, and one press goes back');
  {
    const reload = async () => {
      await desk.goto(`${fresh.url}#/~hub/agent-edit/teardown`);
      await desk.locator('[data-edit-profile="main"] [data-profile-form]').waitFor();
    };
    const confirmed = async (id, order) => {
      fresh.fake.seed(`sections/inbox/agent-config/changes/${id}/result.json`, JSON.stringify({ v: 1, change: id, outcome: 'applied', code: 'ok', rolledBack: false, at: new Date().toISOString() }), 'application/json', { writer: 'hermes-config' });
      await desk.waitForTimeout(ms(2500));
      const live = agentConfigJson({ now: new Date(), exportedMinutesAgo: 0, modelOptions: { main: [ref('anthropic', 'claude-opus-5-5'), ref('openai-codex', 'gpt-6-sol'), ref('anthropic', 'claude-sonnet-5-5'), ref('anthropic', 'claude-haiku-5-5')], briefs: MODEL_OPTIONS.briefs } });
      live.profiles.main.model = { provider: order.provider, default: order.model };
      live.profiles.main.fallbacks = order.fallbacks.map(item => ({ provider: item.provider, model: item.model }));
      seedAgentConfig(fresh.fake, live);
    };
    const signedOf = id => fresh.fake.json(`sections/inbox/agent-config/changes/${id}/approved.json`);
    // The Opus change from above is confirmed and runs; then a plain change drops Opus; its way back is to the Opus order.
    await confirmed(opusId, signedOf(opusId).to);
    await reload();
    const row = desk.locator('[data-edit-profile="main"]');
    await row.locator('[data-profile-off]').waitFor({ state: 'detached', timeout: ms(15000) });
    await row.locator('[data-profile-fallback]').filter({ has: desk.locator('option:checked', { hasText: 'claude-opus-5-5' }) }).locator('[data-fallback-remove]').click();
    await row.locator('[data-profile-send]').click();
    await row.locator('[data-profile-off]').waitFor();
    const plainId = await row.locator('[data-profile-change]').first().getAttribute('data-profile-change');
    assert.ok(!signedOf(plainId).to.fallbacks.some(item => item.model === 'claude-opus-5-5'), 'the plain change drops Opus');
    await confirmed(plainId, signedOf(plainId).to);
    await reload();
    const undo = row.locator('[data-change-undo]');
    await undo.waitFor({ timeout: ms(20000) });
    const signedBefore = signedCount();
    // The note names the billing before the press, and one press signs.
    assert.match(flat(await row.locator('[data-undo-opus-note]').innerText()), /^Opus is a fallback: when the models before it fail, replies bill through the Anthropic API without asking\.$/);
    assert.equal(await row.locator('[data-undo-opus-yes], [data-undo-opus-no], [data-undo-opus-confirm]').count(), 0, 'no second step');
    await undo.click();
    await row.locator('[data-profile-off]').waitFor();
    assert.equal(signedCount(), signedBefore + 1, 'one press signs');
    const goneBack = await row.locator('[data-profile-change]').first().getAttribute('data-profile-change');
    assert.ok(signedOf(goneBack).to.fallbacks.some(item => item.model === 'claude-opus-5-5'), 'the way back is to the Opus order');
  }
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await fresh.close();
  await stale.close();
  await bare.close();
}
console.log('hub-agent-details-ui: passed');
