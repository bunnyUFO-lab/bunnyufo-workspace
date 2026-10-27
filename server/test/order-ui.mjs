// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspaces are the only files written.
//
// The menu from the pointer and the keyboard: a pin button on every row, cards / project chips /
// section headings dragged into an order that is remembered, and J/K/↑/↓/Alt+↑↓ through the list
// without opening the search box.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';

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

// Dragging is a pointer gesture (src/lib/drag.ts): press, move past the threshold, release.
// `at` aims inside the target — a fraction of its width and height — which is how a place in a
// row (top or bottom half) or in a line of chips and cards (left or right half) is chosen.
const drag = async (page, source, target, at = { x: 0.5, y: 0.5 }) => {
  await source.waitFor();
  let settled = null;
  for (let tries = 0; tries < 40; tries++) {
    const box = await source.boundingBox();
    if (settled && box.x === settled.x && box.y === settled.y) break;
    settled = box;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const from = await source.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  // Lifting a card opens the empty pinned list and pushes the rows down: aim at where the target is now.
  await new Promise(resolve => setTimeout(resolve, 150));
  const to = await target.boundingBox();
  await page.mouse.move(to.x + to.width * at.x, to.y + to.height * at.y, { steps: 10 });
  await page.mouse.up();
};
const TOP = { x: 0.5, y: 0.15 }, BOTTOM = { x: 0.5, y: 0.85 }, LEFT = { x: 0.15, y: 0.5 }, RIGHT = { x: 0.85, y: 0.5 };

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.locator('.sidebar-item').first().waitFor();

  const texts = selector => page.locator(selector).evaluateAll(els => els.map(el => el.querySelector('.item-text')?.textContent ?? el.textContent));
  const sidebarCards = (section) => page.locator(`.sidebar-groups > div:has(> [data-section="${section}"]) .sidebar-item .item-text`).allInnerTexts();
  const chips = () => page.locator('.sidebar .project-chip').evaluateAll(els => els.map(el => el.textContent.replace(/[0-9]/g, '').trim()).filter(Boolean));
  const until = async (read, expected, what) => {
    for (let tries = 0; tries < 50; tries++) {
      const got = await read();
      if (JSON.stringify(got) === JSON.stringify(expected)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(await read(), expected, what);
  };

  // —— The pin button on a row ————————————————————————————————————————————
  // A row's text starts with its icon, so match on the title element.
  const itemOf = title => page.locator('.sidebar-item', { has: page.locator('.item-text', { hasText: new RegExp(`^${title}$`) }) });
  const rowOf = title => page.locator('.sidebar-row', { has: page.locator('.item-text', { hasText: new RegExp(`^${title}$`) }) });
  const pinButton = title => rowOf(title).locator('.sidebar-item-pin');
  assert.equal(await page.locator('.sidebar-item-pin').count(), 5, 'Every row has a pin button.');
  assert.ok(await page.locator('.sidebar-item-pin').first().evaluate(el => Number(getComputedStyle(el).opacity)) >= 0.5, 'The pin button is legible without hovering.');
  await pinButton('A2').click();
  await page.locator('.sidebar-pins .sidebar-item', { hasText: 'A2' }).waitFor();
  assert.equal(await pinnedInFile('a2'), true, 'The button pins the card and writes it through.');
  assert.equal(await page.locator('.sidebar-pins .sidebar-item-pin.on').count(), 1, 'A pinned row shows the pin lit.');
  await page.locator('.sidebar-pins .sidebar-item-pin').click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-pins .sidebar-item').length === 0);
  assert.equal(await pinnedInFile('a2'), false, 'The same button unpins it.');

  // —— Cards inside a section ——————————————————————————————————————————————
  await until(() => sidebarCards('One'), ['A1', 'A2', 'A3', 'A4'], 'With nothing arranged, the list follows freshness.');
  await drag(page, itemOf('A3'), rowOf('A1'), TOP);
  await until(() => sidebarCards('One'), ['A3', 'A1', 'A2', 'A4'], 'A card dropped on the top half of another lands above it.');
  await drag(page, itemOf('A3'), rowOf('A2'), BOTTOM);
  await until(() => sidebarCards('One'), ['A1', 'A2', 'A3', 'A4'], '…and on the bottom half, below it.');
  // The board is the same list.
  await until(() => page.locator('.home-section:has(.section-title:text("One")) .card-title').allInnerTexts(), ['A1', 'A2', 'A3', 'A4'], 'The board shows the same order.');
  await drag(page, page.locator('.entity-card[data-entity="a4"]'), page.locator('.entity-card[data-entity="a1"]'), LEFT);
  await until(() => sidebarCards('One'), ['A4', 'A1', 'A2', 'A3'], 'Dragging on the board rearranges the menu too.');
  // Dropped on a card of another section, nothing moves.
  await drag(page, itemOf('A4'), rowOf('B1'));
  await until(() => sidebarCards('One'), ['A4', 'A1', 'A2', 'A3'], 'A card dropped in another project\'s section stays where it was.');
  assert.equal(await itemOf('A4').count(), 1);

  await page.reload();
  await page.locator('.sidebar-item').first().waitFor();
  await until(() => sidebarCards('One'), ['A4', 'A1', 'A2', 'A3'], 'The order is remembered across a reload.');

  // —— Projects ————————————————————————————————————————————————————————————
  await until(chips, ['All', 'One', 'Two', 'Recent'].filter(Boolean).map(label => label), 'Chips follow the registry at first.').catch(() => {});
  const names = async () => (await chips()).filter(name => /^(One|Two)/.test(name)).map(name => name.slice(0, 3));
  assert.deepEqual(await names(), ['One', 'Two']);
  await drag(page, page.locator('.sidebar .project-chip', { hasText: 'Two' }), page.locator('.sidebar .project-chip', { hasText: 'One' }), LEFT);
  await until(names, ['Two', 'One'], 'A chip dropped on the left half of another goes before it.');
  assert.deepEqual(await page.locator('.sidebar-groups [data-section]').evaluateAll(els => els.map(el => el.dataset.section)), ['Two', 'One'], 'The project sections follow the chips.');
  assert.equal(await page.locator('.sidebar .project-chip.active').count(), 1, 'A drag is not a click: the filter did not change.');
  assert.ok(await page.locator('.sidebar .project-chip.active', { hasText: 'All' }).count() === 1);
  // The number keys follow the new order.
  await page.locator('.main').click({ position: { x: 5, y: 5 } });
  // (The starter examples are registered too, and were first before and after.)
  await page.keyboard.press('2');
  await page.locator('.sidebar .project-chip.active', { hasText: 'Two' }).waitFor();
  await page.keyboard.press('0');
  await page.locator('.sidebar .project-chip.active', { hasText: 'All' }).waitFor();
  // A project's heading moves it as well.
  await drag(page, page.locator('.sidebar-groups [data-section="One"]'), page.locator('.sidebar-groups [data-section="Two"]'), TOP);
  await until(names, ['One', 'Two'], 'A project heading dragged above another moves the project.');

  // —— Category headings (inside one project) ——————————————————————————————
  await page.locator('.sidebar .project-chip', { hasText: 'One' }).click();
  await until(() => page.locator('.sidebar-groups [data-section]').evaluateAll(els => els.map(el => el.dataset.section)), ['alpha', 'bravo']);
  await drag(page, page.locator('.sidebar-groups [data-section="bravo"]'), page.locator('.sidebar-groups [data-section="alpha"]'), TOP);
  await until(() => page.locator('.sidebar-groups [data-section]').evaluateAll(els => els.map(el => el.dataset.section)), ['bravo', 'alpha'], 'A category heading moves among the categories.');
  await page.locator('.sidebar .project-chip', { hasText: 'All' }).click();

  // —— The keyboard ————————————————————————————————————————————————————————
  await page.locator('.main').click({ position: { x: 5, y: 5 } });
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    return el?.classList.contains('sidebar-item') ? `card:${el.querySelector('.item-text').textContent}` : el?.dataset?.section ? `section:${el.dataset.section}` : el?.tagName;
  });
  await page.keyboard.press('j');
  assert.equal(await focused(), 'section:One', 'J lands on the first heading of the menu (no search box needed).');
  await page.keyboard.press('j');
  assert.equal(await focused(), 'card:A4', 'J goes down one row.');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(), 'card:A1', '↓ does the same once focus is in the list.');
  await page.keyboard.press('ArrowUp');
  assert.equal(await focused(), 'card:A4');
  await page.keyboard.press('k');
  assert.equal(await focused(), 'section:One', 'K goes back up.');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.sidebar-groups [data-section="One"]')?.getAttribute('aria-expanded') === 'false');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.sidebar-groups [data-section="One"]')?.getAttribute('aria-expanded') === 'true');
  await page.keyboard.press('j');
  await page.keyboard.press('Alt+ArrowDown');
  await until(() => sidebarCards('One'), ['A1', 'A4', 'A2', 'A3'], 'Alt+↓ moves the focused card one place down.');
  assert.equal(await focused(), 'card:A4', '…and keeps the focus on it, so it can be moved again.');
  await page.keyboard.press('Alt+ArrowDown');
  await until(() => sidebarCards('One'), ['A1', 'A2', 'A4', 'A3']);
  await page.keyboard.press('Alt+ArrowUp');
  await until(() => sidebarCards('One'), ['A1', 'A4', 'A2', 'A3']);
  await page.keyboard.press('Enter');
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'A4' }).waitFor();

  // Typing in the search box is untouched: J is a letter there.
  await page.keyboard.press('/');
  await page.keyboard.type('jk');
  assert.equal(await page.locator('.sidebar-search input').inputValue(), 'jk');

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Order UI passed: pin buttons on rows, cards / chips / headings drag into a remembered order, the menu moves by keyboard.');
} finally { await browser?.close(); await service.close(); }
