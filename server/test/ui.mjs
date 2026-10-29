// Run after npm run build. Isolated browser and repository; no agent login,
// live conversation, Windows shortcut or production setting is touched.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(root, '.cache/workspace-ui-'));
for (const dir of ['workspace/test', 'knowledge', 'processes', '.claude/skills/example', '.agents/skills/example', 'inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
await writeFile(path.join(repo, '.claude/skills/example/SKILL.md'), '# Example skill\n\n**Read me**\n');
const documentPath = path.join(repo, 'knowledge/notes.md');
await writeFile(documentPath, '# A useful document\n\n| Name | State |\n| --- | --- |\n| Example | Ready |\n\n**Bold text**\n');
const steps = Array.from({ length: 12 }, (_, index) => ({ name: `Step ${index + 1} - complete English title`, path: `step${index}.html` }));
for (const [index, step] of steps.entries()) await writeFile(path.join(repo, 'workspace/test', step.path), `<h1>Document ${index + 1}</h1><p>Readable content.</p>`);
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'test', folder: 'test', title: 'Workspace test', category: 'test', created: '2026-09-15', status: 'active', steps }] }));
await cp(path.join(root, 'public/assets'), path.join(root, 'dist/assets'), { recursive: true });
const mcpHome = path.join(repo, 'fake-home'); await mkdir(path.join(mcpHome, '.codex'), { recursive: true });
await writeFile(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'fixture-tools': { url: 'https://fixture.example/mcp', headers: { Authorization: 'private-ui-fixture-token' } } } }));
await writeFile(path.join(repo, '.claude/settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
await writeFile(path.join(mcpHome, '.codex/config.toml'), '[mcp_servers."global-tools"]\nurl="https://global.example/mcp"\n');
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: mcpHome, env: {}, probe: async () => ({ status: 'available', toolCount: 7 }) } });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 900, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace + '#/test/0');
  for (let index = 0; index < 12; index++) { await page.getByRole('tab').nth(index).click(); await page.frameLocator('iframe.report-frame').getByRole('heading', { name: `Document ${index + 1}`, exact: true }).waitFor(); }
  let releaseReport;
  const delayedReport = new Promise(resolve => { releaseReport = resolve; });
  await page.route('**/test/step0.html*', async route => { if (route.request().method() === 'GET') await delayedReport; await route.continue(); });
  await page.getByRole('tab').nth(0).click();
  try {
    await page.getByRole('status').filter({ hasText: 'Opening report' }).waitFor();
    assert.equal(await page.locator('iframe.report-frame').evaluate(element => getComputedStyle(element).visibility), 'hidden');
    assert.equal(await page.locator('.report-document').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(10, 11, 13)');
  } finally { releaseReport(); }
  await page.locator('.report-document[aria-busy=false]').waitFor();
  assert.equal(await page.frameLocator('iframe.report-frame').locator('body').evaluate(element => getComputedStyle(element).scrollbarColor), 'rgb(81, 76, 89) rgb(17, 18, 23)');
  await page.unroute('**/test/step0.html*');
  await page.route('**/test/step1.html', route => route.request().method() === 'HEAD' ? route.fulfill({ status: 404 }) : route.continue());
  await page.getByRole('tab').nth(1).click();
  await page.getByText('Page unavailable (404).', { exact: true }).waitFor();
  await page.unroute('**/test/step1.html');
  await page.getByRole('tab').nth(2).click();
  await page.locator('.report-document[aria-busy=false]').waitFor();
  await page.getByRole('button', { name: 'Toggle files', exact: true }).click();
  await page.getByRole('treeitem', { name: /^knowledge$/ }).click();
  await page.getByRole('treeitem', { name: /^notes.md/ }).click();
  await page.getByRole('heading', { name: 'A useful document' }).waitFor(); assert.equal(await page.locator('.buw-markdown table').count(), 1);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit notes.md' }).fill('# Edited document\n\nUnicode: русский 🐽\n');
  await page.getByRole('textbox', { name: 'Edit notes.md' }).press('Control+s');
  await page.getByText('Saved', { exact: true }).waitFor(); assert.match(await readFile(documentPath, 'utf8'), /русский 🐽/);
  // A URL pasted over selected text links it.
  await page.getByRole('textbox', { name: 'Edit notes.md' }).evaluate(content => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); let node
    while ((node = walker.nextNode()) && !node.textContent.includes('Edited document')) { /* find the heading */ }
    const range = document.createRange(), at = node.textContent.indexOf('document')
    range.setStart(node, at); range.setEnd(node, at + 'document'.length)
    getSelection().removeAllRanges(); getSelection().addRange(range)
  });
  await page.waitForTimeout(100);
  await page.getByRole('textbox', { name: 'Edit notes.md' }).evaluate(content => {
    const data = new DataTransfer(); data.setData('text/plain', 'https://example.com/doc')
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  });
  await page.getByText('# Edited [document](https://example.com/doc)').waitFor();
  await page.getByRole('textbox', { name: 'Edit notes.md' }).press('Control+z');
  // The toolbar formats the selection without taking the editor's focus.
  await page.getByRole('textbox', { name: 'Edit notes.md' }).press('Control+Home');
  await page.getByRole('textbox', { name: 'Edit notes.md' }).press('Shift+End');
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' }).click();
  await page.getByText('**# Edited document**').waitFor();
  await page.getByRole('textbox', { name: 'Edit notes.md' }).press('Control+z');
  await writeFile(documentPath, '# Changed by another agent\n');
  await page.getByRole('textbox', { name: 'Edit notes.md' }).fill('# My unsaved draft\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText(/This file changed on disk/).waitFor(); assert.match(await readFile(documentPath, 'utf8'), /another agent/);
  await page.getByRole('button', { name: 'Close file preview' }).click();
  // At this width the panel overlays the page, so choosing a file put it away: bring it back.
  await page.getByRole('button', { name: 'Toggle files', exact: true }).click();
  await page.getByRole('treeitem', { name: /^notes.md/ }).click();
  await page.getByRole('heading', { name: 'My unsaved draft' }).waitFor();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('heading', { name: 'Changed by another agent' }).waitFor();
  await page.getByRole('button', { name: 'Close file preview' }).click();
  await page.getByRole('button', { name: 'Toggle skills', exact: true }).click();
  await page.getByRole('treeitem', { name: /^example$/ }).click(); await page.getByRole('treeitem', { name: /^SKILL.md/ }).click();
  await page.getByRole('heading', { name: 'Example skill' }).waitFor();
  await page.getByRole('button', { name: 'Toggle mcp', exact: true }).click();
  await page.getByRole('heading', { name: 'fixture-tools', exact: true }).waitFor();
  assert.equal((await page.locator('.mcp-panel').innerText()).includes('private-ui-fixture-token'), false);
  await page.getByRole('button', { name: 'Check fixture-tools for Claude', exact: true }).click();
  await page.locator('[data-mcp-id="claude:fixture-tools"]').getByText('7 tools', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Filter MCP by agent' }).selectOption('codex');
  await page.getByRole('heading', { name: 'global-tools', exact: true }).waitFor();
  assert.equal(await page.locator('.mcp-server').count(), 1);
  await page.getByRole('combobox', { name: 'Filter MCP by scope' }).selectOption('project');
  await page.getByText('No MCP servers match these filters.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close MCP', exact: true }).click();
  assert.deepEqual(errors, []);
  // Signed out is not absent: a page with no token meets the service and says so.
  const stranger = await (await browser.newContext({ viewport: { width: 900, height: 800 } })).newPage(); stranger.setDefaultTimeout(10000);
  await stranger.goto(service.origin + '/');
  await stranger.getByText('Open bunnyUFO Workspace from the address its service printed', { exact: true }).waitFor();
  await stranger.getByRole('button', { name: 'Reload', exact: true }).waitFor();
  assert.equal(await stranger.locator('.entity-card').count(), 0);
  console.log('UI passed: 12 clickable wrapping tabs; Markdown preview/edit/save/conflict/draft; local Skills; MCP filtering, checks and hidden credentials.');
} finally {
  await browser?.close();
  await service.close();
}
