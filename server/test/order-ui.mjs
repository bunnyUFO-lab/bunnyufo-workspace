// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspaces are the only files written.
//
// Order in the Library: pin and unpin from a row's menu, Move up and Move down in a pinned row's menu, the pinned order
// remembered across a reload, and a chip / heading / card order saved in this browser still applied.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';
import { contextWithListOpen } from './shell-helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/order-ui-'));
const today = new Date().toISOString().slice(0, 10);
const card = (id, title, category = 'test') => ({
  id, folder: id, title, description: 'A card.', category,
  created: today, updated: today, status: 'active',
  steps: [{ name: 'Page', path: 'index.html' }],
});

async function workspace(name, cards) {
  const dir = path.join(base, name);
  for (const entity of cards) {
    await mkdir(path.join(dir, entity.folder), { recursive: true });
    await writeFile(path.join(dir, entity.folder, 'index.html'), `<h1>${entity.title}</h1>`);
  }
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: cards }, null, 2));
  return dir;
}
// Three cards in "One" (two categories, so the category headings can be moved too), one in "Two".
const one = await workspace('one', [card('a1', 'A1', 'alpha'), card('a2', 'A2', 'alpha'), card('a3', 'A3', 'alpha'), card('a4', 'A4', 'bravo')]);
const two = await workspace('two', [card('b1', 'B1')]);
const repo = await mkdtemp(path.join(root, '.cache/order-ui-app-'));
for (const dir of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: one, name: 'One', activate: true });
await addWorkspace({ registryFile, path: two, name: 'Two' });

const stateFile = path.join(repo, '.buw', 'card-state.json');
const pinnedInFile = async id => {
  try {
    const { cards } = JSON.parse(await readFile(stateFile, 'utf8'));
    return Object.entries(cards).find(([key]) => key.endsWith(`/${id}`))?.[1]?.pinned;
  } catch { return undefined; }
};

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const open = async init => {
    const context = await contextWithListOpen(browser, { viewport: { width: 1280, height: 950 } });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.setDefaultTimeout(ms(10000));
    page.on('pageerror', error => errors.push(error.message));
    return page;
  };
  const errors = [];
  const page = await open();
  await page.goto(service.urls.workspace);
  const rows = () => page.locator('[data-library] .lib-row');
  const row = title => page.locator('[data-library] .lib-row', { has: page.locator('.lib-row-body b', { hasText: new RegExp(`^${title}$`) }) });
  const menu = async (title, item) => {
    await row(title).locator('[data-row-menu]').click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  const pinned = () => page.locator('[data-library] [role="list"][aria-label="Pinned"] .lib-row-body b').allInnerTexts();
  const heads = () => page.locator('[data-library] .lib-head[data-section]').evaluateAll(els => els.map(el => el.dataset.section));
  const titles = () => page.locator('[data-library] .lib-row-body b').allInnerTexts();
  const chips = () => page.locator('[data-library] .ui-chips .ui-chip').evaluateAll(els => els.map(el => el.firstChild.textContent.trim()));
  const until = async (read, expected, what) => {
    for (let tries = 0; tries < 50; tries++) {
      const got = await read();
      if (JSON.stringify(got) === JSON.stringify(expected)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(await read(), expected, what);
  };
  await rows().first().waitFor();
  assert.equal(await rows().count(), 5);

  // —— Pin from a row menu ————————————————————————————————————————————————
  await menu('A2', 'Pin');
  await until(pinned, ['A2'], 'The menu pins the card.');
  assert.equal(await pinnedInFile('a2'), true, 'It writes through.');
  assert.equal(await rows().count(), 5, 'A pinned card is still listed once.');
  await menu('A2', 'Unpin');
  await until(pinned, [], 'The same menu unpins it.');
  assert.equal(await pinnedInFile('a2'), false);

  // —— A pinned list in a chosen order: Move up and Move down, remembered across a reload ——
  await menu('A1', 'Pin'); await until(pinned, ['A1']);
  await menu('A3', 'Pin'); await until(pinned, ['A1', 'A3']);
  await menu('B1', 'Pin'); await until(pinned, ['A1', 'A3', 'B1'], 'A fresh pin goes to the end.');
  await menu('B1', 'Move up');
  await until(pinned, ['A1', 'B1', 'A3'], 'Move up goes one place up, across workspaces.');
  await menu('A1', 'Move down');
  await until(pinned, ['B1', 'A1', 'A3'], 'Move down goes one place down.');
  await row('B1').locator('[data-row-menu]').click();
  assert.equal(await page.getByRole('menuitem', { name: 'Move up', exact: true }).isDisabled(), true, 'The first pin cannot move up.');
  await page.getByRole('button', { name: 'Close' }).click();
  await row('A3').locator('[data-row-menu]').click();
  assert.equal(await page.getByRole('menuitem', { name: 'Move down', exact: true }).isDisabled(), true, 'The last pin cannot move down.');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await rows().first().waitFor();
  await until(pinned, ['B1', 'A1', 'A3'], 'The order is remembered across a reload.');
  // A row not pinned has no Move items.
  await row('A4').locator('[data-row-menu]').click();
  assert.equal(await page.getByRole('menuitem', { name: 'Move up', exact: true }).count(), 0, 'Only a pinned row can move.');
  await page.getByRole('button', { name: 'Close' }).click();
  for (const title of ['B1', 'A1', 'A3']) await menu(title, 'Unpin');
  await until(pinned, []);

  // —— An order saved in this browser still orders the chips, the headings and the cards (nothing here sets it any more) ——
  const saved = await open(() => {
    if (!localStorage.getItem('buw.order')) localStorage.setItem('buw.order', JSON.stringify({ projects: ['two', 'one'], sections: ['bravo', 'alpha'], cards: { 'category:alpha': ['one/a3', 'one/a1', 'one/a2'] } }));
  });
  await saved.goto(service.urls.workspace);
  await saved.locator('[data-library] .lib-row').first().waitFor();
  const savedChips = (await saved.locator('[data-library] .ui-chips .ui-chip').evaluateAll(els => els.map(el => el.firstChild.textContent.trim()))).filter(name => /^(One|Two)$/.test(name));
  assert.deepEqual(savedChips, ['Two', 'One'], 'order.projects orders the section chips.');
  await saved.locator('[data-library] .ui-chips .ui-chip', { hasText: /^One/ }).click();
  await saved.locator('[data-library] .lib-head[data-section]').first().waitFor();
  assert.deepEqual(await saved.locator('[data-library] .lib-head[data-section]').evaluateAll(els => els.map(el => el.dataset.section)), ['bravo', 'alpha'], 'order.sections orders the category headings.');
  assert.deepEqual(await saved.locator('[data-library] [role="list"][aria-label="alpha"] .lib-row-body b').allInnerTexts(), ['A3', 'A1', 'A2'], 'order.cards orders the cards of a category.');

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Order UI passed: pinned Move up and Move down and their order after a reload; a saved chip, heading and card order still applies.');
} finally { await browser?.close(); await service.close(); }
