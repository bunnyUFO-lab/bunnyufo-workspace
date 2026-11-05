// What delegate_task started: the fold over run events and the completion rows Hermes saves. Texts follow Hermes 0.22.5's own formats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DELEGATE_WAIT_MS, dispatchOf, foldDelegates, parseDelivery, settleDelegates } from '../chat-delegates.mjs';

const handle = (goals, extra = {}) => JSON.stringify({ status: 'dispatched', mode: 'background', count: goals.length, delegation_id: 'deleg_ab12', goals, ...extra });
const cutHandle = goals => `${handle(goals).slice(0, 497)}...`;
const fold = events => events.reduce((list, [event, data]) => foldDelegates(list, event, data), []);

const BATCH = `[ASYNC DELEGATION BATCH COMPLETE — deleg_ab12]
A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished; its consolidated results are below.

Dispatched: 2026-11-04 20:12:13 (2m8s ago)
Role: leaf   Model: gpt-6-sol   Total duration: 128.76s

--- ✓ TASK 1/2: Read the mood board  (status=completed, api_calls=9, 64.2s) ---
## Findings
The board asks for dusk colours.
Full live transcript (complete tool/assistant trace): /home/hermes/cache/delegation/live/deleg_ab12/task-0.log

--- ✗ TASK 2/2: Read the scenery cards  (status=error, 11s) ---
(error: the card was gone)
Partial output:
Only the index loaded.`;

test('a dispatch handle names what started, also when its last goal is cut', () => {
  assert.deepEqual(dispatchOf(handle(['One', 'Two "quoted"'])), { delegation: 'deleg_ab12', count: 2, goals: ['One', 'Two "quoted"'] });
  const long = 'x'.repeat(600);
  const cut = dispatchOf(cutHandle(['Short goal', long]));
  assert.equal(cut.count, 2);
  assert.equal(cut.goals[0], 'Short goal');
  assert.match(cut.goals[1], /^x+…$/);
});

test('delegate_task calls that start nothing add nothing', () => {
  const list = [];
  assert.equal(foldDelegates(list, 'tool.completed', { tool: 'delegate_task', preview: '{"action": "list", "count": 0, "subagents": [], "note": "No live subagents right now."}' }), list);
  assert.equal(foldDelegates(list, 'tool.completed', { tool: 'delegate_task', preview: '' }), list);
  assert.equal(foldDelegates(list, 'tool.completed', { tool: 'terminal', preview: handle(['Not a delegate']) }), list);
  assert.equal(foldDelegates(list, 'tool.started', { tool: 'delegate_task', preview: '2 tasks' }), list);
});

test('the handle and the subagent events make one record per delegate, in either order', () => {
  const start = { goal: 'Read the mood board', task_index: 0, task_count: 2, subagent_id: 'sa-0-x' };
  const second = { goal: 'Read the scenery cards', task_index: 1, task_count: 2, subagent_id: 'sa-1-y' };
  const dispatch = ['tool.completed', { tool: 'delegate_task', preview: handle([start.goal, second.goal]) }];
  for (const events of [
    [dispatch, ['subagent.start', start], ['subagent.start', second]],
    [['subagent.start', start], ['subagent.start', second], dispatch],
  ]) {
    const list = fold(events);
    assert.deepEqual(list.map(item => [item.index, item.goal, item.state, item.delegation, item.count]), [
      [0, start.goal, 'running', 'deleg_ab12', 2],
      [1, second.goal, 'running', 'deleg_ab12', 2],
    ]);
    assert.deepEqual(list.map(item => item.id), ['d1', 'd2']);
  }
});

test('a subagent.start fills in the whole of a goal the handle cut', () => {
  const whole = `Read ${'y'.repeat(600)}`.slice(0, 390);
  const list = fold([
    ['tool.completed', { tool: 'delegate_task', preview: cutHandle(['Short', `Read ${'y'.repeat(600)}`]) }],
    ['subagent.start', { goal: whole, task_index: 1, task_count: 2, subagent_id: 'sa-1' }],
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].goal, whole);
});

test('subagent.complete ends the delegate, and a failure says so', () => {
  const list = fold([
    ['subagent.start', { goal: 'A', task_index: 0, task_count: 2, subagent_id: 'sa-0' }],
    ['subagent.start', { goal: 'B', task_index: 1, task_count: 2, subagent_id: 'sa-1' }],
    ['subagent.complete', { task_index: 0, subagent_id: 'sa-0', status: 'completed', summary: 'Found it.', duration_seconds: 64.2 }],
    ['subagent.complete', { task_index: 1, subagent_id: 'sa-1', status: 'timeout', preview: 'Ran out of time.' }],
  ]);
  assert.deepEqual(list.map(item => [item.state, item.summary, item.seconds]), [['done', 'Found it.', 64], ['failed', 'Ran out of time.', undefined]]);
});

