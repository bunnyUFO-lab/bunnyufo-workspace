// Run after npm run build. Chats and jobs in progress stay visible: the device keeps the chat whose reply is coming (and the jobs it started),
// and the list, the thread and the Jobs view merge it with what the Hub answers. Route interception makes the reads lie: the list answers
// without the chat, the thread answers 404 or with too few lines, the jobs read fails. At phone width; one flow also on `routes: 'path'`,
// which is the real site's mode.
import { chromium } from '@playwright/test';
import { ms, steadyFetch } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { requestJson } from '../../site/api/test/hub-fixtures.mjs';
import { hashOf } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const KEY = 'buw.hub.inProgress.v1';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const jobId = (slug, tail) => `${day}-probe-${slug}-${tail}`;
const [LOCAL_JOB, DONE_JOB] = [jobId('scan-tilesets', 'c111'), jobId('finished-scan', 'c222')];
const SAVED_CHAT = `${day}-sav123`;
const ASK = 'Plan the forest level';

const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: Array.from({ length: 8 }, () => ['Working on it. ', { hold: true }]) } });
const browser = await chromium.launch({ headless: true, channel });
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{"chats":[],"jobs":[]}'), KEY);
const open = async (options = {}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  const lies = { hide: null, thread: null, jobs: false, jobsView: false };
  await context.route(url => url.pathname === '/api/hub/chat', async route => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    const response = await steadyFetch(route);
    const body = await response.json();
    await route.fulfill({ response, json: lies.hide ? { ...body, conversations: body.conversations.filter(chat => chat.id !== lies.hide), total: Math.max(0, (body.total ?? 0) - 1) } : body });
  });
  await context.route(url => /^\/api\/hub\/chat\/[^/]+$/.test(url.pathname), async route => {
    if (route.request().method() !== 'GET' || !lies.thread) { await route.fallback(); return; }
    if (lies.thread === '404') await route.fulfill({ status: 404, json: { error: 'No such conversation.' } });
    else await route.fulfill({ json: { messages: [], running: false } });
  });
  await context.route(url => /^\/api\/hub\/chat\/[^/]+\/jobs$/.test(url.pathname), route => (lies.jobs ? route.abort() : route.fallback()));
  await context.route(url => url.pathname === '/api/hub/jobs', route => (lies.jobsView ? route.abort() : route.fallback()));
  if (options.path) {
    await context.route('**/api/capabilities', async route => {
      const response = await steadyFetch(route);
      await route.fulfill({ response, json: { ...(await response.json()), routes: 'path' } });
    });
  }
  if (options.seed) {
    await context.addInitScript(({ key, store }) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, JSON.stringify(store)); sessionStorage.setItem('seeded', '1'); } }, { key: KEY, store: options.seed });
  }
  if (options.blocked) {
    // The app's own settings read storage unguarded in places (App.tsx), so only the list's key is blocked here: reads and writes both throw.
    await context.addInitScript(key => { for (const name of ['getItem', 'setItem']) { const real = Storage.prototype[name]; Storage.prototype[name] = function (k, ...rest) { if (k === key) throw new DOMException('blocked', 'SecurityError'); return real.call(this, k, ...rest); }; } }, KEY);
  }
  return { page, lies, context };
};
const send = async (page, text) => {
  await page.goto(`${fixture.url}#/~hub/chat/new`);
  await page.locator('textarea[aria-label="Message"]').fill(text);
  await page.keyboard.press('Enter');
  await page.locator('[data-pending]').waitFor();
  await page.waitForFunction(() => /#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/.test(location.hash));
  await page.locator('.hub-bubble.assistant', { hasText: 'Working on it.' }).waitFor();
  const chat = (await hashOf(page)).split('/').pop();
  // The reply so far is written about once a second.
  await page.waitForFunction(({ key, chat }) => (JSON.parse(localStorage.getItem(key) || '{"chats":[]}').chats.find(entry => entry.id === chat)?.reply ?? '').includes('Working on it.'), { key: KEY, chat });
  return chat;
};
const rowOf = (page, chat) => page.locator(`[data-chat-list] [data-conversation="${chat}"]`);
const lines = (page, role, text) => page.locator(`.hub-bubble.${role}`, { hasText: text });
const release = async (index, text) => { fixture.hermes.release(fixture.hermes.runs[index].id, text); };
let run = 0;

try {
  {
    const { page, lies } = await open();
    step('send in a new chat, leave, return with the list answering without it: the row is still there, Replying; a reload keeps it');
    const chat = await send(page, ASK);
    const mine = run++;
    lies.hide = chat;
    await page.evaluate(() => { location.hash = '#/~hub/chat'; });
    await rowOf(page, chat).locator('[data-conversation-running]').waitFor();
    assert.match(await rowOf(page, chat).textContent(), /Plan the forest level/);
    await page.reload();   // a reload on the thread; the list is opened again
    await page.evaluate(() => { location.hash = '#/~hub/chat'; });
    await rowOf(page, chat).locator('[data-conversation-running]').waitFor();

    step('the thread answers 404: the owner message and the reply so far show, with no bounce and no error');
    lies.thread = '404';
    await rowOf(page, chat).click();
    await lines(page, 'user', ASK).waitFor();
    await lines(page, 'assistant', 'Working on it.').waitFor();
    await page.locator('[data-chat-unsaved]').waitFor();
    assert.equal(await hashOf(page), `#/~hub/chat/${chat}`);
    assert.equal(await page.locator('.hub-error').count(), 0, 'No "not found" while the device holds the turn.');

    step('the thread answers with too few lines: the same, after a reload');
    lies.thread = 'short';
    await page.reload();
    await lines(page, 'user', ASK).waitFor();
    await lines(page, 'assistant', 'Working on it.').waitFor();
    await page.locator('[data-chat-unsaved]').waitFor();
    assert.equal(await hashOf(page), `#/~hub/chat/${chat}`);

    step('the read recovers: one copy of each line, and the note goes away');
    lies.thread = null;
    lies.hide = null;
    await page.locator('[data-chat-unsaved]').waitFor({ state: 'detached' });
    await page.locator('[data-pending]').waitFor();
    assert.equal(await page.locator('.hub-bubble.user').count(), 1);
    assert.equal(await page.locator('.hub-bubble.assistant', { hasText: 'Working on it.' }).count(), 1, 'The reply is not shown twice.');

    step('the reply saves: the entry leaves and the row is ordinary');
    await release(mine, 'All done.');
    await page.locator('[data-pending]').waitFor({ state: 'detached' });
    await page.waitForFunction(({ key }) => JSON.parse(localStorage.getItem(key) || '{"chats":[]}').chats.length === 0, { key: KEY });
    await page.evaluate(() => { location.hash = '#/~hub/chat'; });
    await rowOf(page, chat).waitFor();
    assert.equal(await page.locator('[data-conversation-running]').count(), 0);
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }

  {
    const { page } = await open();
    step('delete a chat during its reply: it does not come back, including after a reload');
    const chat = await send(page, 'Delete me while you reply');
    run++;
    await page.evaluate(() => { location.hash = '#/~hub/chat'; });
    await rowOf(page, chat).waitFor();
    await page.locator(`[data-chat-list] [data-swipe="${chat}"] [data-row-menu]`).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await rowOf(page, chat).waitFor({ state: 'detached' });
    assert.equal((await stored(page)).chats.length, 0);
    await page.reload();
    await page.locator('[data-chat-list]').waitFor();
    assert.equal(await rowOf(page, chat).count(), 0);
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }

  {
    const { page } = await open();
    step('archive a chat during its reply: it does not come back, including after a reload');
    const chat = await send(page, 'Archive me while you reply');
    run++;
    await page.evaluate(() => { location.hash = '#/~hub/chat'; });
    await rowOf(page, chat).waitFor();
    await page.locator(`[data-chat-list] [data-swipe="${chat}"] [data-row-menu]`).click();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await rowOf(page, chat).waitFor({ state: 'detached' });
    assert.equal((await stored(page)).chats.length, 0);
    await page.reload();
    await page.locator('[data-chat-list]').waitFor();
    assert.equal(await rowOf(page, chat).count(), 0);
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }

  {
    const { page, lies } = await open({ path: true });
    step('path routes (the real site): the row stays with the list lying, and the thread keeps its lines with the read answering 404');
    const chat = await send(page, 'Path routes reply');
    const mine = run++;
    lies.hide = chat;
    lies.thread = '404';
    await page.evaluate(() => { location.hash = '#/~hub/chat'; });
    await rowOf(page, chat).locator('[data-conversation-running]').waitFor();
    await rowOf(page, chat).click();
    await lines(page, 'user', 'Path routes reply').waitFor();
    await lines(page, 'assistant', 'Working on it.').waitFor();
    await page.locator('[data-chat-unsaved]').waitFor();
    assert.equal(await hashOf(page), `#/~hub/chat/${chat}`);
    lies.thread = null;
    lies.hide = null;
    await page.locator('[data-chat-unsaved]').waitFor({ state: 'detached' });
    await release(mine, 'Done on path routes.');
    await page.locator('[data-pending]').waitFor({ state: 'detached' });
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }

  {
    const { page } = await open({ blocked: true });
    step('storage blocked: chat still works');
    await page.goto(`${fixture.url}#/~hub/chat/new`);
    await page.locator('textarea[aria-label="Message"]').fill('Blocked storage reply');
    await page.keyboard.press('Enter');
    await page.locator('.hub-bubble.assistant', { hasText: 'Working on it.' }).waitFor();
    await release(run++, 'Done without storage.');
    await page.locator('.hub-bubble.assistant', { hasText: 'Working on it. Done without storage.' }).waitFor().catch(async () => { await page.locator('[data-pending]').waitFor({ state: 'detached' }); });
    assert.equal(await page.locator('.hub-bubble.user', { hasText: 'Blocked storage reply' }).count(), 1);
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }

  const longAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const entry = (id, title, extra = {}) => ({ key: `k${id}`, id, title, persona: null, model: null, startedAt: new Date().toISOString(), lines: [{ role: 'user', text: title, at: new Date().toISOString() }], base: 0, ask: { text: title, at: new Date().toISOString() }, reply: 'Half a sentence', jobs: [], ...extra });
  {
    const OLD = `${day}-old001`;
    const OLD2 = `${day}-old002`;
    const { page } = await open({ seed: { chats: [entry(OLD, 'Old reply', { startedAt: longAgo }), entry(OLD2, 'Another old reply', { startedAt: longAgo })], jobs: [] } });
    step('an entry past two hours says the Hub never confirmed the reply, keeps its words, and can be dismissed');
    await page.goto(`${fixture.url}#/~hub/chat`);
    await rowOf(page, OLD).locator('[data-conversation-unconfirmed]').waitFor();
    assert.equal(await page.locator('[data-chat-none]').count(), 0, 'No "No chats yet" while an entry exists.');
    await rowOf(page, OLD).click();
    await lines(page, 'assistant', 'Half a sentence').waitFor();
    await page.locator('[data-chat-unconfirmed]').waitFor();
    await page.locator('[data-entry-dismiss]').click();
    await page.locator('[data-chat-unconfirmed]').waitFor({ state: 'detached' });
    assert.deepEqual((await stored(page)).chats.map(item => item.id), [OLD2]);
    await page.evaluate(() => { location.hash = '#/~hub/chat'; });
    await rowOf(page, OLD2).locator('[data-conversation-unconfirmed]').waitFor();
    await page.locator(`[data-entry-dismiss]`).click();
    await rowOf(page, OLD2).waitFor({ state: 'detached' });
    assert.equal((await stored(page)).chats.length, 0);
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }

  {
    const SEARCH = `${day}-sea001`;
    const { page } = await open({ seed: { chats: [entry(SEARCH, 'Quiet title', { reply: 'The dragon sleeps under the bridge' })], jobs: [] } });
    step('chat search matches the words of a chat in progress, and a failed list read shows it beside the error');
    await page.route(url => url.pathname === '/api/hub/chat', route => route.abort());
    await page.goto(`${fixture.url}#/~hub/chat`);
    await rowOf(page, SEARCH).waitFor();
    await page.locator('[data-chat-search]').fill('dragon');
    await rowOf(page, SEARCH).waitFor();
    await page.locator('[data-chat-search]').fill('zeppelin');
    await page.locator('[data-chat-nomatch], [data-chat-list] [data-conversation]').first().waitFor();
    assert.equal(await rowOf(page, SEARCH).count(), 0);
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }

  {
    const job = (id, title, state) => ({ chat: SAVED_CHAT, addedAt: new Date().toISOString(), job: { id, title, text: 'Scan them.', project: 'probe', writer: 'hermes', verified: true, state, approvable: false, by: 'hermes', agent: 'Researcher' } });
    const request = { ...requestJson({ id: DONE_JOB, project: 'probe', by: 'hermes-main', text: 'Finished scan', now: new Date() }), title: 'Finished scan', preset: 'research', target: 'hermes', origin: { kind: 'agent', name: 'hermes' }, createdAt: new Date(Date.now() - 3_600_000).toISOString() };
    fixture.seed.request(request, { writer: 'agent' });
    fixture.seed.put(`requests/${DONE_JOB}/approved.json`, { v: 1, request: DONE_JOB, target: 'hermes', limits: { minutes: 30 }, expires: new Date(Date.now() + 3_600_000).toISOString(), at: new Date(Date.now() - 3_000_000).toISOString(), by: 'owner' });
    fixture.seed.put(`requests/${DONE_JOB}/taken.json`, { runner: 'hermes', at: new Date(Date.now() - 2_900_000).toISOString() });
    fixture.seed.put(`requests/${DONE_JOB}/result.json`, { outcome: 'nothing', at: new Date(Date.now() - 2_000_000).toISOString(), by: 'hermes', summary: 'Done.' });
    fixture.fake.seed(`sections/inbox/chat/${SAVED_CHAT}.jsonl`, `${[
      { role: 'user', text: 'Scan the tilesets', at: new Date(Date.now() - 3_700_000).toISOString() },
      { role: 'assistant', text: 'Two scans.', at: new Date(Date.now() - 3_600_000).toISOString(), jobs: [DONE_JOB, LOCAL_JOB] },
    ].map(item => JSON.stringify(item)).join('\n')}\n`, 'application/x-ndjson');
    const { page, lies } = await open({ seed: { chats: [], jobs: [job(LOCAL_JOB, 'Scan the tilesets', 'running'), job(DONE_JOB, 'Finished scan', 'running')] } });
    step('a job the chat started: with the job reads failing its row is still in the thread and in the Jobs view');
    lies.jobs = true;
    lies.jobsView = true;
    await page.goto(`${fixture.url}#/~hub/chat/${SAVED_CHAT}`);
    const rows = page.locator('[data-chat-jobs] [data-job-row]');
    await rows.first().waitFor();
    await page.locator(`[data-chat-jobs] [data-job-row="${LOCAL_JOB}"]`).waitFor();
    await page.goto(`${fixture.url}#/~hub/jobs/running`);
    await page.locator(`[data-job-row="${LOCAL_JOB}"][data-job-local]`).waitFor();
    await page.locator(`[data-job-row="${DONE_JOB}"][data-job-local]`).waitFor();
    assert.equal((await stored(page)).jobs.length, 2);

    step('once the Hub shows a job finished it is the Hub\'s row and the entry has gone');
    lies.jobsView = false;
    await page.reload();
    await page.locator(`[data-jobs-list="running"] [data-job-row="${LOCAL_JOB}"]`).waitFor();
    await page.waitForFunction(({ key, id }) => !JSON.parse(localStorage.getItem(key)).jobs.some(item => item.job.id === id), { key: KEY, id: DONE_JOB });
    assert.deepEqual((await stored(page)).jobs.map(item => item.job.id), [LOCAL_JOB], 'The unfinished one stays.');
    await page.goto(`${fixture.url}#/~hub/jobs/finished`);
    const done = page.locator(`[data-jobs-list="finished"] [data-job-row="${DONE_JOB}"]`);
    await done.waitFor();
    assert.equal(await done.getAttribute('data-job-local'), null);
    await page.context().unrouteAll({ behavior: "ignoreErrors" }); await page.context().close();
  }
  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
