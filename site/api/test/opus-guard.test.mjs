// The one place that states the cost rule: Opus bills through the API, so no default, chain or automatic pick holds it, and an owner's own pick is kept.
// Nothing here reaches a provider: the fake Hermes and the stand-in S3 answer, and a pick is only checked as data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODELS, CHAT_CHAIN, chatModelOf, isDear, isOpus, personaModelIds, spawnModelsForClient } from '../chat-models.mjs';
import { CHAT_PERSONAS, PERSONA_TEMPLATES } from '../chat-personas.mjs';
import { AGENTS } from '../hub-team.mjs';
import { createAgentEdits } from '../hub-agent-edit.mjs';
import { changeState, validChange, validExport, validResult } from '../hub-agent-config.mjs';
import { loadSigningKey, parsePublicKey, publicKeyPem, verify } from '../signing.mjs';
import { AGENT_EDIT_OPTIONS } from '../agent-edit.mjs';
import { PRESETS } from '../presets.mjs';
import { chooseModel } from '../../../src/hub/chatModel.ts';
import { isDear as pageIsDear, isOpus as pageIsOpus, opusNote } from '../../../src/hub/agentEditField.ts';
import { agentConfigJson } from './hub-fixtures.mjs';
import { KEY, approve, stack, until } from './hermes-stack.mjs';

const NOW = new Date('2026-11-01T12:00:00Z');
const CODEX = { provider: 'openai-codex', model: 'gpt-6-sol' };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const DEEPSEEK = { provider: 'deepseek', model: 'deepseek-v4-pro' };
const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5' };

test('isDear: Opus and Fable, on the server and the page; each warns by name', () => {
  for (const model of ['claude-fable-5-1', 'Claude-Fable-5-1', 'claude-opus-5-5']) {
    assert.equal(isDear(model), true, model);
    assert.equal(pageIsDear(model), true, `the page agrees: ${model}`);
  }
  for (const model of ['claude-sonnet-5-5', 'gpt-6-sol', 'claude-haiku-5-5', '', undefined, null]) {
    assert.equal(isDear(model), false, String(model));
    assert.equal(pageIsDear(model), false, `the page agrees: ${model}`);
  }
  const fable = { provider: 'anthropic', model: 'claude-fable-5-1' };
  const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
  assert.match(opusNote(fable, []), /^Fable is the primary/);
  assert.match(opusNote(sonnet, [fable]), /^Fable is a fallback/);
  assert.equal(opusNote(sonnet, []), null);
});

test('isOpus: Opus ids are, nothing else is', () => {
  for (const model of ['claude-opus-5-5', 'claude-opus-4-5-20251101', 'claude-3-opus-20240229', 'claude-opus-latest', 'opus', 'anthropic/claude-opus-5-5', 'anthropic.claude-opus-5-5', 'claude-opus-4-5@20251101', 'Claude-Opus-5-5', 'claude-opus5', 'claude.opus-5', 'anthropic/opus', 'claude_opus_5']) {
    assert.equal(isOpus(model), true, model);
    assert.equal(pageIsOpus(model), true, `the page agrees: ${model}`);
  }
  for (const model of ['claude-sonnet-5-5', 'gpt-6-sol', 'deepseek-v4-pro', 'claude-haiku-5-5', '', undefined, null]) {
    assert.equal(isOpus(model), false, String(model));
    assert.equal(pageIsOpus(model), false, `the page agrees: ${model}`);
  }
});

test('no preset pins an Opus model', () => {
  for (const preset of PRESETS) assert.equal(isOpus(chatModelOf(preset.model).model), false, preset.id);
});

test('CHAT_CHAIN holds no Opus, and every id in it is a listed model', () => {
  for (const id of CHAT_CHAIN) {
    const entry = CHAT_MODELS.find(item => item.id === id);
    assert.ok(entry, `${id} is listed`);
    assert.equal(isOpus(entry.model), false, `${id} is not Opus`);
    assert.ok(!entry.explicitOnly, `${id} is not explicit-only`);
  }
  assert.equal(chatModelOf('auto').model, null, 'Auto names no model, so it cannot name Opus');
});

test('no persona, persona template or agent names an Opus model', () => {
  for (const persona of CHAT_PERSONAS) {
    assert.equal(isOpus(chatModelOf(persona.model).model), false, `persona ${persona.id}`);
    assert.ok(personaModelIds().includes(persona.model), `persona ${persona.id} starts on a model a persona may start on`);
  }
  for (const template of PERSONA_TEMPLATES) assert.equal(isOpus(chatModelOf(template.model).model), false, `template ${template.id}`);
  assert.doesNotMatch(JSON.stringify(AGENTS), /opus/i, 'AGENTS (display lines included) never name Opus');
});

