// Run after npm run build. The Away switch in Settings, through a real browser over the fixture service:
// At the PC by default, one tap to Away (with its "until" and the sub-line) and one tap back, the switch surviving a
// reload, the file the Hub wrote (no writer mark, 12 h at most), a failed write shown as an error, the blocked session
// without a link saying so honestly, a linked one offering "Open the session", an Ask from a session carrying the same
// link, and 390 px with no sideways scroll. Nothing is ever overwritten: the bucket only gains files.
import { chromium } from '@playwright/test';
import './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { askJson, eventJson, minutesAgo, plainOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const LINK = 'https://claude.ai/code/session_TESTabc123';

const fixture = await startHubFixture({ seedData: false });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};

try {
  const { seed, now, fake } = fixture;
  seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 5), project: 'probe', session: 'sess-bare', title: 'Bare session needs a look', extra: { reason: 'question' } }));
  seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 3), project: 'probe', session: 'sess-linked', title: 'Linked session needs a look', url: LINK, extra: { reason: 'question' } }));
  const asked = askJson({ id: `${day}-probe-which-lane-a1a1`, now: minutesAgo(now, 2), question: 'Which lane first?', options: plainOptions().slice(0, 2), allowDrawing: false });
  asked.from = { ...asked.from, url: LINK };
  seed.ask(asked);
  const plain = askJson({ id: `${day}-probe-no-link-b2b2`, now: minutesAgo(now, 1), question: 'A question with no link?', options: plainOptions().slice(0, 2), allowDrawing: false });
  seed.ask(plain);
  // Links that only look like a session link: the Open the session button never shows for them.
  const lookalikes = ['https://claude.ai.evil/code/session_abc1', 'http://claude.ai/code/session_abc1', 'https://claude.ai/code/session_abc1/extra', 'https://claude.ai/code/session_abc1?x=1', 'https://evil.test/https://claude.ai/code/session_abc1', 'https://claude.ai/code/'];
  lookalikes.forEach((url, i) => {
    const fake = askJson({ id: `${day}-probe-lookalike-${i}-c3c${i}`, now: minutesAgo(now, 1), question: `Lookalike link ${i}?`, options: plainOptions().slice(0, 2), allowDrawing: false });
    fake.from = { ...fake.from, url };
    seed.ask(fake);
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  const page = await open({ width: 1280, height: 900 });
  const toggle = page.locator('[data-away-toggle]');
  const label = () => toggle.locator('[data-away-label]').innerText();
  const stored = () => fake.objects.get('sections/inbox/presence.json');

  step('Settings starts at the PC: a switch, no sub-line, and nothing stored');
  await page.goto(`${fixture.url}#/~hub/settings`);
  await toggle.waitFor();
  assert.equal(await label(), 'At the PC');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('[data-away-sub]').count(), 0);
  assert.equal(stored(), undefined);

  step('one tap turns Away on: "Away until HH:MM", the sub-line, and a file the Hub wrote with no writer mark');
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-away-label]')?.textContent?.startsWith('Away until'));
  assert.match(await label(), /^Away until \d{1,2}:\d{2}/);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.equal((await page.locator('[data-away-sub]').innerText()).trim(), 'Questions from Claude sessions come here and to Discord.');
  const file = JSON.parse(stored().body.toString('utf8'));
  assert.equal(file.away, true);
  assert.equal(file.v, 1);
  const ahead = new Date(file.until).getTime() - new Date(file.at).getTime();
  assert.ok(ahead > 11.9 * 3600000 && ahead <= 12 * 3600000, `until is 12 h ahead (${ahead / 3600000} h)`);
  assert.deepEqual(stored().metadata, {}, 'no writer mark: the Hub wrote it');
  await page.evaluate(() => { location.hash = '#/~hub/today'; });
  await page.locator('[data-today-away]').waitFor();
  await page.evaluate(() => { location.hash = '#/~hub/settings'; });
  await toggle.waitFor();

  step('it survives a reload, and one tap back to the PC expires it');
  await page.reload();
  await toggle.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-away-label]')?.textContent?.startsWith('Away until'));
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-away-label]')?.textContent === 'At the PC');
  assert.equal(await page.locator('[data-away-sub]').count(), 0);
  assert.equal(JSON.parse(stored().body.toString('utf8')).away, false);
  await page.reload();
  await toggle.waitFor();
  assert.equal(await label(), 'At the PC', 'Still at the PC after a reload.');

  step('a write that fails shows its error and leaves the switch where it was');
  await page.route('**/api/hub/presence', route => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: '{"error":"Test failure"}', contentType: 'application/json' }) : route.continue()), { times: 1 });
  await toggle.click();
  await page.locator('[data-away-error]', { hasText: 'Test failure' }).waitFor();
  assert.equal(await label(), 'At the PC');
  await page.unroute('**/api/hub/presence');

  step('a blocked session without a link says so and where to go; one with a link offers Open the session');
  await page.goto(`${fixture.url}#/~hub/needs/unstick`);
  const bare = page.locator('.ni[data-kind="unstick"]', { hasText: 'Bare session' });
  const linked = page.locator('.ni[data-kind="unstick"]', { hasText: 'Linked session' });
  await bare.waitFor();
  await linked.waitFor();
  assert.equal((await bare.locator('[data-blocked-hint]').innerText()).trim(), 'No phone link came with this session. Open the Claude app on pc.example.test.');
  assert.equal(await bare.locator('[data-link="session"]').count(), 0);
  assert.equal(await linked.locator('[data-blocked-hint]').count(), 0);
  assert.equal((await linked.locator('[data-link="session"]').innerText()).trim(), 'Open the session');
  assert.equal(await linked.locator('[data-link="session"]').getAttribute('href'), LINK);

  step('an Ask from a session carries the link; one without a link shows none');
  await page.goto(`${fixture.url}#/~hub/needs/question`);
  const lane = page.locator('.ni', { hasText: 'Which lane first?' });
  await lane.waitFor();
  assert.equal((await lane.locator('[data-ask-session] a').innerText()).trim(), 'Open the session');
  assert.equal(await lane.locator('[data-ask-session] a').getAttribute('href'), LINK);
  assert.equal(await lane.locator('[data-ask-session] a').getAttribute('target'), '_blank');
  assert.equal(await page.locator('.ni', { hasText: 'A question with no link?' }).locator('[data-ask-session]').count(), 0);
  for (let i = 0; i < lookalikes.length; i += 1) {
    const row = page.locator('.ni', { hasText: `Lookalike link ${i}?` });
    await row.waitFor();
    assert.equal(await row.locator('[data-ask-session]').count(), 0, `${lookalikes[i]} is refused`);
  }
  await page.goto(`${fixture.url}#/~hub/ask/${asked.id}`);
  await page.locator('[data-ask-session] a').waitFor();

  step('at 390 px the switch fits, with the sub-line, and nothing scrolls sideways');
  const phone = await open({ width: 390, height: 844 });
  await phone.goto(`${fixture.url}#/~hub/settings`);
  await phone.locator('[data-away-toggle]').click();
  await phone.waitForFunction(() => document.querySelector('[data-away-label]')?.textContent?.startsWith('Away until'));
  await phone.locator('[data-away-sub]').waitFor();
  const box = await phone.locator('[data-away-toggle]').boundingBox();
  assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await noSideways(phone, 'Settings with the Away switch at phone width');

  console.log('needs-away-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
