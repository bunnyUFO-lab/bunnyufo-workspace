// What a job delivered: the pure parts. Cards run in both forms the Library has (a card in `assistant`, and one in a project's own section),
// because both are real: before Milestone 2 a job's card is in `assistant`, after it a project job's card is in the project's section.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverablesOf, jobsList, jobTab, pillsOf, prLabel } from '../job-deliverables.mjs';
import { asksOf, outcomeOf } from '../run-outcome.mjs';
import { requestItem } from '../hub-model.mjs';

const JOB = '20261105-measure-a1b1';
const ASK_A = '20261105-colours-c3d3';
const ASK_B = '20261105-sizes-e5f5';
const at = '2026-11-05T10:00:00.000Z';
const later = '2026-11-05T10:20:00.000Z';
const earlier = '2026-11-05T09:00:00.000Z';

const item = (extra = {}) => ({ id: JOB, project: 'dev-proj', at, state: 'done', title: 'Measure it', preset: 'research', run: { runner: 'hermes', at, session: 's1' }, finish: { outcome: 'card', at: later }, ...extra });
const index = new Map([
  ['assistant/measure-sizes', { title: 'Sizes', href: '/assistant#/measure-sizes' }],
  ['dev-proj/measure-sizes', { title: 'Sizes', href: '/dev-proj#/measure-sizes' }],
]);
const card = ref => index.get(ref);

test('a card in any section is read as section/folder, with no assistant assumed', () => {
  for (const ref of ['assistant/measure-sizes', 'dev-proj/measure-sizes']) {
    const [one] = deliverablesOf({ item: item({ finish: { outcome: 'card', at: later, card: ref } }), card });
    assert.deepEqual(one, { kind: 'card', ref, section: ref.split('/')[0], title: 'Sizes', href: `/${ref.split('/')[0]}#/measure-sizes` });
  }
  const [missing] = deliverablesOf({ item: item({ finish: { outcome: 'card', at: later, card: 'dev-proj/not-yet' } }), card });
  assert.equal(missing.href, undefined, 'A card the index does not have yet has no link; the page says so.');
  assert.deepEqual(deliverablesOf({ item: item({ finish: { outcome: 'card', at: later, card: '../../x' } }), card }), [], 'A malformed reference is dropped.');
});

test('a pull request is a link with a label', () => {
  assert.equal(prLabel('https://github.com/owner/repo/pull/12'), 'owner/repo #12');
  const [pr] = deliverablesOf({ item: item({ finish: { outcome: 'pr', at: later, pr: 'https://github.com/owner/repo/pull/12' } }) });
  assert.deepEqual(pr, { kind: 'pr', href: 'https://github.com/owner/repo/pull/12', label: 'owner/repo #12' });
  assert.deepEqual(deliverablesOf({ item: item({ finish: { outcome: 'pr', at: later, pr: 'javascript:alert(1)' } }) }), []);
});

test('Asks: from.request, the result and the report count; another project or an older Ask does not', () => {
  const asks = [
    { id: ASK_A, project: 'dev-proj', at: later, title: 'Which palette?', state: 'open', fromRequest: JOB },
    { id: ASK_B, project: 'dev-proj', at: later, title: 'Which size?', state: 'open' },
    { id: '20261105-other-1111', project: 'other', at: later, title: 'Other project', state: 'open', fromRequest: JOB },
    { id: '20261105-old-2222', project: 'dev-proj', at: earlier, title: 'Before the job', state: 'open', fromRequest: JOB },
    { id: '20261105-nobody-3333', project: 'dev-proj', at: later, title: 'Unrelated', state: 'open' },
  ];
  const names = list => list.filter(row => row.kind === 'ask').map(row => row.id);
  assert.deepEqual(names(deliverablesOf({ item: item(), asks })), [ASK_A]);
  assert.deepEqual(names(deliverablesOf({ item: item({ finish: { outcome: 'asks', at: later, asks: [ASK_B] } }), asks })), [ASK_A, ASK_B], 'The result names more.');
  assert.deepEqual(names(deliverablesOf({ item: item(), asks, reportText: `Questions filed.\nASKS: ${ASK_B}` })), [ASK_A, ASK_B], 'An older Hermes job names its Asks only in the report.');
  assert.deepEqual(names(deliverablesOf({ item: item({ finish: { outcome: 'asks', at: later, asks: ['20261105-other-1111', '20261105-old-2222'] } }), asks })), [ASK_A], 'Named Asks of another project or from before the job are dropped too.');
});

