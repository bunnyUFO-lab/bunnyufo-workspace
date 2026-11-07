import test from 'node:test';
import assert from 'node:assert/strict';
import { agentGroups, agentsLine, autoOf, exportLine, foldOpen, groupByFolder, groupPluginRows, isSkillsRoute, listGroups, NO_PLUGINS_LINE, openSkill, pluginRows, previewOf, profileText, readOpen, sharedText, skillHash, skillMatches, skillOf } from '../../src/hub/team/skillsModel.ts';

const skill = over => ({ id: 'plan', autoLoad: false, owner: false, profiles: ['main'], autoLoadProfiles: [], sources: ['installed'], agents: [], ...over });

test('a skill id with a slash is one encoded segment and comes back whole', () => {
  assert.equal(skillHash('dev/plan'), '#/~hub/team/skills/dev%2Fplan');
  assert.equal(skillOf('skills/dev/plan'), 'dev/plan');
  assert.equal(skillOf('skills'), null);
  assert.equal(skillOf(undefined), null);
  assert.equal(skillOf('agents/x'), null);
});

test('the skills half is team/skills and anything under it', () => {
  assert.equal(isSkillsRoute('skills'), true);
  assert.equal(isSkillsRoute('skills/plan'), true);
  assert.equal(isSkillsRoute(undefined), false);
  assert.equal(isSkillsRoute('skillset'), false);
});

test('the export line says when, or says there is none', () => {
  assert.deepEqual(exportLine({ exportedAt: '2026-11-04T10:00:00Z', fresh: true }, '2 h ago'), { text: 'Read from the Hermes host 2 h ago.', warn: false });
  assert.equal(exportLine({ exportedAt: '2026-11-04T10:00:00Z', fresh: false }, '2 days ago').warn, true);
  assert.match(exportLine({ exportedAt: null, fresh: false }, '').text, /not published/);
});

test('profiles are plain words', () => {
  assert.equal(profileText(skill({ profiles: [] })), 'No profile has it installed.');
  assert.equal(profileText(skill({ profiles: ['main', 'briefs'] })), 'On the profiles main, briefs.');
});

const person = (id, name, profile) => ({ id, name, profile, skills: profile ? ['a/one', 'two'] : null, autoLoad: profile ? ['two'] : null, ...(profile ? {} : { note: 'on the PC' }) });
const view = over => ({
  exportedAt: '2026-11-04T10:00:00Z', fresh: true, maybeCut: false, skills: [],
  agents: [person('hermes', 'Hermes', 'main'), person('planner', 'Planner', 'main'), person('researcher', 'Researcher', 'main'), person('briefs', 'Briefs', 'briefs'), person('claude', 'Claude Code', null)],
  plugins: { known: false, text: 'x', items: [] }, ...over,
});

test('skills group by their first folder, folders in order, loose skills last as Other', () => {
  const groups = groupByFolder([{ id: 'two' }, { id: 'research/b' }, { id: 'creative/a' }, { id: 'research/a/deep' }, { id: 'creative/c' }])
  assert.deepEqual(groups.map(group => [group.folder, group.label, group.items.map(item => item.id)]), [
    ['creative', 'creative', ['creative/a', 'creative/c']],
    ['research', 'research', ['research/b', 'research/a/deep']],
    ['', 'Other', ['two']],
  ]);
  assert.deepEqual(groupByFolder([]), []);
});

test('the search matches any part of the id, ignoring case and spaces at the ends', () => {
  assert.equal(skillMatches('research/Deep-Dive', ' deep '), true);
  assert.equal(skillMatches('research/deep-dive', 'RESEARCH'), true);
  assert.equal(skillMatches('research/deep-dive', 'plan'), false);
  assert.equal(skillMatches('x', ''), true);
});

test('agents on one profile are one group; Claude Code is its own group with the reason', () => {
  const groups = agentGroups(view());
  assert.deepEqual(groups.map(group => [group.profile, group.agents.map(agent => agent.name)]), [
    ['main', ['Hermes', 'Planner', 'Researcher']], ['briefs', ['Briefs']], [null, ['Claude Code']],
  ]);
  assert.deepEqual(groups[0].skills, ['a/one', 'two']);
  assert.deepEqual(groups[0].autoLoad, ['two']);
  assert.equal(groups[2].skills, null);
  assert.equal(groups[2].note, 'on the PC');
});

