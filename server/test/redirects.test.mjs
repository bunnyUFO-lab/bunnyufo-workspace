// The whole address table of the new shell (src/lib/redirects.ts): pure, so no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAddress } from '../../src/lib/redirects.ts';

const base = { pathname: '/', hub: true, routes: 'path' };
const at = (hash, extra = {}) => canonicalAddress({ ...base, hash, ...extra });

test('an empty address on a Hub host opens Today at the first render, at any width', () => {
  assert.equal(at('', { first: true }), '#/~hub/today');
});

test('an empty address with no Hub is the Library: no rewrite', () => {
  assert.equal(at('', { first: true, hub: false }), null);
  assert.equal(at('#/', { hub: false }), null);
});

test('a section address with no hash is that section in the Library, on a Hub host', () => {
  assert.equal(at('', { pathname: '/magic-loops', first: true }), '/magic-loops#/~hub/library');
  assert.equal(at('', { pathname: '/magic-loops' }), '/magic-loops#/~hub/library');
  assert.equal(at('', { pathname: '/magic-loops', hub: false }), null);
});

test('an empty hash or #/ reached by Back or after a workspace switch is the Library', () => {
  assert.equal(at(''), '#/~hub/library');
  assert.equal(at('#'), '#/~hub/library');
  assert.equal(at('#/'), '#/~hub/library');
  assert.equal(at('#/', { first: true }), '#/~hub/library');
  assert.equal(at('', { routes: 'hash' }), '#/~hub/library');
});

test('every card link stands', () => {
  assert.equal(at('#/alpha'), null);
  assert.equal(at('#/alpha/2'), null);
  assert.equal(at('#/alpha/2', { pathname: '/magic-loops' }), null);
  assert.equal(at('#/alpha', { hub: false }), null);
});

test('the old Hub screen names go to the new ones', () => {
  assert.equal(at('#/~hub/inbox'), '#/~hub/needs');
  assert.equal(at('#/~hub/inbox/question'), '#/~hub/needs/question');
  assert.equal(at('#/~hub/board'), '#/~hub/work');
  assert.equal(at('#/~hub/board/all/abc'), '#/~hub/work/all/abc');
  assert.equal(at('#/~hub/roadmap/sprite-studio'), '#/~hub/map/sprite-studio');
});

test('the map with no project is the Projects list; with one it stands', () => {
  assert.equal(at('#/~hub/map'), '#/~hub/project');
  assert.equal(at('#/~hub/roadmap'), '#/~hub/project');
  assert.equal(at('#/~hub/map/sprite-studio'), null);
  assert.equal(at('#/~hub/map/sprite-studio/n1'), null);
});

test('the new screens stand', () => {
  for (const hash of ['#/~hub/today', '#/~hub/library', '#/~hub/search', '#/~hub/settings', '#/~hub/chat', '#/~hub/chat/abc/m/3', '#/~hub/team/skills', '#/~hub/ask/x', '#/~hub/project/p/roadmap/n1']) {
    assert.equal(at(hash), null, hash);
  }
});

test('an unknown Hub screen, or a bare ~hub, is Today', () => {
  assert.equal(at('#/~hub/nonsense'), '#/~hub/today');
  assert.equal(at('#/~hub/nonsense/deeper'), '#/~hub/today');
  assert.equal(at('#/~hub'), '#/~hub/today');
  assert.equal(at('#/~hub/'), '#/~hub/today');
});

test('a project tab by its old name goes to the new tab, once the project page has them', () => {
  assert.equal(at('#/~hub/project/p/running'), null);
  assert.equal(at('#/~hub/project/p/running', { projectTabs: true }), '#/~hub/project/p/work');
  assert.equal(at('#/~hub/project/p/needs', { projectTabs: true }), '#/~hub/project/p/work');
  assert.equal(at('#/~hub/project/p/library', { projectTabs: true }), '#/~hub/project/p/cards');
  assert.equal(at('#/~hub/project/p/work', { projectTabs: true }), null);
  assert.equal(at('#/~hub/project/p/roadmap/n1', { projectTabs: true }), null);
});

test('a /~o tail with no sheet in memory is dropped; with one it stays', () => {
  assert.equal(at('#/~hub/work/~o'), '#/~hub/work');
  assert.equal(at('#/alpha/~o'), '#/alpha');
  assert.equal(at('#/~hub/work/~o/~o'), '#/~hub/work');
  assert.equal(at('#/~hub/work/~o', { overlayOpen: true }), null);
  assert.equal(at('#/~hub/board/~o', { overlayOpen: true }), '#/~hub/work/~o');
  assert.equal(at('#/~hub/board/~o'), '#/~hub/work');
});

test('a rewrite adds no loop: the answer is itself a fixed point', () => {
  const inputs = ['', '#/', '#/~hub/inbox', '#/~hub/map', '#/~hub/zzz', '#/~hub/work/~o'];
  for (const hash of inputs) {
    const first = at(hash, { first: true });
    if (!first) continue;
    const hashOnly = first.slice(first.indexOf('#'));
    assert.equal(at(hashOnly), null, `${hash} -> ${first}`);
  }
});
