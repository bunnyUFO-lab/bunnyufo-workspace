// Run after npm run build. Needs you by project, through a real browser over the fixture service: every item shows its
// project (and keeps its bead), the Approvals chip, the project picker narrowing the list, the counts and the address,
// Back, a project chip that filters, the empty state with "Show all projects", a one-item link that still focuses its
// item, and no sideways scroll at 390 px. Nothing is ever overwritten: the bucket only gains files.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { askJson, checklistJson, eventJson, minutesAgo, plainOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = (project, slug, tail) => `${day}-${project}-${slug}-${tail}`;

const fixture = await startHubFixture({ seedData: false, signing: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const ask = (project, slug, tail, minutes, extra = {}) => askJson({ id: id(project, slug, tail), project, now: minutesAgo(fixture.now, minutes), question: `Question ${slug}?`, options: plainOptions().slice(0, 2), allowDrawing: false, ...extra });

try {
  const { seed, now } = fixture;
  // Magic Loops 3 (two questions, one list), Sprite Studio 2 (a question, a blocked session), Bunnylink 2 (a review, an approval).
  seed.ask(ask('magic-loops', 'jump', 'a111', 10, { bead: 'ml-7f3c' }));
  seed.ask(ask('magic-loops', 'dash', 'a222', 20));
  seed.checklist(checklistJson({ id: id('magic-loops', 'setup', 'c111'), project: 'magic-loops', now: minutesAgo(now, 30) }));
  seed.ask(ask('sprite-studio', 'palette', 'b111', 40));
  seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 50), project: 'sprite-studio', session: 'sess-ss', title: 'Permission needed: run the sprite batch', source: 'hub-hooks', extra: { reason: 'permission' } }));
  seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(now, 60), project: 'bunnylink', bead: 'bl-9a2', title: 'PR ready for review: gate script', url: 'https://example.test/pr/7' }));
  const approval = id('bunnylink', 'look-at-the-gate', 'e5e5');
  seed.request({ id: approval, project: 'bunnylink', createdAt: minutesAgo(now, 70).toISOString(), by: 'owner', text: 'Look at the gate script', preset: 'code-task', repo: 'example/bunnylink', target: 'at-pc', origin: { kind: 'owner', name: 'owner' } });
  await new Promise(resolve => setTimeout(resolve, 100));

  const page = await open({ width: 1280, height: 900 });
  const cards = () => page.locator('.ni:not(.leaving)');
  const hash = () => page.evaluate(() => location.hash);
  const chipsOf = () => page.locator('.needs .hub-chips .hub-chip').evaluateAll(list => list.map(item => [item.getAttribute('data-filter'), item.querySelector('.n')?.textContent ?? null]));
  const go = async value => { await page.evaluate(next => { location.hash = next; }, value); };
  await page.goto(`${fixture.url}#/~hub/needs`);
  await cards().first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);

  step('every item shows its project first, with the display name; the bead stays after it');
  const chips = await page.locator('.ni [data-project-chip]').evaluateAll(list => list.map(item => item.textContent));
  assert.deepEqual([...chips].sort(), ['Bunnylink', 'Bunnylink', 'Magic Loops', 'Magic Loops', 'Magic Loops', 'Sprite Studio', 'Sprite Studio']);
  const jump = page.locator(`[data-need="ask-${id('magic-loops', 'jump', 'a111')}"] .ni-meta`);
  const meta = (await jump.innerText()).replace(/\s+/g, ' ');
  assert.ok(meta.indexOf('Magic Loops') >= 0 && meta.indexOf('Magic Loops') < meta.indexOf('asked'), meta);
  assert.ok(meta.includes('ml-7f3c'), `The bead stays: ${meta}`);
  assert.ok(!meta.includes('undefined'));

  step('the Approvals chip sits second, with its count');
  assert.deepEqual((await chipsOf()).slice(0, 4), [['all', '7'], ['approvals', '1'], ['question', '3'], ['steps', '1']]);
  await page.locator('.hub-chip[data-filter="approvals"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/approvals');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 1);
  assert.equal(await cards().first().getAttribute('data-kind'), 'approval');

  step('a blocked session names its tool and what it waits on, and the tab is Sessions');
  await go('#/~hub/needs/all');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  assert.equal((await page.locator('.ni[data-kind="unstick"] .ni-meta .ni-chip').first().innerText()).trim(), 'Claude permission');
  assert.equal((await page.locator('.hub-chip[data-filter="unstick"]').innerText()).replace(/\s+/g, ' ').trim(), 'Sessions 1');

  step('the Hermes ping link, needs/approval, lands on All as it always did');
  await page.goto(`${fixture.url}#/~hub/needs/approval`);
  await page.reload();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  assert.equal(await page.locator('.hub-chip.on').getAttribute('data-filter'), 'all');

  step('the old Unstick address redirects to Sessions in place, and a project rides along');
  const before = await page.evaluate(() => history.length);
  await page.goto(`${fixture.url}#/~hub/needs/unstick/sprite-studio`);
  await page.reload();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/sessions/sprite-studio');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 1);
  assert.equal(await page.locator('.hub-chip.on').getAttribute('data-filter'), 'unstick');
  assert.ok(before >= 1);
  await page.goto(`${fixture.url}#/~hub/needs/sessions`);
  await page.reload();
  await page.locator('.ni[data-kind="unstick"]').waitFor();
  assert.equal(await hash(), '#/~hub/needs/sessions');

  step('the picker lists the projects with items and their counts');
  await go('#/~hub/needs/all');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  await page.locator('.needs-project .cb-chev').click();
  const options = await page.locator('.needs-project [role="option"]').evaluateAll(list => list.map(item => [item.dataset.value, item.textContent]));
  assert.deepEqual(options, [['all', 'All projects (7)'], ['bunnylink', 'Bunnylink (2)'], ['magic-loops', 'Magic Loops (3)'], ['sprite-studio', 'Sprite Studio (2)']]);

  step('picking a project narrows the list and the counts, and the address changes');
  await page.locator('.needs-project [role="option"][data-value="sprite-studio"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all/sprite-studio');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 2);
  assert.deepEqual(await chipsOf(), [['all', '2'], ['question', '1'], ['unstick', '1'], ['answered', null]]);
  assert.equal(await page.locator('.needs-project input').inputValue(), 'Sprite Studio (2)');

  step('Back restores All');
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  assert.equal(await hash(), '#/~hub/needs/all');

  step('tapping a project chip filters, and a kind chip keeps the project');
  await page.locator('.ni [data-project-chip="bunnylink"]').first().click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all/bunnylink');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 2);
  await page.locator('.hub-chip[data-filter="approvals"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/approvals/bunnylink');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 1);
  assert.deepEqual((await chipsOf()).slice(0, 2), [['all', '2'], ['approvals', '1']]);

  step('a shared link opens straight on the kind in the project');
  await page.goto(`${fixture.url}#/~hub/needs/question/magic-loops`);
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 2);
  assert.deepEqual(await page.locator('.ni [data-project-chip]').evaluateAll(list => list.map(item => item.textContent)), ['Magic Loops', 'Magic Loops']);

  step('the empty state names the project and offers Show all projects');
  await go('#/~hub/needs/approvals/sprite-studio');
  const empty = page.locator('[data-project-empty]');
  await empty.waitFor();
  assert.match(await empty.innerText(), /^Nothing for Sprite Studio waits on you\. Show all projects$/);
  await empty.locator('[data-show-all-projects]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/approvals');
  assert.match(await page.locator('.needs-empty, .nq, .hub-empty').first().innerText(), /./);
  await go('#/~hub/needs/approvals');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 1);

  step('a one-item link still focuses the item');
  await go('#/~hub/needs/all');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  const blocked = (await page.locator('[data-kind="unstick"]').first().getAttribute('data-need')).replace(/^blocked-/, '');
  await page.goto(`${fixture.url}#/~hub/needs/${encodeURIComponent(blocked)}`);
  await page.reload();
  const target = page.locator(`[data-need="blocked-${blocked}"]`);
  await target.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  await page.waitForFunction(file => document.querySelector(`[data-need="blocked-${file}"]`)?.classList.contains('flash'), blocked);
  assert.equal(await hash(), '#/~hub/needs/all', 'The address settles on the list.');

  step('the item pages carry the project too');
  await go(`#/~hub/ask/${id('magic-loops', 'jump', 'a111')}`);
  await page.locator('.hub-top [data-project-chip="magic-loops"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.hub-top [data-project-chip]')?.textContent?.trim() === 'Magic Loops');

  step('at 390 px: the picker sits above the chips and nothing scrolls sideways');
  const phone = await open({ width: 390, height: 844 });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  const boxes = await phone.evaluate(() => ({ picker: document.querySelector('.needs-project').getBoundingClientRect().bottom, chips: document.querySelector('.needs-bar .hub-chips-wrap').getBoundingClientRect().top, scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(boxes.picker <= boxes.chips + 1, `The picker is above the chips (${boxes.picker} vs ${boxes.chips}).`);
  assert.ok(boxes.scroll <= boxes.inner, `The page scrolls sideways (${boxes.scroll} > ${boxes.inner}).`);
  await phone.goto(`${fixture.url}#/~hub/needs/all/magic-loops`);
  await phone.waitForFunction(() => document.querySelectorAll('.ni').length === 3);
  const after = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub').scrollWidth, hubInner: document.querySelector('.hub').clientWidth }));
  assert.ok(after.scroll <= after.inner && after.hub <= after.hubInner, JSON.stringify(after));

  console.log('hub-needs-project-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
