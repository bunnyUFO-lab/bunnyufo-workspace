// Run after npm run build. Needs you by project, through a real browser over the fixture service: every item shows its
// project (and keeps its bead), the Approvals chip, the project picker narrowing the list, the counts and the address,
// Back, a project chip that filters, the empty state with "Show all projects", a one-item link that still focuses its
// item, and no sideways scroll at 390 px. Nothing is ever overwritten: the bucket only gains files.
// It also covers the ProjectPage (#/~hub/project/<id>[/<tab>]): header, the three buttons, the four tabs, the links into it, and 390 px.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { askJson, beadsIssue, checklistJson, eventJson, minutesAgo, plainOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = (project, slug, tail) => `${day}-${project}-${slug}-${tail}`;

const fixture = await startHubFixture({ seedData: false, signing: true, hermes: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
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
  // The project page: Magic Loops has a finished milestone and an open one (two done, one doing, one next); Sprite Studio only a finished one;
  // Discord bots and Bunnylink have an open one but no PC runs. Magic Loops alone has a Library section.
  const stamp = { created: '2026-10-01T10:00:00Z' };
  const closedTask = (taskId, title, parent) => beadsIssue({ id: taskId, title, parent, status: 'closed', closed: '2026-10-05T10:00:00Z', ...stamp });
  const copy = (project, issues) => seed.beads(project, issues, { pushedAt: minutesAgo(now, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: `example/${project}` });
  copy('magic-loops', [
    beadsIssue({ id: 'ml-m0', title: 'Prototype', type: 'milestone', status: 'closed', closed: '2026-10-03T10:00:00Z', ...stamp }),
    closedTask('ml-t0', 'Throw the prototype together', 'ml-m0'),
    beadsIssue({ id: 'ml-m1', title: 'Core loop', type: 'milestone', ...stamp }),
    beadsIssue({ id: 'ml-f1', title: 'Movement', type: 'epic', parent: 'ml-m1', labels: ['sprint:sprint-5'], ...stamp }),
    { ...closedTask('ml-t1', 'Run', 'ml-f1'), labels: ['sprint:sprint-4'] }, { ...closedTask('ml-t2', 'Jump', 'ml-f1'), labels: ['sprint:sprint-5'] },
    beadsIssue({ id: 'ml-t3', title: 'Wall-jump', parent: 'ml-f1', status: 'in_progress', labels: ['sprint:sprint-5'], ...stamp }),
    beadsIssue({ id: 'ml-t4', title: 'Dash', parent: 'ml-f1', labels: ['sprint:sprint-5'], ...stamp }),
  ]);
  copy('sprite-studio', [beadsIssue({ id: 'ss-m1', title: 'Editor', type: 'milestone', status: 'closed', closed: '2026-10-03T10:00:00Z', ...stamp }), closedTask('ss-t1', 'Draw', 'ss-m1')]);
  for (const [project, prefix] of [['shadowdark', 'sd'], ['bunnylink', 'bl']]) copy(project, [beadsIssue({ id: `${prefix}-m1`, title: 'First milestone', type: 'milestone', ...stamp }), beadsIssue({ id: `${prefix}-t1`, title: 'Open task', parent: `${prefix}-m1`, ...stamp })]);
  // A project with roadmaps: the Roadmap tab lists them (ws-im1.3.2).
  copy('roadmapped', [
    beadsIssue({ id: 'rd-r1', title: 'Hub work', type: 'epic', labels: ['roadmap'], ...stamp }),
    beadsIssue({ id: 'rd-f1', title: 'First ring', type: 'feature', parent: 'rd-r1', ...stamp }),
    closedTask('rd-t1', 'Done thing', 'rd-f1'),
    beadsIssue({ id: 'rd-t2', title: 'Open thing', parent: 'rd-f1', labels: ['sprint:sprint-6'], ...stamp }),
    beadsIssue({ id: 'rd-r2', title: 'Editing', type: 'epic', parent: 'rd-r1', labels: ['roadmap'], ...stamp }),
    beadsIssue({ id: 'rd-t3', title: 'Loose thing', parent: 'rd-r2', ...stamp }),
    beadsIssue({ id: 'rd-r3', title: 'Shipped', type: 'epic', labels: ['roadmap'], status: 'closed', closed: '2026-10-06T10:00:00Z', ...stamp }),
    beadsIssue({ id: 'rd-f3', title: 'Shipped ring', type: 'feature', parent: 'rd-r3', status: 'closed', closed: '2026-10-06T10:00:00Z', ...stamp }),
    closedTask('rd-t4', 'Shipped thing', 'rd-f3'),
  ]);
  fixture.fake.seed('sections/magic-loops/workspace.json', JSON.stringify({ name: 'Magic Loops', entities: [{ id: 'jump-notes', title: 'Jump notes', folder: 'jump-notes', updated: '2026-10-20' }, { id: 'dash-report', title: 'Dash report', folder: 'dash-report', updated: '2026-10-28' }] }), 'application/json');
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
  // The display names come from a second fetch (the project list); until it lands each chip shows the project's id.
  await page.waitForFunction(() => { const list = [...document.querySelectorAll('.ni [data-project-chip]')]; return list.length === 7 && list.every(item => /^[A-Z]/.test(item.textContent ?? '')); });
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

  step('picking All restores All: a project pick is state on the screen and added no step to Back');
  await page.locator('.needs-project input').click();
  await page.locator('.needs-project [role="option"][data-value="all"]').click();
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
  await page.waitForFunction(() => [...document.querySelectorAll('.ni [data-project-chip]')].every(item => /^[A-Z]/.test(item.textContent ?? '')));
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

  step('at 390 px: the picker sits above the filter select and nothing scrolls sideways');
  const phone = await open({ width: 390, height: 844 });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  const boxes = await phone.evaluate(() => ({ picker: document.querySelector('.needs-project').getBoundingClientRect().bottom, chips: document.querySelector('.needs-bar .needs-filter-select').getBoundingClientRect().top, scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(boxes.picker <= boxes.chips + 1, `The picker is above the chips (${boxes.picker} vs ${boxes.chips}).`);
  assert.ok(boxes.scroll <= boxes.inner, `The page scrolls sideways (${boxes.scroll} > ${boxes.inner}).`);
  await phone.goto(`${fixture.url}#/~hub/needs/all/magic-loops`);
  await phone.waitForFunction(() => document.querySelectorAll('.ni').length === 3);
  const after = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub').scrollWidth, hubInner: document.querySelector('.hub').clientWidth }));
  assert.ok(after.scroll <= after.inner && after.hub <= after.hubInner, JSON.stringify(after));

  // ---- The project page (ws-im1.3.1) ----
  const goPage = async (view, target) => { await view.goto(`${fixture.url}${target}`); await view.locator('[data-project-page]').waitFor(); };
  const actions = view => view.locator('[data-project-action]').evaluateAll(list => list.map(item => item.getAttribute('data-project-action')));
  // Controls shorter than 44 px: [text, height] pairs of the visible ones.
  const small = (view, selector) => view.locator(selector).evaluateAll(list => list.map(item => [item.textContent.trim().slice(0, 24), Math.round(item.getBoundingClientRect().height), item.getBoundingClientRect().width]).filter(([, height, width]) => width > 0 && height < 44));

  step('project page: name, Runs on chip, Plan and New job, Run sprint and three tabs; every control is 44 px');
  await goPage(page, '#/~hub/project/magic-loops');
  assert.equal((await page.locator('.pp-title').innerText()).trim(), 'Magic Loops');
  await page.locator('.hub-runs').waitFor();
  assert.deepEqual(await actions(page), ['plan', 'build', 'sprint']);
  await page.waitForFunction(() => document.querySelector('[data-project-tab="work"] small'));
  assert.deepEqual((await page.locator('[data-project-tab]').allInnerTexts()).map(text => text.replace(/\s+/g, '')), ['Roadmap', 'Work3', 'Cards']);
  assert.equal(await page.locator('[data-project-row="magic-loops"]').getAttribute('aria-current'), 'page', 'The Projects list beside it lights this project.');
  assert.deepEqual(await small(page, '[data-project-action], .pp-tabs a, .pp-switch button, .pp .hub-runs'), [], 'Every control is at least 44 px high.');
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('[data-project-note]').count(), 0, 'Magic Loops runs on the PC: no note.');
  assert.equal(await page.locator('[data-rail] [data-nav="project"]').getAttribute('aria-current'), 'page', 'Projects is lit on the rail.');
  assert.deepEqual((await page.locator('[data-rail] [data-nav]').evaluateAll(list => list.map(item => item.getAttribute('data-nav')))).filter(name => name === 'project' || name === 'chat'), ['chat', 'project'], 'Chat, then Projects, as in the mockup; the Roadmap has no entry of its own.');

  step('project page, Roadmap accordion: the current milestone open with the map counts; the finished one is a closed row; a task opens over the page, and Back returns; Map and List add no entry');
  const rows = page.locator('[data-pp-roadmap] [data-pp-milestone]');
  assert.equal(await rows.count(), 2, 'The open milestone, then the finished one.');
  const current = page.locator('[data-pp-milestone][data-open="true"]');
  assert.equal(await current.count(), 1);
  assert.match(await current.locator('[data-pp-count]').innerText(), /^Now · .*2 of 4 done/);
  assert.equal(await current.locator('.pp-ring text').innerHTML(), '2/4');
  assert.deepEqual(await current.locator('[data-pp-task]').evaluateAll(list => list.map(item => item.getAttribute('data-pp-task'))), ['ml-t3', 'ml-t4', 'ml-t1', 'ml-t2']);
  const finished = page.locator('[data-pp-milestone][data-open="false"]');
  assert.equal(await finished.count(), 1, 'The finished milestone is one closed line.');
  assert.equal(await finished.locator('[data-pp-task]').count(), 0, 'A closed row draws no tasks.');
  assert.equal(await page.locator('[data-pp-done-toggle], [data-pp-finished]').count(), 0, 'There is no Done fold any more.');
  await current.locator('[data-pp-task="ml-t3"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops/roadmap/ml-t3');
  await page.locator('.hub-map-panel').waitFor();
  await page.goBack();
  await page.locator('[data-project-page="magic-loops"] [data-pp-roadmap]').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/~hub/project/magic-loops');
  const depth = await page.evaluate(() => history.length);
  await page.locator('[data-roadmap-view="map"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/map/magic-loops');
  await page.locator('.hub-map-box svg').waitFor();
  await page.locator('[data-roadmap-view="list"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await page.locator('[data-pp-roadmap]').waitFor();
  assert.equal(await page.evaluate(() => history.length), depth, 'Map and List added no entry.');

  step('project page, Roadmap tab with roadmaps: nested folds instead of the flat list; a roadmap opens, offers its map, and the link opens that roadmap map; Back returns');
  await goPage(page, '#/~hub/project/roadmapped');
  await page.locator('[data-pp-roadmap] [data-roadmap-row]').first().waitFor();
  assert.deepEqual(await page.locator('[data-pp-roadmap] [data-roadmap-row]').evaluateAll(list => list.map(row => [row.dataset.roadmapRow, row.dataset.depth])), [['rd-r1', '0'], ['rd-r2', '1'], ['rd-r3', '0']]);
  assert.match(await page.locator('[data-roadmap-row="rd-r1"] > .ui-fold-h').innerText(), /next up · 1 of 3 done/);
  const head = page.locator('[data-roadmap-row="rd-r1"] > .ui-fold-h button');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await page.locator('[data-roadmap-map="rd-r1"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/map/roadmapped/rd-r1');
  await page.locator('.hub-map-box svg').waitFor();
  assert.equal(await page.locator('[data-roadmap-toggle="branch"]').getAttribute('aria-current'), 'page');
  await page.goBack();
  await page.locator('[data-pp-roadmap]').waitFor();
  await goPage(page, '#/~hub/project/magic-loops');

  step('project page: the Roadmap tab has no Running panel any more; what runs is on the Work tab');
  assert.equal(await page.locator('[aria-label="Working now"], [data-pp-side]').count(), 0);

  step('project page: a tab pushes history, the count matches Today, a row opens Needs you with the project chosen and the item flashed');
  await page.locator('[data-project-tab="work"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops/work');
  await page.locator('.pp .nrow').first().waitFor();
  assert.equal(await page.locator('.pp .nrow').count(), 3);
  await page.goBack();
  await page.locator('[data-pp-roadmap]').waitFor();
  await page.locator('[data-project-tab="work"]').click();
  await page.locator('.pp .nrow').first().waitFor();
  await page.locator('.pp .nrow').first().click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all/magic-loops');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 3 && document.querySelector('.ni.flash'));
  assert.equal(await page.evaluate(() => localStorage.getItem('hub-today-project')), null, 'A link does not change the choice.');
  await go('#/~hub/project/magic-loops/needs');
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops/work');
  assert.equal((await page.locator('[data-pp-all-needs]').innerText()).trim(), 'All in Needs you ›');
  await page.locator('[aria-label="Working now"]').waitFor();
  assert.equal(await page.locator('[aria-label="Working now"]').count(), 1);

  step('project page, Cards tab: the section\'s cards newest first; no section says so; a bad id says no such project');
  await page.locator('[data-project-tab="cards"]').click();
  await page.locator('[data-pp-cards]').waitFor();
  assert.deepEqual(await page.locator('[data-pp-card]').allInnerTexts(), ['Dash report', 'Jump notes']);
  assert.equal(await page.locator('[data-pp-card]').first().getAttribute('href'), '/magic-loops#/dash-report');
  assert.equal(await page.locator('[data-pp-open-section]').getAttribute('href'), '/magic-loops');
  await goPage(page, '#/~hub/project/sprite-studio/cards');
  await page.locator('[data-pp-no-library]').waitFor();
  assert.match((await page.locator('[data-pp-no-library]').innerText()).trim(), /^This project has no cards yet, because it has no Library section\./);
  assert.match(await page.locator('[data-pp-no-library] [data-pp-library-link]').getAttribute('href'), /#\/~hub\/library/, 'It says where to go next.');
  await goPage(page, '#/~hub/project/no-such-thing');
  assert.match((await page.locator('[data-project-missing]').innerText()).trim(), /^No project called no-such-thing\./);
  assert.equal(await page.locator('[data-project-action]').count(), 0);
  assert.ok(await page.locator('[data-project-row]').count() >= 3, 'The Projects list is there to pick one.');

  step('Projects: no id opens the first project beside the list; picking a row pushes history');
  await goPage(page, '#/~hub/project');
  assert.ok(await page.locator('[data-project-page]').getAttribute('data-project-page'), 'It shows a project.');
  await page.locator('[data-project-row="bunnylink"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/bunnylink');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#/~hub/project');

  step('project page, buttons: Build opens Spawn with the project and Code task; Plan opens Chat on the Planner with an unsent draft');
  await goPage(page, '#/~hub/project/magic-loops');
  await page.locator('[data-project-action="build"]').click();
  await page.locator('[data-spawn-sheet]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-spawn-project]')?.value === 'Magic Loops');
  assert.equal(await page.locator('[data-spawn-sheet] [data-preset="code-task"]').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  await page.locator('[data-project-action="plan"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/chat');
  assert.match(await page.locator('textarea[aria-label="Message"]').inputValue(), /\(project magic-loops\)/);

  step('project page, sprint: Magic Loops links to its first open milestone; Discord bots and Bunnylink are off with the server\'s sentence; nothing open is off with its note');
  await goPage(page, '#/~hub/project/magic-loops');
  const sprint = page.locator('a[data-project-action="sprint"]');
  await sprint.waitFor();
  assert.equal(await sprint.getAttribute('href'), '#/~hub/project/magic-loops/roadmap/ml-m1');
  assert.equal(await page.locator('[data-project-note="sprint"]').count(), 0);
  await goPage(page, '#/~hub/project/shadowdark');
  await page.locator('[data-project-note="sprint"]').waitFor();
  assert.equal(await page.locator('[data-project-note="sprint"]').innerText(), 'Sprints run on the PC. Discord bots has no PC runs.');
  assert.equal(await page.locator('[data-project-action="sprint"]').count(), 0, 'No sprint button where none can run.');
  assert.match(await page.locator('[data-project-note="runs-on"]').innerText(), /runs in the cloud/);
  await goPage(page, '#/~hub/project/bunnylink');
  await page.locator('[data-project-note="sprint"]').waitFor();
  assert.equal(await page.locator('[data-project-note="sprint"]').innerText(), 'Sprints run on the PC. Bunnylink has no PC runs.');
  assert.match(await page.locator('[data-project-note="runs-on"]').innerText(), /you start its work at the PC/);
  await goPage(page, '#/~hub/project/sprite-studio');
  await page.locator('[data-project-note="sprint"]').waitFor();
  assert.equal(await page.locator('[data-project-note="sprint"]').innerText(), 'No open milestone to sprint on.');
  assert.equal(await page.locator('[data-project-action="sprint"]').count(), 0);

  step('the name links: Needs, Work and an item page open the page; a list chip in Needs still filters; Today has no picker');
  await go('#/~hub/needs/all/magic-loops');
  await page.locator('[data-project-link="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go('#/~hub/work/magic-loops');
  await page.locator('.work-spawn [data-project-link="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go(`#/~hub/ask/${id('magic-loops', 'jump', 'a111')}`);
  await page.locator('.hub-top [data-project-chip="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go('#/~hub/today');
  await page.locator('[data-today-title]').waitFor();
  assert.equal(await page.locator('[data-today-project], .today-project').count(), 0, 'Today has no project picker, so it has no name link either.');
  await go('#/~hub/needs/all');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  await page.locator('.ni [data-project-chip="bunnylink"]').first().click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all/bunnylink');

  step('an address wins on Needs you and writes nothing; a bare address is All, whatever another screen picked (moved from hub-shared-project-ui)');
  await page.evaluate(() => { localStorage.setItem('buw.hub.project', 'sprite-studio'); });
  await page.goto(`${fixture.url}#/~hub/needs`);
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  assert.equal(await hash(), '#/~hub/needs', 'A bare address stays bare: no project is filled in from memory.');
  await go('#/~hub/needs/question/magic-loops');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 2);
  assert.equal(await page.evaluate(() => localStorage.getItem('hub-today-project')), null, 'A link is a look, not a pick.');
  assert.equal(await page.evaluate(() => localStorage.getItem('buw.hub.project')), 'sprite-studio', 'Work and the Roadmap keep what they had.');
  await go('#/~hub/needs/question');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 3);

  step('the Activity project filter is local: it writes nothing anyone else reads (moved from hub-shared-project-ui)');
  await go('#/~hub/activity');
  const activity = page.locator('.hub-top:has([aria-label="Project"])').first();
  await activity.waitFor();
  const activityChips = activity.locator('.hub-chips[aria-label="Project"] .hub-chip');
  if (await activityChips.count()) await activityChips.filter({ hasText: /Bunnylink/i }).first().click();
  else {
    await activity.getByRole('combobox', { name: 'Project' }).click();
    await activity.locator('[role="option"]', { hasText: /Bunnylink/i }).first().click();
  }
  assert.equal(await page.evaluate(() => localStorage.getItem('hub-today-project')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('buw.hub.project')), 'sprite-studio', 'Activity left the remembered project alone.');

  step('at 390 px: the page fits, Plan and New job share a row, every control is 44 px');
  const narrow = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await goPage(narrow, '#/~hub/project/magic-loops');
  await narrow.locator('a[data-project-action="sprint"]').waitFor();
  assert.equal(await narrow.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth && document.querySelector('.hub').scrollWidth <= document.querySelector('.hub').clientWidth), true, 'No sideways scroll.');
  assert.deepEqual(await small(narrow, '[data-project-action], .pp-tabs a, .pp-switch button, .pp .hub-runs, .pj-ms-head, .pj-task'), [], 'Every control is at least 44 px high.');
  const tops = await narrow.locator('[data-project-actions] .hub-btn, [data-project-actions] .ui-btn').evaluateAll(list => list.map(item => Math.round(item.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, 'Plan and New job share a row.');
  assert.equal(await narrow.locator('[aria-label="Working now"]').count(), 0, 'Below 1000 px the Running panel is the Running tab only.');
  assert.equal(await narrow.locator('[data-tabs]').count(), 0, 'A project page is a page of its own on a phone: no tab bar, a Back button instead.');
  assert.equal(await narrow.locator('[data-top="detail"] [data-back]').count(), 1);

  const go2 = (view, target) => view.evaluate(next => { location.hash = next; }, target);
  step('project page with a sprint: the picker row, the list narrowed to the sprint, the header count, a sheet, the Map, the Work tab link, an empty sprint');
  const sprintPage = await open({ width: 1280, height: 900 });
  await goPage(sprintPage, '#/~hub/project/magic-loops?sprint=sprint-5');
  await sprintPage.locator('[data-pp-sprint-row]').waitFor();
  assert.equal(await sprintPage.locator('[data-filter-sprint]').inputValue(), 'Movement · 1 of 3 tasks done', 'The group that carries the label names the sprint.');
  assert.equal((await sprintPage.locator('[data-pp-sprint-count]').innerText()).trim(), '1 of 3 tasks done');
  assert.equal(await sprintPage.locator('[data-pp-sprint-board]').getAttribute('href'), '#/~hub/work?project=magic-loops&sprint=sprint-5');
  await sprintPage.locator('[data-pp-roadmap] [data-pp-milestone]').first().waitFor();
  assert.deepEqual(await sprintPage.locator('[data-pp-roadmap] [data-pp-milestone]').evaluateAll(list => list.map(item => item.getAttribute('data-pp-milestone'))), ['ml-m1'], 'Only the milestone with a task in the sprint.');
  assert.deepEqual(await sprintPage.locator('[data-pp-roadmap] [data-pp-task]').evaluateAll(list => list.map(item => item.getAttribute('data-pp-task'))), ['ml-t3', 'ml-t4', 'ml-t2']);
  assert.equal(await sprintPage.locator('[data-pp-milestone][data-state="done"]').count(), 0, 'The finished Prototype milestone is not in the sprint.');
  assert.equal((await sprintPage.locator('[data-project-done]').innerText()).trim(), '1 of 3 tasks done.', 'The header counts the sprint.');
  const sprintDepth = await sprintPage.evaluate(() => history.length);
  await sprintPage.locator('[data-filter-sprint]').click();
  assert.deepEqual(await sprintPage.locator('.cb-list [role="option"]').evaluateAll(list => list.map(item => item.getAttribute('data-value'))), ['', 'sprint-5', 'sprint-4']);
  await sprintPage.locator('.cb-list [role="option"][data-value=""]').click();
  await sprintPage.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await sprintPage.waitForFunction(() => document.querySelectorAll('[data-pp-roadmap] [data-pp-task]').length === 4);
  assert.equal(await sprintPage.evaluate(() => history.length), sprintDepth, 'A pick adds no history entry.');
  assert.equal(await sprintPage.locator('[data-pp-sprint-board]').count(), 0, 'No sprint, no board link.');
  await sprintPage.locator('[data-filter-sprint]').click();
  await sprintPage.locator('.cb-list [role="option"][data-value="sprint-5"]').click();
  await sprintPage.waitForFunction(() => location.hash === '#/~hub/project/magic-loops?sprint=sprint-5');
  await sprintPage.locator('[data-pp-task="ml-t3"]').click();
  await sprintPage.waitForFunction(() => location.hash === '#/~hub/project/magic-loops/roadmap/ml-t3?sprint=sprint-5');
  await sprintPage.locator('.hub-map-panel').waitFor();
  await sprintPage.goBack();
  await sprintPage.waitForFunction(() => location.hash === '#/~hub/project/magic-loops?sprint=sprint-5');
  await sprintPage.locator('[data-roadmap-view="map"]').click();
  await sprintPage.waitForFunction(() => location.hash === '#/~hub/map/magic-loops?sprint=sprint-5');
  await sprintPage.locator('.hub-map-box svg').waitFor();
  assert.equal(await sprintPage.locator('[data-filter-sprint]').inputValue(), 'Movement · 1 of 3 tasks done', 'The picker stays on the Map.');
  await go2(sprintPage, '#/~hub/map/magic-loops/ml-t1?sprint=sprint-5');
  await sprintPage.locator('.hub-map-panel').waitFor();
  assert.match(await sprintPage.locator('.hub-map-panel').innerText(), /Run/, 'A node outside the sprint still opens its details.');
  await go2(sprintPage, '#/~hub/project/magic-loops/work?sprint=sprint-5');
  await sprintPage.locator('[data-pp-work]').waitFor();
  assert.equal((await sprintPage.locator('[data-pp-work] [data-pp-sprint-board]').innerText()).trim(), 'Open Movement on the board ›');
  assert.equal(await sprintPage.locator('[data-pp-sprint-row]').count(), 0, 'The Work tab has no picker: it is not filtered.');
  await go2(sprintPage, '#/~hub/project/magic-loops?sprint=nothing');
  await sprintPage.locator('[data-pp-sprint-empty]').waitFor();
  assert.match(await sprintPage.locator('[data-pp-sprint-empty]').innerText(), /No tasks in this sprint\./);
  assert.equal(await sprintPage.locator('[data-filter-sprint]').inputValue(), 'nothing', 'A sprint the list lacks still shows.');
  await sprintPage.locator('[data-pp-sprint-clear]').click();
  await sprintPage.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go2(sprintPage, '#/~hub/project/roadmapped?sprint=sprint-6');
  await sprintPage.locator('[data-pp-roadmap] [data-pp-milestone]').first().waitFor();
  assert.equal(await sprintPage.locator('[data-roadmap-row]').count(), 0, 'A sprint uses the flat milestone list even for a project with roadmaps.');

  step('project page with a sprint at 390 px: the row fits and the picker is 44 px');
  const sprintPhone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await goPage(sprintPhone, '#/~hub/project/magic-loops?sprint=sprint-5');
  await sprintPhone.locator('[data-pp-sprint-row]').waitFor();
  assert.deepEqual(await small(sprintPhone, '[data-filter-sprint], [data-pp-sprint-board]'), [], 'The picker and the board link are 44 px.');
  assert.equal(await sprintPhone.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true, 'No sideways scroll.');

  step('roadmap accordion: a roadmap holds its milestones as folds, a finished roadmap is one closed line, Hide completed (off by default, remembered)');
  const hideKey = () => page.evaluate(() => localStorage.getItem('buw.roadmap.hideDone'));
  const openRow = async (view, id) => {
    const head = view.locator(`[data-roadmap-row="${id}"] > .ui-fold-h button`);
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  };
  await goPage(page, '#/~hub/project/roadmapped');
  await page.locator('[data-pp-roadmap] [data-roadmap-row]').first().waitFor();
  assert.equal(await hideKey(), null);
  assert.equal(await page.locator('[data-roadmap-hide-done]').getAttribute('aria-pressed'), 'false', 'Hide completed is off by default.');
  await openRow(page, 'rd-r1');
  assert.deepEqual(await page.locator('[data-roadmap-row="rd-r1"] > .ui-fold-body > .ui-fold[data-pp-milestone]').evaluateAll(list => list.map(item => item.dataset.ppMilestone)), ['rd-f1']);
  assert.match(await page.locator('[data-pp-milestone="rd-f1"] > .ui-fold-h').innerText(), /First ring/);
  assert.equal(await page.locator('[data-roadmap-row="rd-r3"]').getAttribute('data-open'), 'false', 'A finished roadmap is one closed line.');
  assert.equal(await page.locator('[data-roadmap-row="rd-r3"] [data-pp-milestone]').count(), 0);
  await page.locator('[data-roadmap-hide-done]').click();
  assert.equal(await page.locator('[data-roadmap-hide-done]').getAttribute('aria-pressed'), 'true');
  assert.equal(await hideKey(), '1');
  assert.deepEqual(await page.locator('[data-pp-roadmap] [data-roadmap-row]').evaluateAll(list => list.map(row => row.dataset.roadmapRow)), ['rd-r1', 'rd-r2'], 'The finished roadmap is hidden.');
  await page.reload();
  await page.locator('[data-pp-roadmap] [data-roadmap-row]').first().waitFor();
  assert.equal(await page.locator('[data-roadmap-hide-done]').getAttribute('aria-pressed'), 'true', 'The setting is remembered.');
  await goPage(page, '#/~hub/project/magic-loops');
  await page.locator('[data-pp-roadmap] [data-pp-milestone]').first().waitFor();
  assert.equal(await page.locator('[data-pp-milestone][data-state="done"]').count(), 0, 'Hide completed hides the finished milestone.');
  await goPage(page, '#/~hub/project/magic-loops?sprint=sprint-5');
  await page.locator('[data-filter-sprint]').click();
  assert.deepEqual(await page.locator('.cb-list [role="option"]').evaluateAll(list => list.map(item => item.getAttribute('data-value'))), ['', 'sprint-5'], 'Finished sprints leave the picker.');
  await goPage(page, '#/~hub/project/magic-loops?sprint=sprint-4');
  assert.equal(await page.locator('[data-filter-sprint]').inputValue(), 'sprint-4 · 1 of 1 tasks done', 'The selected sprint stays, even if finished.');
  await page.evaluate(() => localStorage.removeItem('buw.roadmap.hideDone'));
  await goPage(page, '#/~hub/project/magic-loops?sprint=sprint-5');
  await page.locator('[data-filter-sprint]').click();
  assert.deepEqual(await page.locator('.cb-list [role="option"]').evaluateAll(list => list.map(item => item.getAttribute('data-value'))), ['', 'sprint-5', 'sprint-4'], 'With it off, every sprint is there.');

  step('project page: Hide completed sits beside the sprint picker, shows when it can hide something, and an all-done list says so with a way back');
  await page.evaluate(() => localStorage.removeItem('buw.roadmap.hideDone'));
  await goPage(page, '#/~hub/project/sprite-studio');
  await page.locator('[data-pp-sprint-row] [data-roadmap-hide-done]').waitFor();
  assert.equal(await page.locator('[data-filter-sprint]').count(), 0, 'No sprints, no picker, but the chip is there for the finished milestone.');
  assert.equal(await page.locator('[data-roadmap-hide-done]').count(), 1);
  await goPage(page, '#/~hub/project/shadowdark');
  await page.locator('[data-pp-roadmap]').waitFor();
  assert.equal(await page.locator('[data-roadmap-hide-done]').count(), 0, 'Nothing finished, no sprint, no roadmap: nothing to hide, no chip.');
  await goPage(page, '#/~hub/project/roadmapped');
  await page.locator('[data-pp-roadmap]').waitFor();
  assert.equal(await page.locator('[data-pp-sprint-row] [data-roadmap-hide-done]').count(), 1, 'On a project with roadmaps the chip is in the sprint row.');
  assert.equal(await page.locator('[data-pp-roadmap] [data-roadmap-hide-done]').count(), 0, 'The accordion does not draw a second one.');
  await goPage(page, '#/~hub/project/magic-loops?sprint=sprint-4');
  await page.locator('[data-pp-sprint-row] [data-roadmap-hide-done]').click();
  await page.locator('[data-pp-all-done]').waitFor();
  assert.match(await page.locator('[data-pp-all-done]').innerText(), /Everything here is done\./);
  assert.equal(await page.locator('[data-filter-sprint]').inputValue(), 'sprint-4 · 1 of 1 tasks done', 'The selected finished sprint stays in the picker.');
  await page.locator('[data-pp-show-done]').click();
  await page.locator('[data-pp-milestone]').first().waitFor();
  assert.equal(await page.locator('[data-roadmap-hide-done]').getAttribute('aria-pressed'), 'false', 'Show completed turns the setting off.');
  await page.evaluate(() => localStorage.removeItem('buw.roadmap.hideDone'));

  step('roadmap accordion at 390 px: the heads are 44 px and nothing scrolls sideways');
  const rowsPhone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await goPage(rowsPhone, '#/~hub/project/roadmapped');
  await rowsPhone.locator('[data-roadmap-row]').first().waitFor();
  assert.deepEqual(await small(rowsPhone, '[data-roadmap-hide-done], [data-roadmap-expand], [data-roadmap-collapse], .ui-fold-head'), [], 'Every control is 44 px.');
  assert.equal(await rowsPhone.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true, 'No sideways scroll.');

  console.log('hub-needs-project-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
