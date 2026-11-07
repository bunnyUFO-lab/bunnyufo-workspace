// A visitor who is not signed in, on a site that requires sign-in, is told `hub: false`: the app shows the Library alone, sends no request to
// /api/hub/, and a link to a Hub screen lands on the Library rather than an error. Against a stand-in for the site. Run after npm run build.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const today = new Date().toISOString().slice(0, 10);
const card = { id: 'alpha', folder: 'alpha', title: 'A card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Task', path: 'task.md' }] };
const dist = path.join(root, 'dist');
const hubRequests = [];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://site');
  const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
  if (url.pathname.startsWith('/api/hub/')) { hubRequests.push(url.pathname); return send(401, 'application/json', JSON.stringify({ error: 'Sign in to read this.' })); }
  if (url.pathname === '/api/capabilities') return send(200, 'application/json', JSON.stringify({ write: false, create: false, cards: false, hub: false, chat: false, reason: 'Read-only here: sign in to change cards.' }));
  if (url.pathname === '/api/card-state') return send(200, 'application/json', JSON.stringify({ cards: {} }));
  if (url.pathname === '/sites.json') return send(200, 'application/json', JSON.stringify([{ id: 'agent-plans', name: 'Agent Plans', base: '/w/agent-plans' }]));
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
  page.setDefaultTimeout(ms(15000));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/agent-plans`);
  await page.locator('.lib-row').waitFor();
  assert.deepEqual(hubRequests, [], 'The Library loads without asking the Hub for anything.');

  await page.goto(`${origin}/agent-plans#/~hub/today`);
  await page.locator('.lib-row').waitFor();
  await page.waitForTimeout(ms(1000));
  assert.deepEqual(hubRequests, [], 'A link to a Hub screen sends no Hub request.');
  assert.deepEqual(errors, [], 'No error is shown or thrown.');
  console.log('Hub guest UI passed: the Library alone, no Hub request.');
} finally { await browser.close(); server.close(); }
