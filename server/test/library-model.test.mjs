// What the Library lists (src/library/libraryModel.ts): pure, so no browser. The grouping, the pins crossing a section, the archive rule, paging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryList, pageOf, matchesQuery, isArchived, sortPins, PAGE, pickedProjects, togglePick, projectOrder, filterLabel, arrangeApplies } from '../../src/library/libraryModel.ts';

const day = offset => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const one = { id: 'one', name: 'One' };
const two = { id: 'two', name: 'Two' };
const card = (id, workspace, extra = {}) => ({ id, title: id.toUpperCase(), description: '', category: 'test', created: day(0), updated: day(0), status: 'active', workspace, steps: [], ...extra });
const order = { projects: [], sections: [], cards: {} };
const titles = list => list.groups.map(group => [group.label, group.cards.map(c => c.id)]);

const cards = [
  card('a', one, { updated: day(1) }),
  card('b', one, { category: 'notes' }),
  card('c', two, { updated: day(2) }),
  card('p', two, { pinned: true, pinOrder: 1 }),
  card('q', one, { pinned: true, pinOrder: 0 }),
  card('old', one, { updated: day(10), created: day(10), purpose: 'report' }),
  card('gone', two, { status: 'archived' }),
];

test('All with no search and no section is Pinned, then Recent, newest first, the pins once', () => {
  const list = libraryList(cards, order, { query: '', projects: [], view: 'all' });
  assert.deepEqual(titles(list), [['Pinned', ['q', 'p']], ['Recent', ['b', 'a', 'c']]]);
  assert.equal(list.total, 5);
  assert.equal(list.shown, 5);
});

test('one project picked, By project: the pins from every project, then that project by category', () => {
  const list = libraryList(cards, order, { query: '', projects: ['one'], view: 'all', arrange: 'project' });
  assert.deepEqual(titles(list), [['Pinned', ['q', 'p']], ['notes', ['b']], ['test', ['a']]]);
  assert.equal(list.groups[1].category, true, 'categories come in the order their newest card has');
  assert.equal(list.counts.get('one'), 3);
  assert.equal(list.counts.get('two'), 2);
});

test('a search is one newest-first run, over title, description, category, id and section', () => {
  const list = libraryList(cards, order, { query: 'two', projects: [], view: 'all' });
  assert.deepEqual(titles(list), [[null, ['p', 'c']]]);
  assert.equal(matchesQuery(cards[1], 'NOTES'), true);
  assert.equal(matchesQuery(cards[1], 'nothing'), false);
});

test('the archive is the explicit status and the date of a report or done card; a pin keeps a card live', () => {
  assert.equal(isArchived(cards[5]), true);
  assert.equal(isArchived(card('u', one, { updated: day(30), created: day(30) })), false, 'No purpose and active: it stays.');
  assert.equal(isArchived(card('x', one, { pinned: true, updated: day(30), created: day(30) })), false);
  assert.equal(isArchived(cards[6]), true);
  const list = libraryList(cards, order, { query: '', projects: [], view: 'archive' });
  assert.deepEqual(titles(list), [[null, ['gone', 'old']]]);
  assert.equal(list.archivedCount, 2);
  assert.equal(libraryList(cards, order, { query: '', projects: ['one'], view: 'all' }).archivedCount, 1);
});

test('Pinned is a flat run in pin order; pins that were never moved keep the list order', () => {
  assert.deepEqual(titles(libraryList(cards, order, { query: '', projects: [], view: 'pinned' })), [[null, ['q', 'p']]]);
  assert.deepEqual(sortPins([card('y', one, { pinned: true }), card('z', one, { pinned: true, pinOrder: 0 })]).map(c => c.id), ['z', 'y']);
});

test('a saved order still orders the headings and the cards', () => {
  const saved = { projects: [], sections: ['notes', 'test'], cards: { 'category:test': ['one/z', 'one/a'] } };
  const many = [card('a', one), card('z', one, { updated: day(1) }), card('n', one, { category: 'notes' })];
  const list = libraryList(many, saved, { query: '', projects: ['one'], view: 'all', arrange: 'project' });
  assert.deepEqual(titles(list), [['notes', ['n']], ['test', ['z', 'a']]]);
});

test('paging: the first rows, headings kept, nothing past the limit', () => {
  const lots = Array.from({ length: 130 }, (_, i) => card(`c${i}`, one));
  const list = libraryList(lots, order, { query: '', projects: [], view: 'all' });
  assert.equal(PAGE, 60);
  const first = pageOf(list.groups, PAGE);
  assert.equal(first.reduce((n, g) => n + g.cards.length, 0), 60);
  assert.equal(first[0].label, 'Recent');
  assert.equal(pageOf(list.groups, 500).reduce((n, g) => n + g.cards.length, 0), 130);
});