test('group keys cannot collide: a profile name equal to an agent id stays apart', () => {
  const clash = view({ agents: [person('hermes', 'Hermes', 'main'), person('main', 'Main', null)] });
  const keys = agentGroups(clash).map(group => group.key);
  assert.deepEqual(keys, ['profile:main', 'agent:main']);
});

test('the open skill stays while it matches the search, else the first match', () => {
  const ids = ['alpha', 'beta', 'gamma'];
  assert.equal(openSkill(ids, null, ''), 'alpha');
  assert.equal(openSkill(ids, 'gamma', ''), 'gamma');
  assert.equal(openSkill(ids, 'alpha', 'et'), 'beta');
  assert.equal(openSkill(ids, 'beta', 'et'), 'beta');
  assert.equal(openSkill(ids, 'alpha', 'zzz'), null);
});

test('the shared line names the agents, and is silent for one', () => {
  const groups = agentGroups(view());
  assert.equal(sharedText(groups[0]), 'Hermes, Planner and Researcher share one list.');
  assert.equal(sharedText(groups[1]), null);
  assert.equal(sharedText({ ...groups[0], agents: groups[0].agents.slice(0, 2) }), 'Hermes and Planner share one list.');
});

test('plugin rows: the status on that profile, enabled first, and unknown until the export lists them', () => {
  assert.equal(pluginRows(view(), 'main'), null);
  assert.match(NO_PLUGINS_LINE, /does not list plugins yet/);
  const items = [
    { name: 'zed', version: '1', source: 'user', description: '', profiles: [{ profile: 'main', status: 'enabled' }] },
    { name: 'alpha', version: '1', source: 'bundled', description: '', profiles: [{ profile: 'main', status: 'not enabled' }, { profile: 'briefs', status: 'enabled' }] },
    { name: 'beta', version: '1', source: 'bundled', description: '', profiles: [{ profile: 'main', status: 'enabled' }] },
  ];
  const known = view({ plugins: { known: true, text: 'x', items } });
  assert.deepEqual(pluginRows(known, 'main').map(row => [row.name, row.status]), [['beta', 'enabled'], ['zed', 'enabled'], ['alpha', 'not enabled']]);
  assert.deepEqual(pluginRows(known, 'briefs').map(row => row.name), ['alpha'], 'a plugin a profile does not list is not shown for it');
  assert.equal(pluginRows(known, null), null, 'Claude Code has none listed');
});

const lists = (...rows) => view({ agents: rows.map(([id, name, profile, skills, autoLoad]) => ({ id, name, profile, skills, autoLoad: skills ? autoLoad ?? [] : null, ...(skills ? {} : { note: 'on the PC' }) })) });

test('listGroups merges profiles with the same set of skills, in any order, and keeps the first key and place', () => {
  const groups = listGroups(lists(['hermes', 'Hermes', 'main', ['b', 'a/one', 'c']], ['planner', 'Planner', 'main', ['b', 'a/one', 'c']], ['briefs', 'Briefs', 'briefs', ['c', 'b', 'a/one']], ['lone', 'Lone', null, null]));
  assert.deepEqual(groups.map(group => group.key), ['profile:main', 'agent:lone']);
  assert.deepEqual(groups[0].agents.map(agent => agent.name), ['Hermes', 'Planner', 'Briefs']);
  assert.deepEqual(groups[0].profiles, ['main', 'briefs']);
  assert.equal(groups[0].parts.length, 2);
  assert.equal(sharedText(groups[0]), 'Hermes, Planner and Briefs have the same skills.');
  assert.equal(sharedText(agentGroups(view())[0]), 'Hermes, Planner and Researcher share one list.', 'one profile still says share one list');
});

test('listGroups leaves different lists apart, never merges a list that is not known, and does not merge on auto-load', () => {
  const apart = listGroups(lists(['a', 'A', 'main', ['x', 'y']], ['b', 'B', 'briefs', ['x', 'z']]));
  assert.deepEqual(apart.map(group => group.key), ['profile:main', 'profile:briefs']);
  const unknown = listGroups(lists(['a', 'A', null, null], ['b', 'B', null, null]));
  assert.deepEqual(unknown.map(group => group.key), ['agent:a', 'agent:b'], 'two unknown lists are not the same');
  const same = listGroups(lists(['a', 'A', 'main', ['x', 'y'], ['x']], ['b', 'B', 'briefs', ['x', 'y'], []]));
  assert.equal(same.length, 1, 'auto-load differs, the list is the same');
  assert.deepEqual(same[0].autoLoad, ['x']);
});

