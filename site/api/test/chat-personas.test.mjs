import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODELS } from '../chat-models.mjs';
import { CHAT_PERSONAS, chatPersonaOf, chatPersonasForClient, storedPersona } from '../chat-personas.mjs';
import { AGENTS } from '../hub-team.mjs';
import { presetOf } from '../presets.mjs';

test('every research persona is a Team agent whose first preset is a Hermes research preset, and its text carries that preset\'s rules', () => {
  assert.deepEqual(CHAT_PERSONAS.map(entry => entry.id), ['researcher', 'market-researcher', 'teardown', 'planner']);
  for (const entry of CHAT_PERSONAS.filter(item => item.id !== 'planner')) {
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
    assert.match(entry.text, /Never create requests or Asks/, `${entry.id} may not file anything`);
    assert.doesNotMatch(entry.text, /--changes/, entry.id);
  }
});

test('the Planner is the one persona that may file an Ask, and only a change list: its own text names --changes and the rules of the list, and never says "Never create requests or Asks"', () => {
  const planner = CHAT_PERSONAS.find(entry => entry.id === 'planner');
  const agent = AGENTS.find(item => item.id === 'planner');
  assert.ok(agent && agent.profile === 'main' && agent.presets === undefined, 'A Team agent on Hermes main with no job preset.');
  assert.equal(planner.preset, undefined);
  assert.ok(planner.text.startsWith('You are Planner'));
  assert.doesNotMatch(planner.text, /Never create requests or Asks/);
  assert.match(planner.text, /cards ask create --project <project> --kind decision --question .* --changes changes\.json/);
  assert.match(planner.text, /cards beads show --project <project> --open/);
  assert.match(planner.text, /Never more than one change-list Ask per chat turn/);
  assert.match(planner.text, /Never close a question or a task unless the owner told you in this chat that it is decided/);
  assert.match(planner.text, /You do not write to Beads or to a project's cards/);
  assert.match(planner.text, /nothing in Beads has changed/);
  for (const op of ['create', 'update', 'dep', 'close', 'label', 'card']) assert.ok(planner.text.includes(`${op} {`), `the ${op} change is described`);
  assert.match(planner.text, /Labels are only: wayfinder:<type>, milestone, needs-owner, later/);
  assert.ok(planner.text.length < 4000);
  assert.equal(chatPersonaOf('planner').id, 'planner');
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
  for (const entry of chatPersonasForClient()) assert.deepEqual(Object.keys(entry).filter(key => entry[key] !== undefined).sort(), entry.id === 'planner' ? ['id', 'model', 'name', 'role'] : ['id', 'model', 'name', 'preset', 'role']);
});

test('every persona names a model the chat may ask for (Codex for all of them), and the page gets it', () => {
  const listed = new Set(CHAT_MODELS.map(entry => entry.id));
  for (const persona of CHAT_PERSONAS) {
    assert.ok(listed.has(persona.model), `${persona.id} prefers ${persona.model}`);
    assert.equal(persona.model, 'codex', persona.id);
  }
  assert.deepEqual(chatPersonasForClient().map(entry => [entry.id, entry.model]), CHAT_PERSONAS.map(entry => [entry.id, entry.model]));
  for (const entry of chatPersonasForClient()) assert.equal('text' in entry, false, 'still no prompt text');
});
