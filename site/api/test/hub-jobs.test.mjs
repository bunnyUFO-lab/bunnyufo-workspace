// `GET /hub/jobs` and the deliverables on `GET /hub/requests/:id`, against the stand-in bucket. The card of a job is read in both homes it can
// have: a project's job with its card in `assistant` (until Milestone 2) and with its card in the project's own section (after). Nothing here
// reaches a real bucket, Hermes or Beads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, iso, minutesAgo, seeder } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const id = (name, rand) => `${day}-${name}-${rand}`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-jobs-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, inbox: 'inbox-dev' });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const put = seeder(fake, 'sections/inbox-dev');
  const cards = (section, entities) => fake.seed(`sections/${section}/workspace.json`, JSON.stringify({ name: section, entities }), 'application/json');
  /** A Hermes job of `project`, taken `minutes` ago, with the result files given. */
  const job = (jobId, { project = 'dev-proj', title = jobId, minutes = 30, result, session, report } = {}) => {
    put.request({ id: jobId, project, title, text: `Do ${title}`, preset: 'research', target: 'hermes', by: 'hermes', createdAt: iso(minutesAgo(NOW, minutes + 5)) });
    put.put(`requests/${jobId}/approved.json`, { target: 'hermes', expires: iso(new Date(NOW.getTime() + 3600000)), at: iso(minutesAgo(NOW, minutes + 4)) });
    put.put(`requests/${jobId}/taken.json`, { runner: 'hermes', at: iso(minutesAgo(NOW, minutes)), ...(session ? { session } : {}) });
    if (result) put.put(`requests/${jobId}/result.json`, { v: 1, by: 'hub', at: iso(minutesAgo(NOW, 1)), ...result });
    if (report) put.put(`requests/${jobId}/report.md`, report, 'text/markdown');
  };
  return { fake, get, put, job, cards, close: async () => { server.close(); await fake.close(); } };
}

const filedBy = (ask, request) => ({ ...ask, from: { host: 'hermes', tool: 'hermes', request } });

for (const [label, section] of [['before Milestone 2: the card is in assistant', 'assistant'], ['after Milestone 2: the card is in the project section', 'dev-proj']]) {
  test(`jobs list and result page, ${label}`, async () => {
    const { get, put, job, cards, close } = await fixture();
    try {
      cards(section, [{ id: 'sizes-card', title: 'Background sizes', folder: 'sizes' }]);
      const carded = id('measure', 'aaaa');
      const grilled = id('grill', 'bbbb');
      const quiet = id('quiet', 'cccc');
      const running = id('going', 'dddd');
      const elsewhere = id('other', 'eeee');
      const questions = [id('q1', 'f1f1'), id('q2', 'f2f2')];
      job(carded, { title: 'Measure the sizes', result: { outcome: 'card', card: `${section}/sizes` } });
      job(grilled, { title: 'Grill the plan', session: 'sess-1', result: { outcome: 'asks', asks: questions, summary: 'Two questions.' } });
      job(quiet, { title: 'Looked, found nothing', result: { outcome: 'failed', reason: 'nothing-to-do', summary: 'No change needed.' } });
      job(running, { title: 'Still going' });
      job(elsewhere, { title: 'Other project job', project: 'other-proj', result: { outcome: 'card', card: `${section}/sizes` } });
      // Asks the grilling job filed: one names the job, one is from another project (dropped), one is older than the job (dropped).
      put.ask(filedBy(askJson({ id: questions[0], project: 'dev-proj', now: NOW, question: 'Which palette?' }), grilled));
      put.ask(filedBy(askJson({ id: questions[1], project: 'other-proj', now: NOW, question: 'Which size?' }), grilled));
      put.ask(filedBy(askJson({ id: id('old', '9999'), project: 'dev-proj', now: new Date(NOW.getTime() - 86400000), question: 'Before the job' }), grilled));

      const finished = (await get('/hub/jobs?tab=finished&project=dev-proj')).body;
      assert.deepEqual(finished.counts, { running: 1, finished: 3 });
      assert.equal(finished.window, 'two months');
      const byTitle = Object.fromEntries(finished.jobs.map(row => [row.title, row]));
      assert.deepEqual(Object.keys(byTitle).sort(), ['Grill the plan', 'Looked, found nothing', 'Measure the sizes'], 'The project filter uses request.project, not the card\'s section.');
      assert.deepEqual(byTitle['Measure the sizes'].pills.map(pill => pill.text), ['Card']);
      assert.equal(byTitle['Measure the sizes'].deliverables[0].href, `/${section}#/sizes-card`);
      assert.equal(byTitle['Measure the sizes'].agent, 'Researcher');
      assert.equal(byTitle['Measure the sizes'].runner, 'hermes');
      assert.deepEqual(byTitle['Grill the plan'].deliverables.map(row => [row.kind, row.id]), [['ask', questions[0]]], 'Only the Ask of the same project and time counts.');
      assert.equal(byTitle['Grill the plan'].state, 'done', 'A grilling job with its Asks is done, not failed.');
      assert.deepEqual(byTitle['Looked, found nothing'].pills.map(pill => pill.text), ['Nothing to change']);

      const live = (await get('/hub/jobs?tab=running')).body;
      assert.deepEqual(live.jobs.map(row => row.title), ['Still going']);
      assert.deepEqual(live.counts, { running: 1, finished: 4 });

      const page = (await get(`/hub/requests/${carded}`)).body;
      assert.equal(page.cardHref, `/${section}#/sizes-card`, 'The existing cardHref stays.');
      assert.deepEqual(page.deliverables.map(row => [row.kind, row.ref, row.href]), [['card', `${section}/sizes`, `/${section}#/sizes-card`]]);
    } finally { await close(); }
  });
}

