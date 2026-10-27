// Run after npm run build. Isolated repository and browser profile; the fixture card is the only
// file written.
//
// HTML edit mode edits the file's own source with scripts off, and saves it back: text a person
// typed lands in the file, what a script drew at run time does not, and the editor's own
// additions (base, theme, outlines) never reach disk. Single-letter shortcuts stay quiet while
// you type, and Q/E walk the card's tabs.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(root, '.cache/html-edit-ui-'));
for (const dir of ['workspace/edit', 'inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const page1 = path.join(repo, 'workspace/edit/page.html');
await writeFile(page1, '<!DOCTYPE html>\n<html><head><title>Fixture</title><link rel="stylesheet" href="style.css"></head><body><h1>Old title</h1><p id="note" style="color: #112233">Some text.</p><img id="pic" src="pic.svg" alt=""><script>document.body.insertAdjacentHTML("beforeend", "<p id=drawn>drawn by script</p>")</script></body></html>\n');
await writeFile(path.join(repo, 'workspace/edit/style.css'), '#note { text-indent: 13px }');
await writeFile(path.join(repo, 'workspace/edit/pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
await writeFile(path.join(repo, 'workspace/edit/second.html'), '<h1>Second tab</h1>');
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{
  id: 'edit', folder: 'edit', title: 'Edit me', category: 'test', created: today, updated: today, status: 'active',
  steps: [{ name: 'Page', path: 'page.html' }, { name: 'Second', path: 'second.html' }],
}] }));

const service = await createService({ repo, uiDir: path.join(root, 'dist') });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage()
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const logs = []; page.on('console', message => logs.push(message.text()));
  await page.goto(service.urls.workspace + '#/edit/0');
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Old title' }).waitFor();

  // → and ← walk the tabs.
  await page.locator('body').press('ArrowRight');
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Second tab' }).waitFor();
  await page.locator('body').press('ArrowLeft');
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Old title' }).waitFor();

  // Ctrl+E opens edit mode on the file's source: the script did not run.
  await page.keyboard.press('Control+e');
  const editor = page.frameLocator('iframe[title="Editing Page"]');
  await editor.getByRole('heading', { name: 'Old title' }).waitFor();
  assert.equal(await editor.locator('#drawn').count(), 0);
  // The page's own stylesheet and image load in the editor frame (it has its own CSP, not the app's).
  await editor.locator('#note').waitFor();
  await page.waitForFunction(() => {
    const d = document.querySelector('iframe[title="Editing Page"]')?.contentDocument;
    const pic = d?.getElementById('pic');
    return d && pic?.naturalWidth === 10 && getComputedStyle(d.getElementById('note')).textIndent === '13px';
  });
  assert.equal(logs.filter(text => /Content Security Policy|base-uri/.test(text)).length, 0, logs.join(' | '));

  // The toolbar reflects the selection and respects it.
  const colour = page.locator('input[aria-label="Text colour"]');
  const bold = page.getByRole('button', { name: 'B', exact: true });
  await editor.locator('#note').selectText();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Text colour"]').value === '#112233');
  assert.equal(await bold.getAttribute('aria-pressed'), 'false');
  await bold.click();
  assert.equal(await bold.getAttribute('aria-pressed'), 'true');
  await editor.locator('h1').selectText();
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-pressed]')].find(b => b.textContent === 'B')?.getAttribute('aria-pressed') === 'true');
  // A colour moving inside the picker changes nothing in the page; committing it does.
  await editor.locator('#note').selectText();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Text colour"]').value === '#112233');
  await colour.evaluate(el => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await editor.locator('#note').evaluate(el => el.innerHTML.includes('255, 0, 0')), false, 'input alone does not colour the text');
  await colour.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
  assert.equal(await editor.locator('#note').evaluate(el => el.innerHTML.includes('255, 0, 0')), true, 'change colours the text');
  // Larger text steps up from the size the text has now.
  await editor.locator('#note').selectText();
  await page.getByRole('button', { name: 'Larger text' }).click();
  assert.match(await editor.locator('#note').innerHTML(), /font-size: large/);

  // Typing "a", "q" and "p" edits the text and touches no shortcut: the card stays open.
  await editor.locator('h1').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' — a queued, pinned edit');
  assert.match(page.url(), /#\/edit\/0$/);
  assert.equal(await page.locator('.archive-chip.active').count(), 0);

  await page.keyboard.press('Control+s');
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  const saved = await readFile(page1, 'utf8');
  assert.match(saved, /^<!DOCTYPE html>\n/);
  assert.match(saved, /Old title — a queued, pinned edit/);
  assert.match(saved, /font-weight: bold|<b>/);
  assert.match(saved, /<script>document\.body\.insertAdjacentHTML/);
  assert.equal(saved.split("drawn by script").length, 2, "only the script source, not its output");
  assert.doesNotMatch(saved, /data-buw-edit|<base|data-buw-theme/);
  assert.match(saved, /font-size: large/);
  assert.match(saved, /href="style\.css"/);
  assert.match(saved, /src="pic\.svg"/);

  // Esc leaves edit mode without leaving the card; the page reloads from disk with the edit.
  await page.keyboard.press('Escape');
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: /a queued, pinned edit/ }).waitFor();
  assert.match(page.url(), /#\/edit\/0$/);
  // Q is the way back to the cards.
  await page.locator('body').press('q');
  await page.locator('.home').waitFor();

  // In the search box: ↓ walks headings and cards, Space folds a heading (and folds the board's
  // section with it: one state), Enter opens a card.
  await page.keyboard.press('Control+Shift+f');
  const search = page.getByRole('textbox', { name: 'Search entities' });
  await search.waitFor();
  await search.press('ArrowDown');
  await page.locator('.sidebar-section-toggle.cursor').waitFor();
  await search.press(' ');
  await page.waitForFunction(() => document.querySelectorAll('.home .entity-card').length === 0);
  assert.equal(await search.inputValue(), '', 'Space on a heading is not typed into the search');
  await search.press(' ');
  await page.locator('.home .entity-card').first().waitFor();
  await search.press('ArrowDown');
  await page.locator('.sidebar-item.cursor').waitFor();
  await search.press('Enter');
  await page.waitForFunction(() => location.hash === '#/edit');
  await page.locator('iframe.report-frame').waitFor();

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('html edit ui: ok');
} finally { await browser?.close(); await service.close(); }
