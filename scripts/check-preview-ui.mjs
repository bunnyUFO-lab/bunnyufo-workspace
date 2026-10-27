// Exercise browser-only preview with the real predev setup, including a failed lazy import.
// No local service, CLI sessions, or user profile is opened.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// npm run dev removes a leftover public/workspace junction in its predev step; the dev server's
// plugin serves /workspace. Check a workspace of this script's own making, not whatever the user
// has active: the app repo ships the site template and only the sample cards.
const fixture = path.join(root, '.cache', 'preview-workspace');
await rm(fixture, { recursive: true, force: true });
await cp(path.join(root, 'workspace'), fixture, { recursive: true, filter: source => !/[\/](_site|\.jekyll-cache)$/.test(source) });
const card = {
  id: 'preview-fixture', title: 'Preview fixture', description: 'One card with a report and a Markdown page.',
  type: 'group', category: 'dev', created: '2026-10-09', updated: '2026-10-09', folder: 'preview-fixture',
  steps: [{ name: 'Report', path: 'report.html' }, { name: 'Notes', path: 'notes.md' }],
  status: 'active', pinned: false, defaultStep: 0,
};
const swatch = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%23ee3377'/%3E%3C/svg%3E";
await mkdir(path.join(fixture, card.folder), { recursive: true });
// A report like the ones the workspace-authoring skill writes: the shared stylesheet and script,
// and the attribute the app's theme override looks for.
await writeFile(path.join(fixture, card.folder, 'report.html'), [
  '<!doctype html><html lang="en" data-buw-report="document"><head><meta charset="utf-8">',
  '<link rel="stylesheet" href="../_shared/report.css"><title>Preview fixture</title></head>',
  '<body><main><header><h1>Preview fixture</h1><p class="meta">A report for the browser checks.</p></header>',
  `<section class="buw-card"><h2>Media</h2><p><img alt="Artwork" width="80" height="80" src="${swatch}"></p></section>`,
  '</main><script src="../_shared/report.js"></script></body></html>', ''].join('\n'));
