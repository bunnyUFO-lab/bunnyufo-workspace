// What the shell's tests say, said once: go to a screen through the rail or the tab bar, and open the Library. The next change to
// the shell touches this file and the tests keep their meaning.

/** Opens a screen the way a person does: the rail at 900 px and up, the tab bar below. A screen with no entry (Work, Team) is reached by its address. */
export async function nav(page, screen) {
  const entry = page.locator(`[data-rail] [data-nav="${screen}"], [data-tabs] [data-nav="${screen}"]`);
  if (await entry.count()) await entry.click();
  else await page.evaluate(hash => { location.hash = hash; }, `#/~hub/${screen}`);
}

/** The Library: the card list, the screen itself on a phone and the pane beside a card at 900 px and up. */
export async function openLibrary(page) {
  if (!/#\/~hub\/library$/.test(await page.evaluate(() => location.hash))) await nav(page, 'library');
  await page.locator('[data-library] .lib-scroll').first().waitFor();
}

/** The serial of the history entry the page is on (lib/entries stamps one on each), and where it is. */
export const entryOf = page => page.evaluate(() => ({ serial: history.state?.hubEntry ?? 0, hash: location.hash }));

/** The page's address, after the app has had its turn to rewrite it. */
export const hashOf = page => page.evaluate(() => location.hash);

/** No sideways scroll anywhere on the page, at this width. */
export async function noSideways(page, what) {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  if (widths.scroll > widths.inner) throw new Error(`${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
}

/**
 * A browser context whose card list stays open beside a card. Below 1400 px the list starts folded beside a card (a wide report needs
 * the room), and the choice is remembered; a test that works the list while a card is open says so.
 */
export async function contextWithListOpen(browser, options) {
  const context = await browser.newContext(options);
  await context.addInitScript(() => { try { localStorage.setItem('buw.menuCollapsed', '0'); } catch { /* none */ } });
  return context;
}

/**
 * The sheet the Chat thread's title opens: Talk to (a new chat only) and Model. A test that picks either opens it first; it stays open
 * until Back closes it. Returns the sheet's locator.
 */
export async function openChatSheet(page) {
  const sheet = page.locator('[data-chat-sheet]');
  if (!(await sheet.count())) await page.locator('[data-chat-options]').click();
  await sheet.waitFor();
  return sheet;
}

/** Closes the chat sheet the way Back does, and waits for it to go. */
export async function closeChatSheet(page) {
  if (!(await page.locator('[data-chat-sheet]').count())) return;
  await page.goBack();
  await page.locator('[data-chat-sheet]').waitFor({ state: 'detached' });
}