test('checklists, other jobs and tasks', () => {
  const checklists = [
    { id: '20261105-steps-4444', project: 'dev-proj', at: later, title: 'Steps', state: 'open', fromRequest: JOB },
    { id: '20261105-steps-5555', project: 'dev-proj', at: later, title: 'Not ours', state: 'open', fromRequest: '20261105-else-9999' },
  ];
  const requests = [
    { id: '20261105-child-6666', project: 'dev-proj', at: later, title: 'Follow-up job', state: 'proposed', origin: { kind: 'run', name: JOB } },
    { id: '20261105-child-7777', project: 'other', at: later, title: 'Other project', state: 'proposed', origin: { kind: 'run', name: JOB } },
    { id: '20261105-child-8888', project: 'dev-proj', at: later, title: 'By an agent', state: 'proposed', origin: { kind: 'agent', name: JOB } },
  ];
  const touched = { beads: [{ project: 'dev-proj', id: 'dp-1a2' }, { project: 'dev-proj', id: 'dp-1a2' }, { project: 'other', id: 'ot-9z9' }] };
  const out = deliverablesOf({ item: item(), checklists, requests, touched, taskTitle: (project, id) => (id === 'dp-1a2' ? 'Fix the crop' : undefined) });
  assert.deepEqual(out.map(row => [row.kind, row.id]), [['checklist', '20261105-steps-4444'], ['job', '20261105-child-6666'], ['task', 'dp-1a2'], ['task', 'ot-9z9']]);
  assert.equal(out[2].title, 'Fix the crop');
  assert.equal(out[3].title, undefined, 'With no title the row shows the id.');
  assert.deepEqual(Object.keys(out[2]).sort(), ['id', 'kind', 'project', 'title'], 'Only a project and an id are kept of a task, plus its label.');
});

test('request.bead is where the job came from, not something it delivered', () => {
  assert.deepEqual(deliverablesOf({ item: item({ bead: 'dp-0aa', finish: { outcome: 'failed', at: later } }) }), []);
});

test('pills: each deliverable, then how it ended', () => {
  const texts = job => pillsOf(job).map(pill => pill.text);
  const some = (...kinds) => kinds.map(kind => ({ kind }));
  assert.deepEqual(texts({ state: 'done', deliverables: some('card') }), ['Card']);
  assert.deepEqual(texts({ state: 'done', deliverables: some('pr', 'card', 'ask', 'ask', 'checklist', 'task', 'job') }), ['Card', 'PR', '2 Asks', 'Checklist', 'Task', 'Job']);
  assert.deepEqual(texts({ state: 'done', deliverables: some('ask') }), ['Ask']);
  assert.deepEqual(texts({ state: 'asking', deliverables: [] }), ['Has a question']);
  assert.deepEqual(texts({ state: 'done', nothing: true, deliverables: [] }), ['Nothing to change']);
  assert.deepEqual(texts({ state: 'failed', deliverables: [] }), ['Failed']);
  assert.deepEqual(texts({ state: 'stopped', deliverables: [] }), ['Stopped']);
  assert.deepEqual(texts({ state: 'expired', deliverables: [] }), ['Expired']);
  assert.deepEqual(texts({ state: 'running', stale: at, deliverables: [] }), ['No word']);
  assert.deepEqual(texts({ state: 'done', finish: { outcome: 'manual' }, deliverables: [] }), ['You marked it done']);
  assert.deepEqual(texts({ state: 'done', deliverables: [] }), ['Nothing delivered']);
  assert.deepEqual(texts({ state: 'running', deliverables: [] }), [], 'A running job has delivered nothing yet and says nothing.');
  assert.deepEqual(texts({ state: 'failed', deliverables: some('card') }), ['Card', 'Failed']);
});

