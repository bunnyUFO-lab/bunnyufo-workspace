import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_CHAIN, CHAT_MODELS, chatModelOf, chatModelsForClient, currentModelId, personaModelIds, spawnModelsForClient } from '../chat-models.mjs';
import { CHAT_PERSONAS, PERSONA_TEMPLATES } from '../chat-personas.mjs';

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
  assert.deepEqual(CHAT_MODELS.map(entry => entry.id), ['auto', 'codex', 'codex-terra', 'codex-astra', 'codex-luna', 'sonnet', 'haiku', 'opus', 'deepseek-flash']);
  assert.deepEqual(personaModelIds(), ['auto', 'codex', 'codex-terra', 'codex-astra', 'codex-luna', 'sonnet', 'haiku', 'deepseek-flash']);
  assert.deepEqual(spawnModelsForClient().map(entry => entry.id), ['auto', 'sonnet', 'haiku', 'deepseek-flash'], 'what Spawn offered before, unchanged');
});

test('Codex is listed: the ChatGPT plan, no API cost, Hermes main\'s own provider and model', () => {
  const codex = CHAT_MODELS.find(entry => entry.id === 'codex');
  assert.deepEqual({ ...codex }, { id: 'codex', label: 'Codex 6.1 Sol', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6.1-sol' });
  assert.equal(chatModelOf('codex'), codex);
  assert.deepEqual(chatModelsForClient().find(entry => entry.id === 'codex'), { id: 'codex', label: 'Codex 6.1 Sol', note: 'ChatGPT plan, no API cost' });
  const versions = Object.fromEntries(CHAT_MODELS.filter(entry => entry.provider === 'openai-codex').map(entry => [entry.id, entry.model]));
  assert.deepEqual(versions, { codex: 'gpt-6.1-sol', 'codex-terra': 'gpt-6.1-terra', 'codex-astra': 'gpt-6-astra', 'codex-luna': 'gpt-6-luna' });
  assert.equal(CHAT_MODELS[0].id, 'auto', 'Auto stays first');
  assert.match(CHAT_MODELS[0].note, /^Codex on your ChatGPT plan/, 'and names Codex first');
});

test('no default or chain holds Opus or Fable, and Auto sends no pair', () => {
  const defaults = [...CHAT_CHAIN, ...CHAT_PERSONAS.map(entry => entry.model), ...PERSONA_TEMPLATES.map(entry => entry.model)];
  for (const id of defaults) {
    const entry = chatModelOf(id);
    assert.ok(!entry.explicitOnly && !/opus|fable/i.test(`${entry.id} ${entry.model}`), id);
  }
  assert.equal(chatModelOf('auto').provider, null, 'Auto sends no pair: it runs the host primary');
  assert.equal(chatModelOf('codex').model, 'gpt-6.1-sol', 'the chain and the personas that name codex follow it');
  assert.ok(!CHAT_MODELS.some(entry => entry.hidden || entry.model === 'gpt-6-sol'), 'no hidden or second Sol row');
});

test('one row per family, the newest version only, and no Fable', () => {
  const rows = CHAT_MODELS.filter(entry => entry.provider === 'openai-codex' && !entry.hidden);
  const family = entry => /^gpt-[\d.]+-(.+)$/.exec(entry.model)[1];
  const version = entry => Number(/^gpt-([\d.]+)-/.exec(entry.model)[1]);
  assert.equal(new Set(rows.map(family)).size, rows.length, 'no two visible Codex rows are the same family');
  for (const row of rows) {
    const newest = Math.max(...CHAT_MODELS.filter(entry => entry.provider === 'openai-codex' && family(entry) === family(row)).map(version));
    assert.equal(version(row), newest, row.id);
  }
  const claude = CHAT_MODELS.filter(entry => entry.provider === 'anthropic');
  assert.equal(new Set(claude.map(entry => entry.model.split('-')[1])).size, claude.length, 'one row per Claude family');
  assert.deepEqual(chatModelsForClient().map(entry => entry.id), ['auto', 'codex', 'codex-terra', 'codex-astra', 'codex-luna', 'sonnet', 'haiku', 'opus', 'deepseek-flash']);
  for (const entry of chatModelsForClient()) for (const key of ['provider', 'model', 'explicitOnly']) assert.ok(!(key in entry), `${entry.id} leaks ${key}`);
  assert.deepEqual(chatModelsForClient().filter(entry => /\d/.test(entry.label)).map(entry => entry.label), ['Codex 6.1 Sol', 'Codex 6.1 Terra', 'Codex 6 Astra', 'Codex 6 Luna', 'Sonnet 5.5', 'Haiku 5.5', 'Opus 5.5']);
  assert.ok(!CHAT_MODELS.some(entry => /fable/i.test(`${entry.id} ${entry.label} ${entry.model ?? ''}`)));
});

test('an id an earlier version listed reads as its family; unknown ids are still a 400', () => {
  for (const [old, now] of [['codex-6-1-sol', 'codex'], ['codex-sol', 'codex'], ['codex-6-1-terra', 'codex-terra'], ['codex-6-astra', 'codex-astra'], ['codex-6-luna', 'codex-luna']]) {
    assert.equal(currentModelId(old), now);
    assert.equal(chatModelOf(old), CHAT_MODELS.find(entry => entry.id === now));
  }
  assert.equal(currentModelId('sonnet'), 'sonnet');
  for (const bad of ['__proto__', 'constructor', 'toString', 'gone-model']) assert.throws(() => chatModelOf(bad), error => error.status === 400, bad);
});
