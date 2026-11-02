// Run after npm run build. The Combobox in Spawn's project and repository pickers, through a real browser over the fixture
// service: typing filters, Enter picks, Escape closes and then restores, a blur with junk keeps the value, the chevron opens the
// list without focusing the input, the text focuses it, and phone width has no sideways scroll.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
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
const focused = page => page.evaluate(() => document.activeElement?.matches('[data-spawn-project]') ?? false);
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};
const sheetReady = async page => {
  await page.locator('[data-spawn-open]').click();
  await page.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await page.locator('[data-spawn-project]').waitFor();
};
const values = page => page.locator('.cb-list [role="option"]').evaluateAll(nodes => nodes.map(node => node.dataset.value));

try {
  const fixture = await startHubFixture();
  fixtures.push(fixture);
  fixture.seed.beads('bunnylink', [beadsIssue({ id: 'bl-1', title: 'A task', created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: 'example/bunnylink' });
  for (const [project, repo] of [['magic-loops', 'example/magic-loops'], ['sprite-studio', 'example/sprite-studio']]) fixture.fake.seed(`sections/${project}/workspace.json`, JSON.stringify({ name: project, tracked: { repo }, entities: [] }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/today`);
  await sheetReady(page);
  const project = page.locator('[data-spawn-project]');

  step('The project field is an ARIA combobox with a named chevron');
  assert.equal(await project.getAttribute('role'), 'combobox');
  assert.equal(await project.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByRole('button', { name: 'Show projects' }).count(), 1);

  step('Typing part of a name filters the list; Enter picks the match and keeps the sheet open');
  await project.click();
  await page.locator('.cb-list').waitFor();
  assert.ok((await values(page)).length >= 3, 'The whole list shows before typing.');
  await project.fill('WAYF');
  assert.deepEqual(await values(page), ['wayfind']);
  assert.notEqual(await project.getAttribute('aria-activedescendant'), null, 'A highlighted option is announced.');
  await page.keyboard.press('Enter');
  assert.equal(await project.getAttribute('data-value'), 'wayfind');
  assert.equal(await page.locator('.cb-list').count(), 0, 'Picking closes the list.');
  assert.equal(await page.locator('[data-spawn-sheet]').evaluate(node => node.open), true, 'Enter did not close the sheet.');

  step('No match says so; Escape closes the list, a second Escape restores the value');
  const picked = await project.inputValue();
  await project.fill('zzz');
  assert.deepEqual(await values(page), []);
  assert.equal(await page.locator('.cb-none').innerText(), 'No match');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.cb-list').count(), 0);
  assert.equal(await page.locator('[data-spawn-sheet]').evaluate(node => node.open), true, 'The first Escape only closes the list.');
  assert.equal(await project.inputValue(), 'zzz');
  await page.keyboard.press('Escape');
  assert.equal(await project.inputValue(), picked, 'The second Escape puts the value back.');

  step('Arrow keys and End move the highlight');
  await project.fill('');
  await page.keyboard.press('End');
  const all = await values(page);
  assert.equal(await page.locator('.cb-opt.on').getAttribute('data-value'), all[all.length - 1]);
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('.cb-opt.on').getAttribute('data-value'), all[all.length - 2]);
  await page.keyboard.press('Home');
  assert.equal(await page.locator('.cb-opt.on').getAttribute('data-value'), all[0]);
  await page.keyboard.press('Enter');
  assert.equal(await project.getAttribute('data-value'), all[0]);

  step('A blur with text that matches nothing keeps the value');
  const kept = await project.getAttribute('data-value');
  const label = await project.inputValue();
  await project.fill('no such project');
  await page.locator('[data-spawn-text]').click();
  assert.equal(await project.getAttribute('data-value'), kept);
  assert.equal(await project.inputValue(), label);
  assert.equal(await page.locator('.cb-list').count(), 0);

  step('The chevron opens the list without focusing the input; the text does focus it');
  await page.getByRole('button', { name: 'Show projects' }).click();
  await page.locator('.cb-list').waitFor();
  assert.equal(await focused(page), false, 'The input has no focus, so a phone shows no keyboard.');
  await page.getByRole('button', { name: 'Show projects' }).click();
  assert.equal(await page.locator('.cb-list').count(), 0, 'The chevron toggles.');
  await project.click();
  assert.equal(await focused(page), true);
  await page.locator('.cb-list').waitFor();

  step('Picking by click works, and the repository field filters too');
  await page.locator('.cb-list [role="option"][data-value="magic-loops"]').click();
  assert.equal(await project.getAttribute('data-value'), 'magic-loops');
  const repo = page.locator('[data-spawn-repo-pick]');
  await repo.waitFor();
  await repo.fill('sprite');
  assert.deepEqual(await values(page), ['example/sprite-studio', '__other']);
  await page.keyboard.press('Enter');
  assert.equal(await repo.getAttribute('data-value'), 'example/sprite-studio');

  step('Phone width: the list fits 390 px, the chevron shows no keyboard, the page does not scroll sideways');
  const phone = await open({ width: 390, height: 780 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/today`);
  await sheetReady(phone);
  await phone.getByRole('button', { name: 'Show projects' }).tap();
  await phone.locator('.cb-list').waitFor();
  assert.equal(await focused(phone), false, 'Tapping the chevron leaves the input unfocused.');
  const box = await phone.locator('.cb-list').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `The list is inside the screen (${box.x}..${box.x + box.width}).`);
  await noSideways(phone, 'chevron list');
  await phone.locator('.cb-list [role="option"]').first().tap();
  await phone.locator('[data-spawn-project]').tap();
  assert.equal(await focused(phone), true, 'Tapping the text focuses the input.');
  await phone.locator('[data-spawn-project]').fill('loops');
  assert.deepEqual(await values(phone), ['magic-loops']);
  await noSideways(phone, 'filtered list');

  console.log('hub-combobox-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
