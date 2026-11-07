// Tap Approve on a Needs-you proposal and wait until the server has stored the approval.
//
// The toast ("Approved" with the next-item note) shows when the button is tapped, before the server has answered, and the page
// then sends the approval from its own timer. A test that goes straight on to read the request (open its page, list it under
// Requests) can read it before the approval is stored: the row is still the proposal, with no Request label and no
// data-request-open, and the run never starts, so the test waits out its whole timeout for something that cannot come.
import assert from 'node:assert/strict';

export async function approveStored(page, buttonSelector) {
  const stored = page.waitForResponse(response => response.request().method() === 'POST' && /^\/api\/hub\/requests\/[^/]+\/approve$/.test(new URL(response.url()).pathname));
  await page.locator(buttonSelector).click();
  await page.locator('[data-next-note]').waitFor();
  assert.ok((await stored).ok(), 'The approval was stored.');
}
