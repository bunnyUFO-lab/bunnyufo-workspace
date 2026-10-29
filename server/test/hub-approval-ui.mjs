// Run after npm run build. The Approval item and the request page through a real browser, over the fixture service with a
// throwaway signing key: an agent-written proposal shows the warning and Approve signs it once, the note says what is next
// and the focus moves there; Decline writes declined.json with a reason; Edit replaces a request (through Approve again);
// an at-PC request copies its prompt and Mark done writes a manual result; an expired approval is approved again; a link
// opens the item; "Signed by policy"; and the item at 375 px.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'], ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const ids = {
  agentA: `${day}-magic-loops-market-research-on-tug-a1a1`,
  agentB: `${day}-magic-loops-teardown-of-balatro-b2b2`,
  owner: `${day}-magic-loops-fix-the-tab-order-c3c3`,
  edit: `${day}-magic-loops-research-the-dash-d4d4`,
  atPc: `${day}-bunnylink-look-at-the-gate-e5e5`,
  expired: `${day}-magic-loops-old-research-f6f6`,
  policy: `${day}-magic-loops-signed-by-policy-a7a7`,
};
const NEVER = '2099-01-01T00:00:00.000Z';

try {
  const fixture = await startHubFixture({ signing: true });
  fixtures.push(fixture);
  const { seed, now, fake } = fixture;
  const base = (id, rest) => ({ id, project: 'magic-loops', createdAt: minutesAgo(now, 20).toISOString(), by: 'owner', ...rest });
  seed.request(base(ids.agentA, { by: 'hermes', text: 'Market research on tug-of-war card games', preset: 'market-research', target: 'hermes', origin: { kind: 'agent', name: 'hermes' } }));
  seed.request({ ...base(ids.agentB, { by: 'hermes', text: 'Teardown of how Balatro teaches its rules', preset: 'game-teardown', target: 'hermes', origin: { kind: 'agent', name: 'hermes' } }), createdAt: minutesAgo(now, 30).toISOString() });
  seed.request(base(ids.owner, { text: 'Fix the tab order on the settings sheet', preset: 'code-task', repo: 'example/magic-loops', target: 'pc', origin: { kind: 'owner', name: 'owner' }, doneWhen: 'Tab goes top to bottom' }));
  seed.request(base(ids.edit, { text: 'Research the dash arc', preset: 'research', target: 'hermes', origin: { kind: 'owner', name: 'owner' } }));
  seed.request(base(ids.atPc, { project: 'bunnylink', text: 'Look at the gate script', preset: 'code-task', repo: 'example/bunnylink', target: 'at-pc', origin: { kind: 'owner', name: 'owner' } }));
  seed.request(base(ids.expired, { text: 'Old research', preset: 'research', target: 'hermes', origin: { kind: 'owner', name: 'owner' } }));
  seed.put(`requests/${ids.expired}/approved.json`, { v: 1, request: ids.expired, project: 'magic-loops', repo: null, target: 'hermes', limits: { minutes: 30 }, expires: minutesAgo(now, 60).toISOString(), at: minutesAgo(now, 4000).toISOString(), by: 'owner', signature: 'x' });
  seed.request(base(ids.policy, { by: 'hermes', text: 'Research signed without a tap', preset: 'research', target: 'hermes', origin: { kind: 'agent', name: 'hermes' } }));
  seed.put(`requests/${ids.policy}/approved.json`, { v: 1, request: ids.policy, project: 'magic-loops', repo: null, target: 'hermes', limits: { minutes: 30 }, expires: NEVER, at: minutesAgo(now, 1).toISOString(), by: 'policy', signature: 'x' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const has = (id, file) => fake.objects.has(`sections/inbox/requests/${id}/${file}`);
  const json = (id, file) => fake.json(`sections/inbox/requests/${id}/${file}`);
  const requestFolders = () => [...new Set([...fake.objects.keys()].map(key => /sections\/inbox\/requests\/([^/]+)\//.exec(key)?.[1]).filter(Boolean))];

  step('Needs you: the agent-written proposal carries the warning, the preset, the origin and its facts');
  const page = await open({ width: 1280, height: 1000 });
  await page.goto(`${fixture.url}#/~hub/needs`);
  const cardA = page.locator(`[data-need="approval-${ids.agentA}"]`);
  await cardA.waitFor();
  assert.equal(await cardA.getAttribute('data-kind'), 'approval');
  assert.match(await cardA.locator('[data-approval-warning]').innerText(), /Written by hermes, not by you\. Read it before approving\./);
  assert.match(await cardA.locator('[data-approval-text]').innerText(), /tug-of-war/);
  assert.equal((await cardA.locator('[data-approval-preset]').innerText()).trim(), 'Market research');
  assert.equal((await cardA.locator('[data-approval-machine]').innerText()).trim(), 'Hermes');
  assert.match(await cardA.locator('[data-approval-effect]').innerText(), /One card in assistant/);
  assert.equal(await page.locator(`[data-need="approval-${ids.owner}"] [data-approval-warning]`).count(), 0, 'Your own request has no warning.');
  assert.match(await page.locator(`[data-need="approval-${ids.owner}"] [data-approval-effect]`).innerText(), /A new branch and a PR in example\/magic-loops\. No merge, no deploy\./);

  step('Approve signs once, the note says Approved · next, and the focus moves to the next item');
  const order = await page.locator('[data-need]').evaluateAll(list => list.map(item => item.getAttribute('data-need')));
  const next = order[order.indexOf(`approval-${ids.agentA}`) + 1];
  assert.ok(next, 'Something follows the first approval.');
  let approvals = 0;
  page.on('request', request => { if (request.url().endsWith('/approve') && request.method() === 'POST') approvals += 1; });
  await cardA.locator('[data-approval-approve]').click();
  await page.locator('[data-next-note]').waitFor();
  assert.match(await page.locator('[data-next-note]').innerText(), /^Approved · next:/);
  assert.equal(approvals, 1, 'One tap, one approval.');
  const approved = json(ids.agentA, 'approved.json');
  assert.deepEqual([approved.target, approved.by, approved.request], ['hermes', 'local', ids.agentA]);
  assert.ok(approved.signature, 'The approval is signed.');
  await page.locator(`[data-need="${next}"]`).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-need]')?.getAttribute('data-need')), next, 'The focus is on the next item.');
  await page.locator(`[data-need="approval-${ids.agentA}"]`).waitFor({ state: 'detached' });

  step('Decline asks for an optional reason and writes declined.json; the item leaves Needs you');
  const cardOwner = page.locator(`[data-need="approval-${ids.owner}"]`);
  await cardOwner.locator('[data-approval-decline]').click();
  await cardOwner.locator('[data-approval-reason]').fill('Not this sprint');
  await cardOwner.locator('[data-approval-decline-send]').click();
  await page.locator(`[data-need="approval-${ids.owner}"]`).waitFor({ state: 'detached' });
  assert.equal(json(ids.owner, 'declined.json').reason, 'Not this sprint');
  assert.match(await page.locator('[data-next-note]').innerText(), /^Declined/);

  step('Edit opens Spawn on the request; Approve makes a new request that replaces it and retires the old one');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.edit)}`);
  await page.locator('[data-approval-edit]').click();
  await page.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await page.locator('[data-spawn-sheet] h2').innerText(), 'Edit the request');
  assert.equal(await page.locator('[data-spawn-text]').inputValue(), 'Research the dash arc');
  assert.equal(await page.locator('[data-spawn-project]').isDisabled(), true, 'The project is fixed when editing.');
  assert.equal(await page.locator('[data-spawn-go]').innerText(), 'Approve');
  await page.locator('[data-spawn-text]').fill('Research the dash arc in other platformers');
  await page.locator('[data-spawn-go]').click();
  await page.locator('[data-spawn-toast]').waitFor();
  assert.equal(json(ids.edit, 'declined.json').reason.startsWith('replaced by '), true);
  const copy = requestFolders().find(id => !Object.values(ids).includes(id) && has(id, 'request.json'));
  assert.ok(copy, 'A new request exists.');
  assert.deepEqual([json(copy, 'request.json').replaces, json(copy, 'request.json').text], [ids.edit, 'Research the dash arc in other platformers']);
  assert.ok(has(copy, 'approved.json'), 'The copy is approved.');

  step('At the PC: Copy prompt copies the brief, Mark done writes a manual result');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.atPc)}`);
  await page.locator('[data-approval-copy]').waitFor();
  assert.equal(await page.locator('[data-approval-approve]').count(), 0, 'Nothing to approve: you start it yourself.');
  assert.equal((await page.locator('[data-approval-machine]').innerText()).trim(), 'You, at the PC');
  await page.locator('[data-approval-copy]').click();
  await page.locator('[data-approval-copied]').waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Look at the gate script/);
  await page.locator('[data-approval-done]').click();
  await page.waitForFunction(() => location.hash.startsWith('#/~hub/needs') || location.hash.startsWith('#/~hub/request/'));
  assert.equal(json(ids.atPc, 'result.json').outcome, 'manual');

  step('An expired approval shows its state and Approve again signs a new one');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.expired)}`);
  await page.locator('[data-approval-state]', { hasText: 'Expired' }).waitFor();
  await page.locator('[data-approval-expired]').waitFor();
  await page.locator('[data-approval-approve]', { hasText: 'Approve again' }).click();
  await page.locator('[data-next-note]').waitFor();
  assert.match(await page.locator('[data-next-note]').innerText(), /^Approved/);
  assert.ok(requestFolders().some(id => has(id, 'request.json') && json(id, 'request.json').replaces === ids.expired && has(id, 'approved.json')), 'The new request replaces the expired one and is approved.');

  step('A request signed by policy says so, and a link opens the item page');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.policy)}`);
  await page.locator('[data-request-state="approved"]').waitFor();
  assert.match(await page.locator('[data-request-state]').innerText(), /Signed by policy/);
  assert.equal(await page.locator('[data-approval-approve]').count(), 0, 'An approved request has no Approve.');
  assert.match(await page.locator('[data-approval-text]').innerText(), /signed without a tap/);

  step('Phone: the item fits at 375 px, the buttons are 44 px, nothing scrolls sideways');
  const phone = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  const cardB = phone.locator(`[data-need="approval-${ids.agentB}"]`);
  await cardB.waitFor();
  await cardB.locator('[data-approval-warning]').waitFor();
  const widths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `The page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  for (const name of ['approve', 'edit', 'decline']) assert.ok((await cardB.locator(`[data-approval-${name}]`).boundingBox()).height >= 44, `${name} is 44 px high.`);
  await phone.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.atPc.replace('e5e5', 'e5e5'))}`);
  const atPcWidths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(atPcWidths.scroll <= atPcWidths.inner, 'The request page does not scroll sideways.');

  console.log('hub-approval-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
