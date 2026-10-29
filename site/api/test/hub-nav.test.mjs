// The rail's groups: every Hub screen sits in exactly one, and a group with no rows is not drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_GROUPS, hubGroups, hubRows } from '../../../src/lib/hubNav.ts';

const FULL = { write: true, chat: true };
const BARE = { write: false, chat: false };

test('every screen hubRows offers sits in exactly one group', () => {
  for (const [screen] of hubRows(FULL)) {
    const homes = HUB_GROUPS.filter(group => group.rows.includes(screen));
    assert.equal(homes.length, 1, `${screen} is in ${homes.length} groups`);
  }
  const named = HUB_GROUPS.flatMap(group => group.rows);
  assert.equal(new Set(named).size, named.length, 'No row is in two groups.');
});

test('the groups and their rows, in order', () => {
  const shape = hubGroups(FULL).map(group => [group.label, group.rows.map(([key]) => key)]);
  assert.deepEqual(shape, [['Operate', ['today', 'needs', 'work', 'team']], ['Plan', ['map', 'chat']], ['Know', ['library', 'sketch']]]);
});

test('without writes or the assistant there is no Sketch, no Chat and no empty group', () => {
  const groups = hubGroups(BARE);
  const keys = groups.flatMap(group => group.rows.map(([key]) => key));
  assert.ok(!keys.includes('sketch') && !keys.includes('chat'));
  assert.ok(keys.includes('library'), 'Library is always there.');
  assert.ok(groups.every(group => group.rows.length > 0));
  assert.deepEqual(groups.map(group => group.id), ['operate', 'plan', 'know']);
});

test('Run is absent while it has no rows', () => {
  assert.ok(!hubGroups(FULL).some(group => group.id === 'run'));
});

test('Team is drawn only when hubRows offers it', () => {
  assert.ok(HUB_GROUPS.find(group => group.id === 'operate').rows.includes('team'));
  const offered = hubRows(FULL).some(([key]) => key === 'team');
  assert.equal(hubGroups(FULL)[0].rows.some(([key]) => key === 'team'), offered);
});
