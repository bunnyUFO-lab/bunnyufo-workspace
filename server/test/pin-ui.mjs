// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspaces are the only files written.
//
// Pinning is a sidebar affordance: the grid shows every card once, in its own project's
// section, and the pinned list lives beside it in the sidebar where the project filter
// cannot hide it.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';

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


// Dragging is a pointer gesture, not HTML5 drag-and-drop (see src/lib/drag.ts), so it is
// driven here the way a hand drives it: press, move, release. `edge` aims at the top or
// bottom of the target instead of its middle, which is how a place in the list is chosen.
const dragCard = async (page, source, target, edge) => {
  // The sidebar slides in and out; measure once it has stopped moving. Before the slide starts it
  // sits still off the left edge, which is not "settled" (that read made a drag start off screen).
  await source.waitFor();
  let settled = null;
  for (let tries = 0; tries < 100; tries++) {
    const box = await source.boundingBox();
    if (settled && box.x >= 0 && box.x === settled.x && box.y === settled.y) break;
    settled = box;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  const y = edge === 'top' ? to.y + 3 : edge === 'bottom' ? to.y + to.height - 3 : to.y + to.height / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, y, { steps: 10 });
  await page.mouse.up();
};

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.locator('.entity-card').first().waitFor();

  // The grid holds each card once — no pinned strip repeating it above its own section.
  assert.equal(await page.locator('.entity-card[data-entity="beta"]').count(), 1, 'The pinned card appears once in the grid.');
  assert.equal(await page.locator('.home-section .section-title', { hasText: 'pinned' }).count(), 0, 'The grid has no pinned section.');
  assert.equal(await page.locator('.entity-card').count(), 2);

  // The sidebar is where pinning shows: its own list, above the project sections. It opens by
  // itself on a wide screen, so the pins are visible at start with no click.
  await page.locator('.sidebar-label', { hasText: 'pinned' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.sidebar-item.pinned').count(), 1, 'The pin is listed at start.');
  assert.equal(await page.locator('.sidebar-item.pinned').count(), 1);
  assert.equal(await page.locator('.sidebar-item', { hasText: 'Beta' }).count(), 1, 'A pinned card is listed once in the sidebar.');

  // Filtering to One takes the pinned card out of the grid — the filter means the grid shows
  // that project — while the sidebar keeps it in reach.
  await page.locator('.sidebar .project-chip', { hasText: 'One' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.entity-card').length === 1);
  assert.equal(await page.locator('.entity-card[data-entity="beta"]').count(), 0, 'A pin from another project does not sit in a filtered grid.');
  assert.equal(await page.locator('.sidebar-item', { hasText: 'Beta' }).count(), 1, 'The filter does not hide a pin from the sidebar.');

  // The sidebar pushes the grid on a wide screen; put it away anyway before touching a card.
  await page.getByRole('button', { name: 'Hide menu' }).click();

  // Both card buttons are legible without hovering: a control that only appears under the
  // pointer is one nobody finds.
  const opacity = selector => page.locator(selector).first().evaluate(el => Number(getComputedStyle(el).opacity));
  assert.ok(await opacity('.entity-card .card-pin') >= 0.7, 'The pin button is visible without hover.');
  assert.ok(await opacity('.entity-card .card-archive') >= 0.7, 'The archive button is visible without hover.');
  // …and they stay inside the card, whatever the chips before them are called.
  const inside = await page.locator('.entity-card[data-entity="alpha"]').evaluate(card => {
    const box = card.getBoundingClientRect();
    return [...card.querySelectorAll('.card-action')].every(button => {
      const rect = button.getBoundingClientRect();
      return rect.right <= box.right + 1 && rect.left >= box.left - 1 && rect.bottom <= box.bottom + 1;
    });
  });
  assert.ok(inside, 'The card buttons sit inside the card.');

  // The button pins a card and writes it through, with no drag needed.
  await page.locator('.entity-card[data-entity="alpha"] .card-pin').click();
  await page.locator('.sidebar-item.pinned', { hasText: 'Alpha' }).waitFor({ state: 'attached' });
  assert.equal(await pinnedInFile(one, 'alpha'), true);
  await page.locator('.entity-card[data-entity="alpha"] .card-pin').click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-item.pinned').length === 1);
  assert.equal(await pinnedInFile(one, 'alpha'), false, 'Unpinning is remembered, so a card published pinned can be taken off the list.');

  await page.getByRole('button', { name: 'Show menu' }).click();

  // Dragging is the mouse's way in: a card dropped on the pinned list is pinned, and a pinned
  // item dragged back out of it is unpinned. The sidebar overlays the grid, so the card has to
  // be picked up with the menu open — which is exactly how it is done by hand.
  await dragCard(page, page.locator('.sidebar-groups .sidebar-item', { hasText: 'Alpha' }), page.locator('.sidebar-pins'));
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-pins .sidebar-item').length === 2);
  assert.equal(await pinnedInFile(one, 'alpha'), true, 'A dropped card is pinned in the state file.');
  await listsUntouched();

  // A pin dropped on the top half of another pin lands above it, and the order is written per
  // card — the list mixes workspaces, so each file keeps its own card's place.
  const pinTitles = () => page.locator('.sidebar-pins .sidebar-item .item-text').allInnerTexts();
  assert.deepEqual(await pinTitles(), ['Beta', 'Alpha'], 'A fresh pin waits at the bottom.');
  const beta = page.locator('.sidebar-pins .sidebar-item', { hasText: 'Beta' });
  const alpha = page.locator('.sidebar-pins .sidebar-row', { hasText: 'Alpha' });
  await dragCard(page, beta, alpha, 'top');
  await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-pins .item-text')].map(e => e.textContent).join() === 'Alpha,Beta');
  await untilOrder(one, 'alpha', 0);
  await untilOrder(two, 'beta', 1);

  await dragCard(page, page.locator('.sidebar-pins .sidebar-item', { hasText: 'Alpha' }), page.locator('.sidebar-groups'));
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-pins .sidebar-item').length === 1);
  assert.equal(await pinnedInFile(one, 'alpha'), false, 'Dragging a pin out of the list unpins it.');
  await listsUntouched();

  // Opening a pin from another project moves the filter with it: the grid you come back to is
  // the card's own project, not whichever one happened to be selected.
  await page.locator('.sidebar-item', { hasText: 'Beta' }).click();
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Beta' }).waitFor();
  // The sidebar is still open: opening a card puts it away only where it covers the screen.
  await page.locator('.sidebar .project-chip.active', { hasText: 'Two' }).waitFor();

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Pin UI passed: pinned lives in the sidebar, the grid shows each card once, pins drag into order, opening a pin follows its project.');
} finally { await browser?.close(); await service.close(); }
