// Run after npm run build. The Spawn sheet through a real browser, over the fixture service: opened from Today, Needs you,
// Work and the palette; the preset chips, the route box and its rules, Bunnylink at the PC, saving a proposal into fake S3,
// the Approve button and its toasts (the capability is faked here; the approve route has its own test with Approve),
// and the bottom sheet at phone width. The default fixture has no signing key, so Spawn can only save a proposal.
import { chromium } from '@playwright/test';
import { ms, steadyFetch } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { pickOption } from './combobox.mjs';
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
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, sheet: document.querySelector('[data-spawn-sheet]')?.scrollWidth ?? 0, sheetInner: document.querySelector('[data-spawn-sheet]')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.sheet <= widths.sheetInner, `${what}: the sheet scrolls sideways (${widths.sheet} > ${widths.sheetInner}).`);
};
// A sheet closes with history.back(), which the browser runs a moment after the sheet has left the page. A test that goes on to
// change the address at once can have that traversal land after its change and undo it (the CI failure was the address back on
// #/~hub/needs/~o), so Escape is followed by a wait for the sheet's own address entry to be gone.
const closeSheet = async target => {
  await target.keyboard.press('Escape');
  await target.waitForFunction(() => !/\/~o$/.test(location.hash));
};
const requestsIn = fixture => [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/request\.json$/.test(key));