await writeFile(path.join(fixture, card.folder, 'notes.md'), '# Notes\n\nA Markdown page for the reader checks.\n');
await writeFile(path.join(fixture, 'workspace.json'), `${JSON.stringify({ entities: [card] }, null, 2)}\n`);
process.env.BUW_CONTENT = fixture;
await import('./ensure-workspace-link.mjs');
const entities = [card];
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false, watch: null, hmr: false } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: process.env.BUW_TEST_BROWSER || 'msedge', headless: true });
  // The dev server proxies /api, /sites.json and /w to a site API on 127.0.0.1:8099 when one is
  // running, which would make this check depend on whatever that process happens to serve. Answer
  // as a site with no data service does, so every page here sees the same thing.
  const site = { sites: [], capabilities: { write: false, create: false }, state: { cards: {} } };
  const noApi = async target => {
    await target.route('**/sites.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(site.sites) }));
    await target.route('**/api/capabilities', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(site.capabilities) }));
    await target.route('**/api/card-state', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(site.state) }));
    await target.route('**/w/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no section"}' }));
  };
  const page = await browser.newPage();
  await noApi(page);
  // A site with a data service behind a login: a write must carry no Authorization header. The
  // local token used to go out as an empty `Bearer ` and the proxy's forward-auth refused it.
  const writes = [];
  await page.route('**/api/capabilities', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ write: true, create: false }) }));
  await page.route('**/api/workspace/status', route => {
    writes.push(route.request().headers());
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: card.id, status: 'archived' }) });
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  // Embedded local web apps (Sprite Studio, ComfyUI) log their own errors; only the Workspace's count.
  const origin = new URL(url).origin;
  page.on('pageerror', error => {
    const stack = error.stack || '';
    if (!/https?:\/\//.test(stack) || stack.includes(origin)) errors.push(error.message);
  });
  page.on('console', message => {
    const source = message.location().url;
    if (message.type() === 'error' && (!source || source.startsWith(origin))) errors.push(message.text());
  });
  await page.goto(url);
  let steps = 0;
  for (const entity of entities.filter(item => item.status !== 'archived')) {
    await page.locator(`.entity-card[data-entity="${entity.id}"]`).click();
    await page.getByRole('tab', { name: entity.steps[entity.defaultStep ?? entity.steps.length - 1].name, exact: true }).waitFor();
    for (const [index, step] of entity.steps.entries()) {
      await page.locator('.step-tab').nth(index).click();
      if (step.url) {
        // A live web tab (Sprite Studio, ComfyUI) shows the running app or, when it is down, its instructions.
        await page.locator('.web-view-bar').waitFor();
      } else if (/\.html$/i.test(step.path)) {
        await page.locator('.report-document[aria-busy=false]').waitFor();
        await page.frameLocator('iframe.report-frame').locator('h1:visible').first().waitFor();
      } else {
        await page.locator('.buw-markdown h1').waitFor();
      }
      steps++;
    }
    // With a card open the first crumb is the way back, labelled "← Cards" (the arrow is aria-hidden).
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    await page.locator('.entity-card').first().waitFor();
  }
  assert.deepEqual(errors, []);
  await page.locator(`.entity-card[data-entity="${card.id}"] .card-archive`).click();
  for (let waited = 0; !writes.length && waited < 10000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writes.length, 1, 'the archive button made one write');
  assert.equal(writes[0].authorization, undefined, 'a site write carries no Authorization header');
  assert.deepEqual(errors, []);

  // Exercise Markdown images as well as links against a root-relative document.
  const mdEntity = entities.find(entity => entity.steps.some(step => /\.md$/i.test(step.path)));
  const mdIndex = mdEntity.steps.findIndex(step => /\.md$/i.test(step.path));
  const mdPath = `/workspace/${mdEntity.folder}/${mdEntity.steps[mdIndex].path}`;
  await page.route(new URL('../reference.png', new URL(mdPath, url)).href, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="pink"/></svg>',
  }));
  await page.route(new URL(mdPath, url).href, route => route.fulfill({
    contentType: 'text/plain',
    body: '# Relative references\n\n[Local file](../notes.md)\n\n[External](https://example.com/)\n\n![Reference](../reference.png)',
  }));
  await page.goto(`${url}#/${mdEntity.id}/${mdIndex}`);
  await page.locator('.buw-markdown h1').waitFor();
  assert.equal(await page.getByRole('link', { name: 'Local file', exact: true }).getAttribute('href'), new URL('../notes.md', new URL(mdPath, url)).href);
  assert.equal(await page.getByRole('link', { name: 'External', exact: true }).getAttribute('href'), 'https://example.com/');
  assert.equal(await page.getByRole('img', { name: 'Reference', exact: true }).getAttribute('src'), new URL('../reference.png', new URL(mdPath, url)).href);
  // A long Markdown page has to scroll inside .content, which clips its overflow. Its own page, so
  // the routes above stay in place and the document is fetched fresh.
  const longPage = await browser.newPage();
  await noApi(longPage);
  longPage.setDefaultTimeout(15000);
  const longBody = ['# Long page'].concat(Array.from({ length: 200 }, (_, index) => `Paragraph ${index + 1}.`)).join('\n\n');
  await longPage.route(new URL(mdPath, url).href, route => route.fulfill({ contentType: 'text/plain', body: longBody }));
  await longPage.goto(`${url}#/${mdEntity.id}/${mdIndex}`);
  await longPage.locator('.buw-markdown h1').waitFor();
  const scrolling = await longPage.evaluate(() => {
    const reader = document.querySelector('.markdown-reader');
    const content = document.querySelector('.content');
    reader.scrollTop = 400;
    return {
      bounded: reader.clientHeight <= content.clientHeight + 2,
      scrollable: reader.scrollHeight > reader.clientHeight + 2,
      scrollTop: reader.scrollTop,
    };
  });
  assert.ok(scrolling.scrollable, 'the long Markdown fixture should overflow its reader');
  assert.ok(scrolling.bounded, 'the Markdown reader must not grow past the area that clips it');
  assert.ok(scrolling.scrollTop > 0, 'a long Markdown page must scroll');
  await longPage.close();

  // The home hero: the greeting on a wide screen, the wordmark beside the logo on a phone.
  const greetingText = /What are we building|Good (morning|evening)|midnight oil/;
  const phoneHome = await (await browser.newContext({ viewport: { width: 375, height: 812 } })).newPage();
  await noApi(phoneHome);
  phoneHome.setDefaultTimeout(15000);
  await phoneHome.goto(url);
  await phoneHome.locator('.home-hero canvas').waitFor();
  assert.equal(await phoneHome.locator('.home-hero').getByText(greetingText).count(), 0, 'a phone shows the wordmark, not the greeting');
  assert.equal(await phoneHome.locator('.home-hero .home-sub').count(), 1, 'the stats line stays');
  await phoneHome.close();
  const wideHome = await browser.newPage();
  await noApi(wideHome);
  wideHome.setDefaultTimeout(15000);
  await wideHome.setViewportSize({ width: 1280, height: 800 });
  await wideHome.goto(url);
  await wideHome.locator('.home-hero h1.home-title').waitFor();
  assert.match(await wideHome.locator('.home-hero h1.home-title').innerText(), greetingText);
  assert.equal(await wideHome.locator('.home-hero canvas').count(), 0, 'a wide screen has no wordmark in the hero');
  await wideHome.close();

  // The shared stylesheet must still style the app's image dialog after bundling.
  await page.getByRole('img', { name: 'Reference', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Image preview', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(12, 13, 17)');
  assert.equal(await dialog.evaluate(node => getComputedStyle(node).display), 'flex');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);

  // One shell on every host: the site's rail offers the tools it can serve, and no others, and the
  // top bar carries no tools of its own.
  for (const name of ['Toggle skills', 'Toggle settings', 'Keyboard shortcuts']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `${name} is on the rail`);
  for (const name of ['Toggle files', 'Toggle mcp']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `${name} needs a host with files`);
  assert.equal(await page.locator('.browser-settings').count(), 0);
  // Browser-only Settings use local storage and style embedded reports too.
  await page.getByRole('button', { name: 'Toggle settings', exact: true }).click();
  await page.getByLabel('Workspace theme', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Toggle settings', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-workspace-theme'), 'light');
  assert.equal(await page.locator('.buw-markdown h1').evaluate(node => getComputedStyle(node).color), 'rgb(17, 21, 33)');
  await page.getByRole('img', { name: 'Reference', exact: true }).click();
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(242, 244, 247)');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(`${url}#/${card.id}/0`);
  await page.locator('.report-document[aria-busy=false]').waitFor();
  const report = page.frameLocator('iframe.report-frame');
  assert.equal(await report.locator('html').getAttribute('data-buw-theme'), 'light');
  assert.equal(await report.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
  await page.reload();
  await page.locator('.report-document[aria-busy=false]').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-workspace-theme'), 'light');
  assert.deepEqual(errors, []);

  // A blocked module used to unmount the entire React tree. Keep navigation,
  // show the actual error, and let a reload recover once the block is gone.
  const failed = await browser.newPage();
  await noApi(failed);
  failed.setDefaultTimeout(15000);
  await failed.route('**/src/components/ReportViewer.tsx*', route => route.abort('failed'));
  await failed.goto(url);
  await failed.locator('.entity-card').first().click();
  await failed.getByRole('alert').waitFor();
  assert.equal(await failed.getByRole('button', { name: 'Cards', exact: true }).count(), 1);
  await failed.getByRole('button', { name: 'Back to Workspace', exact: true }).click();
  await failed.locator('.entity-card').first().waitFor();
  await failed.locator('.entity-card').first().click();
  await failed.getByRole('alert').waitFor();
  await failed.unroute('**/src/components/ReportViewer.tsx*');
  await failed.getByRole('button', { name: 'Reload page', exact: true }).click();
  // The first card's default page may be Markdown or an HTML report.
  await failed.locator('.report-document[aria-busy=false], .buw-markdown h1').first().waitFor();
  assert.equal(await failed.getByRole('alert').count(), 0);
  // A published site serving several workspaces: the address picks which one, and an id the site
  // does not serve says so. Resolution used to return the first entry for every address, so a
  // correct address quietly showed another workspace's cards.
  const multi = await browser.newPage();
  multi.setDefaultTimeout(15000);
  await noApi(multi);   // the routes below are registered later, so they take precedence
  const published = [
    { id: 'first', name: 'First Workspace', base: '/workspace' },
    { id: 'second', name: 'Second Workspace', base: '/workspace', publishedAt: '2026-10-11T00:00:00.000Z' },
    { id: 'third', name: 'Third Workspace', base: '/w/third' },
  ];
  // A third workspace with a pinned card of its own: a pin is listed whatever the address says,
  // so it is the one card that can be opened from another project's page.
  const pinnedCard = {
    id: 'third-only', title: 'Third only', description: 'Pinned, and in another project.', type: 'standalone',
    category: 'dev', created: '2026-10-09', updated: '2026-10-09', folder: 'third-only', pinned: true,
    status: 'active', steps: [{ name: 'Page', path: 'page.html' }],
  };
  await multi.route('**/w/third/workspace.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entities: [pinnedCard] }) }));
  await multi.route('**/w/third/third-only/page.html*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Third only</title><h1>Third only</h1>' }));
  await multi.route('**/sites.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(published) }));
  // waitFor, not count: resolveSite fetches sites.json before the app mounts, so the header
  // is not on the page yet when the navigation settles.
  await multi.goto(new URL('/second', url).href);
  await multi.getByRole('button', { name: /^Workspace: Second Workspace\./ }).first().waitFor();
  // A section served from the bucket has no repository behind it, so there is no source link to
  // offer — and none is, rather than one that would 404.
  await multi.locator('.entity-card').first().click();
  await multi.locator('.report-document[aria-busy=false], .buw-markdown h1').first().waitFor();
  assert.equal(await multi.getByRole('link', { name: 'Open this page in the repository' }).count(), 0, 'no repo, no source link');

  await multi.goto(new URL('/first', url).href);
  await multi.getByRole('button', { name: /^Workspace: First Workspace\./ }).first().waitFor();

  // Opening a pin from another project rewrites the address to that project. It used to keep
  // the one in the bar — /first#/third-only — so the link you copied opened the wrong page.
  await multi.locator('.sidebar-item', { hasText: 'Third only' }).click();
  await multi.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Third only' }).waitFor();
  await multi.waitForFunction(() => location.pathname === '/third');
  assert.equal(new URL(multi.url()).hash, '#/third-only');
  // Back returns to the page the card was opened from, not to the same card under /first.
  await multi.goBack();
  await multi.waitForFunction(() => location.pathname === '/first' && !location.hash);

  await multi.goto(new URL('/nope', url).href);
  await multi.getByRole('heading', { name: 'No workspace "nope" here' }).waitFor();

  console.log(`Browser preview passed: ${entities.length} cards, ${steps} steps, workspace resolution and failed-module recovery.`);
} finally {
  await browser?.close();
  await server.close();
}
