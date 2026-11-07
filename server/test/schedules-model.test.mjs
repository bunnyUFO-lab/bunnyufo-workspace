import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agoWords, cadenceWords, clock, clockBoth, isSchedulesRoute, jobHash, jobSummary, modelWords, oldLine, onWords, promptNotes, resultWords, scheduleOf, sourceLine, targetWords, troubled, zoneName,
} from '../../src/hub/team/schedulesModel.ts';

test('a job address is one encoded segment and comes back whole; the list and other sources are not a job', () => {
  assert.equal(jobHash('brief-x'), '#/~hub/team/schedules/hermes/brief-x');
  assert.equal(jobHash('a b/c'), '#/~hub/team/schedules/hermes/a%20b%2Fc');
  assert.deepEqual(scheduleOf('schedules/hermes/a b/c'), { source: 'hermes', name: 'a b/c' });
  assert.equal(scheduleOf('schedules'), null);
  assert.equal(scheduleOf('schedules/hermes/'), null);
  assert.equal(scheduleOf('schedules/pc/x'), null);
  assert.equal(scheduleOf('skills/x'), null);
  assert.equal(scheduleOf(undefined), null);
});

test('the schedules half is team/schedules and anything under it, and does not take the skills half', () => {
  assert.equal(isSchedulesRoute('schedules'), true);
  assert.equal(isSchedulesRoute('schedules/hermes/x'), true);
  assert.equal(isSchedulesRoute('skills'), false);
  assert.equal(isSchedulesRoute('schedulesx'), false);
  assert.equal(isSchedulesRoute(undefined), false);
});

test('cron in words: the plain shapes, the zone, and nothing for a shape it does not know', () => {
  assert.equal(cadenceWords('0 8 * * 1', 'America/Los_Angeles'), 'Mondays at 08:00, Pacific');
  assert.equal(cadenceWords('0 8 * * *'), 'Every day at 08:00');
  assert.equal(cadenceWords('30 6,18 * * 1-5', 'UTC'), 'Weekdays at 06:30 and 18:30, UTC');
  assert.equal(cadenceWords('0 9 * * 0,6'), 'Weekends at 09:00');
  assert.equal(cadenceWords('5 9 * * 1,3,5'), 'Mondays, Wednesdays and Fridays at 09:05');
  assert.equal(cadenceWords('0 9 * * 7'), 'Sundays at 09:00');
  assert.equal(cadenceWords('15 10 1 * *'), 'Day 1 of each month at 10:15');
  assert.equal(cadenceWords('0 */2 * * *'), 'Every 2 hours');
  assert.equal(cadenceWords('20 */6 * * *'), 'Every 6 hours at minute 20');
  assert.equal(cadenceWords('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(cadenceWords('every 2h'), 'Every 2 hours');
  assert.equal(cadenceWords('every 1h'), 'Every hour');
  assert.equal(cadenceWords('every 30m'), 'Every 30 minutes');
  for (const odd of ['', '0 8 * *', '0 8 * * * *', '0 8 * 3 *', '0 25 * * *', '70 8 * * *', '0 8 * * mon', '0 8 1 * 1', '2026-11-09T08:00', 'at noon']) assert.equal(cadenceWords(odd), '', odd);
});

test('a zone as a short name', () => {
  assert.equal(zoneName('America/Los_Angeles', new Date('2026-07-01T12:00:00Z')), 'Pacific');
  assert.equal(zoneName('America/Los_Angeles', new Date('2026-12-01T12:00:00Z')), 'Pacific');
  assert.equal(zoneName('America/Chicago'), 'Central');
  assert.equal(zoneName('UTC'), 'UTC');
  assert.equal(zoneName('Not/AZone'), 'Not/AZone');
  assert.equal(zoneName(undefined), '');
});

test('ages are words, and an old list says when it was last heard from', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(agoWords('2026-11-01T11:59:40Z', now), 'just now');
  assert.equal(agoWords('2026-11-01T11:54:00Z', now), '6 minutes ago');
  assert.equal(agoWords('2026-11-01T11:59:00Z', now), '1 minute ago');
  assert.equal(agoWords('2026-11-01T03:00:00Z', now), '9 hours ago');
  assert.equal(agoWords('2026-10-28T12:00:00Z', now), '4 days ago');
  assert.equal(agoWords('nonsense', now), '');
  assert.equal(sourceLine({ id: 'hermes-jobs', state: 'live', as_of: '2026-11-01T11:54:00Z', host: 'Hermes host' }, now), 'Hermes host, 6 minutes ago');
  assert.equal(sourceLine({ id: 'pc-tasks', state: 'not-reporting', as_of: null }, now), 'No report');
  assert.equal(oldLine({ state: 'old', as_of: '2026-11-01T03:00:00Z' }, now), 'Last heard from 9 hours ago; these may be out of date.');
  assert.equal(oldLine({ state: 'live', as_of: '2026-11-01T11:54:00Z' }, now), '');
});

test('on, paused and off; how the last run ended; trouble is visible without opening the row', () => {
  assert.deepEqual(onWords({ enabled: true, state: 'scheduled' }), { label: 'On', on: true });
  assert.deepEqual(onWords({ enabled: false, state: 'paused' }), { label: 'Paused', on: false });
  assert.deepEqual(onWords({ enabled: true, state: 'paused' }), { label: 'Paused', on: false });
  assert.deepEqual(onWords({ enabled: false }), { label: 'Off', on: false });
  assert.deepEqual(resultWords({ lastStatus: 'ok' }), { label: 'Worked', failed: false });
  assert.deepEqual(resultWords({ lastStatus: 'error' }), { label: 'Failed', failed: true });
  assert.deepEqual(resultWords({ lastStatus: 'weird' }), { label: 'weird', failed: false });
  assert.deepEqual(resultWords({}), { label: '', failed: false });
  assert.equal(troubled({ lastStatus: 'ok', failureStreak: 0 }), false);
  assert.equal(troubled({ lastStatus: 'error' }), true);
  assert.equal(troubled({ lastStatus: 'ok', failureStreak: 2 }), true);
  assert.equal(troubled({}), false);
});

test("a job's summary lines: cadence, next run only while on, last run with its result", () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const job = { name: 'j', profile: 'briefs', schedule: '0 8 * * 1', enabled: true, prompt: '', nextRunAt: '2026-11-02T14:00:00Z', lastRunAt: '2026-11-01T09:00:00Z', lastStatus: 'ok' };
  assert.deepEqual(jobSummary(job, 'UTC', now, 'UTC'), ['Mondays at 08:00, UTC', 'Next Mon 2 Nov 14:00', 'Last 3 hours ago: worked']);
  assert.deepEqual(jobSummary({ ...job, enabled: false, state: 'paused', lastStatus: 'error' }, 'UTC', now, 'UTC'), ['Mondays at 08:00, UTC', 'Last 3 hours ago: failed']);
  assert.deepEqual(jobSummary({ name: 'j', profile: 'briefs', schedule: '0 8 * * 1', enabled: true, prompt: '' }, undefined, now), ['Mondays at 08:00', 'No run yet']);
  assert.deepEqual(jobSummary({ ...job, schedule: 'odd text', lastRunAt: undefined, nextRunAt: undefined, lastStatus: 'ok' }, 'UTC', now), []);
});

