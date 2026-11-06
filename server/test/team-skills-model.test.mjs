import test from 'node:test';
import assert from 'node:assert/strict';
import { openSkill, agentGroups, exportLine, groupByFolder, isSkillsRoute, NO_PLUGINS_LINE, pluginRows, profileText, sharedText, skillHash, skillMatches, skillOf, sourceText } from '../../src/hub/team/skillsModel.ts';

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

test('sources and profiles are plain words', () => {
  assert.equal(sourceText(skill({ autoLoad: true, sources: ['autoLoad', 'installed'] })), 'loaded on every reply');
  assert.equal(sourceText(skill({ owner: true, sources: ['installed', 'owner'] })), 'installed · one of yours');
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
