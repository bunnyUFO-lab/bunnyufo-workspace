import test from 'node:test';
import assert from 'node:assert/strict';
import { exportLine, isSkillsRoute, profileText, skillHash, skillOf, sourceText } from '../../src/hub/team/skillsModel.ts';

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
