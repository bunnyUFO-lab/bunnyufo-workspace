// A finished job's page keeps its timeline, live lines, usage and report in a closed `<details data-run-did>`, and Playwright does not see
// what a closed fold hides. A test that reads those opens the fold first. A job that is still going has no fold: nothing to open then.
/**
 * Waits for the run view's body, then opens the log if the page has one. `scope` is a page or a locator holding the view. `finished`: the job
 * is still going when this is called and ends while the test watches, so wait for the fold the finished layout brings.
 */
export async function openLog(scope, { finished = false } = {}) {
  await scope.locator(finished ? '[data-run-did]' : '[data-run-did], [data-run-timeline]').first().waitFor({ state: 'attached' });
  const log = scope.locator('[data-run-did]');
  if (!(await log.count())) return;
  if (!(await log.evaluate(node => node.open))) await log.locator('summary').click();
}

/**
 * Opens the log until `target` shows. For a page that has just changed to another job, where the fold of the one before may still be in the
 * document for a moment and the new one starts closed.
 */
export async function showInLog(scope, target, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    await openLog(scope);
    if (await target.isVisible()) return;
    await scope.waitForTimeout?.(200) ?? await new Promise(resolve => setTimeout(resolve, 200));
  }
  await target.waitFor({ timeout: 1000 });
}
