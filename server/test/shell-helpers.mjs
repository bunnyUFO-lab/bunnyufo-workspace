// What the shell's tests say, said once: go to a screen through the rail or the tab bar, and open the Library. The next change to
// the shell touches this file and the tests keep their meaning.

/** Opens a screen the way a person does: the rail at 900 px and up, the tab bar below. A screen with no entry (Work, Team) is reached by its address. */
export async function nav(page, screen) {
  const entry = page.locator(`[data-rail] [data-nav="${screen}"], [data-tabs] [data-nav="${screen}"]`);
  if (await entry.count()) await entry.click();
  else await page.evaluate(hash => { location.hash = hash; }, `#/~hub/${screen}`);
}

/** The Library: the card list. At 900 px and up that is the list beside the screen, below it the grid. */
export async function openLibrary(page) {
  const wide = await page.evaluate(() => matchMedia('(min-width: 900px)').matches);
  if (!/#\/~hub\/library$/.test(await page.evaluate(() => location.hash))) await nav(page, 'library');
  await page.locator(wide ? '.sidebar-list' : '.home').first().waitFor();
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
