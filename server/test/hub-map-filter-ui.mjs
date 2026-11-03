// Run after npm run build. The Roadmap's filter through a real browser: open work by default, the status presets and
// chips, the date choices, the choice kept across a reload, the reset, Fit on the filtered view, and the panel as a
// popover on a desktop and a sheet on a phone. Then the Roadmap's search (it looks through the filter) and the check mark
// on a done feature with no tasks.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const DAY = 86_400_000;
const fixture = await startHubFixture();
const ago = days => new Date(Date.now() - days * DAY).toISOString();
const ymd = days => { const date = new Date(Date.now() - days * DAY); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
// Milestone 1: a fresh, a month-old, a stale and a finished task. Milestone 2: only finished work.
const issues = [
  beadsIssue({ id: 'wa-m1', title: 'Open milestone', type: 'milestone', created: ago(300), updated: ago(1) }),
  beadsIssue({ id: 'wa-f1', title: 'The feature', type: 'epic', parent: 'wa-m1', created: ago(300), updated: ago(1) }),
  beadsIssue({ id: 'wa-new', title: 'Fresh task', status: 'in_progress', parent: 'wa-f1', created: ago(300), updated: ago(2), description: 'Bring the gizmo online.' }),
  beadsIssue({ id: 'wa-mid', title: 'Month-old task', parent: 'wa-f1', created: ago(300), updated: ago(20), description: 'The gizmo needs a power supply.' }),
  beadsIssue({ id: 'wa-old', title: 'Stale task', parent: 'wa-f1', created: ago(300), updated: ago(200) }),
  beadsIssue({ id: 'wa-done', title: 'Finished task', status: 'closed', parent: 'wa-f1', created: ago(300), updated: ago(1), closed: ago(1) }),
  beadsIssue({ id: 'wa-m2', title: 'Finished milestone', type: 'milestone', status: 'closed', blocks: ['wa-m1'], created: ago(300), updated: ago(5), closed: ago(5) }),
  beadsIssue({ id: 'wa-f2', title: 'Old feature', type: 'epic', status: 'closed', parent: 'wa-m2', created: ago(300), updated: ago(5), closed: ago(5) }),
  beadsIssue({ id: 'wa-done2', title: 'Old finished task', status: 'closed', parent: 'wa-f2', created: ago(300), updated: ago(5), closed: ago(5) }),
  // Milestone 3: a closed feature whose one task is closed too (the word "quokka" is only in its description), a closed feature with no tasks, and an open one with none.
  beadsIssue({ id: 'wa-m3', title: 'Archive', type: 'milestone', blocks: ['wa-m2'], created: ago(299), updated: ago(5) }),
  beadsIssue({ id: 'wa-f3', title: 'Archive feature', type: 'epic', status: 'closed', parent: 'wa-m3', created: ago(299), updated: ago(5), closed: ago(5) }),
  beadsIssue({ id: 'wa-rare', title: 'Old report task', status: 'closed', parent: 'wa-f3', created: ago(299), updated: ago(5), closed: ago(5), description: 'A quokka walked across the gizmo report.' }),
  beadsIssue({ id: 'wa-f4', title: 'Shipped empty feature', type: 'epic', status: 'closed', parent: 'wa-m3', created: ago(299), updated: ago(5), closed: ago(5) }),
  beadsIssue({ id: 'wa-f5', title: 'Planned empty feature', type: 'epic', parent: 'wa-m3', created: ago(299), updated: ago(5) }),
];
fixture.seed.beads('workspace-app', issues, { pushedAt: minutesAgo(fixture.now, 10).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/workspace-app' });

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const showMap = async page => {
  await page.goto(`${fixture.url}#/~hub/map/workspace-app`);
  await page.locator('.hub-map-box svg').waitFor();
  await page.waitForTimeout(400);
};
const expandAll = async page => { await page.getByRole('button', { name: 'Expand all' }).click(); await page.waitForTimeout(500); };
const tasks = page => page.locator('[data-kind="t"]').evaluateAll(list => list.map(node => node.getAttribute('data-node')).sort());
const chip = page => page.locator('[data-filter-chip] .hub-filter-chip-text').innerText();
const stored = page => page.evaluate(() => localStorage.getItem('hub-map-filter'));
const openPanel = async page => { await page.getByRole('button', { name: 'Filter', exact: true }).click(); await page.locator('#hub-map-filter').waitFor(); };
const closePanel = async page => { await page.locator('#hub-map-filter').getByRole('button', { name: 'Done', exact: true }).last().click(); await page.waitForTimeout(300); };
const within = async (page, days) => { await page.locator(`[data-within="${days}"]`).click(); await page.waitForTimeout(500); };
/** True when the node is drawn inside the map's box. */
const inside = (page, id) => page.evaluate(nodeId => {
  const box = document.querySelector('.hub-map-box').getBoundingClientRect();
  const rect = document.querySelector(`[data-node="${nodeId}"]`)?.getBoundingClientRect();
  return Boolean(rect && rect.width && rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1);
}, id);
const width = page => page.locator('.hub-map-box svg').evaluate(svg => Number(svg.getAttribute('width')));

try {
  const page = await open({ width: 1280, height: 800 });

  step('the default is Open: done tasks are hidden, the chip says Open, there is nothing to reset');
  await showMap(page);
  assert.equal(await chip(page), 'Open');
  assert.equal(await page.locator('.hub-filter-chip-x').count(), 0, 'no reset on the default');
  await expandAll(page);
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new', 'wa-old']);
  const openWidth = await width(page);
  const thin = page.locator('[data-node="wa-m2"]');
  assert.match(await thin.textContent(), /1 of 1 done/, 'a milestone with nothing left keeps its ring and says what it counts');
  assert.doesNotMatch(await thin.textContent(), /hidden/, 'and never reads hidden');
  assert.equal(await page.locator('[data-toggle="wa-m2"]').count(), 0, 'and has nothing to open');
  assert.match(await page.locator('[data-node="wa-m1"]').textContent(), /1 of 4 done/, 'the milestone counts what it holds, not what is shown');
  assert.equal(await stored(page), null, 'the default stores nothing');

  step('the panel: presets, status chips, a count, at most 600 px wide, Escape closes it');
  await openPanel(page);
  const panel = page.locator('#hub-map-filter');
  assert.ok((await panel.boundingBox()).width <= 600, 'a popover of at most 600 px');
  assert.equal(await panel.locator('[data-preset="open"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await panel.locator('[data-state-chip]').evaluateAll(list => list.map(item => [item.dataset.stateChip, item.getAttribute('aria-pressed')])),
    [['doing', 'true'], ['you', 'true'], ['next', 'true'], ['later', 'true'], ['done', 'false']]);
  assert.match(await panel.locator('[data-filter-count]').innerText(), /3 of 6 tasks shown/);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0, 'Escape closes the panel');

  step('All shows the done tasks; the choice is stored and survives a reload');
  await openPanel(page);
  await page.locator('[data-preset="all"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-done', 'wa-mid', 'wa-new', 'wa-old']);
  assert.equal(await chip(page), 'All');
  assert.ok(JSON.parse(await stored(page)).states.includes('done'));
  assert.ok(await width(page) > openWidth, 'the drawing is wider with the done tasks in it');
  assert.equal(await page.locator('[data-node="wa-m2"]').textContent().then(text => /hidden/.test(text)), false);
  await page.reload();
  await page.locator('.hub-map-box svg').waitFor();
  await page.waitForTimeout(400);
  assert.equal(await chip(page), 'All', 'the choice survived the reload');
  await expandAll(page);
  assert.deepEqual(await tasks(page), ['wa-done', 'wa-done2', 'wa-mid', 'wa-new', 'wa-old', 'wa-rare']);

  step('the reset (x) returns to Open and forgets the choice');
  await page.getByRole('button', { name: 'Reset the filter to Open' }).click();
  await page.waitForTimeout(500);
  assert.equal(await chip(page), 'Open');
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new', 'wa-old']);
  assert.equal(await stored(page), null);
  assert.equal(await page.locator('.hub-filter-chip-x').count(), 0);

  step('status chips: In progress only, then a custom pair; the last state cannot be switched off');
  await openPanel(page);
  await page.locator('[data-preset="doing"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-new']);
  assert.equal(await chip(page), 'In progress only');
  await page.locator('[data-state-chip="doing"]').click();
  assert.equal(await page.locator('[data-state-chip="doing"]').getAttribute('aria-pressed'), 'true', 'the only state stays on');
  await page.locator('[data-state-chip="done"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-done', 'wa-done2', 'wa-new', 'wa-rare']);
  assert.equal(await chip(page), 'In progress, Done');

  step('dates: 7, 30 and 90 days, and a custom from-to');
  await page.locator('[data-preset="open"]').click();
  await within(page, 30);
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new']);
  assert.equal(await chip(page), 'Open · 30 d');
  await within(page, 7);
  assert.deepEqual(await tasks(page), ['wa-new']);
  await within(page, 90);
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new']);
  await panel.locator('input[type="date"]').first().fill(ymd(25));
  await panel.locator('input[type="date"]').nth(1).fill(ymd(10));
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-mid'], 'only the task updated between the two days');
  assert.match(await chip(page), /^Open · .+ to .+$/);
  await within(page, 'any');
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new', 'wa-old']);
  assert.equal(await panel.locator('input[type="date"]').first().inputValue(), '', 'a preset clears the custom range');

  step('Fit fits the filtered items');
  await closePanel(page);
  await page.getByRole('button', { name: 'Fit the whole map' }).click();
  await page.waitForTimeout(700);
  const outside = await page.evaluate(() => {
    const box = document.querySelector('.hub-map-box').getBoundingClientRect();
    return [...document.querySelectorAll('.hub-map-box [data-node]')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
    }).map(node => node.dataset.node);
  });
  assert.deepEqual(outside, [], 'every drawn node is inside the box after Fit');
  assert.equal(await page.locator('[data-node="wa-done"]').count(), 0, 'and the done task is not drawn');

  step('Now works on the filtered view, and a bad stored value falls back to Open');
  await page.getByRole('button', { name: 'Go to now' }).click();
  await page.waitForTimeout(500);
  assert.ok(await page.locator('.hub-map-now').isVisible());
  await page.evaluate(() => localStorage.setItem('hub-map-filter', '{bad'));
  await page.reload();
  await page.locator('.hub-map-box svg').waitFor();
  assert.equal(await chip(page), 'Open');
  await page.evaluate(() => localStorage.setItem('hub-map-filter', JSON.stringify({ states: [], within: 5 })));
  await page.reload();
  await page.locator('.hub-map-box svg').waitFor();
  assert.equal(await chip(page), 'Open');

  step('a link to a task the filter hides still opens its panel, with a note; Show all draws the node');
  const deep = await open({ width: 1280, height: 800 });
  await deep.goto(`${fixture.url}#/~hub/map/workspace-app/wa-done`);
  await deep.locator('#hub-map-panel').waitFor();
  assert.match(await deep.locator('#hub-map-panel h3').innerText(), /Finished task/);
  assert.match(await deep.locator('[data-hidden-by-filter]').innerText(), /Hidden by your filter \(Open\)/);
  assert.equal(await deep.locator('[data-node="wa-done"]').count(), 0, 'the node is not drawn under Open');
  await deep.locator('[data-hidden-by-filter] button').click();
  await deep.waitForTimeout(600);
  assert.equal(await deep.locator('[data-hidden-by-filter]').count(), 0, 'the note is gone');
  assert.equal(await deep.locator('[data-node="wa-done"]').count(), 1, 'and the node is drawn');
  assert.equal(await chip(deep), 'All');
  // A milestone's panel reads the whole tree, not the filtered one.
  await deep.goto(`${fixture.url}#/~hub/map/workspace-app/wa-m1`);
  assert.match(await deep.locator('#hub-map-panel').innerText(), /Finished task/);

  step('a filter that matches nothing says so on the map, with a Reset');
  const none = await open({ width: 1280, height: 800 });
  await none.addInitScript(([from, to]) => { try { localStorage.setItem('hub-map-filter', JSON.stringify({ states: ['doing'], within: null, from, to })); } catch { /* none */ } }, [ymd(100), ymd(90)]);
  await showMap(none);
  assert.match(await none.locator('[data-no-match]').innerText(), /No tasks match this filter/);
  await none.locator('[data-no-match] button').click();
  await none.waitForTimeout(500);
  assert.equal(await none.locator('[data-no-match]').count(), 0);
  assert.equal(await chip(none), 'Open');
  // A range that ends before it starts is dropped on load: the map shows its tasks, not an empty one.
  const backwards = await open({ width: 1280, height: 800 });
  await backwards.addInitScript(([from, to]) => { try { localStorage.setItem('hub-map-filter', JSON.stringify({ states: ['doing', 'you', 'next', 'later'], within: null, from, to })); } catch { /* none */ } }, [ymd(1), ymd(30)]);
  await showMap(backwards);
  assert.equal(await chip(backwards), 'Open');
  assert.equal(await backwards.locator('[data-no-match]').count(), 0);

  step('search: a word only in a closed bead\'s description is found through the Open filter; its path opens, the rest dims');
  const find = await open({ width: 1280, height: 800 });
  await showMap(find);
  assert.equal(await chip(find), 'Open');
  assert.equal(await find.locator('[data-kind="t"]').count(), 0, 'nothing is open before the search');
  const field = find.locator('[data-map-search]');
  const count = find.locator('[data-map-count]');
  await field.fill('quokka');
  await find.locator('[data-node="wa-rare"]').waitFor();
  await find.waitForTimeout(400);
  assert.equal((await count.innerText()).trim(), '1 match');
  assert.equal(await find.locator('[data-node="wa-rare"] .hub-map-ring-current').count(), 1, 'the task wears the gold ring');
  assert.equal(await find.locator('[data-node="wa-rare"].hub-map-hit').count(), 1);
  for (const id of ['wa-m3', 'wa-f3', 'wa-rare']) assert.equal(await find.locator(`[data-node="${id}"].hub-map-dim`).count(), 0, `${id} is on the path`);
  for (const id of ['wa-m1', 'wa-m2', 'wa-f4']) assert.equal(await find.locator(`[data-node="${id}"].hub-map-dim`).count(), 1, `${id} is dimmed`);
  assert.equal(await find.locator('[data-kind="t"]').count(), 1, 'only the found task is drawn');
  assert.equal(await chip(find), 'Open', 'the filter itself is untouched');
  assert.equal(await find.evaluate(() => localStorage.getItem('hub-map-search')), 'quokka');
  assert.ok(await inside(find, 'wa-rare'), 'the task is in view');
  assert.equal(await find.locator('[data-map-step]').count(), 0, 'one match needs no step buttons');

  step('search: three matches, the arrow keys step with a wrap, Enter opens the panel');
  await field.fill('gizmo');
  await find.waitForFunction(() => /3 matches/.test(document.querySelector('[data-map-count]').textContent));
  assert.match(await count.innerText(), /3 matches · ↑ ↓ to step/);
  await find.waitForTimeout(400);
  const current = () => find.locator('.hub-map-ring-current').evaluate(ring => ring.parentElement.getAttribute('data-node'));
  const first = await current();
  assert.ok(await inside(find, first), 'the first match is in view');
  assert.equal(await find.locator('.hub-map-hit').count(), 3);
  await field.press('ArrowDown');
  await find.waitForTimeout(300);
  assert.match(await count.innerText(), /^2 of 3 · /);
  const second = await current();
  assert.notEqual(second, first);
  assert.ok(await inside(find, second), 'the second match is in view');
  await field.press('ArrowDown');
  await field.press('ArrowDown');
  assert.match(await count.innerText(), /^1 of 3 · /, 'it wraps');
  assert.equal(await current(), first);
  await field.press('ArrowUp');
  assert.match(await count.innerText(), /^3 of 3 · /, 'and wraps backwards');
  await field.press('ArrowDown');
  await field.press('Enter');
  await find.locator('#hub-map-panel').waitFor();
  assert.ok((await find.evaluate(() => location.hash)).endsWith(`/${first}`), 'Enter opens the current match');
  assert.equal(await find.locator('[data-map-step]').count(), 2, 'step buttons show for several matches');

  step('search: a bead id finds it; a word in a milestone title lights it without opening its tasks');
  await find.goto(`${fixture.url}#/~hub/map/workspace-app`);
  await find.locator('.hub-map-box svg').waitFor();
  await field.fill('wa-old');
  await find.locator('[data-node="wa-old"]').waitFor();
  assert.equal((await count.innerText()).trim(), '1 match');
  await find.getByRole('button', { name: 'Clear search' }).click();
  await find.waitForTimeout(400);
  await field.fill('milestone');
  await find.waitForFunction(() => /2 matches/.test(document.querySelector('[data-map-count]').textContent));
  assert.equal(await find.locator('[data-node="wa-m1"].hub-map-hit').count(), 1);
  assert.equal(await find.locator('[data-node="wa-m2"].hub-map-hit').count(), 1);
  assert.equal(await find.locator('[data-kind="t"]').count(), 0, 'no task opened');
  assert.match(await find.locator('[data-node="wa-m1"] tspan.hub-map-hit-text').first().textContent(), /milestone/i, 'the word is marked in the title');

  step('search: no matches says so with a Clear link; Escape clears; Clear gives back what was open');
  await field.fill('zzzz');
  await find.waitForFunction(() => /No matches/.test(document.querySelector('[data-map-count]').textContent));
  assert.equal(await find.locator('.hub-map-dim').count(), 0, 'nothing dims without matches');
  await find.locator('[data-map-clear]').click();
  assert.equal(await field.inputValue(), '');
  await field.fill('milestone');
  await field.press('Escape');
  assert.equal(await field.inputValue(), '', 'Escape clears the query');
  await expandAll(find);
  const expanded = await tasks(find);
  await find.getByRole('button', { name: 'Collapse' }).click();
  await find.waitForTimeout(400);
  await field.fill('gizmo');
  await find.waitForFunction(() => /3 matches/.test(document.querySelector('[data-map-count]').textContent));
  assert.ok((await tasks(find)).length >= 2, 'the matches opened');
  await find.getByRole('button', { name: 'Clear search' }).click();
  await find.waitForTimeout(500);
  assert.equal(await find.locator('.hub-map-dim').count(), 0, 'the dimming is gone');
  assert.equal(await find.locator('[data-kind="t"]').count(), 0, 'and what was open before the search is open again');
  assert.equal(await find.evaluate(() => localStorage.getItem('hub-map-search')), null, 'the stored query is gone');
  assert.ok(expanded.length > 0);

  step('search: the query is remembered across a reload; a refresh does not move the view');
  await field.fill('gizmo');
  await find.waitForFunction(() => /3 matches/.test(document.querySelector('[data-map-count]').textContent));
  await find.reload();
  await find.locator('.hub-map-box svg').waitFor();
  await find.waitForFunction(() => /3 matches/.test(document.querySelector('[data-map-count]').textContent));
  assert.equal(await find.locator('[data-map-search]').inputValue(), 'gizmo');
  assert.equal(await find.locator('.hub-map-hit').count(), 3, 'the matches are lit again');
  await find.waitForTimeout(500);
  const placed = await find.locator('.hub-map-stage').evaluate(stage => stage.style.transform);
  const drawn = await find.locator('[data-node]').count();
  await find.evaluate(() => window.dispatchEvent(new Event('buw:hub-wrote')));
  await find.waitForTimeout(900);
  assert.equal(await find.locator('.hub-map-stage').evaluate(stage => stage.style.transform), placed, 'a refresh leaves the view where it was');
  assert.equal(await find.locator('[data-node]').count(), drawn);
  assert.match(await find.locator('[data-map-count]').innerText(), /3 matches/);

  step('a closed feature with no tasks shows a check mark and says done; an open one still shows 0');
  const marks = await open({ width: 1280, height: 800 });
  await showMap(marks);
  await expandAll(marks);
  const shipped = marks.locator('[data-node="wa-f4"]');
  assert.equal((await shipped.locator('text.hub-map-count').textContent()).trim(), '✓');
  assert.match(await shipped.getAttribute('aria-label'), /, done$/);
  const planned = marks.locator('[data-node="wa-f5"]');
  assert.equal((await planned.locator('text.hub-map-count').textContent()).trim(), '0');
  assert.match(await planned.getAttribute('aria-label'), /no tasks yet$/);

  step('storage that throws: the map loads on Open and the filter still works');
  const broken = await open({ width: 1280, height: 800 });
  await broken.addInitScript(() => {
    // Every access to the Roadmap's own keys throws, as in a blocked-storage browser; the rest of the app keeps its storage.
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      const real = Storage.prototype[method];
      Storage.prototype[method] = function guarded(key, ...rest) { if (String(key).startsWith('hub-map')) throw new DOMException('blocked', 'SecurityError'); return real.call(this, key, ...rest); };
    }
  });
  await showMap(broken);
  assert.equal(await chip(broken), 'Open');
  await openPanel(broken);
  await broken.locator('[data-preset="all"]').click();
  await broken.waitForTimeout(400);
  assert.equal(await chip(broken), 'All', 'the choice applies for this visit');

  step('a phone: the panel is a sheet along the bottom, nothing scrolls sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await showMap(phone);
  assert.equal(await chip(phone), 'Open');
  await phone.getByRole('button', { name: 'Filter', exact: true }).tap();
  const sheet = phone.locator('#hub-map-filter');
  await sheet.waitFor();
  const rect = await sheet.boundingBox();
  const wrap = await phone.locator('.hub-map-wrap').boundingBox();
  assert.ok(Math.abs(rect.x - wrap.x) <= 1 && Math.abs(rect.width - wrap.width) <= 1, `the sheet spans the map's width (${rect.x}, ${rect.width})`);
  assert.ok(rect.width >= 360, 'nearly the whole phone');
  assert.ok(Math.abs(rect.y + rect.height - (wrap.y + wrap.height)) <= 2, 'and sits on the bottom edge of the map');
  const widths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, 'no sideways scroll');
  await phone.locator('[data-preset="all"]').tap();
  await phone.waitForTimeout(400);
  assert.equal(await chip(phone), 'All');

  step('a phone: the search field is full width, the step buttons are 44 px and step, nothing scrolls sideways');
  const searchPhone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await showMap(searchPhone);
  await searchPhone.locator('[data-map-search]').fill('gizmo');
  await searchPhone.waitForFunction(() => /3 matches/.test(document.querySelector('[data-map-count]').textContent));
  const fieldBox = await searchPhone.locator('.hub-map-search .sf').boundingBox();
  const wrapBox = await searchPhone.locator('.hub-map-wrap').boundingBox();
  assert.ok(fieldBox.width >= wrapBox.width - 4, `the field spans the width (${fieldBox.width} of ${wrapBox.width})`);
  for (const which of ['prev', 'next']) {
    const button = await searchPhone.locator(`[data-map-step="${which}"]`).boundingBox();
    assert.ok(button.width >= 44 && button.height >= 44, `the ${which} button is at least 44 px (${button.width} by ${button.height})`);
  }
  await searchPhone.locator('[data-map-step="next"]').tap();
  await searchPhone.waitForTimeout(300);
  assert.match(await searchPhone.locator('[data-map-count]').innerText(), /^2 of 3 · /);
  const stepped = await searchPhone.locator('.hub-map-ring-current').evaluate(ring => ring.parentElement.getAttribute('data-node'));
  assert.ok(await inside(searchPhone, stepped), 'the stepped-to match is in view');
  const searchWidths = await searchPhone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(searchWidths.scroll <= searchWidths.inner, 'no sideways scroll');

  console.log('hub-map-filter-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
