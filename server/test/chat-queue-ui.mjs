// Run after npm run build. At phone width: a message sent while Hermes answers waits as a dashed "Queued" row, can be cancelled, goes out when the reply
// ends, survives a reload, and after a Stop shows "Not sent" with Send now. Fake Hermes only.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: [[{ hold: true }], ['Second reply. ', { hold: true }], ['Third reply.']] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  // Headless Edge holds the page's first /live request for about half a minute after a burst of Hub refetches (a Node client gets it at once), so
  // the two steps that follow a turn this page did not start can take 30 s each. Nothing is lost: the replay at the end has every event.
  const field = page.locator('textarea[aria-label="Message"]');
  const rows = page.locator('[data-queued]');
  const send = async text => { await field.fill(text); await page.keyboard.press('Enter'); };
  const noSideways = async what => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${what}: nothing scrolls sideways`);
  await page.goto(`${fixture.url}#/~hub/chat`);

  step('Send stays while a reply runs, with Stop beside it, and the row waits above the composer');
  await send('Plan the forest');
  await page.locator('[data-pending]').waitFor();
  await page.getByRole('button', { name: 'Stop' }).waitFor();
  const sendButton = page.getByRole('button', { name: 'Send', exact: true });
  await sendButton.waitFor();
  await send('Also check the forest level.');
  await rows.first().waitFor();
  assert.equal(await rows.first().getAttribute('data-queued-state'), 'queued');
  assert.equal(await rows.first().locator('[data-queued-pill]').textContent(), 'Queued');
  assert.equal(await field.inputValue(), '', 'The draft is cleared once queued.');
  assert.equal(fixture.hermes.runs.length, 1, 'Nothing starts while the reply runs.');

  step('at 390 and 360 px Stop, Send and the field share a line, the field is 140 px or more, targets are 44 px, nothing scrolls sideways');
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    const box = async locator => locator.boundingBox();
    const [stop, sendBox, text] = [await box(page.getByRole('button', { name: 'Stop' })), await box(sendButton), await box(field)];
    assert.ok(Math.abs(stop.y + stop.height / 2 - (text.y + text.height / 2)) < text.height, `${width}: Stop is on the field's line`);
    assert.ok(Math.abs(sendBox.y - stop.y) < 24, `${width}: Send is on Stop's line`);
    assert.ok(text.width >= 140, `${width}: the field is ${text.width} px wide`);
    assert.ok(stop.height >= 44 && sendBox.height >= 44 && stop.width >= 44 && sendBox.width >= 44, `${width}: targets are 44 px`);
    await noSideways(String(width));
  }
  await page.setViewportSize({ width: 390, height: 844 });

  step('a second message makes a second row, and Cancel removes just that one');
  await send('Never mind this one.');
  await rows.nth(1).waitFor();
  await rows.nth(1).locator('[data-queued-cancel]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 1);
  assert.match(await rows.first().textContent(), /Also check the forest level/);
  await noSideways('rows');

  step('when the reply ends, the row becomes the next user bubble and the next reply streams');
  fixture.hermes.release(fixture.hermes.runs[0].id, 'First reply.');
  await page.locator('.hub-bubble.assistant', { hasText: 'First reply.' }).waitFor();
  await page.locator('.hub-bubble.user', { hasText: 'Also check the forest level.' }).waitFor();
  await page.locator('[data-pending]', { hasText: 'Second reply.' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 0);
  assert.equal(fixture.hermes.runs.length, 2);
  assert.equal(fixture.hermes.runs[1].body.input, 'Also check the forest level.');

  step('a reload mid-reply loses nothing: the question, the stream and a queued row are all still there');
  await send('Then the cave.');
  await rows.first().waitFor();
  await page.reload();
  await page.locator('.hub-bubble.user', { hasText: 'Also check the forest level.' }).waitFor();
  await rows.first().waitFor();
  assert.match(await rows.first().textContent(), /Then the cave/);
  await page.locator('[data-pending]', { hasText: 'Second reply.' }).waitFor();

  step('Stop holds the queue: the row says Not sent, nothing goes out by itself, and Send now delivers');
  await page.getByRole('button', { name: 'Stop' }).click();
  await rows.first().locator('[data-queued-send]').waitFor();
  assert.equal(await rows.first().getAttribute('data-queued-state'), 'held');
  assert.match(await rows.first().locator('[data-queued-pill]').textContent(), /Not sent: the reply was stopped/);
  assert.equal(await rows.first().locator('[data-queued-cancel]').count(), 1);
  await page.waitForTimeout(ms(400));
  assert.equal(fixture.hermes.runs.length, 2, 'Nothing is sent after a stop.');
  await noSideways('held');
  await rows.first().locator('[data-queued-send]').click();
  await page.locator('.hub-bubble.user', { hasText: 'Then the cave.' }).waitFor();
  await page.locator('.hub-bubble.assistant', { hasText: 'Third reply.' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 0);
  assert.equal(fixture.hermes.runs.length, 3);

  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