test('a batch row gives each task its status, its whole result and no transcript path', () => {
  const parsed = parseDelivery(BATCH);
  assert.equal(parsed.delegation, 'deleg_ab12');
  assert.deepEqual(parsed.tasks.map(task => [task.index, task.count, task.goal, task.status, task.seconds]), [
    [0, 2, 'Read the mood board', 'completed', 64.2],
    [1, 2, 'Read the scenery cards', 'error', 11],
  ]);
  assert.match(parsed.tasks[0].summary, /^## Findings\nThe board asks for dusk colours\.$/);
  assert.match(parsed.tasks[1].summary, /Only the index loaded\.$/);
});

test('the other completion rows: one delegate, a failure notice, a batch that never ran, and text that is none of these', () => {
  const one = parseDelivery('[ASYNC DELEGATION COMPLETE — deleg_one]\nA background subagent you dispatched earlier has finished.\nStatus: completed   API calls: 4   Duration: 30.5s\n--- RESULT ---\nAll good.');
  assert.deepEqual(one.tasks, [{ index: 0, count: 1, goal: '', status: 'completed', summary: 'All good.', seconds: 30.5 }]);
  const notice = parseDelivery('[ASYNC DELEGATION TASK FAILED — deleg_two, task 2/3]\nOne subagent has failed.\nTask: B\nStatus: error   Duration: 3s\nError: no key');
  assert.deepEqual(notice.tasks, [{ index: 1, count: 3, goal: 'B', status: 'error', summary: 'no key' }]);
  const broken = parseDelivery('[ASYNC DELEGATION BATCH COMPLETE — deleg_three]\nText.\n--- ERROR ---\nThe batch did not complete successfully: no model');
  assert.deepEqual(broken.tasks, []);
  assert.match(broken.error, /no model/);
  assert.equal(parseDelivery('What the owner typed'), null);
  assert.equal(parseDelivery(null), null);
});

const running = goals => goals.map((goal, index) => ({ id: `d${index + 1}`, delegation: 'deleg_ab12', index, count: goals.length, goal, state: 'running' }));

test('saved rows settle the delegates still running, and the same list comes back when nothing changed', () => {
  const list = running(['Read the mood board', 'Read the scenery cards']);
  assert.equal(settleDelegates(list, [], 1000), list);
  assert.equal(settleDelegates(list, [{ role: 'assistant', content: 'A reply' }], 1000), list);
  assert.equal(settleDelegates(list, null, 1000), list, 'Hermes did not answer.');
  assert.equal(settleDelegates(list, [{ content: BATCH.replaceAll('deleg_ab12', 'deleg_other') }], 1000), list, 'Another batch of the same run.');
  const settled = settleDelegates(list, [{ content: BATCH }], 1000);
  assert.deepEqual(settled.map(item => [item.state, item.seconds]), [['done', 64], ['failed', 11]]);
  assert.match(settled[0].summary, /dusk colours/);
  assert.equal(settleDelegates(settled, [{ content: BATCH }], 1000), settled);
});

test('a failure notice comes first and the batch row replaces it with the whole result', () => {
  const list = running(['A', 'B']);
  const notice = '[ASYNC DELEGATION TASK FAILED — deleg_ab12, task 2/2]\nFailed.\nTask: B\nStatus: error   Duration: 3s\nError: x';
  const early = settleDelegates(list, [{ content: notice }], 1000);
  assert.deepEqual(early.map(item => item.state), ['running', 'failed']);
  const late = settleDelegates(early, [{ content: notice }, { content: BATCH.replace('Read the mood board', 'A').replace('Read the scenery cards', 'B') }], 1000);
  assert.deepEqual(late.map(item => item.state), ['done', 'failed']);
  assert.match(late[1].summary, /Only the index loaded/);
});

test('a batch that never ran fails its delegates, and past the wait the rest are unknown', () => {
  const list = running(['A']);
  const failed = settleDelegates(list, [{ content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_ab12]\n--- ERROR ---\nThe batch did not complete successfully: no model' }], 1000);
  assert.equal(failed[0].state, 'failed');
  assert.match(failed[0].summary, /no model/);
  assert.equal(settleDelegates(list, [], DELEGATE_WAIT_MS), list);
  assert.equal(settleDelegates(list, null, DELEGATE_WAIT_MS + 1)[0].state, 'unknown');
});
