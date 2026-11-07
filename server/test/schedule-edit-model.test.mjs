// The pure words and rules of the job edit form (ws-eh2 G): cadence both ways, the host's schedule rule, the changed lines, and the line a change shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backWords, cadenceOf, changeLine, cronOf, cronProblem, lineDiff, longClock, promptProblem, whenWords } from '../../src/hub/team/scheduleEditModel.ts';

test('a cron text opens as the nearest simple form and goes back to the same text', () => {
  assert.deepEqual(cadenceOf('0 8 * * *'), { kind: 'daily', time: '08:00', days: [1], custom: '0 8 * * *' });
  assert.deepEqual([cadenceOf('30 9 * * 2').kind, cadenceOf('30 9 * * 2').days, cadenceOf('30 9 * * 2').time], ['weekdays', [2], '09:30']);
  assert.deepEqual(cadenceOf('0 6 * * 1,3,5').days, [1, 3, 5]);
  for (const odd of ['30 6,18 * * 1-5', '15 10 1 * *', '*/5 * * * *', 'every 2h', '0 8 * *', '']) assert.equal(cadenceOf(odd).kind, 'custom', odd);
  for (const text of ['0 8 * * *', '30 9 * * 2', '0 6 * * 1,3,5']) assert.equal(cronOf(cadenceOf(text)), text);
  assert.equal(cronOf({ kind: 'weekdays', time: '09:00', days: [2, 0], custom: '' }), '0 9 * * 0,2');
  assert.equal(cronOf({ kind: 'custom', time: '', days: [], custom: ' 5 4 * * 1 ' }), '5 4 * * 1');
  assert.equal(cronOf({ kind: 'daily', time: '', days: [], custom: '' }), '');
});

test('the host\'s rule: five fields, one minute, up to four hours; a typo cannot run a job every minute', () => {
  for (const good of ['0 8 * * 1', '30 6,18 * * 1-5', '15 10 1 * *', '0 0,6,12,18 * * *']) assert.equal(cronProblem(good), '', good);
  for (const bad of ['* * * * *', '0 * * * *', '*/5 * * * *', '0 8 * * 1 *', '0 8 * *', '0 1,2,3,4,5 * * *', '0,30 8 * * *', '0 8 * * x', '0 24 * * *', '60 8 * * *', '']) assert.notEqual(cronProblem(bad), '', bad);
});

test('the cadence in words says whose time it is', () => {
  assert.equal(whenWords('0 9 * * 2', 'America/Los_Angeles'), 'Tuesdays at 09:00, Pacific (Hermes host time)');
  assert.equal(whenWords('0 8 * * *', undefined), 'Every day at 08:00 (Hermes host time)');
  assert.equal(whenWords('15 10 1 * *', 'UTC'), 'Day 1 of each month at 10:15, UTC (Hermes host time)');
  assert.equal(whenWords('0 8 1-7 * 1', 'UTC'), '');
});

test('the prompt rules and the changed lines', () => {
  assert.equal(promptProblem('Line one.\n\tLine two. é'), '');
  for (const bad of ['', '  ', 'x'.repeat(8001), 'bell\u0007']) assert.notEqual(promptProblem(bad), '');
  assert.notEqual(promptProblem('é'.repeat(4001)), '', 'bytes, not characters');
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), [{ mark: '=', text: 'a' }, { mark: '-', text: 'b' }, { mark: '+', text: 'B' }, { mark: '=', text: 'c' }, { mark: '+', text: 'd' }]);
  assert.deepEqual(lineDiff('same', 'same'), [{ mark: '=', text: 'same' }]);
});

const change = (over = {}) => ({ id: '20261106-job-briefs-ab12', op: 'edit', job: 'brief-x', state: 'live', at: '2026-11-06T10:00:00.000Z', by: 'owner', from: { schedule: '0 8 * * 1', provider: null, model: null }, to: { schedule: '0 9 * * 2' }, ...over });
test('after Save: Waiting, Running, then "Next run moved" with both times; a paused job has nothing to show; failures use the Hub\'s words', () => {
  const before = '2026-11-09T08:00:00-08:00';
  const after = '2026-11-10T09:00:00-08:00';
  const job = { nextRunAt: after, enabled: true, state: 'scheduled' };
  assert.deepEqual(changeLine(change({ state: 'waiting' }), job, before), { tone: 'wait', text: 'Waiting for the Hermes host' });
  assert.equal(changeLine(change({ state: 'applied' }), job, before).text.startsWith('Running'), true);
  const moved = changeLine(change(), job, before);
  assert.equal(moved.tone, 'done');
  assert.match(moved.text, /^Next run moved: \w+day \d+ Nov \d\d:\d\d to \w+day \d+ Nov \d\d:\d\d$/);
  assert.equal(moved.text, `Next run moved: ${longClock(before)} to ${longClock(after)}`);
  assert.match(changeLine(change(), job, undefined).text, /^Next run: /, 'with no earlier time known it says where the job is now');
  assert.match(changeLine(change(), job, after).text, /\(unchanged\)$/);
  assert.match(changeLine(change(), { enabled: false, state: 'paused' }, before).text, /paused, so it has no next run until you resume it/);
  assert.match(changeLine(change({ op: 'resume', to: null }), job, null).text, /^Resumed\. Next run: /);
  assert.equal(changeLine(change({ op: 'pause', to: null }), { enabled: false, state: 'paused' }, before).text, 'Paused. It will not run until you resume it.');
  assert.equal(changeLine(change({ to: { promptChanged: true } }), job, before).text, 'Changed.', 'a prompt-only change does not claim the next run moved');
  assert.deepEqual(changeLine(change({ state: 'failed', reason: 'Hermes refused this prompt.' }), job, before), { tone: 'bad', text: 'Hermes refused this prompt.' });
  assert.equal(changeLine(change({ state: 'late' }), job, before).tone, 'bad');
  assert.equal(backWords(change()), 'Go back to the schedule 0 8 * * 1');
  assert.equal(backWords(change({ op: 'pause', to: null })), 'Go back: resume the job');
  assert.equal(backWords(change({ to: { provider: 'a', model: 'b' } })), 'Go back to following the profile');
});
