// Isolated local documents. No production session is touched.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = await mkdtemp(path.join(root, '.cache/links-ui-'));
await mkdir(path.join(repo, 'workspace/test'), { recursive: true });
const external = 'https://browser-check.example/page?one=1&two=2#details';
await writeFile(path.join(repo, 'workspace/test/report.html'), `<!doctype html><html><head></head><body><h1>Link report</h1><a href="${external}"><span>External report link</span></a><a href="#section">Local section</a><h2 id="section">Section</h2><a href="${external}" download>Download</a></body></html>`);
await writeFile(path.join(repo, 'workspace/test/notes.md'), `# Link notes\n\n[Markdown web link](${external})\n`);
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'test', folder: 'test', title: 'Links', category: 'dev', created: '2026-09-22', status: 'active', steps: [{ name: 'Report', path: 'report.html' }, { name: 'Notes', path: 'notes.md' }] }] }));
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: path.join(repo, 'fake-home'), env: {} } });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 650, height: 740 } });
  await context.route('https://browser-check.example/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>External destination</h1>' }));
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  async function popup(click, expected) {
    const next = context.waitForEvent('page');
    await click();
    const opened = await next;
    await opened.waitForLoadState('domcontentloaded');
    assert.equal(opened.url(), expected);
    await opened.close();
  }
  await page.goto(service.urls.workspace + '#/test/0');
  const frame = page.frameLocator('iframe.report-frame');
  await popup(() => frame.getByText('External report link').click(), external);
  await frame.getByRole('heading', { name: 'Link report' }).waitFor();
  await frame.getByText('Local section', { exact: true }).click();
  assert.equal(await frame.getByText('Local section', { exact: true }).getAttribute('target'), null);
  assert.equal(await frame.getByText('Download', { exact: true }).getAttribute('target'), null);
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await popup(() => page.getByRole('link', { name: 'Markdown web link' }).click(), external);
  await page.getByRole('heading', { name: 'Link notes' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Links UI passed: Markdown and HTML popups; local sections and download links preserved.');
} finally {
  await browser?.close(); await service.close();
}
