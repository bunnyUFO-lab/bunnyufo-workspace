// Run after npm run build. The type and sub-type badges of Needs you, through a real browser over the fixture service:
// every type has its badge with a word, Asks of all four kinds and lists of all four kinds show their sub-type, a guess
// is marked, the sub-type chip row narrows the list (and composes with the project filter), the item pages carry the
// badges, the colours meet the contrast rule in the light and the dark theme, and 390 px does not scroll sideways.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { TITLES, seedMixed } from './needs-kinds-seed.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ seedData: false, signing: true, hermes: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};

try {
  const ids = seedMixed(fixture);
  await new Promise(resolve => setTimeout(resolve, 100));
  const page = await open({ width: 1280, height: 900 });
  const cards = () => page.locator('.ni:not(.leaving)');
  const go = async value => { await page.evaluate(next => { location.hash = next; }, value); };
  const row = title => page.locator('.ni', { has: page.locator('.ni-t', { hasText: title }) });
  // The list settles after the address does: wait for the titles, then assert them.
  const titlesAre = async expected => {
    await page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('.ni:not(.leaving) .ni-t')].map(node => node.textContent)) === want, JSON.stringify(expected));
  };
  const text = async locator => (await locator.innerText()).replace(/\s+/g, ' ').trim();
  await page.goto(`${fixture.url}#/~hub/needs`);
  await cards().first().waitFor();
  const total = 17;
  await page.waitForFunction(count => document.querySelectorAll('.ni').length === count, total);

  step('every type has its badge with a word and an icon');
  const types = [
    [TITLES.request, 'approval-request', 'Approval request'],
    [TITLES.hermesAsks, 'hermes-asks', 'Hermes asks'],
    [TITLES.askVerify, 'question', 'Question'],
    [TITLES.designReview, 'design', 'Design review'],
    [TITLES.stepsVerify, 'steps', 'Steps'],
    [TITLES.playtest, 'playtest', 'Playtest'],
    [TITLES.review, 'pr', 'Review'],
    [TITLES.blocked, 'unstick', 'Claude permission'],
  ];
  for (const [title, type, label] of types) {
    const badge = row(title).locator('[data-badge="type"]');
    assert.equal(await badge.getAttribute('data-type'), type, title);
    assert.equal((await badge.innerText()).trim(), label, title);
    assert.ok(await badge.locator('svg').count() === 1, `${title}: an icon`);
  }

  step('a request approval is its own type, never a Question with the kind Approval');
  assert.equal(await row(TITLES.request).locator('[data-badge="sub"]').count(), 0);
  assert.equal(await row(TITLES.askApproval).locator('[data-badge="type"]').getAttribute('data-type'), 'question');
  assert.equal((await row(TITLES.askApproval).locator('[data-badge="sub"]').innerText()).trim(), 'Approval');

  step('Asks of all four kinds show their sub-type; a guess is marked and says so');
  const asks = [[TITLES.askApproval, 'approval', 'Approval'], [TITLES.askVerify, 'verify', 'Verify'], [TITLES.askDesign, 'design', 'Design choice'], [TITLES.askDecision, 'decision', 'Decision']];
  for (const [title, sub, label] of asks) {
    const badge = row(title).locator('[data-badge="sub"]');
    assert.equal(await badge.getAttribute('data-sub'), sub, title);
    assert.equal((await badge.innerText()).trim(), label, title);
    assert.equal(await badge.getAttribute('data-inferred'), null, `${title}: the sender said so`);
  }
  const guessed = row(TITLES.askGuessed).locator('[data-badge="sub"]');
  assert.equal(await guessed.getAttribute('data-sub'), 'verify');
  assert.notEqual(await guessed.getAttribute('data-inferred'), null);
  assert.match(await guessed.getAttribute('title'), /Guessed/);
  assert.equal(await row(TITLES.askPasskey).locator('[data-badge="sub"]').getAttribute('data-sub'), 'approval', 'A passkey Ask reads as an approval');

  step('lists of all four kinds show their sub-type; a playtest has none');
  const lists = [[TITLES.stepsVerify, 'verify', 'Verify'], [TITLES.stepsSetup, 'setup', 'Set up'], [TITLES.stepsInvestigate, 'investigate', 'Investigate'], [TITLES.stepsDevelop, 'develop', 'Develop']];
  for (const [title, sub, label] of lists) {
    const badge = row(title).locator('[data-badge="sub"]');
    assert.equal(await badge.getAttribute('data-sub'), sub, title);
    assert.equal((await badge.innerText()).trim(), label, title);
    assert.equal(await badge.getAttribute('data-group'), 'steps');
  }
  assert.equal(await row(TITLES.stepsGuessed).locator('[data-badge="sub"]').getAttribute('data-sub'), 'setup');
  assert.equal(await row(TITLES.playtest).locator('[data-badge="sub"]').count(), 0);
  assert.equal(await row(TITLES.review).locator('[data-badge="sub"]').count(), 0);

  step('the first chip of a card is still its type');
  assert.equal((await row(TITLES.blocked).locator('.ni-meta .ni-chip').first().innerText()).trim(), 'Claude permission');

  step('the Question chip has a second row of sub-type chips with counts; Steps has its own');
  await page.locator('.hub-chip[data-filter="question"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/question');
  const subs = () => page.locator('.needs-subs .hub-chip').evaluateAll(list => list.map(item => [item.getAttribute('data-sub-filter'), item.querySelector('.n')?.textContent ?? null]));
  await page.locator('.needs-subs .n').first().waitFor();
  assert.deepEqual(await subs(), [['all', '7'], ['approval', '2'], ['verify', '2'], ['design', '1'], ['decision', '1']]);
  assert.equal(await page.locator('.needs-subs .hub-chip.is-on').getAttribute('data-sub-filter'), 'all');
  assert.equal(await page.locator('.hub-chip.on').count(), 1, 'One `.on` chip: the kind.');

  step('a sub-type chip narrows the list, and the address is question:verify');
  await page.locator('.needs-subs [data-sub-filter="verify"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/question:verify');
  await titlesAre([TITLES.askVerify, TITLES.askGuessed]);
  assert.equal(await page.locator('.hub-chip[data-filter="question"]').getAttribute('aria-current'), 'true', 'The Question chip stays on.');
  assert.equal(await page.locator('.needs-subs [data-sub-filter="verify"]').getAttribute('aria-current'), 'true');
  assert.equal((await subs()).find(([name]) => name === 'verify')[1], '2');

  step('it composes with the project filter, both ways');
  await page.locator('.ni [data-project-chip="magic-loops"]').first().click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/question:verify/magic-loops');
  await titlesAre([TITLES.askVerify]);
  assert.deepEqual((await subs()).map(([name]) => name), ['all', 'approval', 'verify', 'design', 'decision']);
  await page.locator('.needs-subs [data-sub-filter="decision"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/question:decision/magic-loops');
  await titlesAre([TITLES.askDecision]);
  await go('#/~hub/needs/question:design/magic-loops');
  await page.locator('[data-project-empty]').waitFor();
  assert.match(await text(page.locator('[data-project-empty]')), /Nothing for Magic Loops waits on you/);

  step('a shared link opens straight on a sub-type; steps filter too; an unknown sub-type falls back');
  await page.goto(`${fixture.url}#/~hub/needs/steps:investigate`);
  await titlesAre([TITLES.stepsInvestigate]);
  assert.equal(await page.locator('.hub-chip[data-filter="steps"]').getAttribute('aria-current'), 'true');
  assert.deepEqual((await subs()).map(([name]) => name), ['all', 'verify', 'setup', 'investigate', 'develop']);
  await page.goto(`${fixture.url}#/~hub/needs/steps:design`);
  await page.reload();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all');
  assert.equal(await page.locator('.needs-subs').count(), 0, 'The other chips have no sub-type row.');

  step('the item pages carry the badges');
  await go(`#/~hub/ask/${ids.askVerify}`);
  const askPage = page.locator('[data-page-badges]');
  await askPage.waitFor();
  assert.deepEqual(await askPage.locator('.nb').allInnerTexts(), ['Question', 'Verify']);
  await go(`#/~hub/checklist/${ids.stepsSetup}`);
  await page.waitForFunction(() => document.querySelector('[data-page-badges] [data-badge="sub"]')?.textContent === 'Set up');
  assert.equal((await page.locator('[data-page-badges] [data-badge="type"]').innerText()).trim(), 'Steps');
  await go(`#/~hub/checklist/${ids.playtest}`);
  await page.waitForFunction(() => document.querySelector('[data-page-badges] [data-badge="type"]')?.textContent?.trim() === 'Playtest');
  assert.equal(await page.locator('[data-page-badges] [data-badge="sub"]').count(), 0);

  step('the badge colours meet 4.5:1 as the browser draws them, in the dark theme and the light one');
  const contrastOf = () => page.evaluate(() => {
    const parse = value => { const found = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value); return found ? [1, 2, 3].map(at => Number(found[at])) : null; };
    const lum = rgb => { const [r, g, b] = rgb.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const backdrop = node => { for (let at = node; at; at = at.parentElement) { const rgb = parse(getComputedStyle(at).backgroundColor); if (rgb && !/rgba\(.*,\s*0\)/.test(getComputedStyle(at).backgroundColor)) return rgb; } return [255, 255, 255]; };
    return [...document.querySelectorAll('.ni [data-badge]')].map(node => {
      const style = getComputedStyle(node);
      const fg = parse(style.color);
      const filled = node.dataset.badge === 'type';
      const bg = filled ? parse(style.backgroundColor) : backdrop(node.parentElement);
      return { label: node.textContent.trim(), kind: node.dataset.badge, ratio: ratio(fg, bg) };
    });
  });
  await go('#/~hub/needs/all');
  await page.waitForFunction(count => document.querySelectorAll('.ni').length === count, total);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(name => { if (name === 'light') document.documentElement.setAttribute('data-workspace-theme', 'light'); else document.documentElement.removeAttribute('data-workspace-theme'); }, theme);
    const results = await contrastOf();
    assert.ok(results.length >= 25, `${theme}: ${results.length} badges measured`);
    for (const result of results) assert.ok(result.ratio >= 4.5, `${theme} ${result.kind} "${result.label}": ${result.ratio.toFixed(2)}`);
  }
  await page.evaluate(() => document.documentElement.removeAttribute('data-workspace-theme'));

  step('at 390 px: the badges wrap, nothing scrolls sideways, in the list, a filter and an item page');
  const phone = await open({ width: 390, height: 844 });
  const sideways = () => phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.waitForFunction(count => document.querySelectorAll('.ni').length === count, total);
  let box = await sideways();
  assert.ok(box.scroll <= box.inner && box.hub <= box.hubInner, JSON.stringify(box));
  await phone.goto(`${fixture.url}#/~hub/needs/question:approval`);
  await phone.locator('.needs-subs').waitFor();
  await phone.waitForFunction(() => document.querySelectorAll('.ni').length === 2);
  box = await sideways();
  assert.ok(box.scroll <= box.inner && box.hub <= box.hubInner, JSON.stringify(box));
  const chipBox = await phone.locator('.needs-subs').evaluate(node => { const rect = node.getBoundingClientRect(); return { right: rect.right, width: innerWidth }; });
  assert.ok(chipBox.right <= chipBox.width, 'The sub-type row stays inside the screen.');
  await phone.goto(`${fixture.url}#/~hub/ask/${ids.askApproval}`);
  await phone.locator('[data-page-badges]').waitFor();
  box = await sideways();
  assert.ok(box.scroll <= box.inner && box.hub <= box.hubInner, JSON.stringify(box));

  console.log('hub-needs-kinds-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
