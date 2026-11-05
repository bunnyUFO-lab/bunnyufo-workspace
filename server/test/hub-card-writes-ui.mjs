// Run after npm run build. Agent writes in a project section through a real browser, phone width first (ws brief 2.5): the strip on a
// card page, the sheet with the rows, the two-step Revert and its messages, the project page's Library tab, and the Team panel for
// the setting. Over the hub fixture; the agent's writes are made by the real card API handler over the stand-in S3.
import { chromium, expect } from '@playwright/test';
import { ms, SCALE } from './ui-timeouts.mjs';
expect.configure({ timeout: 5000 * SCALE });
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { seedAgentCards, HUB_CARD } from './card-writes-seed.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const open = async options => {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the hub scrolls sideways.`);
};
const tall = async (locator, what) => {
  for (const height of await locator.evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(height >= 44 - 0.5, `${what}: a control is ${height} px high.`);
};
const KEY = `sections/one/${HUB_CARD.folder}/index.md`;
const ORIGINAL = '# The hub card\n\nA card that happens to be called hub.\n';

let fixture;
try {
  fixture = await startHubFixture({ work: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  const phone = await open(PHONE);

  step('a card with no agent writes shows no strip at all');
  await phone.goto(`${fixture.url}#/hub`);
  await phone.locator('.content').waitFor();
  await phone.waitForResponse(response => response.url().includes('/hub/card-writes'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await phone.locator('[data-cw-strip]').count(), 0);

  await seedAgentCards(fixture.fake);

  step('with writes, one line says who did what and when; the tap target is 44 px and nothing runs sideways');
  await phone.reload();
  const strip = phone.locator('[data-cw-strip]');
  await strip.waitFor();
  await expect(strip).toContainText('Researcher changed a tab');
  await expect(strip).toContainText('ago');
  await tall(phone.locator('[data-cw-history]'), 'History');
  assert.ok((await strip.boundingBox()).height >= 44 - 0.5, 'the strip is 44 px high');
  await noSideways(phone, 'the card page with a strip');

  step('History opens a bottom sheet with a row for each write, newest first, and the line about names and tokens the first time');
  await phone.locator('[data-cw-history]').click();
  const sheet = phone.locator('.lib-dialog');
  await sheet.waitFor();
  const box = await sheet.boundingBox();
  assert.ok(Math.abs(box.x) < 1 && Math.abs(box.width - 390) < 1 && Math.abs(box.y + box.height - 844) < 2, 'the sheet fills the bottom of the phone');
  await expect(sheet.locator('[data-cw-note]')).toContainText('The token is proven');
  const rows = sheet.locator('[data-cw-row]');
  assert.equal(await rows.count(), 2);
  assert.deepEqual(await rows.evaluateAll(list => list.map(item => item.getAttribute('data-batch'))), ['editbatch01', 'tabbatch01']);
  await expect(rows.nth(0).locator('[data-cw-agent]')).toHaveText('Researcher');
  await expect(rows.nth(0)).toContainText('Fix a fact the owner flagged in this chat');
  await expect(rows.nth(0).locator('.cw-meta')).toContainText('token lib');
  assert.equal(await rows.nth(0).locator('[data-cw-job]').getAttribute('href'), '#/~hub/request/20261105-research-a1b2');
  await expect(rows.nth(0).locator('.cw-files summary')).toHaveText('1 file ›');
  await tall(sheet.locator('button'), 'the sheet');
  await noSideways(phone, 'the sheet');
  await phone.keyboard.press('Escape');
  await phone.locator('[data-cw-history]').click();
  await sheet.waitFor();
  assert.equal(await sheet.locator('[data-cw-note]').count(), 0, 'the line about names shows only the first time');

  step('Revert is two steps in place: what Yes will do in words, No puts the button back, Yes reverts and says so');
  const tabRow = sheet.locator('[data-batch="tabbatch01"]');
  await tabRow.locator('[data-cw-revert]').click();
  await expect(tabRow.locator('[data-cw-will]')).toHaveText('Takes the tab off (you can bring it back with +)');
  await expect(tabRow.locator('.cw-confirm-q')).toHaveText('Revert this?');
  await tall(tabRow.locator('[data-cw-yes], [data-cw-no]'), 'Yes and No');
  await tabRow.locator('[data-cw-no]').click();
  await expect(tabRow.locator('[data-cw-revert]')).toBeVisible();
  assert.equal(await sheet.locator('[data-cw-yes]').count(), 0);
  await tabRow.locator('[data-cw-revert]').click();
  await tabRow.locator('[data-cw-yes]').click();
  await expect(tabRow.locator('[data-cw-reverted]')).toContainText('Reverted by you');
  assert.equal(await tabRow.locator('[data-cw-revert]').count(), 0, 'the button is gone');
  const card = fixture.fake.json('sections/one/workspace.json').entities.find(item => item.id === 'hub');
  assert.deepEqual(card.steps.map(item => item.path), ['index.md']);
  assert.deepEqual(card.removedTabs.map(item => item.path), ['sources.md']);
  assert.equal(fixture.fake.log.some(entry => entry.method === 'DELETE'), false, 'no object is removed');

  step('an edit that cannot go back says why in place and keeps the button: a newer change, then an older version the Hub cannot read yet');
  const editRow = sheet.locator('[data-batch="editbatch01"]');
  assert.equal(await editRow.locator('[data-cw-revert]').count(), 1);
  const agentText = fixture.fake.text(KEY);
  fixture.fake.seed(KEY, 'The owner changed this meanwhile.\n', 'text/markdown');
  await editRow.locator('[data-cw-revert]').click();
  await expect(editRow.locator('[data-cw-will]')).toHaveText('Puts the old text back');
  await editRow.locator('[data-cw-yes]').click();
  await expect(editRow.locator('[data-cw-error]')).toContainText('changed after this write');
  await expect(editRow.locator('[data-cw-revert]')).toBeVisible();
  assert.equal(fixture.fake.text(KEY), 'The owner changed this meanwhile.\n', 'nothing was overwritten');
  fixture.fake.seed(KEY, agentText, 'text/markdown');
  fixture.fake.fail = (_key, method, query) => method === 'GET' && query.has('versionId') && 403;
  await editRow.locator('[data-cw-revert]').click();
  await editRow.locator('[data-cw-yes]').click();
  await expect(editRow.locator('[data-cw-error]')).toHaveText('The Hub cannot read older versions yet.');
  fixture.fake.fail = null;
  await editRow.locator('[data-cw-revert]').click();
  await editRow.locator('[data-cw-yes]').click();
  await expect(editRow.locator('[data-cw-reverted]')).toContainText('Reverted by you');
  assert.equal(fixture.fake.text(KEY), ORIGINAL, 'the old text is back');

  step('the project page: a line about the setting above the cards, and the rows below them');
  await phone.goto(`${fixture.url}#/~hub/project/lanes/library`);
  const agents = phone.locator('[data-pp-agents]');
  await agents.waitFor();
  await expect(agents).toContainText('Agents may add cards here.');
  await expect(phone.locator('[data-pp-agent-writes] h3')).toHaveText('Agent writes');
  const projectRows = phone.locator('[data-pp-agent-writes] [data-cw-row]');
  assert.equal(await projectRows.count(), 2);
  await expect(projectRows.first()).toContainText('in Lanes plan');
  await tall(phone.locator('[data-pp-agent-writes] button, [data-pp-agents] a'), 'the Library tab');
  await noSideways(phone, 'the Library tab with rows');

  step('Team: the setting lists each Library section, assistant locked on, and a change saves a list at once');
  await phone.goto(`${fixture.url}#/~hub/team`);
  const panel = phone.locator('[data-card-write-setting]');
  await panel.waitFor();
  await expect(panel).toContainText('Where agents may add cards');
  await expect(panel).toContainText('Always on: it is where they fall back to.');
  await expect(panel).toContainText('Turning one off takes up to 30 seconds. Cards already there stay.');
  assert.equal(await panel.locator('[data-card-write-section="assistant"]').isDisabled(), true);
  assert.equal(await panel.locator('[data-card-write-section="assistant"]').isChecked(), true);
  const lanes = panel.locator('[data-card-write-section="lanes"]');
  assert.equal(await lanes.isChecked(), true);
  for (const height of await panel.locator('li label').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(height >= 44 - 0.5, `a setting row is ${height} px high`);
  await noSideways(phone, 'the Team panel');
  await expect(panel.locator('[data-card-write-unsaved]')).toBeVisible();
  assert.equal(fixture.fake.text('sections/inbox/library-writes.json'), null, 'nothing is saved until the owner changes it');
  await lanes.uncheck();
  await expect(lanes).not.toBeChecked();
  await expect.poll(() => fixture.fake.json('sections/inbox/library-writes.json')?.off).toEqual(['lanes']);
  await expect(panel.locator('[data-card-write-unsaved]')).toHaveCount(0);
  await phone.goto(`${fixture.url}#/~hub/project/lanes/library`);
  await expect(phone.locator('[data-pp-agents]')).toHaveText('Agents may not write here');
  await phone.goto(`${fixture.url}#/~hub/team`);
  await panel.waitFor();
  await panel.locator('[data-card-write-section="lanes"]').check();
  await expect.poll(() => fixture.fake.json('sections/inbox/library-writes.json')?.off).toEqual([]);

  step('on a wide screen the strip, the sheet and the rows read the same');
  const desk = await open({ viewport: { width: 1280, height: 800 } });
  await desk.goto(`${fixture.url}#/hub`);
  await desk.locator('[data-cw-strip]').waitFor();
  await desk.locator('[data-cw-history]').click();
  await desk.locator('.lib-dialog [data-cw-row]').first().waitFor();
  assert.equal(await desk.locator('.lib-dialog [data-cw-row]').count(), 2);
  assert.equal(await desk.locator('.lib-dialog [data-cw-revert]').count(), 0, 'both writes were reverted above');
  await noSideways(desk, 'the sheet on a wide screen');

  console.log('hub-card-writes-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close();
}