test("times in the viewer's zone, with the host's beside them when they read differently", () => {
  assert.equal(clock('2026-11-09T14:00:00Z', 'UTC'), 'Mon 9 Nov 14:00');
  assert.equal(clock('nonsense', 'UTC'), '');
  assert.equal(clockBoth('2026-11-09T14:00:00Z', 'UTC', 'UTC'), 'Mon 9 Nov 14:00');
  assert.equal(clockBoth('2026-11-09T14:00:00Z', 'America/Chicago', 'UTC'), 'Mon 9 Nov 14:00 (host: Mon 9 Nov 08:00 Central)');
  assert.equal(clockBoth('2026-11-09T14:00:00Z', undefined, 'UTC'), 'Mon 9 Nov 14:00');
});

test("model, targets and prompt notes in the page's words", () => {
  assert.deepEqual(modelWords({}, 'claude-haiku-5-5'), { pinned: false, text: 'Follows the profile: ', model: 'claude-haiku-5-5' });
  assert.deepEqual(modelWords({}, undefined), { pinned: false, text: 'Follows the profile', model: '' });
  assert.deepEqual(modelWords({ model: 'claude-sonnet-5-5', provider: 'anthropic' }, 'claude-haiku-5-5'), { pinned: true, text: 'Pinned: ', model: 'claude-sonnet-5-5' });
  assert.equal(targetWords({ platform: 'discord', label: '#chan' }), 'Discord, #chan');
  assert.equal(targetWords({ platform: 'chat', label: 'room' }), 'chat, room');
  assert.equal(targetWords(null), 'No destination known');
  assert.equal(targetWords(undefined), 'Not reported');
  assert.deepEqual(promptNotes({}), []);
  assert.deepEqual(promptNotes({ promptCut: true, promptRedacted: 2 }), ['This is the first part of the prompt. The export cuts a long one.', '2 secret-like texts were replaced with [redacted].']);
  assert.deepEqual(promptNotes({ promptRedacted: 1 }), ['1 secret-like text was replaced with [redacted].']);
});
