// What each agent can use (ws-cl0.6.10): the Hermes settings export joined with the agent list, read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { AGENTS } from '../hub-team.mjs';
import { validExport } from '../hub-agent-config.mjs';
import { teamSkills, PLUGINS_LINE } from '../hub-team-skills.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { agentConfigJson, seedAgentConfig } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date('2026-11-01T12:00:00Z');
const exportOf = (extra, minutes = 12) => validExport(agentConfigJson({ now: NOW, exportedMinutesAgo: minutes, ...extra }));
const rowOf = (view, id) => view.skills.find(skill => skill.id === id);

test('no export: nothing is claimed, and the answer says it is not known', () => {
  const view = teamSkills({ exported: null, agents: AGENTS, at: NOW });
  assert.deepEqual([view.exportedAt, view.fresh, view.skills], [null, false, []]);
  assert.ok(view.agents.every(agent => agent.skills === null), 'no agent is given a list it does not have');
  assert.deepEqual(view.plugins, { known: false, text: PLUGINS_LINE });
});

test('skills are joined to the agents of their profile; the owner flag and the sources come from the export', () => {
  const view = teamSkills({ exported: exportOf(), agents: AGENTS, at: NOW });
  assert.equal(view.fresh, true);
  assert.equal(view.exportedAt, '2026-11-01T11:48:00.000Z');
  assert.deepEqual(view.skills.map(skill => skill.id), ['brief-writer', 'simplify-text', 'spend-digest']);
  const auto = rowOf(view, 'simplify-text');
  assert.deepEqual([auto.autoLoad, auto.owner, auto.profiles, auto.sources], [true, true, ['main', 'briefs'], ['autoLoad', 'owner']]);
  assert.deepEqual(auto.agents.map(agent => agent.id), ['hermes', 'briefs', 'researcher', 'market-researcher', 'teardown', 'planner']);
  const brief = rowOf(view, 'brief-writer');
  assert.deepEqual([brief.autoLoad, brief.owner, brief.sources], [false, false, ['installed']]);
  assert.ok(!view.skills.some(skill => skill.agents.some(agent => agent.id === 'claude')), 'Claude Code has no profile, so no skill is claimed for it');
});

test('agents on one profile share a list; Claude Code is unknown, with the reason', () => {
  const exported = exportOf({ extraProfile: {} });
  exported.profiles.briefs.skills = { autoLoad: [], installed: ['only-briefs'] };
  const view = teamSkills({ exported, agents: AGENTS, at: NOW });
  const byId = Object.fromEntries(view.agents.map(agent => [agent.id, agent]));
  assert.deepEqual(byId.hermes.skills, byId.planner.skills);
  assert.deepEqual(byId.briefs.skills, ['only-briefs']);
  assert.equal(byId.claude.skills, null);
  assert.equal(byId.claude.note, PLUGINS_LINE);
  assert.deepEqual(rowOf(view, 'only-briefs').agents.map(agent => agent.id), ['briefs']);
});

test('an owner skill that no profile has is listed with no agents, not given to anyone', () => {
  const exported = exportOf();
  exported.ownerSkills = ['loose-skill'];
  const row = rowOf(teamSkills({ exported, agents: AGENTS, at: NOW }), 'loose-skill');
  assert.deepEqual([row.owner, row.profiles, row.agents, row.autoLoad], [true, [], [], false]);
});

test('an old export is still shown, flagged not fresh; a list at its cap says it may be cut', () => {
  const stale = teamSkills({ exported: exportOf({}, 8 * 60), agents: AGENTS, at: NOW });
  assert.deepEqual([stale.fresh, stale.skills.length > 0], [false, true]);
  assert.equal(stale.maybeCut, false);
  const exported = exportOf();
  exported.profiles.main.skills.installed = Array.from({ length: 100 }, (_, index) => `skill-${index}`);
  assert.equal(teamSkills({ exported, agents: AGENTS, at: NOW }).maybeCut, true);
});

test('a profile the export lacks gives its agents no list', () => {
  const exported = exportOf();
  delete exported.profiles.briefs;
  const view = teamSkills({ exported, agents: AGENTS, at: NOW });
  assert.equal(view.agents.find(agent => agent.id === 'briefs').skills, null);
  assert.deepEqual(rowOf(view, 'spend-digest').profiles, ['main']);
});

async function fixture({ requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-skills-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser, hub: createHub({ bucket, enabled: true }), allowedOrigins: ['https://site.example'] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, headers = {}) => fetch(`${origin}/api${route}`, { method, headers, body: method === 'POST' ? '{}' : undefined });
  return { fake, call, close: async () => { server.close(); await fake.close(); } };
}

test('GET /hub/team/skills: the signed-in answer, read-only, and a 401 without a user', async () => {
  const { fake, call, close } = await fixture();
  try {
    const owner = { 'Remote-User': 'owner' };
    const none = await (await call('GET', '/hub/team/skills', owner)).json();
    assert.deepEqual([none.exportedAt, none.fresh, none.skills], [null, false, []]);
    seedAgentConfig(fake, agentConfigJson({ now: new Date(), exportedMinutesAgo: 5 }));
    const got = await call('GET', '/hub/team/skills', owner);
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.equal(body.fresh, true);
    assert.deepEqual(body.skills.map(skill => skill.id), ['brief-writer', 'simplify-text', 'spend-digest']);
    assert.equal((await call('GET', '/hub/team/skills')).status, 401);
    assert.equal((await call('POST', '/hub/team/skills', { ...owner, Origin: 'https://site.example', 'Content-Type': 'application/json' })).status, 404, 'there is no write path');
    assert.equal((await call('GET', '/hub/team/skills/extra', owner)).status, 404);
  } finally { await close(); }
  const open = await fixture({ requireRemoteUser: false });
  try { assert.equal((await open.call('GET', '/hub/team/skills')).status, 200); } finally { await open.close(); }
});
