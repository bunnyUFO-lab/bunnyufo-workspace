import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODELS } from '../chat-models.mjs';
import { CHAT_PERSONAS, PERSONA_TEMPLATES, chatPersonaOf, chatPersonasForClient, personaTextOf, storedPersona } from '../chat-personas.mjs';
import { AGENTS, PERSONA_AGENTS } from '../hub-team.mjs';
import { presetOf } from '../presets.mjs';

test('every research persona is a Team agent whose first preset is a Hermes research preset, and its text carries that preset\'s rules', () => {
  assert.deepEqual(CHAT_PERSONAS.map(entry => entry.id), ['researcher', 'market-researcher', 'teardown', 'planner']);
  assert.deepEqual(PERSONA_AGENTS, CHAT_PERSONAS.map(entry => entry.id), 'the Team list of editable personas is the persona table');
  for (const entry of CHAT_PERSONAS.filter(item => item.id !== 'planner')) {
    const agent = AGENTS.find(item => item.id === entry.id);
    assert.ok(agent, entry.id);
    assert.equal(agent.presets[0], entry.preset);
    const preset = presetOf(entry.preset);
    assert.deepEqual(preset.targets, ['hermes']);
    assert.equal(preset.model, null, 'Hermes main: no provider of its own');
    assert.ok(entry.text.startsWith(`You are ${agent.name}`));
    assert.ok(entry.text.includes('Write exactly one card to the `<section>` section'));
    assert.doesNotMatch(entry.text, /\{\{/, 'every placeholder is filled');
    assert.ok(entry.text.includes('--context chat') && entry.text.includes(`--agent "${agent.name}"`), 'a chat write says who and that it is a chat');
    assert.ok(preset.template.includes(entry.extra), 'the extra rules are the preset\'s');
    assert.ok(entry.text.length < 2500);
    assert.match(entry.text, /Never create requests or Asks/, `${entry.id} may not file anything`);
    assert.doesNotMatch(entry.text, /--changes/, entry.id);
  }
});

test('a research persona quotes the card-write rules: the section from the chat, why recorded, a new tab before an edit, no script edits', () => {
  for (const entry of CHAT_PERSONAS.filter(item => item.preset)) {
    assert.ok(entry.text.includes('`<section>` is the project this chat is about, if it has a Library section, else `assistant`. Ask which one only if the chat points at two'), entry.id);
    assert.ok(entry.text.includes('--why "<one line: what this is, which section and why>" --context chat'), entry.id);
    assert.ok(entry.text.includes('prefer a new tab to editing an existing one'), entry.id);
    assert.ok(entry.text.includes('(`.js`, `.mjs`, `.cjs`, `.wasm`)') && entry.text.includes("turns off that tab's saving until the owner reverts it"), entry.id);
    assert.ok(entry.text.includes('Pass `--edit` only when the owner asked for that very card'), entry.id);
    assert.ok(entry.text.length < 2500, `${entry.id} stays under the length check`);
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
  assert.match(planner.text, /Labels are only: wayfinder:<type>, milestone, roadmap, needs-owner, later/);
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

test('the templates of a new persona (ws-im1.4.3) are built from the default text and name a listed model', () => {
  assert.deepEqual(PERSONA_TEMPLATES.map(item => item.id), ['research', 'planner', 'plain']);
  for (const template of PERSONA_TEMPLATES) assert.ok(CHAT_MODELS.some(model => model.id === template.model), template.id);
  const research = PERSONA_TEMPLATES.find(item => item.id === 'research');
  assert.equal(research.text('Researcher', CHAT_PERSONAS[0].role), CHAT_PERSONAS[0].text, 'the research template is the Researcher text');
  assert.equal(research.text('Scout', 'finds things'), personaTextOf({ name: 'Scout', role: 'finds things', extra: '' }));
  const planner = CHAT_PERSONAS.find(item => item.id === 'planner').text;
  assert.equal(PERSONA_TEMPLATES.find(item => item.id === 'planner').text('Planner', 'ignored'), planner, 'the planner template is the Planner text');
  assert.equal(PERSONA_TEMPLATES.find(item => item.id === 'planner').text('Scout', 'ignored').replace('You are Scout,', 'You are Planner,'), planner);
  const plain = PERSONA_TEMPLATES.find(item => item.id === 'plain').text('Scout', 'finds things');
  assert.match(plain, /^You are Scout, one of the owner's agents: finds things\./);
  assert.doesNotMatch(plain, /--changes|Write exactly one card/);
  assert.match(plain, /Never create requests or Asks/);
});

test('a retired entry stays in the table for an old chat but is no choice for a new one', () => {
  const table = [...CHAT_PERSONAS, { id: 'gone', name: 'Gone', role: 'was here', model: 'codex', text: 'You are Gone.', custom: true, retired: true }];
  assert.equal(storedPersona('gone', table).text, 'You are Gone.');
  assert.throws(() => chatPersonaOf('gone', table), error => error.status === 400 && error.message === 'Unknown persona.');
  assert.equal(chatPersonaOf('teardown', table).id, 'teardown');
  assert.deepEqual(chatPersonasForClient(table).map(entry => entry.id), CHAT_PERSONAS.map(entry => entry.id));
});
