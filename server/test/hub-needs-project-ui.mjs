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
  // Workspace app and Bunnylink have an open one but no PC runs. Magic Loops alone has a Library section.
  const stamp = { created: '2026-10-01T10:00:00Z' };
  const closedTask = (taskId, title, parent) => beadsIssue({ id: taskId, title, parent, status: 'closed', closed: '2026-10-05T10:00:00Z', ...stamp });
  const copy = (project, issues) => seed.beads(project, issues, { pushedAt: minutesAgo(now, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: `example/${project}` });
  copy('magic-loops', [
    beadsIssue({ id: 'ml-m0', title: 'Prototype', type: 'milestone', status: 'closed', closed: '2026-10-03T10:00:00Z', ...stamp }),
    closedTask('ml-t0', 'Throw the prototype together', 'ml-m0'),
    beadsIssue({ id: 'ml-m1', title: 'Core loop', type: 'milestone', ...stamp }),
    beadsIssue({ id: 'ml-f1', title: 'Movement', type: 'epic', parent: 'ml-m1', ...stamp }),
    closedTask('ml-t1', 'Run', 'ml-f1'), closedTask('ml-t2', 'Jump', 'ml-f1'),
    beadsIssue({ id: 'ml-t3', title: 'Wall-jump', parent: 'ml-f1', status: 'in_progress', ...stamp }),
    beadsIssue({ id: 'ml-t4', title: 'Dash', parent: 'ml-f1', ...stamp }),
  ]);
  copy('sprite-studio', [beadsIssue({ id: 'ss-m1', title: 'Editor', type: 'milestone', status: 'closed', closed: '2026-10-03T10:00:00Z', ...stamp }), closedTask('ss-t1', 'Draw', 'ss-m1')]);
  for (const [project, prefix] of [['workspace-app', 'ws'], ['bunnylink', 'bl']]) copy(project, [beadsIssue({ id: `${prefix}-m1`, title: 'First milestone', type: 'milestone', ...stamp }), beadsIssue({ id: `${prefix}-t1`, title: 'Open task', parent: `${prefix}-m1`, ...stamp })]);
  // A project with roadmaps: the Roadmap tab lists them (ws-im1.3.2).
  copy('roadmapped', [
    beadsIssue({ id: 'rd-r1', title: 'Hub work', type: 'epic', labels: ['roadmap'], ...stamp }),
    beadsIssue({ id: 'rd-f1', title: 'First ring', type: 'feature', parent: 'rd-r1', ...stamp }),
    closedTask('rd-t1', 'Done thing', 'rd-f1'),
    beadsIssue({ id: 'rd-t2', title: 'Open thing', parent: 'rd-f1', ...stamp }),
    beadsIssue({ id: 'rd-r2', title: 'Editing', type: 'epic', parent: 'rd-r1', labels: ['roadmap'], ...stamp }),
    beadsIssue({ id: 'rd-t3', title: 'Loose thing', parent: 'rd-r2', ...stamp }),
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

  // ---- The project page (ws-im1.3.1) ----
  const goPage = async (view, target) => { await view.goto(`${fixture.url}${target}`); await view.locator('[data-project-page]').waitFor(); };
  const actions = view => view.locator('[data-project-action]').evaluateAll(list => list.map(item => item.getAttribute('data-project-action')));
  // Controls shorter than 44 px: [text, height] pairs of the visible ones.
  const small = (view, selector) => view.locator(selector).evaluateAll(list => list.map(item => [item.textContent.trim().slice(0, 24), Math.round(item.getBoundingClientRect().height), item.getBoundingClientRect().width]).filter(([, height, width]) => width > 0 && height < 44));

  step('project page: name, Runs on chip, three buttons, picker and tabs; every control is 44 px');
  await goPage(page, '#/~hub/project/magic-loops');
  assert.equal((await page.locator('.pp-title').innerText()).trim(), 'Magic Loops');
  await page.locator('.hub-runs').waitFor();
  assert.deepEqual(await actions(page), ['plan', 'build', 'sprint']);
  await page.waitForFunction(() => document.querySelector('[data-project-tab="needs"]').textContent.includes('('));
  assert.deepEqual(await page.locator('[data-project-tab]').allInnerTexts(), ['Roadmap', 'Running (0)', 'Needs you (3)', 'Library']);
  assert.equal(await page.locator('.pp .hub-chips .hub-chip.on').innerText(), 'Magic Loops');
  assert.deepEqual(await small(page, '[data-project-actions] .hub-btn, .pp-tabs .wk-tab, .pp .hub-chip, .pp .hub-runs'), [], 'Every control is at least 44 px high.');
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('[data-project-note]').count(), 0, 'Magic Loops runs on the PC: no note.');
  assert.equal(await page.locator('[data-hub-link="project"]').getAttribute('aria-current'), 'page', 'Projects is lit in the sidebar.');
  assert.deepEqual(await page.locator('[data-hub-group="plan"] [data-hub-link]').evaluateAll(list => list.map(item => item.getAttribute('data-hub-link'))), ['project', 'map', 'chat']);

  step('project page, Roadmap tab: one row per milestone with the map counts; finished ones fold; a chip opens that task on the map, and Back returns');
  const rows = page.locator('[data-pp-roadmap] [data-pp-milestone]');
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.first().locator('.pp-ms-count').innerText(), '2 of 4 done');
  assert.equal(await rows.first().locator('.pp-ring text').innerHTML(), '2/4');
  assert.deepEqual(await rows.first().locator('[data-pp-task]').evaluateAll(list => list.map(item => item.getAttribute('data-pp-task'))), ['ml-t3', 'ml-t4', 'ml-t1', 'ml-t2']);
  assert.equal((await page.locator('[data-pp-finished] summary').innerText()).trim(), '1 finished');
  assert.equal(await page.locator('[data-pp-finished][open]').count(), 0);
  await rows.first().locator('[data-pp-task="ml-t3"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/map/magic-loops/ml-t3');
  await page.locator('.hub-map-panel').waitFor();
  await page.goBack();
  await page.locator('[data-project-page="magic-loops"] [data-pp-roadmap]').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/~hub/project/magic-loops');
  await page.locator('[data-pp-open-map]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/map/magic-loops');
  await page.goBack();
  await page.locator('[data-pp-roadmap]').waitFor();

  step('project page, Roadmap tab with roadmaps (RoadmapRows): nested rows instead of the flat list; a row opens that roadmap\'s map, and Back returns');
  await goPage(page, '#/~hub/project/roadmapped');
  await page.locator('[data-pp-roadmap-rows] [data-roadmap-row]').first().waitFor();
  assert.deepEqual(await page.locator('[data-pp-roadmap-rows] [data-roadmap-row]').evaluateAll(list => list.map(row => [row.dataset.roadmapRow, row.dataset.depth])), [['rd-r1', '0'], ['rd-r2', '1']]);
  assert.equal(await page.locator('[data-pp-roadmap]').count(), 0, 'The flat milestone list is not shown.');
  assert.equal(await page.locator('[data-roadmap-row="rd-r1"] .rm-row-count').innerText(), '0 of 1 done');
  await page.locator('[data-roadmap-row="rd-r1"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/map/roadmapped/rd-r1');
  await page.locator('.hub-map-box svg').waitFor();
  assert.equal(await page.locator('[data-roadmap-toggle="branch"]').getAttribute('aria-current'), 'page');
  await page.goBack();
  await page.locator('[data-pp-roadmap-rows]').waitFor();
  await goPage(page, '#/~hub/project/magic-loops');

  step('project page, wide: the Running panel sits beside the Roadmap tab, and only there');
  await page.locator('[data-pp-side] [aria-label="Working now"]').waitFor();
  assert.equal(await page.locator('[aria-label="Working now"]').count(), 1);

  step('project page: a tab pushes history, the count matches Today, a row opens Needs you with the project chosen and the item flashed');
  await page.locator('[data-project-tab="needs"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops/needs');
  await page.locator('.pp .nrow').first().waitFor();
  assert.equal(await page.locator('[data-pp-side]').count(), 0, 'The side panel belongs to the Roadmap tab.');
  assert.equal(await page.locator('.pp .nrow').count(), 3);
  await page.goBack();
  await page.locator('[data-pp-roadmap]').waitFor();
  await page.locator('[data-project-tab="needs"]').click();
  await page.locator('.pp .nrow').first().waitFor();
  await page.locator('.pp .nrow').first().click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all/magic-loops');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 3 && document.querySelector('.ni.flash'));
  assert.equal(await page.evaluate(() => localStorage.getItem('hub-today-project')), null, 'The page leaves Today\'s remembered project alone.');
  await go('#/~hub/project/magic-loops/needs');
  assert.equal((await page.locator('[data-pp-all-needs]').innerText()).trim(), 'All in Needs you ›');
  await page.locator('[data-project-tab="running"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops/running');
  await page.locator('[aria-label="Working now"]').waitFor();
  assert.equal(await page.locator('[aria-label="Working now"]').count(), 1);

  step('project page, Library tab: the section\'s cards newest first; no section says so; a bad id says no such project');
  await page.locator('[data-project-tab="library"]').click();
  await page.locator('[data-pp-cards]').waitFor();
  assert.deepEqual(await page.locator('[data-pp-card]').allInnerTexts(), ['Dash report', 'Jump notes']);
  assert.equal(await page.locator('[data-pp-card]').first().getAttribute('href'), '/magic-loops#/dash-report');
  assert.equal(await page.locator('[data-pp-open-section]').getAttribute('href'), '/magic-loops');
  await goPage(page, '#/~hub/project/sprite-studio/library');
  await page.locator('[data-pp-no-library]').waitFor();
  assert.equal((await page.locator('[data-pp-no-library]').innerText()).trim(), 'No Library section for this project.');
  await goPage(page, '#/~hub/project/no-such-thing');
  assert.equal((await page.locator('[data-project-missing]').innerText()).trim(), 'No project called no-such-thing.');
  assert.equal(await page.locator('[data-project-action]').count(), 0);
  assert.ok(await page.locator('.pp .hub-chips .hub-chip').count() >= 3, 'The chips are there to pick one.');

  step('project page: no id opens a project; picking a chip pushes history');
  await goPage(page, '#/~hub/project');
  assert.ok(await page.locator('[data-project-page]').getAttribute('data-project-page'), 'It shows a project.');
  await page.locator('.pp .hub-chips .hub-chip', { hasText: 'Bunnylink' }).click();
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

  step('project page, sprint: Magic Loops links to its first open milestone; Workspace app and Bunnylink are off with the server\'s sentence; nothing open is off with its note');
  await goPage(page, '#/~hub/project/magic-loops');
  const sprint = page.locator('a[data-project-action="sprint"]');
  await sprint.waitFor();
  assert.equal(await sprint.getAttribute('href'), '#/~hub/map/magic-loops/ml-m1');
  assert.equal(await page.locator('[data-project-note="sprint"]').count(), 0);
  await goPage(page, '#/~hub/project/workspace-app');
  await page.locator('[data-project-note="sprint"]').waitFor();
  assert.equal(await page.locator('[data-project-note="sprint"]').innerText(), 'Sprints run on the PC. Workspace app has no PC runs.');
  assert.equal(await page.locator('button[data-project-action="sprint"]').isDisabled(), true);
  assert.match(await page.locator('[data-project-note="runs-on"]').innerText(), /runs in the cloud/);
  await goPage(page, '#/~hub/project/bunnylink');
  await page.locator('[data-project-note="sprint"]').waitFor();
  assert.equal(await page.locator('[data-project-note="sprint"]').innerText(), 'Sprints run on the PC. Bunnylink has no PC runs.');
  assert.match(await page.locator('[data-project-note="runs-on"]').innerText(), /you start its work at the PC/);
  await goPage(page, '#/~hub/project/sprite-studio');
  await page.locator('[data-project-note="sprint"]').waitFor();
  assert.equal(await page.locator('[data-project-note="sprint"]').innerText(), 'No open milestone to sprint on.');
  assert.equal(await page.locator('button[data-project-action="sprint"]').isDisabled(), true);

  step('the name links: Needs, Work, the Roadmap, an item page and Today open the page; a list chip in Needs still filters');
  await go('#/~hub/needs/all/magic-loops');
  await page.locator('[data-project-link="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go('#/~hub/work/magic-loops');
  await page.locator('.work-spawn [data-project-link="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go('#/~hub/map/magic-loops');
  await page.locator('.hub-map-chips [data-project-link="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go(`#/~hub/ask/${id('magic-loops', 'jump', 'a111')}`);
  await page.locator('.hub-top [data-project-chip="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await go('#/~hub/today');
  await page.locator('.today-project .hub-chip', { hasText: 'Magic Loops' }).click();
  await page.locator('.today-project [data-project-link="magic-loops"]').click();
  await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
  await page.evaluate(() => localStorage.removeItem('hub-today-project'));
  await go('#/~hub/needs/all');
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 7);
  await page.locator('.ni [data-project-chip="bunnylink"]').first().click();
  await page.waitForFunction(() => location.hash === '#/~hub/needs/all/bunnylink');

  step('at 390 px: the page fits, the three buttons share a row, every control is 44 px, and More has Projects');
  const narrow = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await goPage(narrow, '#/~hub/project/magic-loops');
  await narrow.locator('a[data-project-action="sprint"]').waitFor();
  assert.equal(await narrow.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth && document.querySelector('.hub').scrollWidth <= document.querySelector('.hub').clientWidth), true, 'No sideways scroll.');
  assert.deepEqual(await small(narrow, '[data-project-actions] .hub-btn, .pp-tabs .wk-tab, .pp .hub-chip, .pp .hub-runs, .pp-chip, .pp-ms-title'), [], 'Every control is at least 44 px high.');
  const tops = await narrow.locator('[data-project-actions] .hub-btn').evaluateAll(list => list.map(item => Math.round(item.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, 'The three buttons share a row.');
  assert.equal(await narrow.locator('[aria-label="Working now"]').count(), 0, 'Below 1000 px the Running panel is the Running tab only.');
  assert.deepEqual(await narrow.locator('nav.hub-tabs > .hub-tab').evaluateAll(list => list.map(item => item.getAttribute('data-hub-tab'))), ['today', 'needs', 'work', 'team', 'map', 'more'], 'The phone bar is unchanged.');
  assert.equal(await narrow.locator('[data-hub-tab="more"]').getAttribute('class').then(value => value.includes('active')), true, 'More is lit on the page: Projects lives there.');
  await narrow.locator('[data-hub-tab="more"]').tap();
  assert.equal(await narrow.locator('[data-hub-more="project"]').getAttribute('aria-current'), 'page');

  console.log('hub-needs-project-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
