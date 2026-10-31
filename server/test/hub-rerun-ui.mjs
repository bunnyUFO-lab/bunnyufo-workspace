// Run after npm run build. The watcher's rerun Ask through a real browser over the hub fixture: the Ask carries the
// `Passkey only` and `Runs again` tags, answering "run it again" shows the notice with the copy's id (the Hub signed and
// approved it), a second Ask for the same run says it was already approved again, "Keep it denied" shows no notice, and an
// Ask whose run cannot be run again says why. At 1280 and 375 px; nothing scrolls sideways.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { askId, startHubFixture } from './hub-fixture.mjs';
import { askJson } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const OPTIONS = [{ id: 'allowed', label: 'I ran the allow lines; run it again' }, { id: 'denied', label: 'Keep it denied' }];
const CONTEXT = 'Denied:\n1. Bash `ping -n 1 host.example.test`\n   - `.\install.ps1 -Runs -Allow "Bash(ping:*)"`\n\nRun the lines at the PC first, in PowerShell. Then answer here: the request is approved again and starts within a few minutes of the PC seeing the rule. If the rule is not in yet, it waits and you get one note. Answering never changes the allow list.';

const fixture = await startHubFixture({ signing: true });
const browser = await chromium.launch({ headless: true, channel });
try {
  // A real run the Hub signed for the PC, ended `failed`: the owner's request through the site API, then the files a run leaves.
  const api = async (route, body) => {
    const response = await fetch(`${fixture.origin}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.origin, Authorization: `Bearer ${fixture.service.token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const made = await api('/hub/requests', { project: 'sprite-studio', preset: 'sprite-set', text: 'Make the walk cycle', title: 'Walk cycle' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api(`/hub/requests/${made.body.id}/approve`, { target: 'pc' })).status, 201);
  fixture.seed.put(`requests/${made.body.id}/taken.json`, { runner: 'pc', host: 'test-pc', nonce: 'n'.repeat(22), at: new Date(Date.now() - 30 * 60000).toISOString() });
  fixture.seed.put(`requests/${made.body.id}/result.json`, { v: 1, outcome: 'failed', summary: 'Denied a tool call.', reason: 'denied', by: 'run', at: new Date(Date.now() - 5 * 60000).toISOString() });
  const question = 'Run "Walk cycle" was denied `ping -n 1 host.example.test`. Allow it and run it again?';
  const rerun = { request: made.body.id, kind: 'denied' };
  const gone = { request: askId('rerun-gone', 'e5f6'), kind: 'denied' };
  const seedAsk = (tail, field) => {
    const id = askId('rerun', tail);
    fixture.seed.ask({ ...askJson({ id, project: 'sprite-studio', question, options: OPTIONS, context: CONTEXT, allowDrawing: false }), requirePasskey: true, rerun: field });
    return id;
  };
  // A second run, for the Ask that can allow rules from the phone.
  const made2 = await api('/hub/requests', { project: 'sprite-studio', preset: 'sprite-set', text: 'Make the idle cycle', title: 'Idle cycle' });
  assert.equal((await api('/hub/requests/' + made2.body.id + '/approve', { target: 'pc' })).status, 201);
  fixture.seed.put('requests/' + made2.body.id + '/taken.json', { runner: 'pc', host: 'test-pc', nonce: 'n'.repeat(22), at: new Date(Date.now() - 30 * 60000).toISOString() });
  fixture.seed.put('requests/' + made2.body.id + '/result.json', { v: 1, outcome: 'failed', summary: 'Denied a tool call.', reason: 'denied', by: 'run', at: new Date(Date.now() - 5 * 60000).toISOString() });
  const RULE = 'Bash(ping -n 1 host.example.test)';
  const allowId = askId('rerun-allow', 'g7h8');
  fixture.seed.ask({ ...askJson({ id: allowId, project: 'sprite-studio', question, options: [{ id: 'allow', label: 'Allow it and run it again' }, ...OPTIONS], context: CONTEXT, allowDrawing: false }), requirePasskey: true, rerun: { request: made2.body.id, kind: 'denied', allow: [RULE] } });
  const asks = { '1280': { one: seedAsk('a1b2', rerun), two: seedAsk('b2c3', rerun), keep: seedAsk('c3d4', gone), lost: seedAsk('d4e5', gone) }, '375': { keep: seedAsk('f6a7', gone), lost: seedAsk('a7b8', gone) } };
  await new Promise(resolve => setTimeout(resolve, 150));

  for (const [name, viewport] of [['1280', { width: 1280, height: 900 }], ['375', { width: 375, height: 800 }]]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => { throw error; });
    const noSideways = async what => {
      const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
      assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
    };
    const open = async id => { await page.goto(`${fixture.url}#/~hub/ask/${id}`); await page.locator('[data-option="allowed"]').waitFor(); };
    const answerWith = async option => { await page.locator(`[data-option="${option}"]`).click(); await page.locator('[data-send]').click(); };

    step(`${name}: the Ask shows both tags and the two options`);
    await open(asks[name].keep);
    const tags = await page.locator('.hub-steps .tag').allInnerTexts();
    assert.deepEqual(tags, ['Passkey only', 'Runs again']);
    assert.equal(await page.locator('[data-option]').count(), 2);
    await noSideways('rerun Ask');

    step(`${name}: "Keep it denied" shows no notice`);
    await answerWith('denied');
    assert.equal(await page.locator('[data-avatar-notice]').count(), 0);

    step(`${name}: an Ask whose run is gone says why it did not run again`);
    await open(asks[name].lost);
    await answerWith('allowed');
    await page.locator('[data-avatar-notice]').waitFor();
    assert.match(await page.locator('[data-avatar-notice]').innerText(), /^Not run again: /);
    await noSideways('not run again');

    if (name === '1280') {
      step('the first Ask approves a copy, the second says it was already approved');
      await open(asks[name].one);
      await answerWith('allowed');
      await page.locator('[data-avatar-notice]').waitFor();
      assert.match(await page.locator('[data-avatar-notice]').innerText(), /^Approved again as .+\. It starts on the Gaming PC within a few minutes of the allow lines being in\.$/);
      await open(asks[name].two);
      await answerWith('allowed');
      await page.locator('[data-avatar-notice]').waitFor();
      assert.match(await page.locator('[data-avatar-notice]').innerText(), /^Already approved again as /);
    }
    if (name === '1280') {
      step('1280: the Allow Ask shows the exact rule, the Allows on PC tag and the notice after Allow');
      await page.goto(fixture.url + '#/~hub/ask/' + allowId);
      await page.locator('[data-rerun-allow]').waitFor();
      assert.equal((await page.locator('[data-rerun-allow] code').innerText()).trim(), RULE);
      assert.deepEqual(await page.locator('.hub-steps .tag').allInnerTexts(), ['Passkey only', 'Runs again', 'Allows on PC']);
      assert.equal(await page.locator('[data-option]').count(), 3);
      await answerWith('allow');
      await page.locator('[data-avatar-notice]').waitFor();
      assert.match(await page.locator('[data-avatar-notice]').innerText(), /^Allowed 1 rule for sprite-studio and approved again as .+. The Gaming PC adds the rule and starts it within a few minutes; it sends an alert when it does.$/);
    }
    await context.close();
  }
  console.log('hub-rerun-ui: passed');
} finally {
  await browser.close();
  await fixture.close();
}
