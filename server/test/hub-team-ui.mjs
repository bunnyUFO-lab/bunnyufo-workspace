// Run after npm run build. The Team screen and its Sprite sheet through a real browser, over the hub fixture.
import { chromium } from '@playwright/test';
import { ms, steadyFetch } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { BUILTIN, genSprite } from '../../src/hub/team/sprites.ts';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

// The sprite as the page draws it: one entry per run of equal pixels, so a rect list identifies a sprite.
const signatureOf = data => {
  const out = [];
  data.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      if (c === '.') { x += 1; continue; }
      let w = 1;
      while (x + w < row.length && row[x + w] === c) w += 1;
      out.push(`${x},${y},${w},${data.palette[c]}`);
      x += w;
    }
  });
  return out.join('|');
};
const domSignature = locator => locator.evaluate(svg => [...svg.querySelectorAll('rect')].map(r => `${r.getAttribute('x')},${r.getAttribute('y')},${r.getAttribute('width')},${r.getAttribute('fill')}`).join('|'));

const fixture = await startHubFixture({ pc: 'fresh', hermes: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};
const cardSprite = (page, agent) => page.locator(`[data-agent="${agent}"] .team-tile svg`);

try {
  step('seven cards (the three research agents and the Planner among them), the header counts, the labels, and Team in the sidebar');
  const desk = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('.team-card').count(), 7);
  assert.deepEqual(await desk.locator('.team-card h3').allInnerTexts(), ['Hermes', 'Briefs', 'Claude Code', 'Researcher', 'Market researcher', 'Teardown', 'Planner']);
  assert.equal(await desk.locator('[data-give-work]').count(), 3, 'Only the research agents take work from here.');
  await desk.locator('[data-give-work="teardown"]').click();
  await desk.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await desk.locator('[data-preset="game-teardown"]').getAttribute('aria-pressed'), 'true', 'Give work opens Spawn on the preset of that agent.');
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  assert.equal(await desk.locator('[data-rail] [data-nav="team"]').count(), 1, 'Team is on the rail.');
  assert.equal(await desk.locator('[data-rail] [data-nav="team"]').getAttribute('aria-current'), 'page', 'Team is the current entry on the rail.');
  assert.match(await desk.locator('[data-team-online]').innerText(), /^\d\/7$/);
  assert.equal(await desk.locator('[data-agent="hermes"] .team-facts').innerText().then(t => t.replace(/\s+/g, ' ')), 'Model Codex gpt-6-sol · Sonnet, then DeepSeek fallback Runs as Hermes profile main');
  assert.match(await desk.locator('[data-agent="briefs"] .team-facts').innerText(), /Haiku 5\.5 · DeepSeek fallback/);
  assert.equal(await desk.locator('[data-agent="claude"]').getAttribute('data-status'), 'working', 'The fixture PC has a busy session.');
  assert.equal(await desk.locator('[data-team-working]').innerText(), '1');
  assert.ok(await desk.locator('[data-agent="claude"] .team-sessions li').count() >= 2, 'Claude Code lists its sessions.');
  assert.match(await desk.locator('[data-agent="claude"] .team-sessions').innerText(), /Wall-jump tutorial/);
  await noSideways(desk, 'Team at 1280');

  step('each card has one main button with its label; Chat lands in Chat on the right persona; Run now and Start a run open Spawn');
  const labels = { hermes: 'Chat', briefs: 'Run now', claude: 'Start a run', researcher: 'Give work', 'market-researcher': 'Give work', teardown: 'Give work', planner: 'Chat' };
  for (const [id, label] of Object.entries(labels)) {
    assert.equal(await desk.locator(`[data-agent="${id}"] [data-main-action]`).count(), 1, `${id} has one main button.`);
    assert.equal((await desk.locator(`[data-agent="${id}"] [data-main-action]`).innerText()).trim(), label, id);
    // Details comes first; Edit follows on the four agents with a chat persona (ws-im1.4.1) and nowhere else.
    const editable = id !== 'claude';   // every agent on a Hermes profile has an Edit link (its model); Claude Code has none
    assert.deepEqual(await desk.locator(`[data-agent="${id}"] .team-links a`).allInnerTexts(), editable ? ['Details', 'Edit'] : ['Details'], `${id}: link row.`);
    assert.equal(await desk.locator(`[data-edit-open="${id}"]`).count(), editable ? 1 : 0, `${id}: Edit link.`);
    if (editable) assert.equal(await desk.locator(`[data-edit-open="${id}"]`).getAttribute('href'), `#/~hub/agent-edit/${id}`);
  }
  assert.equal(await desk.locator('[data-main-action]').count(), 7);
  await desk.locator('[data-main-action="hermes"]').click();
  await desk.waitForFunction(() => location.hash === '#/~hub/chat');
  await desk.locator('textarea').first().waitFor();
  assert.equal(await desk.locator('textarea').first().inputValue(), '', 'The composer is empty.');
  assert.equal(await desk.locator('[data-chat-persona]').inputValue(), 'hermes', 'Hermes is no persona.');
  assert.equal(await desk.locator('[data-spawn-sheet]').count(), 0);
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  await desk.locator('[data-main-action="planner"]').click();
  await desk.waitForFunction(() => location.hash === '#/~hub/chat');
  await desk.locator('textarea').first().waitFor();
  assert.equal(await desk.locator('[data-chat-persona]').inputValue(), 'planner', 'Chat opens on the Planner.');
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  await desk.locator('[data-main-action="briefs"]').click();
  await desk.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await desk.locator('[data-preset="projects-brief"]').getAttribute('aria-pressed'), 'true', 'Run now opens Spawn on Projects brief.');
  assert.equal(await desk.locator('[data-spawn-text]').inputValue(), 'Write the daily projects brief now.');
  await desk.locator('[data-spawn-route="hermes"]').waitFor();
  assert.match(await desk.locator('[data-spawn-estimate]').innerText(), /posts nowhere/);
  assert.equal(await desk.locator('[data-spawn-go]').isEnabled(), true);
  const sent = desk.waitForRequest(request => request.method() === 'POST' && /\/hub\/requests$/.test(request.url()));
  await desk.locator('[data-spawn-go]').click();
  const body = (await sent).postDataJSON();
  assert.deepEqual([body.preset, body.project, body.text], ['projects-brief', 'workspace-app', 'Write the daily projects brief now.']);
  await desk.locator('[data-spawn-toast]').waitFor();
  const filed = [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/request\.json$/.test(key));
  assert.equal(filed.length, 1, 'Sending files one request.');
  assert.deepEqual([fixture.fake.json(filed[0]).preset, fixture.fake.json(filed[0]).target], ['projects-brief', 'hermes'], 'The request is a Hermes one.');
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  await desk.locator('[data-main-action="claude"]').click();
  await desk.locator('[data-spawn-sheet]').waitFor();
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  await desk.locator('[data-main-action="claude"]').click();
  await desk.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await desk.locator('[data-preset="code-task"]').getAttribute('aria-pressed'), 'true', 'Start a run opens Spawn on Code task.');
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });

  step('the sheet opens with the focus inside, shows the current sprite first, and Escape gives the focus back');
  const hermesButton = desk.locator('[data-sprite-open="hermes"]');
  await hermesButton.click();
  const sheet = desk.locator('dialog[data-sprite-sheet="hermes"]');
  await sheet.waitFor();
  assert.equal(await sheet.evaluate(node => node.contains(document.activeElement)), true, 'The focus moved into the sheet.');
  assert.equal(await sheet.locator('.sheet-tile').first().getAttribute('data-sprite-tile'), 'hermes', 'The current sprite comes first.');
  assert.equal(await sheet.locator('[data-sheet-note]').innerText(), 'This is the current sprite');
  assert.equal(await sheet.locator('[data-sheet-use]').isDisabled(), true, 'Nothing to use while the current sprite is selected.');
  const box = await sheet.boundingBox();
  assert.ok(box.x > 0 && box.x + box.width < 1280, 'A dialog in the middle on desktop.');
  await desk.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  await desk.waitForFunction(() => document.activeElement?.getAttribute('data-sprite-open') === 'hermes');

  step('the Custom segment says there are no sheets yet');
  await desk.route('**/api/hub/team/*/sheets', route => route.fulfill({ json: { sheets: [] } }));
  await hermesButton.click();
  await sheet.waitFor();
  await sheet.locator('[data-sheet-mode="custom"]').click();
  await sheet.locator('[data-sheet-custom]').getByText('No custom sheets yet.').waitFor();
  assert.equal(await sheet.locator('[data-sheet-custom]').innerText(), 'No custom sheets yet.');
  assert.equal(await sheet.locator('[data-sheet-use]').count(), 0, 'No Use this on the Custom segment.');
  await sheet.locator('[data-sheet-mode="quick"]').click();

  step('pick developer, Use this: toast, then the card shows it after a reload');
  await sheet.locator('[data-sprite-tile="developer"]').click();
  assert.equal(await sheet.locator('[data-sprite-tile="developer"]').getAttribute('aria-checked'), 'true');
  assert.equal(await sheet.locator('[data-sheet-note]').innerText(), 'Built in. Use this applies it now, no job.');
  await sheet.locator('[data-sheet-use]').click();
  await sheet.waitFor({ state: 'detached' });
  await desk.locator('[data-team-toast]', { hasText: 'Hermes has a new sprite. No job needed.' }).waitFor();
  const wanted = signatureOf(BUILTIN.developer);
  await desk.reload();
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await domSignature(cardSprite(desk, 'hermes')), wanted, 'The card shows the developer sprite after a reload.');

  step('Undo restores the previous sprite');
  await desk.locator('[data-sprite-open="briefs"]').click();
  const briefsSheet = desk.locator('dialog[data-sprite-sheet="briefs"]');
  await briefsSheet.waitFor();
  const before = await domSignature(cardSprite(desk, 'briefs'));
  await briefsSheet.locator('[data-sprite-tile="qa"]').click();
  await briefsSheet.locator('[data-sheet-use]').click();
  await desk.locator('[data-team-toast]').waitFor();
  await desk.waitForFunction(sel => document.querySelector(sel)?.innerHTML.length > 0, '[data-agent="briefs"] .team-tile svg');
  await desk.waitForFunction(({ sel, was }) => [...document.querySelector(sel).querySelectorAll('rect')].map(r => `${r.getAttribute('x')},${r.getAttribute('y')},${r.getAttribute('width')},${r.getAttribute('fill')}`).join('|') !== was, { sel: '[data-agent="briefs"] .team-tile svg', was: before });
  await desk.locator('[data-team-undo]').click();
  await desk.locator('[data-team-toast]', { hasText: 'old sprite back' }).waitFor();
  await desk.waitForFunction(({ sel, was }) => [...document.querySelector(sel).querySelectorAll('rect')].map(r => `${r.getAttribute('x')},${r.getAttribute('y')},${r.getAttribute('width')},${r.getAttribute('fill')}`).join('|') === was, { sel: '[data-agent="briefs"] .team-tile svg', was: before });
  await desk.reload();
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await domSignature(cardSprite(desk, 'briefs')), before, 'The restored sprite survives a reload.');

  step('Randomize twice gives two different sprites, the same as genSprite for those salts');
  await desk.locator('[data-sprite-open="claude"]').click();
  const claudeSheet = desk.locator('dialog[data-sprite-sheet="claude"]');
  await claudeSheet.waitFor();
  const preview = claudeSheet.locator('[data-sheet-preview] svg');
  const seen = [];
  for (const salt of [1, 2]) {
    await claudeSheet.locator('[data-sheet-randomize]').click();
    await claudeSheet.locator(`[data-sprite-tile="random-${salt}"]`).waitFor();
    seen.push(await domSignature(preview));
    assert.equal(seen.at(-1), signatureOf(genSprite('Claude Code', salt)), `Salt ${salt} draws what genSprite draws.`);
    assert.equal(await claudeSheet.locator('[data-sheet-note]').innerText(), `Randomized from the name: ${genSprite('Claude Code', salt).label}`);
  }
  assert.notEqual(seen[0], seen[1], 'Two different sprites.');
  await claudeSheet.locator('[data-sheet-use]').click();
  await claudeSheet.waitFor({ state: 'detached' });
  await desk.reload();
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await domSignature(cardSprite(desk, 'claude')), seen[1], 'The randomized sprite is the card after a reload.');

  step('phone: Team is a page with a 44 px Back button and no tab bar, the sheet is a bottom sheet, nothing scrolls sideways');
  for (const width of [375, 390]) {
    const phone = await open({ width, height: 844 }, { hasTouch: true, isMobile: true });
    await phone.goto(`${fixture.url}#/~hub/team`);
    await phone.locator('.team-card').first().waitFor();
    assert.equal(await phone.locator('[data-tabs]').count(), 0, 'Team is a page of its own: no tab bar.');
    const back = await phone.locator('[data-top="detail"] [data-back]').boundingBox();
    assert.ok(back.height >= 44 && back.width >= 44, `Back at ${width}: ${back.width} x ${back.height} is a 44 px target.`);
    await noSideways(phone, `Team at ${width}`);
    for (const target of await phone.locator('.team-card [data-main-action], .team-card .team-details-link, .team-card [data-sprite-open]').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A main button, Details or Sprite is ${target} px high.`);
    await phone.locator('[data-sprite-open="hermes"]').tap();
    const sheetBox = await phone.locator('dialog.sprite-sheet').boundingBox();
    assert.ok(Math.abs(sheetBox.x) < 1 && Math.abs(sheetBox.width - width) < 1, `The sheet spans the screen at ${width}.`);
    assert.ok(Math.abs(sheetBox.y + sheetBox.height - 844) < 2, `The sheet sits at the bottom at ${width}.`);
    await noSideways(phone, `Sprite sheet at ${width}`);
    for (const target of await phone.locator('dialog.sprite-sheet button').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A button in the sheet is ${target} px high.`);
    await phone.keyboard.press('Escape');
  }

  step('a visitor who cannot write sees why there is no Sprite button');
  assert.equal(await desk.locator('[data-sprite-signin]').count(), 0, 'With write, no sign-in note.');
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(guestContext);
  await guestContext.route('**/api/capabilities', async route => {
    const response = await steadyFetch(route);
    await route.fulfill({ response, json: { ...(await response.json()), write: false } });
  });
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(ms(15000));
  await guest.goto(`${fixture.url}#/~hub/team`);
  await guest.locator('.team-card').first().waitFor();
  assert.equal(await guest.locator('[data-sprite-open]').count(), 0, 'No Sprite button without write.');
  assert.equal(await guest.locator('[data-sprite-signin]').count(), 7, 'Each card says why.');
  assert.equal(await guest.locator('[data-sprite-signin]').first().innerText(), 'Sign in to change sprites');
  assert.equal(await guest.locator('[data-sprite-signin]').first().isVisible(), true);
  assert.equal(await guest.locator('[data-main-action]').count(), 0, 'Signed out: no main button.');
  assert.equal(await guest.locator('[data-details-open]').count(), 7, 'Details stays.');
  assert.equal(await guest.locator('[data-new-persona]').count(), 0, 'No New persona without write.');

  step('with chat off the Chat buttons go and the others stay');
  const quiet = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(quiet);
  await quiet.route('**/api/capabilities', async route => {
    const response = await steadyFetch(route);
    await route.fulfill({ response, json: { ...(await response.json()), chat: false } });
  });
  const noChat = await quiet.newPage();
  noChat.setDefaultTimeout(ms(15000));
  await noChat.goto(`${fixture.url}#/~hub/team`);
  await noChat.locator('.team-card').first().waitFor();
  assert.deepEqual(await noChat.locator('[data-main-action]').allInnerTexts(), ['Run now', 'Start a run', 'Give work', 'Give work', 'Give work']);

  step('New persona: pick a template, name it, land on its Edit page; it is a card with Chat, Details, Edit and Sprite (no sheet job), in Chat, and shares Hermes main');
  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('[data-new-persona]').count(), 1);
  await desk.locator('[data-new-persona]').click();
  const sheetNew = desk.locator('dialog[data-new-persona-sheet]');
  await sheetNew.waitFor();
  await sheetNew.locator('[data-template-row]').first().waitFor();
  assert.deepEqual(await sheetNew.locator('[data-template-row]').evaluateAll(list => list.map(item => item.getAttribute('data-template-row'))), ['research', 'planner', 'plain']);
  assert.equal(await sheetNew.locator('[data-template="research"]').isChecked(), true, 'The research template is the first pick.');
  assert.equal(await sheetNew.locator('[data-template-row] details[open]').count(), 0, 'The texts are closed.');
  await sheetNew.locator('[data-template-row="planner"] summary').click();
  assert.match(await sheetNew.locator('[data-template-row="planner"] pre').innerText(), /^You are <name>, one of the owner's agents/);
  assert.equal(await sheetNew.locator('[data-new-create]').isDisabled(), true, 'A name and a role come first.');
  await sheetNew.locator('[data-new-name]').fill('Level; reviewer');
  await sheetNew.locator('[data-new-role]').fill('reviews level designs');
  assert.equal(await sheetNew.locator('[data-new-create]').isDisabled(), true, 'A name with a symbol is not allowed.');
  await sheetNew.locator('[data-new-name]').fill('Level reviewer');
  await sheetNew.locator('[data-template="research"]').check();
  await sheetNew.locator('[data-new-create]').click();
  await desk.waitForFunction(() => location.hash === '#/~hub/agent-edit/level-reviewer');
  await desk.locator('[data-edit-form]').waitFor();
  assert.equal(await desk.locator('[data-edit-role]').inputValue(), 'reviews level designs');
  assert.match(await desk.locator('[data-edit-prompt]').inputValue(), /^You are Level reviewer, one of the owner's agents: reviews level designs\./);
  await desk.locator('[data-edit-profile="main"]').waitFor();
  assert.match(await desk.locator('[data-profile-shared]').innerText(), /Level reviewer/, 'The profile section names who shares main, itself included.');
  assert.equal(await desk.locator('[data-revert="default"]').count(), 0, 'No "Back to the app text" row.');
  assert.match(await desk.locator('.ae-version').first().innerText(), /Created/);

  await desk.goto(`${fixture.url}#/~hub/team`);
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('.team-card').count(), 8);
  assert.equal(await desk.locator('[data-agent="level-reviewer"] h3').innerText(), 'Level reviewer');
  assert.deepEqual(await desk.locator('[data-agent="level-reviewer"] .team-links a').allInnerTexts(), ['Details', 'Edit']);
  assert.equal((await desk.locator('[data-agent="level-reviewer"] [data-main-action]').innerText()).trim(), 'Chat');
  assert.equal(await desk.locator('[data-agent="level-reviewer"] .team-chip').innerText(), 'Research');
  await desk.locator('[data-sprite-open="level-reviewer"]').click();
  const customSheet = desk.locator('dialog[data-sprite-sheet="level-reviewer"]');
  await customSheet.waitFor();
  assert.equal(await customSheet.locator('[data-sheet-mode]').count(), 0, 'Sprite Studio sheets are for the built-in agents.');
  assert.equal(await customSheet.locator('[data-sheet-make]').count(), 0, 'No sheet job for it.');
  assert.ok(await customSheet.locator('.sheet-tile').count() > 1, 'The built-in and random sprites stay.');
  await desk.keyboard.press('Escape');
  await customSheet.waitFor({ state: 'detached' });
  await desk.locator('[data-main-action="level-reviewer"]').click();
  await desk.waitForFunction(() => location.hash === '#/~hub/chat');
  await desk.locator('[data-chat-persona]').waitFor();
  assert.equal(await desk.locator('[data-chat-persona]').inputValue(), 'level-reviewer', 'It is in the Talk to menu and Chat opens on it.');
  await desk.goto(`${fixture.url}#/~hub/agent/level-reviewer`);
  await desk.locator('[data-prompt="persona"] summary').click();
  assert.match(await desk.locator('[data-prompt="persona"] pre').innerText(), /^You are Level reviewer, one of the owner's agents/, 'Details shows its persona prompt.');

  step('Retire asks once, takes it off the Team, and Bring back returns it');
  await desk.goto(`${fixture.url}#/~hub/agent-edit/level-reviewer`);
  await desk.locator('[data-retire-open]').waitFor();
  await desk.locator('[data-retire-open]').click();
  assert.equal(await desk.locator('[data-retire-confirm]').innerText(), 'It leaves the Team and the Talk to menu. Old chats keep working.');
  await desk.locator('[data-retire-no]').click();
  assert.equal(await desk.locator('[data-retire-confirm]').count(), 0);
  await desk.locator('[data-retire-open]').click();
  await desk.locator('[data-retire-yes]').click();
  await desk.waitForFunction(() => location.hash === '#/~hub/team');
  await desk.locator('.team-card').first().waitFor();
  assert.equal(await desk.locator('.team-card').count(), 7);
  assert.equal(await desk.locator('[data-agent="level-reviewer"]').count(), 0);
  await desk.locator('[data-new-persona]').click();
  await sheetNew.locator('[data-retired-row="level-reviewer"]').waitFor();
  assert.match(await sheetNew.locator('[data-retired]').innerText(), /Level reviewer/);
  await sheetNew.locator('[data-bring-back="level-reviewer"]').click();
  await sheetNew.waitFor({ state: 'detached' });
  await desk.locator('[data-team-toast]').waitFor();
  await desk.locator('[data-agent="level-reviewer"]').waitFor();
  assert.equal(await desk.locator('.team-card').count(), 8);
  await desk.waitForFunction(() => document.activeElement?.hasAttribute('data-new-persona'));

  step('phone: New persona is a bottom sheet, every button is 44 px high, nothing scrolls sideways');
  for (const width of [375, 390]) {
    const phone = await open({ width, height: 844 }, { hasTouch: true, isMobile: true });
    await phone.goto(`${fixture.url}#/~hub/team`);
    await phone.locator('.team-card').first().waitFor();
    await noSideways(phone, `Team with a made persona at ${width}`);
    assert.ok((await phone.locator('[data-new-persona]').boundingBox()).height >= 44 - 0.5);
    await phone.locator('[data-new-persona]').tap();
    const dialogNew = phone.locator('dialog[data-new-persona-sheet]');
    await dialogNew.locator('[data-template-row]').first().waitFor();
    const box2 = await dialogNew.boundingBox();
    assert.ok(Math.abs(box2.x) < 1 && Math.abs(box2.width - width) < 1, `The sheet spans the screen at ${width}.`);
    assert.ok(Math.abs(box2.y + box2.height - 844) < 2, `The sheet sits at the bottom at ${width}.`);
    await noSideways(phone, `New persona at ${width}`);
    for (const target of await dialogNew.locator('button, input[type="text"], summary').evaluateAll(list => list.map(item => item.getBoundingClientRect().height))) assert.ok(target >= 44 - 0.5, `A control in the sheet is ${target} px high.`);
    await phone.keyboard.press('Escape');
  }

  console.log('hub-team-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