test('tabs: running and finished; proposed, declined and the legacy states are left out', () => {
  for (const state of ['approved', 'taken', 'running', 'stopping', 'lost']) assert.equal(jobTab(state), 'running', state);
  for (const state of ['done', 'failed', 'stopped', 'asking', 'expired']) assert.equal(jobTab(state), 'finished', state);
  for (const state of ['proposed', 'declined', 'open', 'whatever']) assert.equal(jobTab(state), null, state);
});

test('the list counts, filters by project, drops legacy requests and caps Finished newest first', () => {
  const preset = () => ({ agent: 'Researcher' });
  const make = (n, extra = {}) => requestItem({ id: `20261105-job-${String(n).padStart(4, '0')}`, project: 'dev-proj', createdAt: at, text: `Job ${n}`, preset: 'research' }, 'done', { at, runner: 'hermes' }, { result: { outcome: 'card', at: new Date(Date.parse(at) + n * 1000).toISOString(), card: 'dev-proj/x' }, ...extra });
  const requests = [
    ...Array.from({ length: 105 }, (_, n) => make(n)),
    { ...make(900), project: 'other' },
    { ...make(901), preset: undefined },
    { ...make(902), state: 'running', finish: undefined },
    { ...make(903), state: 'proposed' },
  ];
  const all = jobsList({ requests, tab: 'finished', preset, build: () => [] });
  assert.deepEqual(all.counts, { running: 1, finished: 106 });
  assert.equal(all.jobs.length, 100, 'At most 100 finished.');
  assert.equal(all.jobs[0].id, '20261105-job-0900', 'Newest first.');
  assert.equal(all.window, 'two months');
  const mine = jobsList({ requests, project: 'dev-proj', tab: 'running', preset, build: () => [] });
  assert.deepEqual([mine.counts, mine.jobs.length], [{ running: 1, finished: 105 }, 1], 'The other project is out of both counts.');
  assert.equal(all.jobs[0].agent, 'Researcher');
});

test('ASKS: ids from the last line, valid ones only, at most 12', () => {
  assert.deepEqual(asksOf(`Done.\nASKS: ${ASK_A}, ${ASK_B}`), [ASK_A, ASK_B]);
  assert.deepEqual(asksOf(`ASKS: ${ASK_A}\nmore\nASKS: **${ASK_B}**`), [ASK_B], 'The last line counts.');
  assert.deepEqual(asksOf(`ASKS: ${ASK_A} not-an-id ../../x ${ASK_A}`), [ASK_A], 'A bad id is dropped and a repeat counted once.');
  assert.deepEqual(asksOf('no such line'), []);
  const many = Array.from({ length: 20 }, (_, n) => `20261105-q-${String(n).padStart(2, '0')}ab`).join(' ');
  assert.equal(asksOf(`ASKS: ${many}`).length, 12);
});

test('a grilling run ends with ASKS and no CARD: done with its Asks, not failed', () => {
  const run = output => ({ status: 'completed', output });
  const asks = outcomeOf({ run: run(`Three questions.\nASKS: ${ASK_A} ${ASK_B}`), at });
  assert.deepEqual([asks.outcome, asks.asks], ['asks', [ASK_A, ASK_B]]);
  const both = outcomeOf({ run: run(`CARD: dev-proj/x\nCARD: assistant/x\nASKS: ${ASK_A}`), at });
  assert.deepEqual([both.outcome, both.card, both.asks], ['card', 'assistant/x', [ASK_A]]);
  assert.equal('asks' in outcomeOf({ run: run('CARD: assistant/x'), at }), false, 'No asks key without asks.');
  assert.match(outcomeOf({ run: run('Nothing useful'), at }).summary, /without a card/);
  assert.deepEqual(outcomeOf({ run: run('ASKS: not-an-id'), at }).outcome, 'failed', 'A bad id is dropped, leaving no Asks.');
});
