// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspaces are the only files written.
//
// The Library's filters: back from a card finds the search as it was, the Archive view counts what it holds and
// keeps its place when a section is picked, All lists Recent newest first, one section is grouped by category,
// and a card whose page is gone says so.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';
import { contextWithListOpen, libraryFilter, pickProject, projectRows } from './shell-helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/home-filters-ui-'));
const day = offset => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const card = (id, title, extra = {}) => ({
  id, folder: id, title, description: 'A card.', category: 'test',
  created: day(0), updated: day(0), status: 'active',
  steps: [{ name: 'Page', path: 'index.html' }], ...extra,
});

async function workspace(name, cards) {
  const dir = path.join(base, name);
  for (const entity of cards) {
    await mkdir(path.join(dir, entity.folder), { recursive: true });
    if (entity.id !== 'ghost') await writeFile(path.join(dir, entity.folder, 'index.html'), `<h1>${entity.title}</h1>`);
  }
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: cards }, null, 2));
  return dir;
}
// One: two live cards and one untouched for ten days. Two: a live card and one whose page is missing.
const one = await workspace('one', [card('alpha', 'Alpha'), card('bravo', 'Bravo', { created: day(1), updated: day(1) }), card('old', 'Old', { created: day(10), updated: day(10) })]);
const two = await workspace('two', [card('gamma', 'Gamma', { created: day(2), updated: day(2) }), card('ghost', 'Ghost', { created: day(3), updated: day(3) })]);
const repo = await mkdtemp(path.join(root, '.cache/home-filters-ui-app-'));
for (const dir of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: one, name: 'One', activate: true });
await addWorkspace({ registryFile, path: two, name: 'Two' });

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await contextWithListOpen(browser, { viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(ms(10000));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const logs = []; page.on('console', message => logs.push(message.text()));
  await page.goto(service.urls.workspace);
  await page.locator('[data-library] .lib-row').first().waitFor();

  const search = page.locator('.lib-search input');
  const rows = () => page.locator('[data-library] .lib-row');
  const ids = () => rows().evaluateAll(list => list.map(el => el.getAttribute('data-entity')));
  const blur = () => page.evaluate(() => document.activeElement?.blur?.());
  const openCard = async id => {
    await page.evaluate(hash => { location.hash = hash; }, `#/${id}/0`);
    await page.locator('.report-document').waitFor();
    await blur();
  };
  const view = name => page.locator('[data-library] .ui-seg button', { hasText: new RegExp('^' + name) });
  const arrange = name => page.locator('[data-library] .ui-seg.lib-arrange button', { hasText: new RegExp('^' + name) });
  const searchFor = async term => {
    await search.fill(term);
    await page.locator('[data-matches]').waitFor();
  };
  // The list stays beside a card on this context; fold it so a card is read alone and Back is a real step.
  const assertBack = async (what, term, count) => {
    await search.waitFor();
    assert.equal(await search.inputValue(), term, `${what}: Back finds the search text as it was`);
    assert.equal(await rows().count(), count, `${what}: and the list it filtered`);
  };

  // Back from a card finds the list as it was, whichever way back it is (design: a Back leaves the Library as you left it).
  // Replaces: going back to the cards cleared the search.
  await searchFor('Bravo');
  assert.equal(await rows().count(), 1);
  await page.locator('.lib-row-main').first().click();
  await page.locator('.report-document').waitFor();
  await blur();
  await page.keyboard.press('q');
  await assertBack('Q', 'Bravo', 1);
  await page.locator('.lib-row-main').first().click();
  await page.locator('.report-document').waitFor();
  await page.keyboard.press('Escape');
  await assertBack('Esc', 'Bravo', 1);
  await page.locator('.lib-row-main').first().click();
  await page.locator('.report-document').waitFor();
  await page.getByRole('link', { name: /Back/ }).click();
  await assertBack('Back link', 'Bravo', 1);

  // Esc in the field clears it; so does the Clear link. A section chip adds no step.
  await search.focus();
  await page.keyboard.press('Escape');
  assert.equal(await search.inputValue(), '', 'Esc clears the search');
  await rows().nth(3).waitFor();
  await searchFor('Bravo');
  await page.locator('[data-matches] .lib-clear').click();
  assert.equal(await search.inputValue(), '');
  assert.equal(await rows().count(), 4, 'every live card is back');

  // The Archive view counts what it holds (the card dated ten days ago), says why, and a section keeps the view.
  assert.equal(await page.locator('[data-archive-note]').count(), 0);
  assert.equal(await view('Archive').locator('small').innerText(), '1', 'the Archive segment counts the archived card');
  await view('Archive').click();
  await page.locator('[data-archive-note]').waitFor();
  assert.match(await page.locator('[data-archive-note]').innerText(), /7 days/);
  assert.deepEqual(await ids(), ['old']);
  assert.deepEqual(await projectRows(page), [['All projects', 1], ['One', 1], ['Starter examples', 0], ['Two', 0]], 'a project counts what the view would show, the empty one last');
  await pickProject(page, 'One');
  assert.equal(await view('Archive').getAttribute('aria-pressed'), 'true', 'picking a section keeps the view (replaces: All turned the archive off)');
  assert.deepEqual(await ids(), ['old']);
  await pickProject(page, 'One');
  await view('All').click();

  // All with no section: Pinned (none here), then Recent, newest first. One section: grouped by category, with the heading's menu.
  assert.equal(await page.locator('[data-library] .lib-head h2').innerText(), 'Recent');
  assert.deepEqual(await ids(), ['alpha', 'bravo', 'gamma', 'ghost'], 'newest first');
  await pickProject(page, 'One');
  assert.deepEqual(await ids(), ['alpha', 'bravo'], 'a project pick narrows');
  assert.equal(await page.locator('[data-library] .lib-head h2').innerText(), 'Recent', 'Recent stays one run with a project picked');
  await arrange('By project').click();
  assert.equal(await page.locator('[data-library] .lib-head h2').innerText(), 'Test', 'By project with one picked is grouped by category');
  await arrange('Recent').click();
  await pickProject(page, 'One');
  assert.equal(await page.locator('[data-library] .lib-head h2').innerText(), 'Recent');
  assert.equal(await page.evaluate(() => localStorage.getItem('buw.showRecent') ?? localStorage.getItem('buw.showArchived')), null, 'the old view keys are gone');

  // A card whose page is gone says so, with the real status.
  await page.evaluate(() => { location.hash = '#/ghost/0'; });
  await page.locator('.report-error', { hasText: 'Page unavailable (404)' }).waitFor();

  // No theme message was posted to a frame that was still blank.
  assert.equal(logs.filter(text => /postMessage/.test(text)).length, 0, logs.join(' | '));

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('home filters ui: ok');
} finally { await browser?.close(); await service.close(); }