test('Recent with one project picked is a flat newest-first run under Pinned, not categories', () => {
  const list = libraryList(cards, order, { query: '', projects: ['one'], view: 'all', arrange: 'recent' });
  assert.deepEqual(titles(list), [['Pinned', ['q', 'p']], ['Recent', ['b', 'a']]]);
});

test('several projects: Recent is one run; By project is a heading per project in the filter order, newest first', () => {
  const three = { id: 'three', name: 'Three' };
  const all = [...cards, card('t', three, { updated: day(3) }), card('u', three)];
  const picks = ['one', 'three'];
  assert.deepEqual(titles(libraryList(all, order, { query: '', projects: picks, view: 'all', arrange: 'recent' })), [['Pinned', ['q', 'p']], ['Recent', ['b', 'u', 'a', 't']]]);
  const grouped = libraryList(all, order, { query: '', projects: picks, view: 'all', arrange: 'project', projectOrder: ['three', 'one', 'two'] });
  assert.deepEqual(titles(grouped), [['Pinned', ['q', 'p']], ['Three', ['u', 't']], ['One', ['b', 'a']]]);
  assert.deepEqual(grouped.groups.slice(1).map(g => g.project), ['three', 'one']);
  assert.equal(grouped.groups[1].category, undefined, 'a project heading is not a category');
});

test('no picks and By project: every project gets a heading', () => {
  const list = libraryList(cards, order, { query: '', projects: [], view: 'all', arrange: 'project', projectOrder: ['two', 'one'] });
  assert.deepEqual(titles(list), [['Pinned', ['q', 'p']], ['Two', ['c']], ['One', ['b', 'a']]]);
});

test('the toggle also arranges the Archive; Pinned, a search and Trash ignore it', () => {
  assert.deepEqual(titles(libraryList(cards, order, { query: '', projects: [], view: 'archive', arrange: 'project', projectOrder: ['one', 'two'] })), [['One', ['old']], ['Two', ['gone']]]);
  assert.deepEqual(titles(libraryList(cards, order, { query: '', projects: [], view: 'pinned', arrange: 'project' })), [[null, ['q', 'p']]]);
  assert.deepEqual(titles(libraryList(cards, order, { query: 'two', projects: [], view: 'all', arrange: 'project' })), [[null, ['p', 'c']]]);
  assert.equal(arrangeApplies('all', ''), true);
  assert.equal(arrangeApplies('archive', ''), true);
  assert.equal(arrangeApplies('all', 'x'), false);
  assert.equal(arrangeApplies('pinned', ''), false);
  assert.equal(arrangeApplies('trash', ''), false);
});

test('picks narrow Pinned, Archive and a search, and the pins in All still cross', () => {
  assert.deepEqual(titles(libraryList(cards, order, { query: '', projects: ['two'], view: 'pinned' })), [[null, ['p']]]);
  assert.deepEqual(titles(libraryList(cards, order, { query: '', projects: ['two'], view: 'archive' })), [[null, ['gone']]]);
  assert.deepEqual(titles(libraryList(cards, order, { query: 'test', projects: ['two'], view: 'all' })), [[null, ['p', 'c']]]);
  assert.deepEqual(titles(libraryList(cards, order, { query: '', projects: ['two'], view: 'all' }))[0], ['Pinned', ['q', 'p']]);
});

test('counts ignore the picks, so the filter list shows what each project would add', () => {
  const list = libraryList(cards, order, { query: '', projects: ['one'], view: 'all' });
  assert.equal(list.counts.get('two'), 2);
  assert.equal(list.total, 5);
});

test('the filter: toggling, the last untick meaning all, unknown ids dropped, the button label, empty projects last', () => {
  assert.deepEqual(togglePick([], 'one'), ['one']);
  assert.deepEqual(togglePick(['one'], 'two'), ['one', 'two']);
  assert.deepEqual(togglePick(['one'], 'one'), []);
  assert.deepEqual(pickedProjects(['one', 'gone', 'one'], [one, two]), ['one']);
  assert.deepEqual(pickedProjects([], [one, two]), []);
  assert.equal(filterLabel([], [one, two]), 'All projects');
  assert.equal(filterLabel(['two'], [one, two]), 'Two');
  assert.equal(filterLabel(['one', 'two'], [one, two]), '2 projects');
  assert.deepEqual(projectOrder([one, two, { id: 'three' }], new Map([['two', 3]])), ['two', 'one', 'three']);
});
