// What the Library lists (src/library/libraryModel.ts): pure, so no browser. The grouping, the pins crossing a section, the archive rule, paging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryList, pageOf, matchesQuery, isArchived, sortPins, PAGE } from '../../src/library/libraryModel.ts';

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
  card('old', one, { updated: day(10), created: day(10) }),
  card('gone', two, { status: 'archived' }),
];

test('All with no search and no section is Pinned, then Recent, newest first, the pins once', () => {
  const list = libraryList(cards, order, { query: '', section: '', view: 'all' });
  assert.deepEqual(titles(list), [['Pinned', ['q', 'p']], ['Recent', ['b', 'a', 'c']]]);
  assert.equal(list.total, 5);
  assert.equal(list.shown, 5);
});

test('one section with no search: the pins from every section, then that section by category', () => {
  const list = libraryList(cards, order, { query: '', section: 'one', view: 'all' });
  assert.deepEqual(titles(list), [['Pinned', ['q', 'p']], ['notes', ['b']], ['test', ['a']]]);
  assert.equal(list.groups[1].category, true, 'categories come in the order their newest card has');
  assert.equal(list.counts.get('one'), 3);
  assert.equal(list.counts.get('two'), 2);
});

test('a search is one newest-first run, over title, description, category, id and section', () => {
  const list = libraryList(cards, order, { query: 'two', section: '', view: 'all' });
  assert.deepEqual(titles(list), [[null, ['p', 'c']]]);
  assert.equal(matchesQuery(cards[1], 'NOTES'), true);
  assert.equal(matchesQuery(cards[1], 'nothing'), false);
});

test('the archive is the date rule and the explicit status; a pin keeps a card live', () => {
  assert.equal(isArchived(cards[5]), true);
  assert.equal(isArchived(card('x', one, { pinned: true, updated: day(30), created: day(30) })), false);
  assert.equal(isArchived(cards[6]), true);
  const list = libraryList(cards, order, { query: '', section: '', view: 'archive' });
  assert.deepEqual(titles(list), [[null, ['gone', 'old']]]);
  assert.equal(list.archivedCount, 2);
  assert.equal(libraryList(cards, order, { query: '', section: 'one', view: 'all' }).archivedCount, 1);
});

test('Pinned is a flat run in pin order; pins that were never moved keep the list order', () => {
  assert.deepEqual(titles(libraryList(cards, order, { query: '', section: '', view: 'pinned' })), [[null, ['q', 'p']]]);
  assert.deepEqual(sortPins([card('y', one, { pinned: true }), card('z', one, { pinned: true, pinOrder: 0 })]).map(c => c.id), ['z', 'y']);
});

test('a saved order still orders the headings and the cards', () => {
  const saved = { projects: [], sections: ['notes', 'test'], cards: { 'category:test': ['one/z', 'one/a'] } };
  const many = [card('a', one), card('z', one, { updated: day(1) }), card('n', one, { category: 'notes' })];
  const list = libraryList(many, saved, { query: '', section: 'one', view: 'all' });
  assert.deepEqual(titles(list), [['notes', ['n']], ['test', ['z', 'a']]]);
});

test('paging: the first rows, headings kept, nothing past the limit', () => {
  const lots = Array.from({ length: 130 }, (_, i) => card(`c${i}`, one));
  const list = libraryList(lots, order, { query: '', section: '', view: 'all' });
  assert.equal(PAGE, 60);
  const first = pageOf(list.groups, PAGE);
  assert.equal(first.reduce((n, g) => n + g.cards.length, 0), 60);
  assert.equal(first[0].label, 'Recent');
  assert.equal(pageOf(list.groups, 500).reduce((n, g) => n + g.cards.length, 0), 130);
});
