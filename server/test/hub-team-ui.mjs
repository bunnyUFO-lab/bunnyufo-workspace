// Run after npm run build. The Team screen and its Sprite sheet through a real browser, over the hub fixture.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { BUILTIN, genSprite } from '../../src/hub/team/sprites.ts';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

// The sprite as the page draws it: one entry per run of equal pixels, so a rect list identifies a sprite.
const signatureOf = data => {
  const out = [];
  data.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      if (c === '.') { x += 1; continue; }
      let w = 1;
      while (x + w < row.length && row[x + w] === c) w += 1;
      out.push(`${x},${y},${w},${data.palette[c]}`);
      x += w;
    }
  });
  return out.join('|');
};
const domSignature = locator => locator.evaluate(svg => [...svg.querySelectorAll('rect')].map(r => `${r.getAttribute('x')},${r.getAttribute('y')},${r.getAttribute('width')},${r.getAttribute('fill')}`).join('|'));

const fixture = await startHubFixture({ pc: 'fresh' });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
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
const cardSprite = (page, agent) => page.locator(`[data-agent="${agent}"] .team-tile svg`);

try {
  step('six cards (the three research agents among them), the header counts, the labels, and Team in the sidebar');
  const desk = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('.team-card').count(), 6);
  assert.deepEqual(await desk.locator('.team-card h3').allInnerTexts(), ['Hermes', 'Briefs', 'Claude Code', 'Researcher', 'Market researcher', 'Teardown']);
  assert.equal(await desk.locator('[data-give-work]').count(), 3, 'Only the research agents take work from here.');
  await desk.locator('[data-give-work="teardown"]').click();
  await desk.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await desk.locator('[data-preset="game-teardown"]').getAttribute('aria-pressed'), 'true', 'Give work opens Spawn on the preset of that agent.');
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  assert.equal(await desk.locator('[data-hub-group="operate"] [data-hub-link="team"]').count(), 1, 'Team is in Operate.');
  assert.equal(await desk.locator('[data-hub-link="team"]').getAttribute('aria-current'), 'page', 'Team is the current row in the sidebar.');
  assert.match(await desk.locator('[data-team-online]').innerText(), /^\d\/6$/);
  assert.equal(await desk.locator('[data-agent="hermes"] .team-facts').innerText().then(t => t.replace(/\s+/g, ' ')), 'Model Codex gpt-6-sol · Sonnet, then DeepSeek fallback Runs as Hermes profile main');
  assert.match(await desk.locator('[data-agent="briefs"] .team-facts').innerText(), /Haiku 5\.5 · DeepSeek fallback/);
  assert.equal(await desk.locator('[data-agent="claude"]').getAttribute('data-status'), 'working', 'The fixture PC has a busy session.');
  assert.equal(await desk.locator('[data-team-working]').innerText(), '1');
  assert.ok(await desk.locator('[data-agent="claude"] .team-sessions li').count() >= 2, 'Claude Code lists its sessions.');
  assert.match(await desk.locator('[data-agent="claude"] .team-sessions').innerText(), /Wall-jump tutorial/);
  await noSideways(desk, 'Team at 1280');

  step('the sheet opens with the focus inside, shows the current sprite first, and Escape gives the focus back');
  const hermesButton = desk.locator('[data-sprite-open="hermes"]');
  await hermesButton.click();
  const sheet = desk.locator('dialog[data-sprite-sheet="hermes"]');
  await sheet.waitFor();
  assert.equal(await sheet.evaluate(node => node.contains(document.activeElement)), true, 'The focus moved into the sheet.');
  assert.equal(await sheet.locator('.sheet-tile').first().getAttribute('data-sprite-tile'), 'hermes', 'The current sprite comes first.');
  assert.equal(await sheet.locator('[data-sheet-note]').innerText(), 'This is the current sprite');
  assert.equal(await sheet.locator('[data-sheet-use]').isDisabled(), true, 'Nothing to use while the current sprite is selected.');
  const box = await sheet.boundingBox();
  assert.ok(box.x > 0 && box.x + box.width < 1280, 'A dialog in the middle on desktop.');
  await desk.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  await desk.waitForFunction(() => document.activeElement?.getAttribute('data-sprite-open') === 'hermes');

  step('the Custom segment is one disabled line');
  await hermesButton.click();
  await sheet.waitFor();
  await sheet.locator('[data-sheet-mode="custom"]').click();
  assert.equal(await sheet.locator('[data-sheet-custom]').innerText(), 'Custom sprites arrive with the Agent avatar preset.');
  assert.equal(await sheet.locator('[data-sheet-use]').count(), 0, 'No Use this on the Custom segment.');
  await sheet.locator('[data-sheet-mode="quick"]').click();

  step('pick developer, Use this: toast, then the card shows it after a reload');
  await sheet.locator('[data-sprite-tile="developer"]').click();
  assert.equal(await sheet.locator('[data-sprite-tile="developer"]').getAttribute('aria-checked'), 'true');
  assert.equal(await sheet.locator('[data-sheet-note]').innerText(), 'Built in. Use this applies it now, no job.');
  await sheet.locator('[data-sheet-use]').click();
  await sheet.waitFor({ state: 'detached' });
  await desk.locator('[data-team-toast]', { hasText: 'Hermes has a new sprite. No job needed.' }).waitFor();
  const wanted = signatureOf(BUILTIN.developer);
  await desk.reload();
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await domSignature(cardSprite(desk, 'hermes')), wanted, 'The card shows the developer sprite after a reload.');

  step('Undo restores the previous sprite');
  await desk.locator('[data-sprite-open="briefs"]').click();
  const briefsSheet = desk.locator('dialog[data-sprite-sheet="briefs"]');
  await briefsSheet.waitFor();
  const before = await domSignature(cardSprite(desk, 'briefs'));
  await briefsSheet.locator('[data-sprite-tile="qa"]').click();
  await briefsSheet.locator('[data-sheet-use]').click();
  await desk.locator('[data-team-toast]').waitFor();
  await desk.waitForFunction(sel => document.querySelector(sel)?.innerHTML.length > 0, '[data-agent="briefs"] .team-tile svg');
  await desk.waitForFunction(({ sel, was }) => [...document.querySelector(sel).querySelectorAll('rect')].map(r => `${r.getAttribute('x')},${r.getAttribute('y')},${r.getAttribute('width')},${r.getAttribute('fill')}`).join('|') !== was, { sel: '[data-agent="briefs"] .team-tile svg', was: before });
  await desk.locator('[data-team-undo]').click();
  await desk.locator('[data-team-toast]', { hasText: 'old sprite back' }).waitFor();
  await desk.waitForFunction(({ sel, was }) => [...document.querySelector(sel).querySelectorAll('rect')].map(r => `${r.getAttribute('x')},${r.getAttribute('y')},${r.getAttribute('width')},${r.getAttribute('fill')}`).join('|') === was, { sel: '[data-agent="briefs"] .team-tile svg', was: before });
  await desk.reload();
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await domSignature(cardSprite(desk, 'briefs')), before, 'The restored sprite survives a reload.');

  step('Randomize twice gives two different sprites, the same as genSprite for those salts');
  await desk.locator('[data-sprite-open="claude"]').click();
  const claudeSheet = desk.locator('dialog[data-sprite-sheet="claude"]');
  await claudeSheet.waitFor();
  const preview = claudeSheet.locator('[data-sheet-preview] svg');
  const seen = [];
  for (const salt of [1, 2]) {
    await claudeSheet.locator('[data-sheet-randomize]').click();
    await claudeSheet.locator(`[data-sprite-tile="random-${salt}"]`).waitFor();
    seen.push(await domSignature(preview));
    assert.equal(seen.at(-1), signatureOf(genSprite('Claude Code', salt)), `Salt ${salt} draws what genSprite draws.`);
    assert.equal(await claudeSheet.locator('[data-sheet-note]').innerText(), `Randomized from the name: ${genSprite('Claude Code', salt).label}`);
  }
  assert.notEqual(seen[0], seen[1], 'Two different sprites.');
  await claudeSheet.locator('[data-sheet-use]').click();
  await claudeSheet.waitFor({ state: 'detached' });
  await desk.reload();
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await domSignature(cardSprite(desk, 'claude')), seen[1], 'The randomized sprite is the card after a reload.');

  step('phone: Team is on the bar, every tab is 44 px high with its label whole, the sheet is a bottom sheet, nothing scrolls sideways');
  for (const width of [375, 390]) {
    const phone = await open({ width, height: 844 }, { hasTouch: true, isMobile: true });
    await phone.goto(`${fixture.url}#/~hub/team`);
    await phone.locator('.team-card').first().waitFor();
    assert.deepEqual(await phone.locator('nav.hub-tabs > .hub-tab').evaluateAll(list => list.map(item => item.getAttribute('data-hub-tab'))), ['today', 'needs', 'work', 'team', 'map', 'more']);
    assert.equal(await phone.locator('[data-hub-tab="team"]').getAttribute('aria-current'), 'page');
    const tabs = await phone.locator('nav.hub-tabs > .hub-tab').evaluateAll(list => list.map(item => {
      const label = item.querySelector('.hub-tab-label');
      const rect = item.getBoundingClientRect();
      return { key: item.getAttribute('data-hub-tab'), width: rect.width, height: rect.height, clipped: label.scrollWidth > label.clientWidth };
    }));
    for (const tab of tabs) {
      assert.ok(tab.height >= 44 && tab.width >= 44, `${tab.key} at ${width}: ${tab.width} x ${tab.height} is a 44 px target.`);
      assert.equal(tab.clipped, false, `${tab.key} at ${width}: the label is whole.`);
    }
    await noSideways(phone, `Team at ${width}`);
    await phone.locator('[data-sprite-open="hermes"]').tap();
    const sheetBox = await phone.locator('dialog.sprite-sheet').boundingBox();
    assert.ok(Math.abs(sheetBox.x) < 1 && Math.abs(sheetBox.width - width) < 1, `The sheet spans the screen at ${width}.`);
    assert.ok(Math.abs(sheetBox.y + sheetBox.height - 844) < 2, `The sheet sits at the bottom at ${width}.`);
    await noSideways(phone, `Sprite sheet at ${width}`);
    for (const target of await phone.locator('dialog.sprite-sheet button').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A button in the sheet is ${target} px high.`);
    await phone.keyboard.press('Escape');
  }

  step('a visitor who cannot write sees why there is no Sprite button');
  assert.equal(await desk.locator('[data-sprite-signin]').count(), 0, 'With write, no sign-in note.');
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(guestContext);
  await guestContext.route('**/api/capabilities', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), write: false } });
  });
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(15000);
  await guest.goto(`${fixture.url}#/~hub/team`);
  await guest.locator('.team-card').first().waitFor();
  assert.equal(await guest.locator('[data-sprite-open]').count(), 0, 'No Sprite button without write.');
  assert.equal(await guest.locator('[data-sprite-signin]').count(), 6, 'Each card says why.');
  assert.equal(await guest.locator('[data-sprite-signin]').first().innerText(), 'Sign in to change sprites');
  assert.equal(await guest.locator('[data-sprite-signin]').first().isVisible(), true);

  console.log('hub-team-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
