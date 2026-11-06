import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/probe-'));
const today = new Date().toISOString().slice(0, 10);
const mk = async (name, id) => { const dir = path.join(base, name); await mkdir(path.join(dir, id), { recursive: true }); await writeFile(path.join(dir, id, 'index.html'), '<h1>x</h1>');
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: [{ id, folder: id, title: id, description: 'd', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Page', path: 'index.html' }] }] })); return dir; };
const repo = await mkdtemp(path.join(root, '.cache/probe-app-'));
for (const d of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, d), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const registryFile = path.join(base, 'registry/workspaces.json'); await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: await mk('one', 'alpha'), name: 'Magic Loops', activate: true });
await addWorkspace({ registryFile, path: await mk('two', 'beta'), name: 'Two' });
const service = await createService({ repo, uiDir: process.env.UIDIR || path.join(root, 'dist'), registryFile });
const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
const measure = () => ({
  inner: innerWidth, doc: document.scrollingElement.scrollWidth,
  over: [...document.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth + 1 && el.clientWidth && getComputedStyle(el).overflowX !== 'visible').map(el => [el.tagName, String(el.className).slice(0, 30), el.scrollWidth, el.clientWidth, el.scrollLeft]).slice(0, 10),
  title: document.querySelector('.lib h1')?.getBoundingClientRect().left,
});
try {
  for (const [width, card] of [[360, false], [390, false], [1200, true], [1000, true]]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block', hasTouch: width < 900 });
    await ctx.addInitScript(() => { try { localStorage.setItem('buw.menuCollapsed', '0'); } catch {} });
    const page = await ctx.newPage();
    await page.goto(service.urls.workspace);
    await page.locator('[data-library] .lib-scroll').first().waitFor();
    if (card) { await page.locator('.lib-row-main').first().click(); await page.locator('.topbar').waitFor(); }
    await page.waitForTimeout(400);
    await page.locator('[data-library] .lib-search input').focus();
    await page.keyboard.type('a');
    console.log(width, card, JSON.stringify(await page.evaluate(measure)));
    await page.screenshot({ path: process.env.TEMP + `/probe-${width}.png` });
    await ctx.close();
  }
} finally { await browser.close(); await service.close?.(); }
