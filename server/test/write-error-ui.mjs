// Two things the published site got wrong, against a stand-in for the proxy in front of it.
//
// A card write that lands on a sign-in page must say so, not "Unexpected token '<'": the site is
// behind Authelia and an expired session answers /api with HTML, which the app parsed as JSON.
//
// And a card's source link must point inside the repository it is actually in. Sections share one
// repository now, each in its own folder, so the card folder alone named a path that is not there.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const today = new Date().toISOString().slice(0, 10);
const card = { id: 'alpha', folder: 'alpha', title: 'A pinned card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active', pinned: true, steps: [{ name: 'Task', path: 'task.md' }] };

// Stands in for Caddy: the built app, the workspace list, and an /api that behaves like the
// proxy did — capabilities pass, and the write gets the login page.
const dist = path.join(root, 'dist');
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://site');
  const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
  if (url.pathname === '/api/capabilities') return send(200, 'application/json', JSON.stringify({ write: true, create: false }));
  if (url.pathname === '/api/card-state') return send(200, 'application/json', JSON.stringify({ cards: {} }));
  if (url.pathname.startsWith('/api/')) return send(200, 'text/html', '<html> <head><title>Sign in</title></head><body>Authelia</body></html>');
  // The real list, shape and all: one repository, the section in a folder inside it.
  if (url.pathname === '/sites.json') return send(200, 'application/json', JSON.stringify([{
    id: 'agent-plans', name: 'Agent Plans', base: '/w/agent-plans',
    repo: 'https://github.com/example-org/workspace-data',
    branch: 'main', path: 'sections/agent-plans',
  }]));
  if (url.pathname === '/w/agent-plans/workspace.json') return send(200, 'application/json', JSON.stringify({ entities: [card] }));
  try {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const body = await readFile(path.join(dist, file));
    return send(200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body);
  } catch { return send(200, 'text/html', await readFile(path.join(dist, 'index.html'))); }
});
await listenOnGoodPort(server, '127.0.0.1');
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${origin}/agent-plans`);
  await page.locator('.entity-card .card-pin').waitFor();
  await page.locator('.entity-card .card-pin').click();
  const bar = page.locator('.write-error');
  await bar.waitFor();
  const text = await bar.textContent();
  console.log('error bar says:', JSON.stringify(text.replace('×', '').trim()));
  assert.ok(!text.includes('Unexpected token'), 'The JSON parse error must not reach the user.');
  assert.match(text, /Signed out|not JSON/);
  // One error UI: the shell's bar, and nothing else, even with a preview open over the app.
  assert.equal(await page.locator('.app-error').count(), 0);
  assert.equal(await page.locator('.write-error').count(), 1);

  // The source link, which has to carry the section's folder inside the repository.
  await page.locator('.entity-card .card-link').click();
  const source = page.locator('a[href*="/blob/"]').first();
  await source.waitFor();
  const href = await source.getAttribute('href');
  console.log('source link:', href);
  assert.equal(href, 'https://github.com/example-org/workspace-data/blob/main/sections/agent-plans/alpha/task.md');

  // A host that refuses the probe is present but not signed in: say so, do not show an empty board.
  const refused = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  refused.setDefaultTimeout(15000);
  await refused.route('**/api/capabilities', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Sign in to continue' }) }));
  await refused.goto(`${origin}/agent-plans`);
  await refused.getByText('Sign in to continue', { exact: true }).waitFor();
  await refused.getByRole('button', { name: 'Reload', exact: true }).waitFor();
  assert.equal(await refused.locator('.entity-card').count(), 0);
  console.log('Write-error UI passed: a sign-in page is reported as one, and a source link points inside its repository.');
} finally { await browser.close(); server.close(); }
