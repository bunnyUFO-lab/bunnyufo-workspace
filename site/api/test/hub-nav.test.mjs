// The shell's entries: the rail in the mockup's order, the phone's five tabs, and what each kind of host is offered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { navEntries, tabEntries } from '../../../src/lib/hubNav.ts';
import { navScreen, showsTabs } from '../../../src/lib/route.ts';

const FULL = { hub: true, write: true, chat: true };
const GUEST = { hub: true, write: false, chat: false };
const NO_CHAT = { hub: true, write: true, chat: false };
const NO_HUB = { hub: false, write: false, chat: false };
const ids = entries => entries.map(entry => entry.nav);

test('the rail: Search, Today, Chat, Library, Projects, then Work and Team, then Sketch and Settings', () => {
  assert.deepEqual(ids(navEntries(FULL)), ['search', 'today', 'chat', 'library', 'project', 'work', 'team', 'sketch', 'settings']);
  assert.deepEqual(navEntries(FULL).map(entry => entry.group), ['top', 'top', 'top', 'top', 'top', 'work', 'work', 'foot', 'foot']);
});

test('the phone has five tabs: Today, Chat, Library, Projects, Search', () => {
  assert.deepEqual(ids(tabEntries(FULL)), ['today', 'chat', 'library', 'project', 'search']);
});

test('a guest sees the same tabs, with Chat (its screen says what it needs), and no Sketch', () => {
  assert.deepEqual(ids(tabEntries(GUEST)), ['today', 'chat', 'library', 'project', 'search']);
  assert.ok(!ids(navEntries(GUEST)).includes('sketch'));
});

test('where writes are on and chat is not set up, Chat is left out', () => {
  assert.ok(!ids(tabEntries(NO_CHAT)).includes('chat'));
  assert.ok(!ids(navEntries(NO_CHAT)).includes('chat'));
});

test('a host with no Hub has the Library, Search and Settings on the rail, and no tabs', () => {
  assert.deepEqual(ids(navEntries(NO_HUB)), ['search', 'library', 'settings']);
  assert.deepEqual(tabEntries(NO_HUB), []);
});

test('every entry opens a Hub address', () => {
  for (const entry of navEntries(FULL)) assert.match(entry.hash, /^#\/~hub\/[a-z]+$/, entry.nav);
});

test('screens light the entry they belong to', () => {
  assert.equal(navScreen('needs'), 'today');
  assert.equal(navScreen('ask'), 'today');
  assert.equal(navScreen('review'), 'today');
  assert.equal(navScreen('activity'), 'work');
  assert.equal(navScreen('jobs'), 'work');
  assert.equal(navScreen('agent'), 'team');
  assert.equal(navScreen('map'), 'project');
  assert.equal(navScreen(undefined), null);
});

test('tabs show on a tab\'s own list and on no deeper screen', () => {
  const hub = (screen, id) => ({ id: null, step: -1, hub: { screen, ...(id ? { id } : {}) } });
  assert.equal(showsTabs(hub('today')), true);
  assert.equal(showsTabs(hub('library')), true);
  assert.equal(showsTabs(hub('search')), true);
  assert.equal(showsTabs(hub('chat')), true);
  assert.equal(showsTabs(hub('chat', 'abc')), false);
  assert.equal(showsTabs(hub('project')), true);
  assert.equal(showsTabs(hub('project', 'p1')), false);
  for (const screen of ['needs', 'ask', 'work', 'team', 'sketch', 'settings', 'map']) assert.equal(showsTabs(hub(screen)), false, screen);
  assert.equal(showsTabs({ id: 'a-card', step: -1 }), true, 'The tab bar stays on an open card, Library lit (ws-cl0.6.12).');
  assert.equal(showsTabs({ id: null, step: -1 }), true);
});
