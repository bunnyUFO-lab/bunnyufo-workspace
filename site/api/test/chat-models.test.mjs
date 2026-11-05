import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_CHAIN, CHAT_MODELS, chatModelOf, chatModelsForClient, personaModelIds, spawnModelsForClient } from '../chat-models.mjs';

test('every id is unique and plain; auto is first and names no provider', () => {
  const ids = CHAT_MODELS.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/);
  assert.equal(CHAT_MODELS[0].id, 'auto');
  assert.equal(CHAT_MODELS[0].provider, null);
  assert.equal(CHAT_MODELS[0].model, null);
  for (const entry of CHAT_MODELS.slice(1)) assert.ok(entry.provider && entry.model, entry.id);
});

test('chatModelOf maps ids, defaults to auto and refuses everything else with 400', () => {
  for (const empty of [undefined, null, '']) assert.equal(chatModelOf(empty).id, 'auto');
  for (const entry of CHAT_MODELS) assert.equal(chatModelOf(entry.id), entry);
  for (const bad of ['gpt-4o', 'anthropic/claude-opus-5', 'claude-haiku-5-5', 'Haiku', {}, 123, [], true, 'x'.repeat(2000)]) {
    assert.throws(() => chatModelOf(bad), error => error.status === 400 && error.message === 'Unknown model.', String(bad).slice(0, 20));
  }
});

test('cost guard: only the opus row names Opus and it is explicitOnly; no Pro model; Codex rows say no API cost; the client list carries only id, label and note', () => {
  const opus = CHAT_MODELS.filter(entry => /opus/i.test(`${entry.id} ${entry.model ?? ''}`));
  assert.deepEqual(opus.map(entry => entry.id), ['opus']);
  assert.equal(opus[0].explicitOnly, true);
  assert.deepEqual([opus[0].provider, opus[0].model], ['anthropic', 'claude-opus-5-5']);
  for (const entry of CHAT_MODELS) assert.doesNotMatch(`${entry.id} ${entry.model ?? ''}`, /pro\b/i, entry.id);
  for (const entry of CHAT_MODELS.filter(item => item.provider === 'openai-codex')) assert.match(entry.note, /no API cost/, entry.id);
  for (const entry of chatModelsForClient()) assert.deepEqual(Object.keys(entry).sort(), ['id', 'label', 'note']);
  assert.ok(CHAT_CHAIN.every(id => CHAT_MODELS.some(entry => entry.id === id && !entry.explicitOnly)), 'the chain holds no Opus and only listed ids');
  assert.deepEqual(CHAT_CHAIN, ['codex', 'sonnet', 'deepseek-flash']);
});

test('the menu order, and the persona and Spawn lists leave out what they must', () => {
  assert.deepEqual(CHAT_MODELS.map(entry => entry.id), ['auto', 'codex', 'codex-6-1-sol', 'codex-6-1-terra', 'codex-6-astra', 'codex-6-luna', 'sonnet', 'haiku', 'opus', 'deepseek-flash']);
  assert.deepEqual(personaModelIds(), ['auto', 'codex', 'codex-6-1-sol', 'codex-6-1-terra', 'codex-6-astra', 'codex-6-luna', 'sonnet', 'haiku', 'deepseek-flash']);
  assert.deepEqual(spawnModelsForClient().map(entry => entry.id), ['auto', 'sonnet', 'haiku', 'deepseek-flash'], 'what Spawn offered before, unchanged');
});

test('Codex is listed: the ChatGPT plan, no API cost, Hermes main\'s own provider and model', () => {
  const codex = CHAT_MODELS.find(entry => entry.id === 'codex');
  assert.deepEqual({ ...codex }, { id: 'codex', label: 'Codex 6 Sol', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6-sol' });
  assert.equal(chatModelOf('codex'), codex);
  assert.deepEqual(chatModelsForClient().find(entry => entry.id === 'codex'), { id: 'codex', label: 'Codex 6 Sol', note: 'ChatGPT plan, no API cost' });
  const versions = Object.fromEntries(CHAT_MODELS.filter(entry => entry.provider === 'openai-codex').map(entry => [entry.id, entry.model]));
  assert.deepEqual(versions, { codex: 'gpt-6-sol', 'codex-6-1-sol': 'gpt-6.1-sol', 'codex-6-1-terra': 'gpt-6.1-terra', 'codex-6-astra': 'gpt-6-astra', 'codex-6-luna': 'gpt-6-luna' });
  assert.equal(CHAT_MODELS[0].id, 'auto', 'Auto stays first');
  assert.match(CHAT_MODELS[0].note, /^Codex on your ChatGPT plan/, 'and names Codex first');
});