test('autoOf: every profile loads it, some do (named), or none', () => {
  const [group] = listGroups(lists(['a', 'A', 'main', ['x', 'y'], ['x', 'y']], ['p', 'P', 'main', ['x', 'y'], ['x', 'y']], ['b', 'B', 'briefs', ['x', 'y'], ['x']]));
  assert.deepEqual(autoOf(group, 'x'), { all: true, only: null });
  assert.deepEqual(autoOf(group, 'y'), { all: false, only: 'Only for A, P' });
  assert.equal(autoOf(group, 'z'), null);
});

test('agentsLine: all agents with a list, some, one and none', () => {
  const six = view({ agents: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => person(id, id.toUpperCase(), 'main')).concat([person('claude', 'Claude Code', null)]) });
  const on = ids => ({ agents: ids.map(id => ({ id, name: id.toUpperCase(), profile: 'main' })) });
  assert.equal(agentsLine(on(['a', 'b', 'c', 'd', 'e', 'f']), six), 'All 6 agents with a list');
  assert.equal(agentsLine(on(['a', 'b', 'c', 'd']), six), 'A, B, C +1');
  assert.equal(agentsLine(on(['a', 'b', 'c']), six), 'A, B, C');
  assert.equal(agentsLine(on(['b']), six), 'B');
  assert.equal(agentsLine(on([]), six), 'No agent known');
  assert.equal(agentsLine(on(['a']), view({ agents: [person('a', 'A', 'main')] })), 'A', 'one agent with a list is not all 1');
});

test('previewOf: fewer than three names, exactly three, and more', () => {
  assert.equal(previewOf([]), '');
  assert.equal(previewOf(['a', 'b']), 'a, b');
  assert.equal(previewOf(['a', 'b', 'c']), 'a, b, c');
  assert.equal(previewOf(['a', 'b', 'c', 'd', 'e']), 'a, b, c +2');
});

test('readOpen survives bad JSON, null, an array, and values that are not booleans', () => {
  assert.deepEqual(readOpen(null), {});
  assert.deepEqual(readOpen('{not json'), {});
  assert.deepEqual(readOpen('[true]'), {});
  assert.deepEqual(readOpen('7'), {});
  assert.deepEqual(readOpen('{"a":true,"b":false,"c":"yes"}'), { a: true, b: false });
  assert.equal(foldOpen('a', { a: false }, true), false, 'what the user chose wins');
  assert.equal(foldOpen('b', { a: false }, true), true, 'no choice: the start state');
});

test('a plugin with different statuses across a merged group is Differs, with who has it how', () => {
  const [group] = listGroups(lists(['h', 'Hermes', 'main', ['x']], ['p', 'Planner', 'main', ['x']], ['b', 'Briefs', 'briefs', ['x']]));
  const items = [
    { name: 'same', version: '1', source: 'bundled', description: '', profiles: [{ profile: 'main', status: 'enabled' }, { profile: 'briefs', status: 'enabled' }] },
    { name: 'split', version: '1', source: 'bundled', description: '', profiles: [{ profile: 'main', status: 'enabled' }, { profile: 'briefs', status: 'disabled' }] },
    { name: 'missing', version: '1', source: 'bundled', description: '', profiles: [{ profile: 'main', status: 'enabled' }] },
    { name: 'off', version: '1', source: 'bundled', description: '', profiles: [{ profile: 'main', status: 'not enabled' }, { profile: 'briefs', status: 'not enabled' }] },
  ];
  const rows = groupPluginRows(view({ plugins: { known: true, text: 'x', items } }), group);
  assert.deepEqual(rows.map(row => [row.name, row.status]), [['same', 'enabled'], ['missing', 'differs'], ['split', 'differs'], ['off', 'not enabled']]);
  assert.equal(rows.find(row => row.name === 'split').line, 'On for Hermes, Planner. Off for Briefs.');
  assert.equal(rows.find(row => row.name === 'missing').line, 'On for Hermes, Planner. Not on for Briefs.');
  assert.equal(groupPluginRows(view(), group), null, 'no plugin list in the export');
  assert.equal(groupPluginRows(view({ plugins: { known: true, text: 'x', items } }), agentGroups(view())[2]), null, 'Claude Code has no profile');
});
