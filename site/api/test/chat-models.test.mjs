import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODELS, chatModelOf, chatModelsForClient } from '../chat-models.mjs';

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

test('no entry names an Opus or Pro model (cost guard), and the client list carries no provider or model string', () => {
  for (const entry of CHAT_MODELS) assert.doesNotMatch(`${entry.id} ${entry.model ?? ''}`, /opus|pro\b/i, entry.id);
  for (const entry of chatModelsForClient()) assert.deepEqual(Object.keys(entry).sort(), ['id', 'label', 'note']);
});
