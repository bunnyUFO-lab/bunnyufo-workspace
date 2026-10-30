// Run after npm run build. The two avatar Asks of the sprite flow through a real browser over the hub fixture: the variant
// pick carries the note about when the sheet starts, and the sheet check draws the real sheet from the Hub, playing its rows,
// instead of the picture the run attached. At 1280 and 375 px; nothing scrolls sideways and the buttons are 44 px high.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { askId, startHubFixture } from './hub-fixture.mjs';
import { askJson, teamSheet } from '../../site/api/test/hub-fixtures.mjs';
import { solidPng } from '../../site/api/test/png.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ sheets: true });
const sheet = teamSheet('claude');
const pickId = askId('avatar-pick', 'a1b2');
const checkId = askId('avatar-sheet', 'b2c3');
const lostId = askId('avatar-lost', 'c3d4');
const options = ['a', 'b', 'c', 'd'].map(id => ({ id, label: `${id.toUpperCase()}: a robot`, image: `${id}.png` }));
fixture.seed.ask({ ...askJson({ id: pickId, project: 'sprite-studio', question: 'Which avatar for Claude Code?', options }), requirePasskey: true, avatar: { agent: 'claude', request: askId('avatar-req', 'd4e5'), subject: 'subjects/claude' } });
fixture.seed.ask({
  ...askJson({ id: checkId, project: 'sprite-studio', question: 'Use this sheet for Claude Code?', options: [{ id: 'use', label: 'Use it' }, { id: 'skip', label: 'Not this one' }] }),
  image: 'preview.png', requirePasskey: true, avatar: { agent: 'claude', sheet: sheet.id },
}, { files: { 'preview.png': solidPng(320, 240, 0x60) } });
fixture.seed.ask({ ...askJson({ id: lostId, project: 'sprite-studio', question: 'Use this sheet?', options: [{ id: 'use', label: 'Use it' }, { id: 'skip', label: 'Not this one' }] }), requirePasskey: true, avatar: { agent: 'claude', sheet: 'sheet-20261029T110000Z-zz99' } });
await new Promise(resolve => setTimeout(resolve, 150));

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => { throw error; });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return { page, errors };
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};

try {
  for (const [name, viewport] of [['1280', { width: 1280, height: 900 }], ['375', { width: 375, height: 800 }]]) {
    const { page, errors } = await open(viewport);

    step(`${name}: the variant pick says when the sheet starts, above the options`);
    await page.goto(`${fixture.url}#/~hub/ask/${pickId}`);
    const note = page.locator('[data-avatar-note="pick"]');
    await note.waitFor();
    assert.equal(await note.innerText(), 'Picking one starts the sprite sheet on the Gaming PC at its next run check, within about an hour.');
    await page.locator('[data-option="a"]').waitFor();
    const noteBox = await note.boundingBox();
    const optionBox = await page.locator('[data-option="a"]').boundingBox();
    assert.ok(noteBox.y < optionBox.y, 'The note is above the options.');
    await noSideways(page, `pick at ${name}`);

    step(`${name}: the sheet check draws the real sheet, plays a state and hides the attached picture`);
    await page.goto(`${fixture.url}#/~hub/ask/${checkId}`);
    const check = page.locator(`[data-avatar-sheet="${sheet.id}"]`);
    await check.waitFor();
    assert.equal(await page.locator('[data-design-image]').count(), 0, 'The run\'s picture is not shown.');
    const sprite = check.locator('[data-row]');
    await sprite.waitFor();
    assert.equal(await sprite.getAttribute('data-row'), 'idle');
    assert.match(await sprite.evaluate(node => getComputedStyle(node).backgroundImage), /sheet-20261029T100000Z-ab12\.png/, 'The sprite is the sheet file the Hub serves.');
    await check.locator('[data-avatar-state="working"]').click();
    assert.equal(await sprite.getAttribute('data-row'), 'running');
    await check.locator('[data-avatar-state="failed"]').click();
    assert.equal(await sprite.getAttribute('data-row'), 'failed');
    for (const height of await check.locator('button').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(height >= 44 - 0.5, `A button is ${height} px high.`);
    await noSideways(page, `sheet check at ${name}`);

    step(`${name}: a sheet that is not listed says so`);
    await page.goto(`${fixture.url}#/~hub/ask/${lostId}`);
    await page.locator('[data-avatar-sheet="missing"]').waitFor();
    assert.match(await page.locator('[data-avatar-sheet="missing"]').innerText(), /not ready or failed its check/);
    assert.deepEqual(errors.filter(text => !/Failed to load resource/.test(text)), [], 'no console errors');
  }

  step('with reduced motion the preview does not cycle by itself');
  const { page: calm } = await open({ width: 1280, height: 900 }, { reducedMotion: 'reduce' });
  await calm.goto(`${fixture.url}#/~hub/ask/${checkId}`);
  await calm.locator(`[data-avatar-sheet="${sheet.id}"] [data-row]`).waitFor();
  await calm.waitForTimeout(3300);
  assert.equal(await calm.locator(`[data-avatar-sheet="${sheet.id}"] [data-row]`).getAttribute('data-row'), 'idle');
  console.log('hub-avatar-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
