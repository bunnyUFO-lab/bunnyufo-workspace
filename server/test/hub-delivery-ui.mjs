// Run after npm run build. Where an answer went, on the Ask's own page through a real browser over the hub fixture: an answered
// Ask shows one line under the answer in four states (delivered, watching, not delivered after N minutes, no session
// watching), "Open the session" only with a safe link, nothing for an Ask nobody answered or a picked-up one. At 1280 and
// 375 px; nothing scrolls sideways. With BUW_SHOT_DIR set it also saves a screenshot of each state there.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { askId, startHubFixture } from './hub-fixture.mjs';
import { askJson, plainOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const shots = process.env.BUW_SHOT_DIR;
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const answer = minutes => ({ choice: 'A', at: ago(minutes), by: 'owner' });
const watch = { v: 1, session: 'abcd1234-5678', host: 'pc-one', folder: 'demo-repo', project: 'probe', at: ago(30), url: 'https://claude.ai/code/session_demo', appUrl: 'claude://claude.ai/code/session_demo' };

const fixture = await startHubFixture();
const browser = await chromium.launch({ headless: true, channel });
try {
  if (shots) await mkdir(shots, { recursive: true });
  const seed = (tail, files, question) => {
    const id = askId('delivery', tail);
    fixture.seed.ask(askJson({ id, options: plainOptions(), question: question ?? 'Which jump arc feels right?' }), { files });
    return id;
  };
  const asks = {
    delivered: seed('a1b1', { 'answer.json': answer(12), 'watch-abcd1234.json': watch, 'delivered.json': { v: 1, at: ago(2), session: 'abcd1234-5678', host: 'pc-one', how: 'woke' } }),
    watching: seed('a1b2', { 'answer.json': answer(2), 'watch-abcd1234.json': watch }),
    stale: seed('a1b3', { 'answer.json': answer(12), 'watch-abcd1234.json': { ...watch, appUrl: 'javascript:alert(1)', url: 'https://claude.ai/code/session_demo' } }),
    none: seed('a1b4', { 'answer.json': answer(3) }),
    picked: seed('a1b5', { 'answer.json': answer(30), 'pickup.json': { at: ago(20), host: 'pc-one' } }),
    open: seed('a1b6', {}),
    // Handed over in a later session's start note: no watch file, so no folder.
    started: seed('a1b7', { 'answer.json': answer(12), 'delivered.json': { v: 1, at: ago(8), session: 'ef567890-1234', host: 'pc-one', how: 'start' } }),
  };
  await new Promise(resolve => setTimeout(resolve, 150));

  for (const [name, viewport] of [['1280', { width: 1280, height: 900 }], ['375', { width: 375, height: 800 }]]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => { throw error; });
    const open = async id => { await page.goto(`${fixture.url}#/~hub/ask/${id}`); await page.locator('.hub-steps').waitFor(); };
    const line = () => page.locator('[data-delivery]');
    const noSideways = async what => {
      const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
      assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
    };
    const shoot = async state => { if (shots) await page.screenshot({ path: path.join(shots, `${state}-${name}.png`), fullPage: true }); };

    step(`${name}: delivered says which session, where and how`);
    await open(asks.delivered);
    await line().waitFor();
    assert.match(await line().innerText(), /^Reached session demo-repo on pc-one .*: woke it\./);
    assert.match(await line().innerText(), /reported by pc-one/);
    assert.equal(await page.locator('[data-delivery-open]').count(), 0);
    await noSideways('delivered');
    await shoot('delivered');

    step(`${name}: delivered at a later session's start, with no folder known`);
    await open(asks.started);
    await line().waitFor();
    assert.match(await line().innerText(), /^Reached an agent session on pc-one .*: at the next session's start\./);
    assert.doesNotMatch(await line().innerText(), /session an agent session/);

    step(`${name}: watching under five minutes, with a link to the session`);
    await open(asks.watching);
    await line().waitFor();
    assert.match(await line().innerText(), /^Session demo-repo on pc-one is watching; it checks every minute\./);
    assert.equal(await line().getAttribute('data-delivery'), 'watching');
    assert.equal(await page.locator('[data-delivery-open]').getAttribute('href'), 'claude://claude.ai/code/session_demo');
    await noSideways('watching');
    await shoot('watching');

    step(`${name}: not delivered after the wait, with only the safe link`);
    await open(asks.stale);
    await line().waitFor();
    assert.match(await line().innerText(), /Not delivered after 12 minutes\. The session may be closed\. Open it, or start a session in demo-repo: it gets the answer at its start\./);
    assert.equal(await page.locator('[data-delivery-open]').getAttribute('href'), 'https://claude.ai/code/session_demo', 'The javascript: link was dropped by the server.');
    await noSideways('stale');
    await shoot('not-delivered');

    step(`${name}: no watcher`);
    await open(asks.none);
    await line().waitFor();
    assert.match(await line().innerText(), /^No session is watching this Ask\. The next session in project probe gets it when it starts\./);
    await noSideways('none');
    await shoot('no-session');

    step(`${name}: a picked-up Ask and an open Ask show no delivery line`);
    await open(asks.picked);
    assert.equal(await line().count(), 0);
    await open(asks.open);
    assert.equal(await line().count(), 0);
    await context.close();
  }
  console.log('hub-delivery-ui: ok');
} finally {
  await browser.close();
  await fixture.close();
}
