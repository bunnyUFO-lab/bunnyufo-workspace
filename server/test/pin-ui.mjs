// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspaces are the only files written.
//
// Pinning is a row menu action in the Library: every card is listed once, the pins sit in Pinned above the rest
// where a section filter cannot hide them, and a pin's place is Move up and Move down in its menu.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';
import { contextWithListOpen, pickProject } from './shell-helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/pin-ui-'));
const today = new Date().toISOString().slice(0, 10);
const card = (id, title, extra = {}) => ({
  id, folder: id, title, description: 'A card.', category: 'test',
  created: today, updated: today, status: 'active',
  steps: [{ name: 'Page', path: 'index.html' }], ...extra,
});

// Two registered workspaces, each with its own card; the one in "Two" is pinned.
async function workspace(name, cards) {
  const dir = path.join(base, name);
  for (const entity of cards) {
    await mkdir(path.join(dir, entity.folder), { recursive: true });
    await writeFile(path.join(dir, entity.folder, 'index.html'), `<h1>${entity.title}</h1>`);
  }
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: cards }, null, 2));
  return dir;
}
const one = await workspace('one', [card('alpha', 'Alpha')]);
const two = await workspace('two', [card('beta', 'Beta', { pinned: true })]);
const repo = await mkdtemp(path.join(root, '.cache/pin-ui-app-'));
for (const dir of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: one, name: 'One', activate: true });
await addWorkspace({ registryFile, path: two, name: 'Two' });

// Pinning is card state, not a card's content: it goes to .buw/card-state.json in the app's own
// folder, keyed "<workspace>/<card>", and no workspace repository is written at all.
const stateFile = path.join(repo, '.buw', 'card-state.json');
const stateOf = async id => {
  try {
    const { cards } = JSON.parse(await readFile(stateFile, 'utf8'));
    return Object.entries(cards).find(([key]) => key.endsWith(`/${id}`))?.[1] ?? {};
  } catch {
    return {};
  }
};
const pinOrderOf = async id => (await stateOf(id)).pinOrder;
// A move writes one card at a time and the list refreshes after each write, so the screen can
// be right a moment before the last write is.
const untilOrder = async (dir, id, expected) => {
  for (let tries = 0; tries < 50; tries++) {
    if (await pinOrderOf(id) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await pinOrderOf(id), expected, `${id} should sit at ${expected} in the pinned list`);
};
const pinnedInFile = async (_dir, id) => (await stateOf(id)).pinned;
/** The card lists themselves are content and nothing here may touch them. */
const listsUntouched = async () => {
  for (const [dir, before] of published) assert.equal(await readFile(path.join(dir, 'workspace.json'), 'utf8'), before, 'A pin must not write a card list.');
};
const published = [[one, await readFile(path.join(one, 'workspace.json'), 'utf8')], [two, await readFile(path.join(two, 'workspace.json'), 'utf8')]];


const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await contextWithListOpen(browser, { viewport: { width: 1280, height: 950 } })).newPage();
  page.setDefaultTimeout(ms(10000));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  const rows = () => page.locator('[data-library] .lib-row');
  const row = id => page.locator(`[data-library] .lib-row[data-entity="${id}"]`);
  /** A row's menu: open it, pick an item. */
  const menu = async (id, item) => {
    await row(id).locator('[data-row-menu]').click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  const pinTitles = () => page.locator('[data-library] [role="list"][aria-label="Pinned"] .lib-row-body b').allInnerTexts();
  await rows().first().waitFor();

  // Each card is listed once: the pin is in Pinned, and Recent holds the rest.
  assert.equal(await row('beta').count(), 1, 'The pinned card appears once.');
  assert.equal(await rows().count(), 2);
  assert.deepEqual(await pinTitles(), ['Beta'], 'The pin is listed at start.');
  assert.equal(await page.locator('[data-library] .lib-head h2', { hasText: 'Pinned' }).count(), 1);

  // A project pick narrows the cards but not the pins: a pin says "keep this in front of me".
  await pickProject(page, 'One');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] .lib-row').length === 2);
  assert.equal(await row('beta').count(), 1, 'The section filter does not hide a pin from another section.');
  assert.equal(await row('alpha').count(), 1);
  assert.equal(await rows().count(), 2, 'Still once each.');
  await pickProject(page, 'One');

  // The row menu pins and unpins, written as card state.
  await menu('alpha', 'Pin');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] [role="list"][aria-label="Pinned"] .lib-row').length === 2);
  assert.equal(await pinnedInFile(one, 'alpha'), true);
  assert.equal(await rows().count(), 2, 'A card pinned still shows once.');
  await menu('alpha', 'Unpin');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] [role="list"][aria-label="Pinned"] .lib-row').length === 1);
  assert.equal(await pinnedInFile(one, 'alpha'), false, 'Unpinning is remembered, so a card published pinned can be taken off the list.');
  await listsUntouched();

  // Move up and Move down change a pin's place, and the order is written per card (the list mixes workspaces). The last pin cannot
  // move down and the first cannot move up.
  await menu('alpha', 'Pin');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] [role="list"][aria-label="Pinned"] .lib-row').length === 2);
  const start = await pinTitles();
  assert.deepEqual([...start].sort(), ['Alpha', 'Beta']);
  const [first, second] = start.map(title => title.toLowerCase());
  const dir = { alpha: one, beta: two };
  await row(first).locator('[data-row-menu]').click();
  assert.equal(await page.getByRole('menuitem', { name: 'Move up', exact: true }).isDisabled(), true, 'The first pin cannot move up.');
  await page.getByRole('button', { name: 'Close' }).click();
  await row(second).locator('[data-row-menu]').click();
  assert.equal(await page.getByRole('menuitem', { name: 'Move down', exact: true }).isDisabled(), true, 'The last pin cannot move down.');
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await page.waitForFunction(want => [...document.querySelectorAll('[data-library] [role="list"][aria-label="Pinned"] .lib-row-body b')].map(e => e.textContent).join() === want, [start[1], start[0]].join());
  await untilOrder(dir[second], second, 0);
  await untilOrder(dir[first], first, 1);
  await menu(first, 'Move up');
  await page.waitForFunction(want => [...document.querySelectorAll('[data-library] [role="list"][aria-label="Pinned"] .lib-row-body b')].map(e => e.textContent).join() === want, start.join());
  await untilOrder(dir[first], first, 0);
  await menu('alpha', 'Unpin');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] [role="list"][aria-label="Pinned"] .lib-row').length === 1);
  assert.equal(await pinnedInFile(one, 'alpha'), false);
  await listsUntouched();

  // A pin opens like any card, from its row.
  await row('beta').locator('.lib-row-main').click();
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Beta' }).waitFor();
  assert.equal(await row('beta').getAttribute('aria-current') ?? await row('beta').locator('.lib-row-main').getAttribute('aria-current'), 'page', 'The open card is lit in the list.');

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Pin UI passed: a pin shows once and survives the section filter, the row menu pins and orders them, and no card list was written.');
} finally { await browser?.close(); await service.close(); }
