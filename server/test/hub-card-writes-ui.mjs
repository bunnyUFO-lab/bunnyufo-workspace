// Run after npm run build. Agent writes in a project section through a real browser, phone width first (ws brief 2.5): the strip on a
// card page, the sheet with the rows, the two-step Revert and its messages, the project page's Library tab, and the Team panel for
// the setting. Over the hub fixture; the agent's writes are made by the real card API handler over the stand-in S3.
import { chromium, expect } from '@playwright/test';
import { ms, SCALE } from './ui-timeouts.mjs';
expect.configure({ timeout: 5000 * SCALE });
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { startHubFixture } from './hub-fixture.mjs';
import { seedAgentCards, HUB_CARD, LANES_CARD } from './card-writes-seed.mjs';

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
  // Waiting starts before the page loads: the answer can arrive before a wait that is attached after goto.
  const answered = phone.waitForResponse(response => response.url().includes('/hub/card-writes'));
  await phone.goto(`${fixture.url}#/hub`);
  await phone.locator('.content').waitFor();
  await answered;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await phone.locator('[data-cw-strip]').count(), 0);

  await seedAgentCards(fixture.fake);

  step('with writes, one line says who did what and when; the tap target is 44 px and nothing runs sideways');
  await phone.reload();
  const strip = phone.locator('[data-cw-strip]');
  await strip.waitFor();
  await expect(strip).toContainText('Researcher changed a tab');
  await expect(strip).toContainText('ago');
  await expect(phone.locator('.content')).toContainText('A card that happens to be called hub', { timeout: ms(15000) });
  assert.ok((await phone.locator('.content').boundingBox()).height > 300, 'the card page keeps its room under the strip');
  await tall(phone.locator('[data-cw-history]'), 'History');
  assert.ok((await strip.boundingBox()).height >= 44 - 0.5, 'the strip is 44 px high');
  await noSideways(phone, 'the card page with a strip');

  step('an HTML tab under the strip shows its text, at phone width, not blank');
  const cardFile = path.join(fixture.dir, 'workspace.json');
  const local = JSON.parse(await readFile(cardFile, 'utf8'));
  local.entities[0].steps.push({ name: 'Page', path: 'page.html' });
  await writeFile(path.join(fixture.dir, 'hub', 'page.html'), '<!doctype html><title>Page</title><p>An agent made this page.</p>');
  await writeFile(cardFile, JSON.stringify(local, null, 2));
  await phone.reload();
  await phone.locator('[data-cw-strip]').waitFor();
  await phone.getByRole('button', { name: 'Page' }).or(phone.getByRole('tab', { name: 'Page' })).first().click();
  await expect(phone.frameLocator('.report-frame').locator('p')).toHaveText('An agent made this page.', { timeout: ms(15000) });
  const frameBox = await phone.locator('.report-frame').boundingBox();
  assert.ok(frameBox.height > 300 && frameBox.width > 300, `the frame has room (${frameBox.width}x${frameBox.height})`);
  await expect(phone.locator('.report-frame')).toHaveCSS('visibility', 'visible');
  await phone.goto(`${fixture.url}#/hub`);
  await phone.reload();
  await phone.locator('[data-cw-strip]').waitFor();

  step('History opens a bottom sheet with a row for each write, newest first, and the line about names and tokens the first time');
  await phone.locator('[data-cw-history]').click();
  const sheet = phone.locator('.lib-dialog');
  await sheet.waitFor();
  const box = await sheet.boundingBox();
  assert.ok(Math.abs(box.x) < 1 && Math.abs(box.width - 390) < 1 && Math.abs(box.y + box.height - 844) < 2, 'the sheet fills the bottom of the phone');
  await expect(sheet.locator('[data-cw-note]')).toContainText('The agent names itself, so treat the name as a claim.');
  assert.equal(await sheet.locator('[data-cw-note]').textContent().then(text => /token/i.test(text)), false, 'no jargon in the note');
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

  step('an edit that cannot go back says why in place and keeps the button: an older version the Hub cannot read yet');
  const editRow = sheet.locator('[data-batch="editbatch01"]');
  assert.equal(await editRow.locator('[data-cw-revert]').count(), 1);
  await editRow.locator('[data-cw-revert]').click();
  await expect(editRow.locator('[data-cw-will]')).toHaveText('Puts the old text back');
  await editRow.locator('[data-cw-no]').click();
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

  step('a file the owner changed after the agent is left alone, said plainly, and the row loses its button');
  const laneEdit = phone.locator('[data-batch="laneedit001"]');
  fixture.fake.seed(`sections/lanes/${LANES_CARD.folder}/index.md`, '# Lanes plan, tweaked by the owner\n', 'text/markdown');
  await laneEdit.locator('[data-cw-revert]').click();
  await laneEdit.locator('[data-cw-yes]').click();
  await expect(laneEdit.locator('[data-cw-reverted]')).toContainText('You changed this file after the agent, so it was left alone');
  assert.equal(await laneEdit.locator('[data-cw-revert]').count(), 0, 'no button: nothing can be undone');
  assert.equal(fixture.fake.text(`sections/lanes/${LANES_CARD.folder}/index.md`), '# Lanes plan, tweaked by the owner\n');

  step('Team: the setting lists each Library section, assistant locked on, and a change saves a list at once');
  await phone.goto(`${fixture.url}#/~hub/team`);
  const panel = phone.locator('[data-card-write-setting]');
  await panel.waitFor();
  await expect(panel).toContainText('Where agents can write');
  await expect(panel).toContainText('Always on: it is where they fall back to.');
  await expect(panel).toContainText('Changes save at once and take effect within 30 seconds. Cards already there stay.');
  assert.equal(await panel.locator('[data-card-write-section="assistant"]').isDisabled(), true);
  assert.equal(await panel.locator('[data-card-write-section="assistant"]').isChecked(), true);
  step('the setting is findable: a button at the top of Team jumps to it, and Floor shows it too');
  await phone.locator('[data-team-write-setting]').click();
  await expect(panel.locator('h3')).toBeInViewport();
  await phone.locator('[data-team-view="floor"]').click();
  await panel.waitFor();
  await phone.locator('[data-team-view="roster"]').click();
  const lanes = panel.locator('[data-card-write-section="lanes"]');
  assert.equal(await lanes.isChecked(), true);
  for (const height of await panel.locator('li label').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(height >= 44 - 0.5, `a setting row is ${height} px high`);
  await noSideways(phone, 'the Team panel');
  await expect(panel.locator('[data-card-write-unsaved]')).toBeVisible();
  assert.equal(((await panel.innerText()).match(/at once/g) ?? []).length, 1, 'the panel says once that changes save at once, and the "not saved yet" line does not say otherwise');
  assert.equal(fixture.fake.text('sections/inbox/library-writes.json'), null, 'nothing is saved until the owner changes it');
  // A save that fails says why and puts the box back; the list stays "not saved yet".
  fixture.fake.fail = (key, method) => method === 'PUT' && key.endsWith('library-writes.json') && 500;
  await lanes.uncheck();
  await expect(panel.locator('[data-card-write-error]')).toContainText('Not saved');
  await expect(panel.locator('[data-card-write-error]')).toContainText('back as it was');
  await expect(lanes).toBeChecked();
  await expect(panel.locator('[data-card-write-unsaved]')).toBeVisible();
  assert.equal(await panel.locator('[data-card-write-saved]').count(), 0);
  fixture.fake.fail = null;
  await lanes.uncheck();
  await expect(panel.locator('[data-card-write-saved]')).toHaveText('Saved.');
  await expect(panel.locator('[data-card-write-unsaved]')).toHaveCount(0);
  assert.ok((await lanes.boundingBox()).height >= 24, 'the box itself is big enough to hit');
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
