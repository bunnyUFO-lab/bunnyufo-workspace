// What Search finds and how it groups it (src/search/searchIndex.ts): pure, so no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchRows, indexRows, groupsFor, countsOf, segments, tileRows, screenRows, itemHash, chatLineHash, readRecent, pushRecent, RECENT_KEY, RECENT_KEEP,
} from '../../src/search/searchIndex.ts';

const hubCaps = { hub: true, write: true, chat: true };
const guestCaps = { hub: true, write: false, chat: false };
const bareCaps = { hub: false, write: false, chat: false };
const one = { id: 'one', name: 'One', active: true };
const two = { id: 'two', name: 'Two' };
const sources = (extra = {}) => ({
  caps: hubCaps,
  cards: [
    { id: 'hub', title: 'The hub card', description: 'About the hub', category: 'notes', workspace: one },
    { id: 'zebra', title: 'Zebra crossing', category: 'notes', workspace: two },
    { id: 'old', title: 'Old harvest plan', category: 'notes', workspace: one, archived: true },
  ],
  items: [{ kind: 'ask', id: 'a1', title: 'Which jump arc?', project: 'magic-loops' }, { kind: 'review', id: 'r1', title: 'Review the tiles', project: 'sprite-studio' }],
  projects: [{ id: 'magic-loops', name: 'Magic Loops' }, { id: 'sprite-studio', name: 'Sprite Studio' }],
  jobs: [{ id: 'j1', title: 'Teardown of a harvest game', project: 'magic-loops', state: 'running', agent: 'Scout' }, { id: 'j2', title: 'Crop sizes', project: 'sprite-studio', state: 'done' }],
  agents: [{ id: 'scout', name: 'Scout', role: 'Research' }],
  chats: [{ id: '20260101-abcdef', title: 'Plan the redesign', persona: 'Hermes' }, { id: '20260102-ghijkl', title: 'Old harvest talk', archived: true }],
  beads: [],
  hits: [],
  ...extra,
});
const titles = rows => rows.map(row => row.title);

test('nothing typed: every row of a host, with no archived card or chat', () => {
  const rows = searchRows(sources(), '');
  assert.ok(!titles(rows).includes('Old harvest plan'), 'An archived card needs a word to be found.');
  assert.ok(!titles(rows).includes('Old harvest talk'), 'So does an archived chat.');
  assert.deepEqual(Object.entries(countsOf(rows)).filter(([, n]) => n).map(([kind]) => kind).sort(), ['chats', 'jobs', 'library', 'needs', 'projects', 'screens', 'team']);
});

test('typed words find archived things, and every word has to match', () => {
  const rows = searchRows(sources(), 'harvest');
  assert.deepEqual(titles(rows).sort(), ['Old harvest plan', 'Old harvest talk', 'Teardown of a harvest game'].sort());
  assert.equal(rows.find(row => row.title === 'Old harvest plan').sub, 'Archived · One', 'The card says it is archived, then its section.');
  assert.deepEqual(titles(searchRows(sources(), 'harvest game')), ['Teardown of a harvest game']);
  assert.deepEqual(titles(searchRows(sources(), 'harvest zebra')), []);
});

test('prefix matches rank first, and the open section comes before the rest', () => {
  const cards = [
    { id: 'x', title: 'My zebra', workspace: two },
    { id: 'y', title: 'Zebra notes', workspace: two },
    { id: 'z', title: 'A zebra of the open section', workspace: one },
  ];
  const rows = searchRows(sources({ cards }), 'zebra').filter(row => row.kind === 'library');
  assert.deepEqual(titles(rows), ['A zebra of the open section', 'Zebra notes', 'My zebra']);
});