test('every Opus row is explicit-only, and an explicit-only row is in no persona or Spawn list', () => {
  const opusRows = CHAT_MODELS.filter(entry => isOpus(entry.model));
  assert.ok(opusRows.length >= 1, 'the Opus row is listed');
  for (const entry of opusRows) assert.equal(entry.explicitOnly, true, `${entry.id} is explicit-only`);
  const explicit = CHAT_MODELS.filter(entry => entry.explicitOnly).map(entry => entry.id);
  for (const id of explicit) {
    assert.ok(!personaModelIds().includes(id), `${id} is no persona's model`);
    assert.ok(!spawnModelsForClient().some(entry => entry.id === id), `${id} is not in the Spawn menu`);
  }
  assert.ok(!CHAT_CHAIN.some(id => explicit.includes(id)), 'no explicit-only row is in the chain');
});

test('chooseModel: an Opus pick stays under a pause, and the default never becomes Opus from the chain', () => {
  const now = NOW.getTime();
  const pauses = ['codex', 'sonnet', 'opus'].map(model => ({ model, seen: NOW.toISOString(), until: new Date(now + 3_600_000).toISOString(), reported: true }));
  assert.equal(chooseModel({ picked: 'opus', preferred: 'codex', chain: CHAT_CHAIN, pauses, now }).model, 'opus');
  assert.equal(chooseModel({ picked: 'opus', preferred: 'codex', chain: CHAT_CHAIN, pauses: [], now }).model, 'opus');
  for (const preferred of personaModelIds()) {
    for (const paused of [[], ['codex'], ['codex', 'sonnet'], ['codex', 'sonnet', 'deepseek-flash'], personaModelIds()]) {
      const some = paused.map(model => ({ model, seen: NOW.toISOString(), until: new Date(now + 3_600_000).toISOString(), reported: true }));
      assert.notEqual(chooseModel({ picked: null, preferred, chain: CHAT_CHAIN, pauses: some, now }).model, 'opus', `${preferred} with ${paused.join(',') || 'nothing'} paused`);
    }
  }
});

test('the quota retry goes to Sonnet when HERMES_RETRY_MODEL names Opus, logs one line without a secret, and a plain value still works', async () => {
  const quota = { chain: [{ provider: 'openai-codex', model: 'gpt-6-sol' }], providerFailures: { 'openai-codex': 'Codex provider quota exhausted (429)' } };
  for (const [wanted, expected] of [['claude-opus-5-5', 'claude-sonnet-5-5'], ['claude-opus-4-5-20251101', 'claude-sonnet-5-5'], ['claude-test-model', 'claude-test-model'], [undefined, 'claude-sonnet-5-5']]) {
    const s = await stack({ hermesOptions: quota, env: wanted ? { HERMES_RETRY_MODEL: wanted } : {} });
    try {
      const lines = [];
      const api = await s.addHub({ log: line => lines.push(String(line)) });
      const id = s.propose();
      await approve(api, id);
      await until(() => s.hermes.runs.length >= 2, 'the retry run');
      assert.equal(s.hermes.runs[1].body.model, expected, `HERMES_RETRY_MODEL=${wanted}`);
      assert.equal(s.hermes.runs[1].body.provider, 'anthropic');
      const refusals = lines.filter(line => /HERMES_RETRY_MODEL/.test(line));
      assert.equal(refusals.length, isDear(wanted) ? 1 : 0, 'one line for a refusal, none otherwise');
      for (const line of refusals) assert.doesNotMatch(line, /sk-|key|token/i);
      await until(() => s.resultOf(id), 'result.json');
    } finally { await s.close(); }
  }
});

// The owner's own pick: a signed profile change with Opus in the chain. The module layer is driven directly; the passkey sits in front of it in hub.mjs.
function editsOf({ options, block = {} }) {
  const base = agentConfigJson({ now: NOW, modelOptions: { main: options, briefs: options } });
  Object.assign(base.profiles.main, block);
  const state = { exported: validExport(base), approvals: new Map() };
  const edits = createAgentEdits({
    personas: { versions: async () => { throw new Error('no persona here'); } },
    profiles: {
      signingKey: loadSigningKey({ HUB_SIGNING_KEY: KEY }),
      exported: async () => state.exported,
      changes: async () => [],
      putApproval: async (id, doc) => { state.approvals.set(id, doc); },
    },
  });
  return { edits, state };
}
const answer = choice => ({ choice });
const edit = fallbacks => ({ profile: 'main', primary: CODEX, fallbacks });
const NOW_BASE = { ...CODEX, fallbacks: [SONNET, DEEPSEEK] };
/** An agent's Ask for the same change, as `cards ask create --agent-edit` files it. */
const agentAsk = (id, fallbacks) => ({ id, requirePasskey: true, options: AGENT_EDIT_OPTIONS.map(option => ({ ...option })), agentEdit: { op: 'profile', ...edit(fallbacks) } });

