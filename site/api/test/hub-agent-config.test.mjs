// The Hermes settings export, cleaned again on the site, and the agent details answer built from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENTS } from '../hub-team.mjs';
import { CHAT_PERSONAS } from '../chat-personas.mjs';
import { presetOf } from '../presets.mjs';
import { agentDetails, CHANGE_CODES, changeState, changeView, effectiveSet, EXPORT_MAX_BYTES, SECRET_PATTERNS, SOUL_MAX_BYTES, STALE_SECONDS, validChange, validExport, validResult, WRITER, redactSecrets } from '../hub-agent-config.mjs';
import { agentConfigJson } from './hub-fixtures.mjs';

// The vectors are a copy of scripts/assistant/config-export/secret-vectors.json in the homelab repo (proxmox-bunnylink), where the
// exporter on the Hermes host is tested against the same set. Update both together. Four inputs carry a JSON escape so that the repository leak check does not flag the file; JSON.parse gives the original text.
const VECTORS = JSON.parse(readFileSync(new URL('./fixtures/secret-vectors.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-01T12:00:00Z');
const agentOf = id => AGENTS.find(agent => agent.id === id);
const detailsOf = (id, exported, at = NOW) => {
  const agent = agentOf(id);
  return agentDetails({ agent, exported, at, persona: CHAT_PERSONAS.find(item => item.id === id) ?? null, preset: agent.presets?.[0] ? presetOf(agent.presets[0]) : null });
};
const exportAt = (iso, extra) => validExport({ ...agentConfigJson({ now: NOW, ...extra }), exportedAt: iso });

test('constants follow the contract', () => {
  assert.equal(EXPORT_MAX_BYTES, 256 * 1024);
  assert.equal(STALE_SECONDS, 7 * 3600);
  assert.equal(WRITER, 'hermes-config');
  assert.equal(SOUL_MAX_BYTES, 32 * 1024);
});

test('the secret patterns equal the shared file, and every vector gives its expected text and count', () => {
  assert.equal(VECTORS.replacement, '[redacted]');
  assert.deepEqual(SECRET_PATTERNS.map(pattern => [pattern.source, pattern.flags.includes('i')]), VECTORS.patterns.map(item => [item.regex, item.ignoreCase]));
  for (const item of VECTORS.cases) {
    const got = redactSecrets(item.input);
    assert.deepEqual([got.text, got.count], [item.expected, item.count], item.name);
  }
});

test('every vector input is redacted inside a soul and a cron prompt, with newlines kept', () => {
  for (const item of VECTORS.cases) {
    const text = `line one\n${item.input}\nline three\r\n`;
    const exported = validExport({ ...agentConfigJson({ now: NOW }), profiles: { briefs: { soul: { text }, cron: [{ name: 'j', schedule: '* * * * *', enabled: true, prompt: text }] } } });
    const soul = exported.profiles.briefs.soul;
    assert.equal(soul.text, `line one\n${item.expected}\nline three\r\n`, item.name);
    assert.equal(soul.redacted, item.count, item.name);
    assert.equal(exported.profiles.briefs.cron[0].prompt, soul.text, item.name);
  }
});

test('a soul the host already counted adds the count of the site to it', () => {
  const exported = validExport({ ...agentConfigJson({ now: NOW }), profiles: { main: { soul: { text: 'a sk-abcdefghijklmnop1234 b', redacted: 2, bytes: 5, truncated: true, sha256: 'b'.repeat(64) } } } });
  assert.deepEqual(exported.profiles.main.soul, { text: 'a [redacted] b', sha256: 'b'.repeat(64), bytes: 5, truncated: true, redacted: 3 });
});

test('the allow-list drops unknown keys at every level and .env-looking keys never survive', () => {
  const raw = agentConfigJson({ now: NOW });
  raw.extra = { API_SERVER_HOST: 'api-host-value' };
  raw.profiles.main.env = { OPENAI_API_KEY: 'x' };
  raw.profiles.main.API_SERVER_HOST = '0.0.0.0';
  raw.profiles.main.docker_forward_env = ['CARD_TOKEN'];
  raw.profiles.main.model.api_key = 'sk-abcdefghijklmnop1234';
  raw.profiles.main.fallbacks[0].base_url = 'http://x.test';
  raw.profiles.main.skills.external_dirs = ['/srv'];
  raw.profiles.main.terminal.docker_env = { A: 'b' };
  raw.profiles.main.soul.path = '/home/hermes/SOUL.md';
  raw.profiles.main.cron = [{ name: 'Daily', schedule: '0 8 * * *', enabled: true, prompt: 'p', deliver: 'discord:1234567890', secret: 'y' }];
  raw.profiles.other = { model: { provider: 'x', default: 'y' } };
  const clean = validExport(raw);
  assert.deepEqual(Object.keys(clean).sort(), ['changedAt', 'exportedAt', 'ownerSkills', 'profiles', 'v']);
  assert.deepEqual(Object.keys(clean.profiles), ['main', 'briefs']);
  assert.deepEqual(Object.keys(clean.profiles.main).sort(), ['cron', 'fallbacks', 'model', 'platformToolsets', 'skills', 'soul', 'terminal', 'toolsets']);
  assert.deepEqual(clean.profiles.main.model, { provider: 'openai-codex', default: 'gpt-6-sol' });
  assert.deepEqual(clean.profiles.main.fallbacks[0], { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.deepEqual(Object.keys(clean.profiles.main.skills), ['autoLoad', 'installed']);
  assert.deepEqual(Object.keys(clean.profiles.main.terminal), ['backend', 'containerMemoryMb']);
  assert.deepEqual(Object.keys(clean.profiles.main.soul).sort(), ['bytes', 'redacted', 'sha256', 'text', 'truncated']);
  assert.deepEqual(clean.profiles.main.cron, [{ name: 'Daily', schedule: '0 8 * * *', enabled: true, prompt: 'p' }]);
  const text = JSON.stringify(clean);
  for (const word of ['API_SERVER_HOST', 'OPENAI_API_KEY', 'docker_forward_env', 'api_key', 'external_dirs', 'docker_env', 'base_url', '1234567890', 'sk-abc', '/home/hermes']) assert.ok(!text.includes(word), word);
});

test('a bad ID string is dropped, not cut; limits hold', () => {
  const raw = agentConfigJson({ now: NOW });
  const long = 'a'.repeat(101);
  raw.profiles.main.model = { provider: 'bad provider', default: long };
  raw.profiles.main.fallbacks = [{ provider: 'ok', model: 'fine' }, { provider: 'ok', model: 'bad model!' }, { provider: 'ok' }, 'text', ...Array.from({ length: 20 }, (_, n) => ({ provider: 'p', model: `m${n}` }))];
  raw.profiles.main.toolsets = ['web', 'with space', '-lead', 7, null, long, ...Array.from({ length: 80 }, (_, n) => `t${n}`)];
  raw.profiles.main.skills.autoLoad = ['x/y', 'a;b'];
  raw.profiles.main.skills.installed = Array.from({ length: 150 }, (_, n) => `s${n}`);
  raw.profiles.main.platformToolsets = { discord: ['web', 'no way'], 'bad key': ['web'], cli: 'web' };
  raw.profiles.main.terminal = { backend: 'dock er', containerMemoryMb: 70000 };
  raw.ownerSkills = ['ok', 'not ok', 5];
  const main = validExport(raw).profiles.main;
  assert.equal(main.model, undefined, 'both IDs were bad: no model block');
  assert.equal(main.fallbacks.length, 10);
  assert.deepEqual(main.fallbacks.slice(0, 2), [{ provider: 'ok', model: 'fine' }, { provider: 'p', model: 'm0' }]);
  assert.equal(main.toolsets.length, 50);
  assert.deepEqual(main.toolsets.slice(0, 2), ['web', 't0']);
  assert.deepEqual(main.skills.autoLoad, ['x/y']);
  assert.equal(main.skills.installed.length, 100);
  assert.deepEqual(main.platformToolsets, { discord: ['web'] });
  assert.equal(main.terminal, undefined);
  assert.deepEqual(validExport(raw).ownerSkills, ['ok']);
  raw.profiles.main.model = { provider: 'ok', default: 'a.b:c/d@e+f-g' };
  raw.profiles.main.terminal = { backend: 'docker', containerMemoryMb: 0 };
  assert.deepEqual(validExport(raw).profiles.main.model, { provider: 'ok', default: 'a.b:c/d@e+f-g' });
  assert.deepEqual(validExport(raw).profiles.main.terminal, { backend: 'docker', containerMemoryMb: 0 });
});

test('toolsets, platform toolsets and cron are omitted when the host did not send them', () => {
  const raw = agentConfigJson({ now: NOW });
  delete raw.profiles.main.toolsets;
  delete raw.profiles.main.platformToolsets;
  delete raw.profiles.main.cron;
  const main = validExport(raw).profiles.main;
  assert.ok(!('toolsets' in main) && !('platformToolsets' in main) && !('cron' in main));
});

test('a wrong version or a bad exportedAt is no export', () => {
  const good = agentConfigJson({ now: NOW });
  assert.ok(validExport(good));
  for (const bad of [null, [], 'x', 5, { ...good, v: 2 }, { ...good, v: '1' }, { ...good, exportedAt: 'yesterday' }, { ...good, exportedAt: 5 }, { ...good, exportedAt: undefined }]) assert.equal(validExport(bad), null, JSON.stringify(bad)?.slice(0, 40));
  assert.equal(validExport({ ...good, changedAt: 'soon' }).changedAt, undefined, 'a bad changedAt is dropped, the export stays');
  assert.deepEqual(validExport({ v: 1, exportedAt: good.exportedAt, profiles: 'x' }).profiles, {});
});

test('a soul over 32 KB from a bad host is cut by the site too, a host-truncated one passes through', () => {
  const big = 'word '.repeat(10000);
  const cut = validExport({ ...agentConfigJson({ now: NOW }), profiles: { main: { soul: { text: big, truncated: false } } } }).profiles.main.soul;
  assert.ok(Buffer.byteLength(cut.text) <= SOUL_MAX_BYTES && cut.text.length > 30000);
  assert.equal(cut.truncated, true);
  const multi = validExport({ ...agentConfigJson({ now: NOW }), profiles: { main: { soul: { text: 'é'.repeat(20000) } } } }).profiles.main.soul;
  assert.ok(Buffer.byteLength(multi.text) <= SOUL_MAX_BYTES && !multi.text.includes('�'), 'no half character');
  const passed = validExport({ ...agentConfigJson({ now: NOW }), profiles: { main: { soul: { text: 'short', truncated: true, bytes: 40000 } } } }).profiles.main.soul;
  assert.deepEqual([passed.text, passed.truncated, passed.bytes], ['short', true, 40000]);
  const jobs = validExport({ ...agentConfigJson({ now: NOW }), profiles: { briefs: { cron: Array.from({ length: 30 }, (_, n) => ({ name: `job ${n}`, schedule: '* * * * *', enabled: n === 0, prompt: 'x '.repeat(5000) })) } } }).profiles.briefs.cron;
  assert.equal(jobs.length, 20);
  assert.ok(Buffer.byteLength(jobs[0].prompt) <= 8192);
  assert.deepEqual([jobs[0].enabled, jobs[1].enabled], [true, false]);
});

test('freshness: 6:59:59 is fresh, 7:00:00 is stale, no export is missing, Claude Code is none', () => {
  const at = new Date('2026-11-01T12:00:00Z');
  const ago = seconds => new Date(at.getTime() - seconds * 1000).toISOString();
  const fresh = detailsOf('hermes', exportAt(ago(7 * 3600 - 1)));
  assert.equal(fresh.freshness.state, 'fresh');
  assert.equal(fresh.freshness.ageSeconds, 7 * 3600 - 1);
  assert.equal(detailsOf('hermes', exportAt(ago(7 * 3600))).freshness.state, 'stale');
  assert.equal(detailsOf('hermes', exportAt(ago(0))).freshness.ageSeconds, 0);
  assert.equal(detailsOf('hermes', exportAt(new Date(at.getTime() + 60000).toISOString())).freshness.ageSeconds, 0, 'a future stamp is age 0');
  const ahead = detailsOf('hermes', exportAt(new Date(at.getTime() + 5 * 60000).toISOString()));
  assert.equal(ahead.freshness.state, 'fresh', 'five minutes of clock skew is allowed');
  const wayAhead = detailsOf('hermes', exportAt(new Date(at.getTime() + 5 * 60000 + 1000).toISOString()));
  assert.equal(wayAhead.freshness.state, 'stale', 'stamped in the future beyond the skew: stale, not fresh');
  assert.equal(wayAhead.freshness.ageSeconds, 0);
  const missing = detailsOf('hermes', null);
  assert.deepEqual(missing.freshness, { state: 'missing' });
  assert.equal(missing.settings, null);
  assert.ok(fresh.freshness.changedAt && fresh.freshness.exportedAt);
  const none = detailsOf('claude', exportAt(ago(10)));
  assert.deepEqual(none.freshness, { state: 'none' });
  assert.equal(none.settings, null);
  assert.deepEqual(none.prompts, []);
  assert.deepEqual(none.jobs, []);
  // An export that lacks the profile of the agent reads as missing for it.
  const lone = validExport({ ...agentConfigJson({ now: NOW }), profiles: { main: agentConfigJson({ now: NOW }).profiles.main } });
  assert.equal(detailsOf('briefs', lone).freshness.state, 'missing');
});

test('Hermes gets its soul only; Briefs gets its soul and jobs; the research agents get soul, persona and the job template', () => {
  const exported = exportAt(NOW.toISOString());
  const hermes = detailsOf('hermes', exported);
  assert.deepEqual(hermes.agent, { id: 'hermes', name: 'Hermes', role: 'chats, plans and dispatches', room: 'Command', runtime: 'Hermes profile main', profile: 'main', editable: { profile: true } });
  assert.deepEqual(hermes.prompts.map(prompt => [prompt.id, prompt.source]), [['soul', 'hermes-host']]);
  assert.equal(hermes.prompts[0].title, 'SOUL.md (profile main)');
  assert.match(hermes.prompts[0].text, /^## Role/);
  assert.equal(hermes.prompts[0].note, undefined);
  assert.deepEqual(hermes.jobs, []);
  assert.deepEqual(hermes.settings.model, { provider: 'openai-codex', default: 'gpt-6-sol' });
  assert.ok(!('soul' in hermes.settings) && !('cron' in hermes.settings));
  const briefs = detailsOf('briefs', exported);
  assert.equal(briefs.agent.profile, 'briefs');
  assert.deepEqual(briefs.agent.editable, { profile: true }, 'a profile agent without a persona can change its model only');
  assert.deepEqual(briefs.prompts.map(prompt => [prompt.id, prompt.source]), [['soul', 'hermes-host'], ['job', 'app']], 'Briefs also shows the template of its Run now job.');
  assert.equal(briefs.prompts[1].title, 'Job template (Projects brief)');
  assert.deepEqual(briefs.jobs, [{ name: 'Daily brief', schedule: '0 8 * * *', enabled: true, prompt: 'Write the daily projects brief.' }]);
  for (const id of ['researcher', 'market-researcher', 'teardown']) {
    const details = detailsOf(id, exported);
    assert.deepEqual(details.prompts.map(prompt => [prompt.id, prompt.source]), [['soul', 'hermes-host'], ['persona', 'app'], ['job', 'app']], id);
    assert.equal(details.prompts[1].title, 'Chat persona');
    assert.equal(details.prompts[1].text, CHAT_PERSONAS.find(item => item.id === id).text);
    const preset = presetOf(agentOf(id).presets[0]);
    assert.equal(details.prompts[2].title, `Job template (${preset.label})`);
    assert.equal(details.prompts[2].text, preset.template);
    assert.match(details.prompts[2].text, /\{\{requestId\}\}/, 'placeholders are left as they are');
    assert.equal(details.prompts[2].note, 'Placeholders are filled in when a job starts.');
  }
  // An edited persona (ws-im1.4.1) shows its own role and text, and says who edited it; the job template stays the app's.
  const edited = { ...CHAT_PERSONAS.find(item => item.id === 'teardown'), role: 'a new role', text: 'Edited text.', edited: { id: 'persona-20261103T101010123Z-ab12', at: '2026-11-03T10:10:10.123Z', by: 'owner' } };
  const shown = agentDetails({ agent: agentOf('teardown'), exported, at: NOW, persona: edited, preset: presetOf('game-teardown') });
  assert.equal(shown.agent.role, 'a new role');
  assert.deepEqual([shown.prompts[1].text, shown.prompts[1].note], ['Edited text.', 'Edited 2026-11-03 by owner.']);
  assert.equal(shown.prompts[2].note, 'Placeholders are filled in when a job starts.');
  // With no export the prompts of the app still come.
  assert.deepEqual(detailsOf('teardown', null).prompts.map(prompt => prompt.id), ['persona', 'job']);
  assert.deepEqual(detailsOf('hermes', null).prompts, []);
});

test('the soul note says when the text was cut or secrets were replaced', () => {
  const exported = validExport({ ...agentConfigJson({ now: NOW }), profiles: { main: { soul: { text: 'key sk-abcdefghijklmnop1234', truncated: true } } } });
  assert.equal(detailsOf('hermes', exported).prompts[0].note, 'Cut at 32 KB. 1 secret-like text was replaced with [redacted].');
});

test('every agent has a profile field: main, briefs or none', () => {
  assert.deepEqual(AGENTS.map(agent => [agent.id, agent.profile]), [['hermes', 'main'], ['briefs', 'briefs'], ['claude', null], ['researcher', 'main'], ['market-researcher', 'main'], ['teardown', 'main'], ['planner', 'main']]);
});

test('an ID string that holds a secret or a URL is dropped, so model and skill names cannot carry one', () => {
  const raw = agentConfigJson({ now: NOW });
  raw.profiles.main.model = { provider: 'ok', default: 'sk-abcdefghijklmnop1234' };
  raw.profiles.main.fallbacks = [{ provider: 'ok', model: 'https://user:pass@host.test/x' }, { provider: 'ok', model: 'fine' }];
  raw.profiles.main.toolsets = ['web', 'token=abcdefgh1234', 'ghp_abcdefghijklmnopqrstuvwx'];
  raw.profiles.main.skills.installed = ['good', 'API_KEY=abcdefgh1234'];
  const main = validExport(raw).profiles.main;
  assert.deepEqual(main.model, { provider: 'ok' });
  assert.deepEqual(main.fallbacks, [{ provider: 'ok', model: 'fine' }]);
  assert.deepEqual(main.toolsets, ['web']);
  assert.deepEqual(main.skills.installed, ['good']);
});

// --- profile changes (ws-im1.4.2) ---

const CODEX = { provider: 'openai-codex', model: 'gpt-6-sol' };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const FLASH = { provider: 'deepseek', model: 'deepseek-flash' };
const approvedDoc = (extra = {}) => ({
  v: 1, kind: 'profile-change', change: '20261101-profile-main-ab12', profile: 'main',
  from: { ...CODEX, fallbacks: [SONNET] }, to: { ...SONNET, fallbacks: [CODEX, FLASH] },
  expires: '2026-11-02T10:00:00.000Z', nonce: 'AAAAAAAAAAAAAAAAAAAAAA', at: '2026-11-01T10:00:00.000Z', by: 'owner', ask: '20261101-profile-main-ab12', signature: 'c2ln', ...extra,
});
const resultDoc = (extra = {}) => ({ v: 1, change: '20261101-profile-main-ab12', outcome: 'applied', code: 'ok', rolledBack: false, at: '2026-11-01T10:03:00.000Z', ...extra });

test('modelOptions are kept only when the export has them, cleaned, and at most 20; the exact-keys export stays as it was', () => {
  const plain = validExport(agentConfigJson({ now: NOW }));
  assert.ok(!('modelOptions' in plain.profiles.main), 'an older exporter\'s profile has no such key');
  const raw = agentConfigJson({ now: NOW });
  raw.profiles.main.modelOptions = [CODEX, { provider: 'x', model: 'sk-abcdefghijklmnopqrstuv' }, { provider: 'a b', model: 'c' }, 'junk', { ...SONNET, needs: 'ANTHROPIC_API_KEY' }];
  raw.profiles.briefs.modelOptions = Array.from({ length: 30 }, (_, index) => ({ provider: 'p', model: `m${index}` }));
  const clean = validExport(raw);
  assert.deepEqual(clean.profiles.main.modelOptions, [CODEX, SONNET], 'secret-looking, malformed and extra keys are dropped');
  assert.equal(clean.profiles.briefs.modelOptions.length, 20);
  const empty = agentConfigJson({ now: NOW });
  empty.profiles.main.modelOptions = [];
  assert.deepEqual(validExport(empty).profiles.main.modelOptions, [], 'an empty list is a list: the host has nothing to offer');
});

test('plugins are kept only when the export has them: name, status, version, source, short redacted description', () => {
  assert.ok(!('plugins' in validExport(agentConfigJson({ now: NOW })).profiles.main), 'an older exporter profile has no such key');
  const raw = agentConfigJson({ now: NOW });
  raw.profiles.main.plugins = [
    { name: 'disk-cleanup', status: 'enabled', version: '2.0.0', source: 'bundled', description: 'Clean up temp files.', path: '/home/x/secret', env: 'KEY' },
    { name: 'odd', status: 'weird', version: 7, source: 'elsewhere', description: 'api_key: CANARYSECRETVALUE123' },
    { name: '' }, 'junk', { status: 'enabled' },
  ];
  raw.profiles.briefs.plugins = Array.from({ length: 130 }, (_, index) => ({ name: `p${index}`, status: 'enabled', description: 'ab '.repeat(200) }));
  const clean = validExport(raw);
  assert.deepEqual(clean.profiles.main.plugins, [
    { name: 'disk-cleanup', status: 'enabled', version: '2.0.0', source: 'bundled', description: 'Clean up temp files.' },
    { name: 'odd', status: 'not enabled', version: '', source: 'user', description: '[redacted]' },
  ]);
  assert.equal(clean.profiles.briefs.plugins.length, 100);
  assert.ok(clean.profiles.briefs.plugins.every(item => item.description.length === 160));
  raw.profiles.main.plugins = [];
  assert.deepEqual(validExport(raw).profiles.main.plugins, [], 'an empty list is a list');
});

test('validChange keeps a good signed change and refuses a wrong kind, extra or missing key, a mismatched id, a bad profile, a duplicate model or five fallbacks', () => {
  const good = validChange(approvedDoc());
  assert.deepEqual(good, { change: '20261101-profile-main-ab12', profile: 'main', from: { ...CODEX, fallbacks: [SONNET] }, to: { ...SONNET, fallbacks: [CODEX, FLASH] }, expires: '2026-11-02T10:00:00.000Z', at: '2026-11-01T10:00:00.000Z', by: 'owner', ask: '20261101-profile-main-ab12' });
  const bad = [
    { kind: 'request' }, { v: 2 }, { extra: 1 }, { profile: 'prod' }, { ask: '20261101-profile-main-zzzz' }, { signature: undefined }, { nonce: 7 }, { expires: 'soon' },
    { to: { ...SONNET, fallbacks: [SONNET] } }, { to: { ...SONNET, fallbacks: [CODEX, FLASH, { provider: 'a', model: 'b' }, { provider: 'c', model: 'd' }, { provider: 'e', model: 'f' }] } },
    { from: { ...CODEX, fallbacks: [], extra: 1 } }, { to: { provider: 'anthropic', model: 'sk-abcdefghijklmnopqrstuv', fallbacks: [] } },
  ];
  for (const extra of bad) assert.equal(validChange(approvedDoc(extra)), null, JSON.stringify(extra));
  const lacking = approvedDoc();
  delete lacking.nonce;
  assert.equal(validChange(lacking), null);
  assert.equal(validChange(null), null);
});

test('validResult accepts the fixed codes and nothing else; ok goes with applied only', () => {
  assert.deepEqual(validResult(resultDoc()), { change: '20261101-profile-main-ab12', outcome: 'applied', code: 'ok', rolledBack: false, at: '2026-11-01T10:03:00.000Z' });
  for (const code of Object.keys(CHANGE_CODES).filter(code => code !== 'ok')) assert.equal(validResult(resultDoc({ outcome: 'failed', code }))?.code, code, code);
  const bad = [{ code: 'it-broke', outcome: 'failed' }, { outcome: 'applied', code: 'restart' }, { outcome: 'failed', code: 'ok' }, { extra: 1 }, { rolledBack: 'yes' }, { at: 'now' }, { v: 2 }, { outcome: 'maybe' }, { change: 7 }];
  for (const extra of bad) assert.equal(validResult(resultDoc(extra)), null, JSON.stringify(extra));
  const lacking = resultDoc();
  delete lacking.rolledBack;
  assert.equal(validResult(lacking), null);
  assert.deepEqual(Object.keys(CHANGE_CODES), ['ok', 'bad-signature', 'bad-shape', 'expired', 'stale', 'unknown-model', 'missing-key', 'no-codex-login', 'config-write', 'config-check', 'restart', 'health', 'interrupted', 'rollback-failed', 'unknown-job', 'job-refused', 'job-check']);
});

test('changeState: waiting, late, failed, applied and live, and a result for another change counts for nothing', () => {
  const change = validChange(approvedDoc());
  const at = iso => new Date(iso);
  const liveExport = stamp => validExport({ ...agentConfigJson({ now: NOW }), exportedAt: stamp, profiles: { main: { model: { provider: 'anthropic', default: 'claude-sonnet-5-5' }, fallbacks: [CODEX, FLASH] } } });
  assert.equal(changeState({ change, at: at('2026-11-01T11:00:00Z') }), 'waiting');
  assert.equal(changeState({ change, at: at('2026-11-02T10:00:01Z') }), 'late');
  assert.equal(changeState({ change, result: validResult(resultDoc({ outcome: 'failed', code: 'health', rolledBack: true })), at: at('2026-11-01T11:00:00Z') }), 'failed');
  assert.equal(changeState({ change, result: validResult(resultDoc()), exported: validExport(agentConfigJson({ now: NOW })), at: at('2026-11-01T11:00:00Z') }), 'applied', 'the export still shows the old settings');
  assert.equal(changeState({ change, result: validResult(resultDoc()), exported: liveExport('2026-11-01T10:02:00Z'), at: at('2026-11-01T11:00:00Z') }), 'applied', 'an export made before the result is not proof');
  assert.equal(changeState({ change, result: validResult(resultDoc()), exported: liveExport('2026-11-01T10:03:00Z'), at: at('2026-11-01T11:00:00Z') }), 'live', 'an export at the result\'s time is');
  assert.equal(changeState({ change, result: validResult(resultDoc({ change: '20261101-profile-main-zzzz' })), at: at('2026-11-01T11:00:00Z') }), 'waiting');
  // The primary alone is not enough: the order of the fallbacks counts.
  const swapped = validExport({ ...agentConfigJson({ now: NOW }), exportedAt: '2026-11-01T10:05:00Z', profiles: { main: { model: { provider: 'anthropic', default: 'claude-sonnet-5-5' }, fallbacks: [FLASH, CODEX] } } });
  assert.equal(changeState({ change, result: validResult(resultDoc()), exported: swapped, at: at('2026-11-01T11:00:00Z') }), 'applied');
});

test('effectiveSet: a result in beats an older export; a newer export wins, with the new order or with a host edit; a failed result changes nothing', () => {
  const change = validChange(approvedDoc());
  const oldBlock = { model: { provider: 'openai-codex', default: 'gpt-6-sol' }, fallbacks: [SONNET] };
  const newBlock = { model: { provider: 'anthropic', default: 'claude-sonnet-5-5' }, fallbacks: [CODEX, FLASH] };
  const hostEdit = { model: { provider: 'deepseek', default: 'deepseek-flash' }, fallbacks: [] };
  const exportOf = (stamp, block) => validExport({ ...agentConfigJson({ now: NOW }), exportedAt: stamp, profiles: { main: block } });
  const ok = { change, result: validResult(resultDoc()), landedAt: '2026-11-01T10:03:33.000Z' };
  const failed = { change, result: validResult(resultDoc({ outcome: 'failed', code: 'health', rolledBack: true })), landedAt: '2026-11-01T10:03:33.000Z' };
  const to = { ...SONNET, fallbacks: [CODEX, FLASH] };
  const old = exportOf('2026-11-01T09:55:00Z', oldBlock);
  assert.deepEqual(effectiveSet(old, 'main', [ok]), to, 'the result is in and the export is older: the order it asked for');
  assert.deepEqual(effectiveSet(old, 'main', []), { ...CODEX, fallbacks: [SONNET] }, 'no change: the export');
  assert.deepEqual(effectiveSet(exportOf('2026-11-01T10:04:00Z', newBlock), 'main', [ok]), to, 'a newer export that shows it');
  assert.deepEqual(effectiveSet(exportOf('2026-11-01T10:04:00Z', hostEdit), 'main', [ok]), { ...FLASH, fallbacks: [] }, 'a newer export with something else: somebody changed the host');
  assert.deepEqual(effectiveSet(exportOf('2026-11-01T10:03:00Z', oldBlock), 'main', [ok]), to, 'made before it landed (the tick start is not the landing)');
  assert.deepEqual(effectiveSet(old, 'main', [failed]), { ...CODEX, fallbacks: [SONNET] }, 'a failed result: the export');
  assert.deepEqual(effectiveSet(old, 'briefs', [ok]), null, 'another profile has its own order (this export has no briefs block here)');
  assert.deepEqual(effectiveSet(old, 'main', [{ change, result: null, landedAt: '' }]), { ...CODEX, fallbacks: [SONNET] }, 'a waiting change is not confirmed');
  const noLanding = { change, result: validResult(resultDoc()), landedAt: '' };
  assert.deepEqual(effectiveSet(exportOf('2026-11-01T10:02:59Z', oldBlock), 'main', [noLanding]), to, 'with no landing time, its own time stands in');
  assert.equal(effectiveSet(null, 'main', [ok]).model, 'claude-sonnet-5-5', 'no export at all: the confirmed change');
  // The newest confirmed change wins over an older one.
  const later = { change: validChange(approvedDoc({ change: '20261101-profile-main-cd34', ask: '20261101-profile-main-cd34', at: '2026-11-01T12:00:00.000Z', expires: '2026-11-01T13:00:00.000Z', to: { ...FLASH, fallbacks: [] } })), result: validResult(resultDoc({ change: '20261101-profile-main-cd34', at: '2026-11-01T12:03:00.000Z' })), landedAt: '2026-11-01T12:03:30.000Z' };
  assert.deepEqual(effectiveSet(old, 'main', [ok, later]), { ...FLASH, fallbacks: [] });
});

test('changeView: runningAt is when the result landed for a confirmed change, falling back to its own time; a failed or waiting one has none', () => {
  const change = validChange(approvedDoc());
  const at = new Date('2026-11-01T11:00:00Z');
  const done = changeView({ change, result: validResult(resultDoc()), landedAt: '2026-11-01T10:03:33.000Z', at });
  assert.deepEqual([done.resultAt, done.runningAt], ['2026-11-01T10:03:00.000Z', '2026-11-01T10:03:33.000Z']);
  assert.equal(changeView({ change, result: validResult(resultDoc()), at }).runningAt, '2026-11-01T10:03:00.000Z');
  assert.equal('runningAt' in changeView({ change, result: validResult(resultDoc({ outcome: 'failed', code: 'health' })), landedAt: '2026-11-01T10:03:33.000Z', at }), false);
  assert.equal('runningAt' in changeView({ change, at }), false);
});

test('agentDetails: a confirmed change whose order is no longer the one in use is replaced, after a way back (A to B, B to A) and after a host edit (A to B, then C)', () => {
  const A = { ...CODEX, fallbacks: [SONNET] };
  const B = { ...FLASH, fallbacks: [] };
  const C = { provider: 'deepseek', model: 'deepseek-v4-pro', fallbacks: [] };
  const doc = (n, from, to, at, ran) => ({ change: validChange(approvedDoc({ change: `20261101-profile-main-${n}`, ask: `20261101-profile-main-${n}`, from, to, at, expires: '2026-11-01T23:00:00.000Z' })), result: validResult(resultDoc({ change: `20261101-profile-main-${n}`, at: ran })), landedAt: ran.replace(':30.000Z', ':45.000Z') });
  const there = doc('aaaa', A, B, '2026-11-01T10:00:00.000Z', '2026-11-01T10:01:30.000Z');
  const back = doc('bbbb', B, A, '2026-11-01T10:30:00.000Z', '2026-11-01T10:31:30.000Z');
  const exportShowing = set => validExport({ ...agentConfigJson({ now: NOW }), exportedAt: '2026-11-01T11:00:00Z', profiles: { main: { model: { provider: set.provider, default: set.model }, fallbacks: set.fallbacks } } });
  const view = (exported, changes) => agentDetails({ agent: agentOf('hermes'), exported, at: NOW, changes });

  const wayBack = view(exportShowing(A), [back, there]);
  assert.deepEqual(wayBack.changes.map(item => [item.to.model, item.state, item.replaced === true]), [['gpt-6-sol', 'live', false], ['deepseek-flash', 'applied', true]], 'only the order in use is running');
  assert.equal(wayBack.change.replaced, undefined, 'the newest is the one in use');

  const edited = view(exportShowing(C), [there]);
  assert.equal(edited.settings.effective.model, 'deepseek-v4-pro');
  assert.deepEqual([edited.change.state, edited.change.replaced], ['applied', true], 'the host was changed since: state stays, and it is marked');
  assert.equal(view(exportShowing(B), [there]).change.replaced, undefined, 'while it is the order in use it is not replaced');
});

test('agentDetails: a change shows while it waits and for a day after it ended; Briefs and the research agents share their profile\'s; Claude Code has none', () => {
  const exported = exportAt(NOW.toISOString());
  const change = validChange(approvedDoc({ at: '2026-11-01T11:30:00.000Z', expires: '2026-11-02T11:30:00.000Z' }));
  const pair = { change, result: null };
  const view = (id, changes, at = NOW) => agentDetails({ agent: agentOf(id), exported, at, changes });
  const waiting = view('teardown', [pair]);
  assert.deepEqual([waiting.change.state, waiting.changes.length, waiting.change.to.model], ['waiting', 1, 'claude-sonnet-5-5']);
  assert.equal(view('claude', [pair]).change, undefined, 'no profile, no change');
  const ended = { change, result: validResult(resultDoc({ outcome: 'failed', code: 'restart', rolledBack: true, at: '2026-11-01T12:00:00.000Z' })) };
  const failed = view('hermes', [ended], new Date('2026-11-02T11:59:00Z')).change;
  assert.deepEqual([failed.state, failed.code, failed.reason, failed.rolledBack], ['failed', 'restart', CHANGE_CODES.restart, true]);
  assert.equal(view('hermes', [ended], new Date('2026-11-02T12:01:00Z')).change, undefined, 'a day after the result it is gone');
  const late = view('hermes', [pair], new Date('2026-11-02T12:00:00Z')).change;
  assert.deepEqual([late.state, late.reason], ['late', 'The Hermes host did not pick this up.']);
  assert.equal(view('hermes', [pair], new Date('2026-11-03T11:31:00Z')).change, undefined, 'and a day after it ran out');
});
