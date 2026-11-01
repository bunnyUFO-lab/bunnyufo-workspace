// Working now's links: which Beads items and cards a row shows, and in what order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BEAD_CHIPS, CARD_CHIPS, beadRefs, cleanTouched, prefixesOf, projectsToLoad, rowLinks, touchedBySession, withLinks } from '../hub-links.mjs';
import { workingNow } from '../hub-pc.mjs';
import { pcStatusJson, eventJson } from './hub-fixtures.mjs';

const bead = (project, id) => ({ project, id });
const issues = ['ws-aaa1', 'ws-bbb2', 'ws-ccc3', 'ws-ddd4', 'ws-a5g.4.11'].map(id => ({ id, title: `Title of ${id}` }));
const known = (_project, id) => issues.some(issue => issue.id === id);

test('touchedBySession keeps the newest event of each session and cleans its shape', () => {
  const events = [
    { kind: 'session-items', session: 's1', ts: '2026-11-01T10:00:00Z', touched: { beads: [bead('p', 'ws-aaa1')], cards: [] } },
    { kind: 'session-items', session: 's1', ts: '2026-11-01T10:05:00Z', touched: { beads: [bead('p', 'ws-aaa1'), bead('p', 'ws-bbb2')], cards: [{ card: 'c1', section: 's' }] } },
    { kind: 'session-items', session: 's2', ts: '2026-11-01T10:00:00Z', touched: { beads: [{ project: 'P!', id: 'ws-aaa1' }, { project: 'p', id: 'not an id' }, bead('p', 'ws-ccc3')], cards: [{ card: '../x' }] } },
    { kind: 'session-started', session: 's3', ts: '2026-11-01T10:00:00Z' },
    { kind: 'session-items', session: 's4', ts: '2026-11-01T10:00:00Z' },
  ];
  const map = touchedBySession(events);
  assert.deepEqual(map.get('s1'), { beads: [bead('p', 'ws-aaa1'), bead('p', 'ws-bbb2')], cards: [{ card: 'c1', section: 's' }] });
  assert.deepEqual(map.get('s2'), { beads: [bead('p', 'ws-ccc3')], cards: [] });
  assert.equal(map.has('s3'), false);
  assert.equal(map.has('s4'), false);
  assert.deepEqual(cleanTouched(undefined), { beads: [], cards: [] });
  assert.equal(cleanTouched({ beads: Array.from({ length: 30 }, (_, i) => bead('p', `ws-x${String(i).padStart(3, '0')}`)) }).beads.length, 10);
});

test('beadRefs: the bd writes first (newest first), then the branch, then a title id the copy has; each once', () => {
  const refs = beadRefs({
    touched: { beads: [bead('p', 'ws-aaa1'), bead('p', 'ws-bbb2')], cards: [] },
    project: 'p', branch: 'sprint/ws-a5g.4.11-drop-cards-allows', title: 'Fix ws-bbb2 and ws-ccc3, not ws-nope9', prefixes: ['ws'], known,
  });
  assert.deepEqual(refs, [bead('p', 'ws-bbb2'), bead('p', 'ws-aaa1'), bead('p', 'ws-a5g.4.11'), bead('p', 'ws-ccc3')]);
});

test('beadRefs: the branch id needs its project prefix; a title id must exist in the copy', () => {
  assert.deepEqual(beadRefs({ project: 'p', branch: 'sprint/ws-a5g.4.11-x', prefixes: ['ml'], known }), []);
  assert.deepEqual(beadRefs({ project: 'p', branch: 'bl-7f3c-wall-jump', prefixes: ['bl'], known }), [bead('p', 'bl-7f3c')]);
  assert.deepEqual(beadRefs({ project: 'p', branch: 'main', prefixes: ['ws'], known }), []);
  assert.deepEqual(beadRefs({ project: 'p', title: 'About ws-nope9', prefixes: ['ws'], known }), [], 'An id in a title that the copy lacks is not linked.');
  assert.deepEqual(beadRefs({ project: 'p', title: 'About ws-ddd4.', prefixes: ['ws'], known }), [bead('p', 'ws-ddd4')]);
  assert.deepEqual(beadRefs({ project: 'p', title: 'prews-ddd4 ws-ddd4x', prefixes: ['ws'], known }), [], 'Only a whole id counts.');
  assert.deepEqual(beadRefs({ title: 'ws-ddd4', branch: 'ws-ddd4', prefixes: ['ws'], known }), [], 'Without a project there is nowhere to link.');
});

