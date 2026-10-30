import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_PERSONAS, chatPersonaOf, chatPersonasForClient, storedPersona } from '../chat-personas.mjs';
import { AGENTS } from '../hub-team.mjs';
import { presetOf } from '../presets.mjs';

test('every persona is a Team agent whose first preset is a Hermes research preset, and its text carries that preset\'s rules', () => {
  assert.deepEqual(CHAT_PERSONAS.map(entry => entry.id), ['researcher', 'market-researcher', 'teardown']);
  for (const entry of CHAT_PERSONAS) {
    const agent = AGENTS.find(item => item.id === entry.id);
    assert.ok(agent, entry.id);
    assert.equal(agent.presets[0], entry.preset);
    const preset = presetOf(entry.preset);
    assert.deepEqual(preset.targets, ['hermes']);
    assert.equal(preset.model, null, 'Hermes main: no provider of its own');
    assert.ok(entry.text.startsWith(`You are ${agent.name}`));
    assert.ok(entry.text.includes('Write exactly one card to the `assistant` section'));
    assert.ok(preset.template.includes(entry.extra), 'the extra rules are the preset\'s');
    assert.ok(entry.text.length < 2500);
  }
});

test('chatPersonaOf: nothing and hermes are no persona; a listed id maps; anything else is a 400', () => {
  for (const value of [undefined, null, '', 'hermes']) assert.equal(chatPersonaOf(value), null);
  assert.equal(chatPersonaOf('teardown').id, 'teardown');
  for (const value of ['builder', 'Teardown', 'You are a pirate', 7, {}, [], 'x'.repeat(2000)]) {
    assert.throws(() => chatPersonaOf(value), error => error.status === 400 && error.message === 'Unknown persona.');
  }
  assert.equal(storedPersona('nobody'), null);
  assert.equal(storedPersona(7), null);
});

test('the page sees names and roles, never the prompt', () => {
  for (const entry of chatPersonasForClient()) assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'preset', 'role']);
});