test('an older Hermes job names its Asks only in the report; a card not in the index has no link; a proposed job is not listed', async () => {
  const { get, put, job, close } = await fixture();
  try {
    const old = id('older', '1111');
    const ask = id('late', '2222');
    job(old, { title: 'Older job', result: { outcome: 'failed', summary: 'Hermes finished without a card.' }, report: `Thinking.\nASKS: ${ask}` });
    put.ask(askJson({ id: ask, project: 'dev-proj', now: NOW, question: 'Late question?' }));
    const lost = id('lost', '3333');
    job(lost, { title: 'Card not yet listed', result: { outcome: 'card', card: 'dev-proj/not-yet' } });
    put.request({ id: id('wait', '4444'), project: 'dev-proj', title: 'Proposed one', text: 'x', preset: 'research', target: 'hermes', by: 'hermes', createdAt: iso(NOW) });
    const jobs = (await get('/hub/jobs?tab=finished')).body.jobs;
    assert.deepEqual(jobs.map(row => row.title).sort(), ['Card not yet listed', 'Older job']);
    assert.deepEqual(jobs.find(row => row.title === 'Older job').pills.map(pill => pill.text), ['Failed'], 'The list reads no report, so the Ask is not found there.');
    const page = (await get(`/hub/requests/${old}`)).body;
    assert.deepEqual(page.deliverables.map(row => [row.kind, row.id]), [['ask', ask]], 'The result page reads the report and finds it.');
    const unlisted = (await get(`/hub/requests/${lost}`)).body.deliverables[0];
    assert.deepEqual([unlisted.kind, unlisted.ref, unlisted.href], ['card', 'dev-proj/not-yet', undefined]);
  } finally { await close(); }
});

test('tasks come from the session-items of the job\'s session, as a project and an id', async () => {
  const { get, put, job, close } = await fixture();
  try {
    const touched = id('task', '5555');
    job(touched, { title: 'Touched a task', session: 'sess-9', result: { outcome: 'card', card: 'assistant/x' } });
    put.event({ kind: 'session-items', ts: NOW.toISOString(), project: 'dev-proj', session: 'sess-9', touched: { beads: [{ project: 'dev-proj', id: 'dp-1a2' }], cards: [] } });
    const [row] = (await get('/hub/jobs?tab=finished')).body.jobs;
    assert.deepEqual(row.deliverables.filter(item => item.kind === 'task'), [{ kind: 'task', project: 'dev-proj', id: 'dp-1a2' }]);
    assert.deepEqual(row.pills.map(pill => pill.text), ['Card', 'Task']);
  } finally { await close(); }
});