test('beadRefs: a bd write keeps the project of the database it wrote to', () => {
  assert.deepEqual(beadRefs({ touched: { beads: [bead('other', 'ws-aaa1')], cards: [] }, project: 'p', prefixes: [], known }), [bead('other', 'ws-aaa1')]);
});

test('rowLinks caps at three Beads chips and two cards and counts the rest; unlisted cards are dropped; nothing is null', () => {
  const touched = { beads: ['ws-aaa1', 'ws-bbb2', 'ws-ccc3', 'ws-ddd4'].map(id => bead('p', id)), cards: [{ card: 'c1', section: 's' }, { card: 'c2', section: 's' }, { card: 'c3', section: 's' }, { card: 'gone', section: 's' }] };
  const resolveCard = (section, card) => (card === 'gone' ? null : { title: `Card ${card}`, href: `/${section}#/${card}` });
  const links = rowLinks({ touched, project: 'p', branch: 'sprint/ws-a5g.4.11-x', prefixes: ['ws'], known, titleOf: (_p, id) => `Title of ${id}`, resolveCard });
  assert.equal(BEAD_CHIPS, 3);
  assert.equal(CARD_CHIPS, 2);
  assert.deepEqual(links.beads.map(row => row.id), ['ws-ddd4', 'ws-ccc3', 'ws-bbb2']);
  assert.equal(links.beads[0].title, 'Title of ws-ddd4');
  assert.equal(links.moreBeads, 2);
  assert.deepEqual(links.cards.map(row => row.card), ['c3', 'c2']);
  assert.equal(links.moreCards, 1);
  assert.equal(rowLinks({ project: 'p', prefixes: ['ws'], known }), null);
});

test('rowLinks: a card published without a section is linked once the site lists it, and the same card twice shows once', () => {
  const touched = { beads: [], cards: [{ card: 'plan' }, { card: 'plan', section: 'agent-plans' }] };
  const resolveCard = (_section, card) => ({ title: 'The plan', href: `/agent-plans#/${card}` });
  const links = rowLinks({ touched, resolveCard });
  assert.equal(links.cards.length, 1);
  assert.equal(links.cards[0].href, '/agent-plans#/plan');
});

test('prefixesOf and projectsToLoad', () => {
  assert.deepEqual(prefixesOf('ws', [{ id: 'ws-1' }, { id: 'bl-2' }, { id: 'weird id' }]).sort(), ['bl', 'ws']);
  assert.deepEqual(prefixesOf(undefined, []), []);
  const map = new Map([['s1', { beads: [bead('other', 'ws-aaa1')], cards: [] }]]);
  assert.deepEqual(projectsToLoad([{ id: 's1', project: 'p' }, { id: 's2' }], map).sort(), ['other', 'p']);
});

test('withLinks adds links to the rows that have them and leaves old rows (no event, no ids) as they were', () => {
  const now = new Date();
  const status = pcStatusJson({ now, sessions: [
    { id: 'new-sess', name: 'Drop the allows', status: 'busy', kind: 'interactive', folder: 'f', repo: 'r', project: 'workspace-app', branch: 'sprint/ws-a5g.4.11-drop', startedAt: now.toISOString() },
    { id: 'old-sess', name: 'An old session', status: 'idle', kind: 'interactive', folder: 'f', repo: 'r', project: 'workspace-app', branch: 'main', startedAt: now.toISOString() },
  ] });
  const events = [{ ...eventJson({ kind: 'session-items', session: 'new-sess', project: 'workspace-app', extra: { touched: { beads: [bead('workspace-app', 'ws-aaa1')], cards: [] } } }), file: 'a.json' }];
  const rows = withLinks(workingNow({ status, events, at: now, defaults: [{ id: 'workspace-app', prefix: 'ws' }] }), {
    events, issuesOf: () => issues, defaultPrefixOf: () => 'ws', resolveCard: () => null,
  });
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.deepEqual(byId['new-sess'].links.beads.map(row => row.id), ['ws-aaa1', 'ws-a5g.4.11']);
  assert.equal(byId['old-sess'].links, undefined);
  assert.equal(byId['old-sess'].title, 'An old session');
});
