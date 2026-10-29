import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS, agentOfEvent, floorRooms, lineAt, mergeEvents, nextSince, roomIdOf, tickerLines, viewOf } from '../../../src/hub/team/floorModel.ts';

const AGENTS = [
  { id: 'hermes', room: 'Command' },
  { id: 'claude', room: 'Build' },
  { id: 'briefs', room: 'Ops' },
  { id: 'stray', room: 'Basement' },
  { id: 'blank', room: '' },
];

test('the room list is the mockup list without the Lab', () => {
  assert.deepEqual(ROOMS.map(room => room.id), ['Command', 'Research', 'Art', 'Build', 'Review', 'Ops']);
});

test('rooms with no agents are left out, and the rest keep room order', () => {
  const rooms = floorRooms([{ id: 'claude', room: 'Build' }, { id: 'hermes', room: 'Command' }]);
  assert.deepEqual(rooms.map(entry => entry.room.id), ['Command', 'Build']);
  assert.deepEqual(floorRooms([]), []);
});

test('an unknown or empty room is Ops, with the agents kept in their order', () => {
  assert.equal(roomIdOf('Basement'), 'Ops');
  assert.equal(roomIdOf(''), 'Ops');
  assert.equal(roomIdOf(undefined), 'Ops');
  const rooms = floorRooms(AGENTS);
  assert.deepEqual(rooms.map(entry => entry.room.id), ['Command', 'Build', 'Ops']);
  assert.deepEqual(rooms[2].agents.map(agent => agent.id), ['briefs', 'stray', 'blank']);
});

test('the view is Roster unless Floor was stored', () => {
  assert.equal(viewOf(null), 'roster');
  assert.equal(viewOf('nonsense'), 'roster');
  assert.equal(viewOf('floor'), 'floor');
  assert.equal(viewOf('roster'), 'roster');
});

test('agentOfEvent: a known agent field wins, anything else is Claude Code', () => {
  assert.equal(agentOfEvent({ agent: 'hermes' }, AGENTS), 'hermes');
  assert.equal(agentOfEvent({ agent: 'nobody' }, AGENTS), 'claude');
  assert.equal(agentOfEvent({ agent: 7 }, AGENTS), 'claude');
  assert.equal(agentOfEvent({}, AGENTS), 'claude');
});

const at = minutes => new Date(Date.parse('2026-10-29T12:00:00Z') - minutes * 60_000).toISOString();
const event = (kind, minutes, extra = {}) => ({ kind, ts: at(minutes), file: `f-${kind}-${minutes}.json`, title: `${kind} ${minutes}`, ...extra });

test('the ticker keeps session, review and ask events only', () => {
  const lines = tickerLines([event('session-started', 1), event('pr-opened', 2), event('ready-for-review', 3), event('ask-created', 4), event('session-ended', 5), event('deployed', 6), event('blocked', 7)], AGENTS);
  assert.deepEqual(lines.map(line => line.text), ['session-started 1', 'ready-for-review 3', 'ask-created 4', 'session-ended 5']);
});

test('the ticker keeps the newest 12, newest first', () => {
  const many = Array.from({ length: 20 }, (_, index) => event('session-started', index + 1));
  const shuffled = [...many].reverse();
  const lines = tickerLines(shuffled, AGENTS);
  assert.equal(lines.length, 12);
  assert.equal(lines[0].text, 'session-started 1');
  assert.equal(lines[11].text, 'session-started 12');
  assert.deepEqual(lines.map(line => Date.parse(line.ts)), [...lines.map(line => Date.parse(line.ts))].sort((a, b) => b - a));
});

test('each line names its agent; a missing title gets a plain sentence; a bad time is dropped', () => {
  const lines = tickerLines([event('ask-created', 1, { agent: 'hermes', title: '' }), event('session-started', 2), { kind: 'session-started', ts: 'never', file: 'x' }], AGENTS);
  assert.deepEqual(lines.map(line => [line.agent, line.text]), [['hermes', 'asked you something'], ['claude', 'session-started 2']]);
});

test('mergeEvents never repeats an event, and nextSince is the newest time held', () => {
  const first = [event('session-started', 5), event('session-ended', 3)];
  const merged = mergeEvents(first, [event('session-ended', 3), event('ask-created', 1)]);
  assert.equal(merged.length, 3);
  assert.equal(nextSince(merged), at(1));
  assert.equal(nextSince([]), null);
});

test('lineAt rotates through the lines, and under reduced motion stays on the newest', () => {
  const lines = tickerLines([event('session-started', 1), event('session-started', 2), event('session-started', 3)], AGENTS);
  assert.deepEqual([0, 1, 2, 3, 4].map(step => lineAt(lines, step, false).text), ['session-started 1', 'session-started 2', 'session-started 3', 'session-started 1', 'session-started 2']);
  assert.equal(lineAt(lines, 7, true).text, 'session-started 1');
  assert.equal(lineAt([], 3, false), null);
});
