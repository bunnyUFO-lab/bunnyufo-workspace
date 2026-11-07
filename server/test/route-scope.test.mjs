// The project and sprint in the address (src/lib/route.ts, hubNav.ts): pure, so no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHashString, withScope, scopeOf, workBoardHash, projectHash, mapHash, workHash, projectNodeHash } from '../../src/lib/route.ts';
import { navEntries, tabEntries } from '../../src/lib/hubNav.ts';

const hub = hash => parseHashString(hash).hub;

test('?project= is the route id on Work, Projects and Map when the path has none', () => {
  assert.deepEqual(hub('#/~hub/work?project=alpha'), { screen: 'work', id: 'alpha', project: 'alpha' });
  assert.deepEqual(hub('#/~hub/project?project=alpha'), { screen: 'project', id: 'alpha', project: 'alpha' });
  assert.deepEqual(hub('#/~hub/map?project=alpha'), { screen: 'map', id: 'alpha', project: 'alpha' });
  assert.equal(hub('#/~hub/work?project=all').id, 'all');
});

test('both address forms give the same board', () => {
  assert.equal(hub('#/~hub/work/alpha?sprint=s5').id, hub('#/~hub/work?project=alpha&sprint=s5').id);
  assert.equal(hub('#/~hub/work/alpha?sprint=s5').sprint, 's5');
});

test('a path id wins over the parameter', () => {
  assert.equal(hub('#/~hub/work/beta?project=alpha').id, 'beta');
  assert.equal(hub('#/~hub/project/beta/work?project=alpha').id, 'beta/work');
});

test('the sprint is trimmed, cut at 80 characters and empty is none', () => {
  assert.equal(hub('#/~hub/work?sprint=%20s5%20').sprint, 's5');
  assert.equal(hub(`#/~hub/work?sprint=${'x'.repeat(100)}`).sprint.length, 80);
  assert.equal(hub('#/~hub/work?sprint=').sprint, undefined);
  assert.equal(hub('#/~hub/work?sprint=%20').sprint, undefined);
});

test('a sheet tail after the query is read as a sheet, not as part of the value', () => {
  const route = parseHashString('#/~hub/work?project=alpha&sprint=s5/~o');
  assert.equal(route.overlay, true);
  assert.equal(route.hub.sprint, 's5');
});

test('the query leaves the old addresses and the cards alone', () => {
  assert.deepEqual(hub('#/~hub/work'), { screen: 'work' });
  assert.deepEqual(hub('#/~hub/work/alpha/ws-1'), { screen: 'work', id: 'alpha/ws-1' });
  assert.deepEqual(parseHashString('#/alpha/2'), { id: 'alpha', step: 2 });
  assert.deepEqual(hub('#/~hub/today?sprint=s5'), { screen: 'today', sprint: 's5' });
});

test('withScope and workBoardHash', () => {
  assert.equal(withScope('#/~hub/today', {}), '#/~hub/today');
  assert.equal(withScope('#/~hub/work', { project: 'a b', sprint: 's5' }), '#/~hub/work?project=a+b&sprint=s5');
  assert.equal(withScope('#/~hub/work?project=a', { sprint: 's5' }), '#/~hub/work?project=a&sprint=s5');
  assert.equal(workBoardHash(), '#/~hub/work');
  assert.equal(workBoardHash('alpha'), '#/~hub/work?project=alpha');
  assert.equal(workBoardHash('alpha', 's5'), '#/~hub/work?project=alpha&sprint=s5');
  assert.equal(workBoardHash('', 's5'), '#/~hub/work?sprint=s5');
  assert.equal(hub(workBoardHash('alpha', 's5')).sprint, 's5');
});

test('the helpers keep a sprint when given one', () => {
  assert.equal(projectHash('alpha', 'work', 's5'), '#/~hub/project/alpha/work?sprint=s5');
  assert.equal(projectHash('alpha'), '#/~hub/project/alpha');
  assert.equal(mapHash('alpha', 'ws-1', 's5'), '#/~hub/map/alpha/ws-1?sprint=s5');
  assert.equal(workHash('alpha', 'ws-1', 's5'), '#/~hub/work/alpha/ws-1?sprint=s5');
  assert.equal(projectNodeHash('alpha', 'ws-1'), '#/~hub/project/alpha/roadmap/ws-1');
  assert.equal(hub(projectNodeHash('alpha', 'ws-1', 's5')).sprint, 's5');
});

test('scopeOf names the project the screen shows', () => {
  assert.deepEqual(scopeOf(hub('#/~hub/work/alpha/ws-1?sprint=s5')), { project: 'alpha', sprint: 's5' });
  assert.deepEqual(scopeOf(hub('#/~hub/work?project=alpha')), { project: 'alpha' });
  assert.deepEqual(scopeOf(hub('#/~hub/map/alpha/ws-1?sprint=s5')), { project: 'alpha', sprint: 's5' });
  assert.deepEqual(scopeOf(hub('#/~hub/project')), {});
  assert.deepEqual(scopeOf(undefined), {});
});

test('the rail and the tabs carry the scope to Today, Projects (sprint only) and Work', () => {
  const caps = { hub: true, write: true, chat: true };
  const scope = { project: 'alpha', sprint: 's5' };
  const of = (list, nav) => list.find(entry => entry.nav === nav).hash;
  const rail = navEntries(caps, scope);
  assert.equal(of(rail, 'today'), '#/~hub/today?project=alpha&sprint=s5');
  assert.equal(of(rail, 'project'), '#/~hub/project?sprint=s5');
  assert.equal(of(rail, 'work'), '#/~hub/work?project=alpha&sprint=s5');
  assert.equal(of(rail, 'team'), '#/~hub/team');
  assert.equal(of(rail, 'library'), '#/~hub/library');
  const tabs = tabEntries(caps, scope);
  assert.equal(of(tabs, 'today'), '#/~hub/today?project=alpha&sprint=s5');
  assert.equal(of(tabs, 'chat'), '#/~hub/chat');
  assert.equal(of(navEntries(caps), 'work'), '#/~hub/work');
});