test('a hit rows go where they say: card, item, project, job, agent, chat', () => {
  const by = word => searchRows(sources(), word)[0];
  assert.equal(by('hub card').hash, '#/hub');
  assert.equal(by('jump arc').hash, itemHash({ kind: 'ask', id: 'a1' }));
  assert.equal(by('jump arc').hash, '#/~hub/ask/a1');
  assert.equal(searchRows(sources(), 'tiles')[0].hash, '#/~hub/review/r1');
  assert.equal(searchRows(sources(), 'magic').find(row => row.kind === 'projects').hash, '#/~hub/project/magic-loops');
  assert.equal(searchRows(sources(), 'crop').find(row => row.kind === 'jobs').hash, '#/~hub/request/j2');
  assert.equal(searchRows(sources(), 'scout').find(row => row.kind === 'team').hash, '#/~hub/agent/scout');
  assert.equal(searchRows(sources(), 'redesign').find(row => row.kind === 'chats').hash, '#/~hub/chat/20260101-abcdef');
});

test('a task is found by id, title or text and opens its project with the task sheet; a hit in the text shows where', () => {
  const beads = [
    { id: 'ml-1', project: 'magic-loops', title: 'Wall jump', status: 'open', text: 'The wall jump feels floaty after the second hop.' },
    { id: 'ml-2', project: 'magic-loops', title: 'Sound', status: 'open', text: 'Nothing here.' },
  ];
  const tasks = searchRows(sources({ beads }), 'floaty').filter(row => row.kind === 'tasks');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].hash, '#/~hub/project/magic-loops/roadmap/ml-1');
  assert.match(tasks[0].sub, /^ml-1 · .*floaty/);
  const byTitle = searchRows(sources({ beads }), 'wall').find(row => row.kind === 'tasks');
  assert.equal(byTitle.sub, 'ml-1 · Magic Loops', 'A title hit names the id and the project.');
  assert.equal(searchRows(sources({ beads }), 'ml-2').filter(row => row.kind === 'tasks').length, 1, 'The id is searchable.');
  assert.deepEqual(searchRows(sources({ beads }), '').filter(row => row.kind === 'tasks'), [], 'Nothing typed lists no task.');
});

test('message hits come after the chats whose titles matched, and open the thread at that line', () => {
  const hits = [{ chat: '20260102-ghijkl', title: 'Old harvest talk', line: 7, snippet: '...the harvest moon plan...', archived: true }];
  const rows = searchRows(sources({ hits }), 'harvest').filter(row => row.kind === 'chats');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hash, '#/~hub/chat/20260102-ghijkl', 'The title match is first.');
  assert.equal(rows[1].hash, chatLineHash('20260102-ghijkl', 7));
  assert.equal(rows[1].hash, '#/~hub/chat/20260102-ghijkl/m/7');
  assert.match(rows[1].sub, /^Archived · /);
});

test('All with text: the mockup order, three a group, six for Needs you and Screens, All n only where more is behind it', () => {
  const cards = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `Gadget ${i}`, workspace: one }));
  const items = Array.from({ length: 8 }, (_, i) => ({ kind: 'ask', id: `i${i}`, title: `Gadget question ${i}` }));
  const groups = groupsFor(searchRows(sources({ cards, items }), 'gadget'), 'all');
  assert.deepEqual(groups.map(group => group.kind), ['needs', 'library']);
  const [needs, library] = groups;
  assert.equal(needs.rows.length, 6);
  assert.equal(needs.all, false, 'Needs you has no All.');
  assert.equal(library.rows.length, 3);
  assert.equal(library.total, 5);
  assert.equal(library.all, true);
  const order = groupsFor(searchRows(sources(), 'a'), 'all').map(group => group.kind);
  assert.deepEqual(order, order.slice().sort((a, b) => ['screens', 'needs', 'chats', 'library', 'projects', 'tasks', 'jobs', 'team'].indexOf(a) - ['screens', 'needs', 'chats', 'library', 'projects', 'tasks', 'jobs', 'team'].indexOf(b)));
});

test('a kind chip shows that kind alone, and a page of it', () => {
  const cards = Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, title: `Card ${i}`, workspace: one }));
  const rows = searchRows(sources({ cards }), '');
  const [group] = groupsFor(rows, 'library', 50);
  assert.equal(group.rows.length, 50);
  assert.equal(group.total, 72 - 2);
  assert.equal(groupsFor(rows, 'library', 100)[0].rows.length, 70);
  assert.equal(countsOf(rows).library, 70);
});

