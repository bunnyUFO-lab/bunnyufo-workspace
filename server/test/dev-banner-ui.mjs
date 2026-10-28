// The development copy says so: a banner naming the branch above the app and a [dev] title, and
// nothing of the kind on a host that reports no `dev`. Against a stand-in for the site.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const today = new Date().toISOString().slice(0, 10);
const card = { id: 'alpha', folder: 'alpha', title: 'A card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Task', path: 'task.md' }] };
const dist = path.join(root, 'dist');
const state = { dev: { branch: 'sprint/ws-1-example', sha: '0123456789abcdef', pr: 42, at: '2026-10-28T10:00:00Z' } };

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://site');
  const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
  if (url.pathname === '/api/capabilities') return send(200, 'application/json', JSON.stringify({ write: false, create: false, ...(state.dev ? { dev: state.dev } : {}) }));
  if (url.pathname === '/api/card-state') return send(200, 'application/json', JSON.stringify({ cards: {} }));
  if (url.pathname === '/sites.json') return send(200, 'application/json', JSON.stringify([{ id: 'agent-plans', name: 'Agent Plans', base: '/w/agent-plans' }]));
  if (url.pathname === '/w/agent-plans/workspace.json') return send(200, 'application/json', JSON.stringify({ entities: [card] }));
  try {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const body = await readFile(path.join(dist, file));
    return send(200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body);
  } catch { return send(200, 'text/html', await readFile(path.join(dist, 'index.html'))); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
try {
  const open = async () => {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`${origin}/agent-plans`);
    await page.locator('.entity-card').waitFor();
    return page;
  };

  const dev = await open();
  const banner = dev.locator('[data-dev-banner]');
  await banner.waitFor();
  const text = (await banner.textContent()).replace(/\s+/g, ' ').trim();
  console.log('banner says:', JSON.stringify(text));
  assert.match(text, /^Development copy\s*· sprint\/ws-1-example\s*· 0123456\s*· PR #42$/);
  assert.match(await dev.title(), /^\[dev\] /);
  assert.equal(await banner.locator('button').count(), 0, 'The banner cannot be dismissed.');
  const box = await dev.locator('.app-layout').boundingBox();
  assert.ok(box.y >= 28 && box.y + box.height <= 900, 'The layout sits under the banner without overflowing.');

  // Light theme at phone width: the bar keeps its colour and the menu button sits below it.
  const phone = await (await browser.newContext({ viewport: { width: 375, height: 700 } })).newPage();
  phone.setDefaultTimeout(15000);
  await phone.addInitScript(() => { try { localStorage.setItem('buw.workspaceTheme', 'light'); } catch {} });
  await phone.goto(`${origin}/agent-plans`);
  await phone.locator('[data-dev-banner]').waitFor();
  assert.equal(await phone.locator('html').getAttribute('data-workspace-theme'), 'light');
  const bar = await phone.locator('[data-dev-banner]').boundingBox();
  assert.equal(await phone.locator('[data-dev-banner]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 196, 81)', 'The bar is the same amber in light theme.');
  const toggle = await phone.locator('.rail-toggle').boundingBox();
  assert.ok(toggle.y >= bar.y + bar.height, `The menu button (top ${toggle.y}) sits below the bar (bottom ${bar.y + bar.height}).`);

  state.dev = null;
  const real = await open();
  assert.equal(await real.locator('[data-dev-banner]').count(), 0);
  assert.doesNotMatch(await real.title(), /^\[dev\]/);

  state.dev = { branch: null };
  const bare = await open();
  assert.match((await bare.locator('[data-dev-banner]').textContent()), /no branch deployed yet/);
  console.log('Dev banner UI passed: shown with the branch on the dev copy, absent on the real site.');
} finally { await browser.close(); server.close(); }