test('an Opus fallback the host lists is signed unchanged and in order by the owner\'s press and by an Apply, and is live when the export shows it', async () => {
  const { edits, state } = editsOf({ options: [CODEX, SONNET, DEEPSEEK, OPUS] });
  // An agent's Ask: a skip or no choice writes nothing; Apply signs.
  const ask = agentAsk('20261101-workspace-app-edit-ab12', [SONNET, OPUS, DEEPSEEK]);
  assert.equal(await edits.afterAnswer({ ask, answer: answer('skip'), user: 'owner', at: NOW }), null);
  assert.deepEqual(await edits.afterAnswer({ ask, answer: {}, user: 'owner', at: NOW }), null, 'no choice writes nothing');
  assert.equal(state.approvals.size, 0, 'a skip writes nothing');
  const applied = await edits.afterAnswer({ ask, answer: answer('apply'), user: 'owner', at: NOW });
  assert.equal(applied.applied, true);
  const doc = state.approvals.get(ask.id);
  assert.deepEqual(doc.to.fallbacks, [SONNET, OPUS, DEEPSEEK], 'unchanged and in order');
  assert.ok(verify(doc, parsePublicKey(publicKeyPem(loadSigningKey({ HUB_SIGNING_KEY: KEY })))), 'the signature is the mark');
  const change = validChange(doc);
  assert.ok(change, 'the signed change is valid');
  // The owner's own press signs the same chain, in the same format, with no Ask.
  const direct = editsOf({ options: [CODEX, SONNET, DEEPSEEK, OPUS] });
  const pressed = await direct.edits.applyDirect({ edit: edit([SONNET, OPUS, DEEPSEEK]), base: NOW_BASE, user: 'owner', at: NOW });
  const pressedDoc = direct.state.approvals.get(pressed.change);
  assert.deepEqual(pressedDoc.to.fallbacks, [SONNET, OPUS, DEEPSEEK], 'the press keeps it too');
  assert.deepEqual(Object.keys(pressedDoc).sort(), Object.keys(doc).sort(), 'the same keys as an Apply');
  assert.equal(pressedDoc.ask, pressedDoc.change);
  assert.ok(validChange(pressedDoc), 'and the Hub reads it back');
  const result = validResult({ v: 1, change: change.change, outcome: 'applied', code: 'ok', rolledBack: false, at: new Date(NOW.getTime() + 60_000).toISOString() });
  assert.ok(result, 'the result is valid');
  const live = agentConfigJson({ now: new Date(NOW.getTime() + 120_000), exportedMinutesAgo: 0, modelOptions: { main: [CODEX, SONNET, DEEPSEEK, OPUS] } });
  live.profiles.main.model = { provider: CODEX.provider, default: CODEX.model };
  live.profiles.main.fallbacks = [SONNET, OPUS, DEEPSEEK];
  const exportedAfter = validExport(live);
  assert.equal(changeState({ change, result, exported: exportedAfter, at: new Date(NOW.getTime() + 180_000) }), 'live');
  assert.equal(changeState({ change, result, exported: validExport(agentConfigJson({ now: new Date(NOW.getTime() + 120_000) })), at: new Date(NOW.getTime() + 180_000) }), 'applied', 'not live while the export still shows the old order');
});

test('an Opus pick the host does not list is refused at the press and at Apply, with the existing words', async () => {
  const { edits, state } = editsOf({ options: [CODEX, SONNET, DEEPSEEK] });
  await assert.rejects(edits.applyDirect({ edit: edit([SONNET, OPUS]), base: NOW_BASE, user: 'owner', at: NOW }), error => error.status === 409 && /not a model the Hermes host offers for this profile/.test(error.message));
  assert.equal(state.approvals.size, 0);
  // An agent-filed Ask that names it anyway is blocked, and Apply writes nothing.
  const listed = editsOf({ options: [CODEX, SONNET, DEEPSEEK, OPUS] });
  const ask = agentAsk('20261101-workspace-app-edit-cd34', [SONNET, OPUS]);
  listed.state.exported = validExport(agentConfigJson({ now: NOW, modelOptions: { main: [CODEX, SONNET, DEEPSEEK], briefs: [CODEX] } }));
  assert.match(await listed.edits.blockedReason(ask, NOW), /not a model the Hermes host offers/);
  const refused = await listed.edits.afterAnswer({ ask, answer: answer('apply'), user: 'owner', at: NOW });
  assert.equal(refused.applied, false);
  assert.equal(listed.state.approvals.size, 0, 'nothing is written');
});
