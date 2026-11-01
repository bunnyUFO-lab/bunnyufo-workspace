// The Needs you list's project filter: the address, the meta line, and the picker's options.
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSlug, metaParts, sessionLabel, sessionWait, needsHref, parseNeedsRoute, projectName, projectOptions } from '../../src/lib/needsView.mjs';

const KNOWN = ['all', 'question', 'steps', 'answered', 'asks', 'unstick', 'sessions'];
const isFilter = word => KNOWN.includes(word);

test('route parsing: the list, a kind, a kind in a project, a project on All, and a one-item link', () => {
  assert.deepEqual(parseNeedsRoute(undefined, isFilter), { filter: undefined, project: '', linked: '' });
  assert.deepEqual(parseNeedsRoute('', isFilter), { filter: undefined, project: '', linked: '' });
  assert.deepEqual(parseNeedsRoute('question', isFilter), { filter: 'question', project: '', linked: '' });
  assert.deepEqual(parseNeedsRoute('question/magic-loops', isFilter), { filter: 'question', project: 'magic-loops', linked: '' });
  assert.deepEqual(parseNeedsRoute('all/sprite-studio', isFilter), { filter: 'all', project: 'sprite-studio', linked: '' });
  assert.deepEqual(parseNeedsRoute('question/all', isFilter), { filter: 'question', project: '', linked: '' }, 'all in the project slot is no project');
  assert.deepEqual(parseNeedsRoute('asks/bunnylink', isFilter), { filter: 'asks', project: 'bunnylink', linked: '' }, 'an old filter name still parses');
  assert.deepEqual(parseNeedsRoute('20261101-event.json', isFilter), { filter: undefined, project: '', linked: '20261101-event.json' });
  assert.equal(parseNeedsRoute('20261101-event.json/magic-loops', isFilter).project, '', 'a one-item link ignores the rest');
});

test('the address of the list round-trips through the parser', () => {
  assert.equal(needsHref('all', ''), '#/~hub/needs/all');
  assert.equal(needsHref('question', 'magic-loops'), '#/~hub/needs/question/magic-loops');
  assert.equal(needsHref(undefined, 'a b'), '#/~hub/needs/all/a%20b');
  const route = decodeURIComponent(needsHref('steps', 'sprite-studio').replace('#/~hub/needs/', ''));
  assert.deepEqual(parseNeedsRoute(route, isFilter), { filter: 'steps', project: 'sprite-studio', linked: '' });
});

test('the meta line keeps both the project and the bead, the project first', () => {
  const names = { 'magic-loops': 'Magic Loops' };
  const parts = metaParts({ project: 'magic-loops', who: 'claude-code · gaming-pc', asked: 'asked 5m ago', bead: 'sd-bf-m5f1t1', names });
  assert.deepEqual(parts, [
    { kind: 'project', id: 'magic-loops', text: 'Magic Loops' },
    { kind: 'text', text: 'claude-code · gaming-pc' },
    { kind: 'text', text: 'asked 5m ago' },
    { kind: 'text', text: 'sd-bf-m5f1t1' },
  ]);
  assert.deepEqual(metaParts({ project: 'other', asked: 'asked 1h ago', names }).map(part => part.text), ['other', 'asked 1h ago'], 'a project the list does not know shows its id');
  const none = metaParts({ who: '', asked: 'asked 1h ago', bead: undefined, names });
  assert.deepEqual(none, [{ kind: 'text', text: 'asked 1h ago' }]);
  assert.ok(!JSON.stringify(none).includes('undefined'));
  assert.equal(projectName(null, undefined), '');
});

test('per-project counts become the picker options, by name, with the chosen project kept', () => {
  const names = { 'magic-loops': 'Magic Loops', 'sprite-studio': 'Sprite Studio' };
  assert.deepEqual(projectOptions({ 'sprite-studio': 2, 'magic-loops': 3, bunnylink: 1 }, names), [
    { id: 'bunnylink', name: 'bunnylink', count: 1 },
    { id: 'magic-loops', name: 'Magic Loops', count: 3 },
    { id: 'sprite-studio', name: 'Sprite Studio', count: 2 },
  ]);
  assert.deepEqual(projectOptions({ 'magic-loops': 3 }, names, 'sprite-studio').map(option => [option.id, option.count]), [['magic-loops', 3], ['sprite-studio', 0]]);
  assert.deepEqual(projectOptions(undefined, names), []);
});

test('a blocked session is labelled with its tool and what it waits on', () => {
  const table = [
    [{ source: 'hub-hooks' }, 'Claude permission'],
    [{ tool: 'claude-code', reason: 'permission_prompt' }, 'Claude permission'],
    [{ tool: 'claude-code', reason: 'elicitation_dialog' }, 'Claude question'],
    [{ tool: 'claude', reason: 'question' }, 'Claude question'],
    [{ tool: 'codex', reason: 'permission_prompt' }, 'Codex permission'],
    [{ tool: 'Codex' }, 'Codex waiting'],
    [{ tool: 'hermes', reason: 'idle_prompt' }, 'Hermes waiting'],
    [{ tool: 'aider', source: 'hub-hooks' }, 'Aider permission'],
    [{ tool: 'aider', reason: 'task done' }, 'Aider waiting'],
    [{ source: 'test' }, 'Session waiting'],
    [{}, 'Session waiting'],
  ];
  for (const [item, label] of table) assert.equal(sessionLabel(item), label, JSON.stringify(item));
  assert.equal(sessionWait({ reason: 'Ask the user' }), 'question');
});

test('the Sessions filter has its own word in the address, and the old words still parse', () => {
  assert.equal(filterSlug('unstick'), 'sessions');
  assert.equal(filterSlug('question'), 'question');
  assert.equal(needsHref('unstick', 'magic-loops'), '#/~hub/needs/sessions/magic-loops');
  assert.deepEqual(parseNeedsRoute('sessions/bunnylink', isFilter), { filter: 'sessions', project: 'bunnylink', linked: '' });
  assert.deepEqual(parseNeedsRoute('unstick', isFilter).filter, 'unstick');
});