try {
  const fixture = await startHubFixture();
  fixtures.push(fixture);
  const issues = [beadsIssue({ id: 'bl-1', title: 'A task', created: '2026-10-01T10:00:00Z' })];
  fixture.seed.beads('bunnylink', issues, { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: 'example/bunnylink' });
  for (const [project, repo] of [['magic-loops', 'example/magic-loops'], ['sprite-studio', 'example/sprite-studio']]) fixture.fake.seed(`sections/${project}/workspace.json`, JSON.stringify({ name: project, tracked: { repo }, entities: [] }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  step('Today: the Spawn button opens the sheet with nine preset chips (Agent avatar is only for an agent) and focus in the text box');
  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('[data-spawn-open]').click();
  await page.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  assert.equal(await page.locator('[data-spawn-sheet] [data-preset]').count(), 10);
  assert.equal(await page.locator('[data-preset="agent-avatar"]').count(), 0, 'No Agent avatar chip without an agent.');
  assert.equal(await page.locator('[data-preset="code-task"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-spawn-text]')), true, 'The text box has the focus.');
  assert.equal(await page.locator('[data-spawn-sheet] .sp-caps').innerText(), '3 Hermes runs at once · 2 PC runs at once · 10 PC and 10 cloud runs a day');
  assert.equal(await page.locator('[data-spawn-sheet] [data-spawn-text]').getAttribute('placeholder'), 'Add a wall-jump tutorial to the first level', 'The preset example is the placeholder.');

  step('Market research on Magic Loops: rule 3 is highlighted and the machine is Hermes; the agent is named as text');
  await pickOption(page.locator('[data-spawn-project]'), 'magic-loops');
  await page.locator('[data-preset="market-research"]').click();
  await page.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  assert.equal(await page.locator('[data-spawn-route] .sp-rules .hit').getAttribute('data-rule'), '3');
  assert.equal(await page.locator('[data-spawn-route] .sp-rules li').count(), 5);
  assert.match(await page.locator('[data-spawn-why]').innerText(), /^it is research$/, 'The reason is plain: no rule number.');
  assert.match(await page.locator('[data-spawn-agent]').innerText(), /Researcher/);
  assert.equal(await page.locator('[data-spawn-repo]').count(), 0, 'Research has no repo field.');
  assert.match(await page.locator('[data-spawn-estimate]').innerText(), /Codex plan/);
  assert.equal(await page.locator('[data-spawn-go]').innerText(), 'Save as a proposal', 'Without a signing key Spawn only saves a proposal.');
  assert.equal(await page.locator('[data-spawn-go]').isDisabled(), true, 'No text, no send.');

  step('Bunnylink: the PC is yours to start, the button adds it to Needs you');
  await pickOption(page.locator('[data-spawn-project]'), 'bunnylink');
  await page.locator('[data-spawn-machine]', { hasText: 'You, at the PC' }).waitFor();
  await page.locator('[data-spawn-route] .sp-rules .hit[data-rule="1"]').waitFor();
  assert.equal(await page.locator('[data-spawn-route] .sp-rules .hit').getAttribute('data-rule'), '1');
  assert.deepEqual(await page.locator('[data-spawn-target] option').allInnerTexts(), ['You, at the PC'], 'Bunnylink has one place to run and no choice.');
  assert.equal(await page.locator('[data-spawn-target]').isDisabled(), true);
  await page.locator('[data-spawn-text]').fill('Look into the odd tab order');
  assert.equal(await page.locator('[data-spawn-go]').innerText(), 'Add to Needs you');
  assert.match(await page.locator('[data-spawn-note]').innerText(), /start it at the PC/);

  step('A code task shows the repo field; a bad repo blocks the button; Auto and the machine choice');
  await pickOption(page.locator('[data-spawn-project]'), 'magic-loops');
  await page.locator('[data-preset="code-task"]').click();
  await page.locator('[data-spawn-repo-pick]').waitFor();
  const pick = page.locator('[data-spawn-repo-pick]');
  const optionsOf = async input => input.locator('xpath=ancestor::div[contains(@class,"cb")][1]').locator('[role="option"]').allInnerTexts();
  assert.equal(await pick.inputValue(), "example/magic-loops (this project's)", 'The own repo of the project is the default.');
  await pick.click();
  assert.deepEqual(await optionsOf(pick), ["example/magic-loops (this project's)", 'example/sprite-studio · sprite-studio', 'Another repo…']);
  await pickOption(pick, 'example/sprite-studio');
  assert.equal(await pick.getAttribute('data-value'), 'example/sprite-studio');
  assert.equal(await page.locator('input[data-spawn-repo]').count(), 0, 'A known repo needs no typing.');
  await pickOption(pick, '__other');
  await page.locator('input[data-spawn-repo]').fill('not a repo');
  assert.equal(await page.locator('[data-spawn-go]').isDisabled(), true);
  assert.equal(await page.locator('[data-spawn-note]').innerText(), 'The repo is owner/name.');
  await page.locator('input[data-spawn-repo]').fill('Some-Org/other.repo');
  // The button also waits for the route to be worked out, so it enables a moment after the repo is valid.
  await page.locator('[data-spawn-go]:enabled').waitFor();
  await pickOption(pick, '');
  assert.equal(await page.locator('input[data-spawn-repo]').count(), 0);
  await page.locator('[data-spawn-machine]', { hasText: 'The PC' }).waitFor();
  await page.locator('[data-spawn-target]').selectOption('cloud');
  await page.locator('[data-spawn-why]').getByText('your choice').waitFor();
  assert.equal(await page.locator('[data-spawn-route] .sp-rules .hit').count(), 0, 'A manual choice highlights no rule.');
  await page.locator('[data-spawn-target]').selectOption('');
  await page.locator('[data-spawn-route] .sp-rules .hit[data-rule="4"]').waitFor();
  assert.doesNotMatch(await page.locator('[data-spawn-why]').innerText(), /rule \d/);

  step('Save as a proposal: request.json has the preset, the proposed target and the owner as origin; the sheet closes with a toast');
  await page.locator('[data-preset="market-research"]').click();
  await pickOption(page.locator('[data-spawn-project]'), 'magic-loops');
  await page.locator('[data-spawn-text]').fill('Market research on tug-of-war card games');
  await page.locator('[data-spawn-done]').fill('A card with three takeaways');
  await page.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  await page.locator('[data-spawn-go]').click();
  await page.locator('[data-spawn-toast]').waitFor();
  assert.match(await page.locator('[data-spawn-toast]').innerText(), /^Saved as a proposal. It waits in Needs you. Open in Needs you$/);
  assert.equal(await page.locator('[data-spawn-sheet]').count(), 0, 'The sheet closed.');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-spawn-open]')), true, 'The focus went back to the Spawn button.');
  const keys = requestsIn(fixture);
  assert.equal(keys.length, 1);
  const stored = fixture.fake.json(keys[0]);
  assert.deepEqual([stored.project, stored.preset, stored.target, stored.doneWhen, stored.origin.kind], ['magic-loops', 'market-research', 'hermes', 'A card with three takeaways', 'owner']);
  assert.equal(fixture.fake.objects.has(keys[0].replace('request.json', 'approved.json')), false, 'A proposal is not approved.');

  step('Needs you: the Spawn button is in the header and opens the same sheet; Escape closes it');
  await page.evaluate(() => { location.hash = '#/~hub/needs'; });
  await page.locator('.needs-actions [data-spawn-open]').click();
  await page.locator('[data-spawn-sheet]').waitFor();
  await closeSheet(page);
  await page.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });

  step('Ctrl+K: "spawn <text>" lists the command first; Enter opens the sheet with the text and the guessed preset');
  await page.keyboard.press('Control+k');
  await page.locator('dialog[data-search="dialog"] input[role="combobox"]').fill('spawn teardown of how balatro teaches its rules');
  const first = page.locator('dialog[data-search="dialog"] [role="option"]').first();
  assert.equal((await first.locator('b').innerText()).trim(), 'New job: teardown of how balatro teaches its rules');
  await page.keyboard.press('Enter');
  await page.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await page.locator('[data-spawn-text]').inputValue(), 'teardown of how balatro teaches its rules');
  assert.equal(await page.locator('[data-preset="game-teardown"]').getAttribute('aria-pressed'), 'true');
  await closeSheet(page);

  step('Ctrl+K from a card page goes to the Hub and opens the sheet there');
  await page.evaluate(() => { location.hash = '#/hub'; });
  await page.keyboard.press('Control+k');
  await page.locator('dialog[data-search="dialog"] input[role="combobox"]').fill('market research on tug-of-war');
  await page.locator('dialog[data-search="dialog"] [role="option"]', { hasText: 'New job: market research on tug-of-war' }).click();
  await page.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await page.locator('[data-preset="market-research"]').getAttribute('aria-pressed'), 'true');
  // The sheet's entry is added a moment after the sheet draws, and page.url() is the browser's last reported address: wait for it.
  await page.waitForURL(/#\/~hub\/today\/~o$/);
  assert.equal(await page.evaluate(() => location.hash), '#/~hub/today/~o', 'The Hub is Today, and the open sheet is its own history entry.');
  await closeSheet(page);

  step('Approve: with the capability on the button reads Approve and each target has its toast, and a wait says why');
  const signed = await open({ width: 1280, height: 900 });
  await signed.route('**/api/capabilities', async route => {
    const response = await steadyFetch(route);
    await route.fulfill({ response, json: { ...(await response.json()), approve: true, policy: ['research', 'docs'] } });
  });
  const approvals = [];
  await signed.route('**/api/hub/requests/*/approve', async route => {
    approvals.push(JSON.parse(route.request().postData() ?? '{}'));
    const waiting = approvals.length === 3 ? { waiting: '3 Hermes runs are going' } : {};
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ state: 'approved', approved: {}, ...waiting }) });
  });
  await signed.goto(`${fixture.url}#/~hub/today`);
  await signed.locator('[data-spawn-open]').click();
  await signed.locator('[data-spawn-policy]').waitFor();
  assert.equal(await signed.locator('[data-spawn-policy]').innerText(), 'Research and docs may be signed by policy.');
  await closeSheet(signed);
  assert.equal(await page.locator('[data-spawn-policy]').count(), 0, 'Without a policy the line is absent.');
  const approve = async (preset, text, toast, target, machine = 'Hermes') => {
    await signed.locator('[data-spawn-open]').click();
    await pickOption(signed.locator('[data-spawn-project]'), 'magic-loops');
    await signed.locator(`[data-preset="${preset}"]`).click();
    await signed.locator('[data-spawn-text]').fill(text);
    // The machine on screen can still be the previous preset's until the new route arrives: Approve only once it is the expected one.
    if (target) await signed.locator('[data-spawn-target]').selectOption(target);
    await signed.locator('[data-spawn-machine]', { hasText: machine }).waitFor();
    assert.equal(await signed.locator('[data-spawn-go]').innerText(), 'Approve');
    await signed.locator('[data-spawn-go]').click();
    await signed.locator('[data-spawn-toast]', { hasText: toast }).waitFor();
  };
  await approve('research', 'Why do runs end early', 'Approved. Hermes starts it now.');
  await approve('code-task', 'Fix the tab order', 'Approved. It starts on the PC within a few minutes.', 'pc', 'The PC');
  await approve('research', 'One more look', 'Approved. It waits: 3 Hermes runs are going.');
  assert.deepEqual(approvals.map(body => body.target), ['hermes', 'pc', 'hermes']);
  // A failed approve keeps the saved request and says so.
  await signed.unroute('**/api/hub/requests/*/approve');
  await signed.route('**/api/hub/requests/*/approve', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The signing key is not set.' }) }));
  await approve('research', 'Fourth', 'Saved, but not approved. It waits in Needs you: The signing key is not set.');

  step('Approve for real: with a signing key the button reads Approve and writes a signed approved.json');
  const keyed = await startHubFixture({ signing: true, hermes: true });
  fixtures.push(keyed);
  await new Promise(resolve => setTimeout(resolve, 100));
  const real = await open({ width: 1280, height: 900 });
  await real.goto(`${keyed.url}#/~hub/today`);
  const spawnReal = async (preset, text, toast, machine) => {
    await real.locator('[data-spawn-open]').click();
    await pickOption(real.locator('[data-spawn-project]'), 'magic-loops');
    await real.locator(`[data-preset="${preset}"]`).click();
    await real.locator('[data-spawn-text]').fill(text);
    await real.locator('[data-spawn-machine]', { hasText: machine }).waitFor();
    assert.equal(await real.locator('[data-spawn-go]').innerText(), 'Approve');
    await real.locator('[data-spawn-go]').click();
    await real.locator('[data-spawn-toast]', { hasText: toast }).waitFor();
  };
  await spawnReal('research', 'Why do runs end early', 'Approved. Hermes starts it now.', 'Hermes');
  await spawnReal('code-task', 'Fix the tab order', 'Approved. It starts on the PC within a few minutes.', 'The PC');
  const signed2 = requestsIn(keyed).map(key => key.replace('request.json', 'approved.json')).filter(key => keyed.fake.objects.has(key)).map(key => keyed.fake.json(key));
  assert.equal(signed2.length, 2, 'Both requests are approved.');
  assert.deepEqual(signed2.map(item => item.target).sort(), ['hermes', 'pc']);
  assert.ok(signed2.every(item => item.signature && item.by === 'local'));

  step('Approve says why it is off, and reads Approving… while it works');
  await real.locator('[data-spawn-open]').click();
  await pickOption(real.locator('[data-spawn-project]'), 'magic-loops');
  await real.locator('[data-preset="research"]').click();
  await real.locator('[data-spawn-why]').waitFor();
  assert.equal(await real.locator('[data-spawn-go]').isDisabled(), true);
  assert.equal(await real.locator('[data-spawn-note]').innerText(), 'Write what it should do.');
  await real.locator('[data-spawn-text]').fill('Why do runs stall');
  assert.equal(await real.locator('[data-spawn-go]').isDisabled(), false);
  // A slow approve. The toast of the earlier approvals can still be on screen, so it proves nothing about this request:
  // the test waits for the handler to have continued the request and for the page to have its response. A handler left
  // sleeping past the next navigation would call route.continue() on a request the page already dropped ("Route is already handled").
  let continued;
  const handled = new Promise(resolve => { continued = resolve; });
  const slowApprove = async route => {
    try {
      await new Promise(resolve => setTimeout(resolve, 1200));
      await route.continue();
    } finally { continued(); }
  };
  await real.route('**/api/hub/requests/*/approve', slowApprove);
  const approved = real.waitForResponse(response => /\/api\/hub\/requests\/[^/]+\/approve$/.test(new URL(response.url()).pathname));
  await real.locator('[data-spawn-go]').click();
  await real.locator('[data-spawn-go]', { hasText: 'Approving…' }).waitFor();
  assert.equal(await real.locator('[data-spawn-go]').getAttribute('aria-busy'), 'true');
  await handled;
  await approved;
  await real.locator('[data-spawn-toast]').waitFor();
  await real.unroute('**/api/hub/requests/*/approve', slowApprove, { behavior: 'wait' });

  step('Edit: Done when can be changed, and an Edit that leaves the text alone keeps "written by"');
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const agentId = `${day}-magic-loops-market-research-on-tug-a1a1`;
  keyed.seed.request({ id: agentId, project: 'magic-loops', createdAt: minutesAgo(keyed.now, 20).toISOString(), by: 'hermes', text: 'Market research on tug-of-war card games', preset: 'market-research', target: 'hermes', doneWhen: 'three takeaways', origin: { kind: 'agent', name: 'hermes' } });
  await real.goto(`${keyed.url}#/~hub/request/${encodeURIComponent(agentId)}`);
  await real.locator('[data-approval-warning]').waitFor();
  await real.locator('[data-approval-edit]').click();
  await real.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await real.locator('[data-spawn-done]').isDisabled(), false, 'Done when can be edited.');
  assert.equal(await real.locator('[data-spawn-done]').inputValue(), 'three takeaways');
  await real.locator('[data-spawn-done]').fill('A card with prices');
  const [again] = await Promise.all([real.waitForRequest(request => request.url().includes('/again')), real.locator('[data-spawn-go]').click()]);
  const sent = JSON.parse(again.postData());
  assert.equal(sent.doneWhen, 'A card with prices');
  assert.equal(sent.text, undefined, 'The text was not touched, so it is not sent.');
  await real.locator('[data-spawn-toast]').waitFor();
  const copyKey = [...keyed.fake.objects.keys()].find(key => /requests\/[^/]+\/request\.json$/.test(key) && keyed.fake.json(key).replaces === agentId);
  const copy = keyed.fake.json(copyKey);
  assert.deepEqual([copy.doneWhen, copy.textOrigin?.kind, copy.textOrigin?.name], ['A card with prices', 'agent', 'hermes']);

  step('Phone: a bottom sheet the width of the screen, no sideways scroll, the buttons reachable');
  const phone = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.locator('.needs-actions [data-spawn-open]').click();
  await phone.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await phone.locator('[data-preset="code-task"]').click();
  await phone.locator('[data-spawn-machine]').waitFor();
  const box = await phone.locator('[data-spawn-sheet]').boundingBox();
  assert.equal(Math.round(box.x), 0);
  assert.equal(Math.round(box.width), 375);
  assert.ok(Math.round(box.y + box.height) >= 811, 'The sheet sits on the bottom edge.');
  await noSideways(phone, 'Spawn at 375 px');
  await phone.locator('[data-spawn-go]').scrollIntoViewIfNeeded();
  const goBox = await phone.locator('[data-spawn-go]').boundingBox();
  assert.ok(goBox.height >= 44 && goBox.y + goBox.height <= 812, 'The button is reachable.');

  console.log('hub-spawn-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