test('a guest sees the same screens, minus Sketch; a host with no Hub sees Library and Settings only', () => {
  assert.ok(screenRows(hubCaps).some(row => row.key === 'sketch'));
  assert.ok(!screenRows(guestCaps).some(row => row.key === 'sketch'));
  assert.ok(screenRows(guestCaps).some(row => row.key === 'chat'), 'A guest sees the Chat screen, which says it needs sign-in.');
  assert.deepEqual(screenRows(bareCaps).map(row => row.key), ['library', 'settings']);
  assert.deepEqual(indexRows(sources({ caps: bareCaps }), true).map(row => row.kind).filter(kind => kind !== 'screens' && kind !== 'library'), [], 'No Hub: nothing of the Hub is searched.');
});

test('the tiles before typing: Work first, then Team, Skills, Activity, Sketch, Settings', () => {
  assert.deepEqual(titles(tileRows(hubCaps)), ['Work', 'Team', 'Skills', 'Activity', 'Sketch', 'Settings']);
  assert.deepEqual(titles(tileRows(guestCaps)), ['Work', 'Team', 'Skills', 'Activity', 'Settings']);
  assert.deepEqual(titles(tileRows(bareCaps)), ['Settings']);
});

test('segments mark the hit words and never produce HTML', () => {
  assert.deepEqual(segments('Plan the Harvest moon', 'harvest plan'), [
    { text: 'Plan', mark: true }, { text: ' the ', mark: false }, { text: 'Harvest', mark: true }, { text: ' moon', mark: false },
  ]);
  assert.deepEqual(segments('a <b>tag</b>', ''), [{ text: 'a <b>tag</b>', mark: false }]);
  assert.deepEqual(segments('what (is) this?', '(is'), [{ text: 'what ', mark: false }, { text: '(is', mark: true }, { text: ') this?', mark: false }], 'Regex characters in a query are plain text.');
});

test('Recent keeps the last six, newest first, one per address, and ignores a value that is not a list of rows', () => {
  const memory = new Map();
  const store = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  for (let i = 0; i < 8; i++) pushRecent(store, { title: `T${i}`, sub: 's', icon: 'card', hash: `#/c${i}` });
  pushRecent(store, { title: 'T3 again', sub: 's', icon: 'card', hash: '#/c3' });
  const now = readRecent(store);
  assert.equal(now.length, RECENT_KEEP);
  assert.deepEqual(now.map(row => row.hash), ['#/c3', '#/c7', '#/c6', '#/c5', '#/c4', '#/c2']);
  assert.equal(now[0].title, 'T3 again');
  memory.set(RECENT_KEY, '{"not":"a list"}');
  assert.deepEqual(readRecent(store), []);
  memory.set(RECENT_KEY, JSON.stringify([{ title: 'x', sub: '', icon: 'card', hash: 'javascript:alert(1)' }, { title: 5 }, null]));
  assert.deepEqual(readRecent(store), [], 'An address that is not ours is dropped.');
  memory.set(RECENT_KEY, 'not json');
  assert.deepEqual(readRecent(store), []);
  assert.deepEqual(readRecent(null), []);
  assert.doesNotThrow(() => pushRecent({ getItem: () => null, setItem: () => { throw new Error('blocked'); } }, { title: 'a', sub: '', icon: 'card', hash: '#/a' }));
});

test('a skill is a Team row that opens its page, with a slash in its id encoded', () => {
  const rows = searchRows(sources({ skills: ['plan-work', 'github/pr-review'] }), 'review');
  const skill = rows.find(row => row.title === 'github/pr-review');
  assert.equal(skill.kind, 'team');
  assert.equal(skill.sub, 'Skill');
  assert.equal(skill.hash, '#/~hub/team/skills/github%2Fpr-review');
  assert.ok(!titles(searchRows(sources(), 'plan-work')).includes('plan-work'), 'A guest has no skills, so none are found.');
});
