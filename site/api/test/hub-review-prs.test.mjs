// A review's pull requests: when it leaves Needs you, and which project it shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveEventItems, projectOfPrs, reviewDetail, buildToday } from '../hub-model.mjs';
import { eventJson } from './hub-fixtures.mjs';

const T0 = Date.UTC(2026, 10, 2, 10, 0);
let n = 0;
const ev = (minute, fields) => ({ ...eventJson({ ts: new Date(T0 + minute * 60000), ...fields }), file: `${String(++n).padStart(4, '0')}.json` });
const PR1 = 'https://github.com/example/app/pull/181';
const PR2 = 'https://github.com/example/app/pull/182';
const OTHER = 'https://github.com/example/skills/pull/64';
const review = (minute, extra) => ev(minute, { kind: 'ready-for-review', title: 'Item', extra });
const merged = (minute, url) => ev(minute, { kind: 'pr-merged', url });

test('a review whose pull requests merged before it was posted is not in Needs you', () => {
  const events = [merged(0, PR1), merged(1, PR2), review(5, { prs: [PR1, PR2] })];
  assert.equal(deriveEventItems(events).reviews.length, 0);
});

test('a review whose pull request merges after it leaves; the single url counts as one pull request', () => {
  assert.equal(deriveEventItems([ev(0, { kind: 'ready-for-review', url: PR1 }), merged(5, PR1)]).reviews.length, 0);
  assert.equal(deriveEventItems([ev(0, { kind: 'ready-for-review', url: PR1 })]).reviews.length, 1);
  assert.equal(deriveEventItems([merged(0, 'https://github.com/example/app/pull/999'), ev(5, { kind: 'ready-for-review', url: PR1 })]).reviews.length, 1, 'a different pull request does not resolve it');
  assert.equal(deriveEventItems([merged(0, 'https://github.com/Example/App/pull/181'), ev(5, { kind: 'ready-for-review', url: PR1 })]).reviews.length, 0, 'GitHub names are not case sensitive');
});

test('a partly merged review stays, with prs and the merged count', () => {
  const [item] = deriveEventItems([merged(0, PR1), review(5, { prs: [PR1, PR2] })]).reviews;
  assert.deepEqual(item.prs, [PR1, PR2]);
  assert.equal(item.prsMerged, 1);
  const [none] = deriveEventItems([review(5, { prs: [PR1, PR2] })]).reviews;
  assert.equal(none.prsMerged, undefined);
});

test('a pull request closed without merging counts as settled for resolving, not as merged', () => {
  const closed = ev(2, { kind: 'pr-closed', url: PR2 });
  assert.equal(deriveEventItems([merged(0, PR1), closed, review(5, { prs: [PR1, PR2] })]).reviews.length, 0);
  const [item] = deriveEventItems([closed, review(5, { prs: [PR1, PR2] })]).reviews;
  assert.equal(item.prsMerged, undefined);
});

test('a review with no pull request keeps the old rule: a later merge of its bead, none before it', () => {
  const noPr = extra => ev(5, { kind: 'ready-for-review', bead: 'ws-1', extra });
  assert.equal(deriveEventItems([noPr(), ev(8, { kind: 'pr-merged', bead: 'ws-1' })]).reviews.length, 0);
  assert.equal(deriveEventItems([ev(0, { kind: 'pr-merged', bead: 'ws-1' }), noPr()]).reviews.length, 1);
  // A url that is not a pull request (a card) is no pull request.
  assert.equal(deriveEventItems([ev(5, { kind: 'ready-for-review', url: 'https://example.test/card' })]).reviews[0].prs, undefined);
});

test('bad prs entries are dropped and at most ten are kept', () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://github.com/example/app/pull/${i + 1}`);
  const [item] = deriveEventItems([review(0, { prs: ['javascript:alert(1)', 'https://evil.test/example/app/pull/1', ...many] })]).reviews;
  assert.equal(item.prs.length, 10);
  assert.ok(item.prs.every(url => url.startsWith('https://github.com/')));
});

test('the project follows the pull requests\' repository only when exactly one repository and one project match', () => {
  const map = { 'example/app': 'workspace-app' };
  assert.equal(projectOfPrs([PR1, PR2], map), 'workspace-app');
  assert.equal(projectOfPrs([PR1, OTHER], map), undefined, 'two repositories');
  assert.equal(projectOfPrs([OTHER], map), undefined, 'no project names it');
  assert.equal(projectOfPrs([], map), undefined);
  assert.equal(projectOfPrs(['https://github.com/Example/App/pull/3'], map), 'workspace-app', 'GitHub names are not case sensitive');
  const events = [review(0, { prs: [PR1, PR2] })];
  assert.equal(deriveEventItems(events, map).reviews[0].project, 'workspace-app');
  assert.equal(deriveEventItems(events).reviews[0].project, 'probe', 'no map: the event project stays');
  assert.equal(deriveEventItems([review(0, { prs: [PR1, OTHER] })], map).reviews[0].project, 'probe');
  assert.equal(buildToday({ asks: [], events, now: new Date(T0 + 3600000), repoProjects: map }).needsYou[0].project, 'workspace-app');
});

test('the review detail takes the same project and reports the merged count', () => {
  const first = review(5, { prs: [PR1, PR2] });
  const events = [merged(0, PR1), first];
  const detail = reviewDetail(events, first.file, { 'example/app': 'workspace-app' });
  assert.equal(detail.project, 'workspace-app');
  assert.equal(detail.prsMerged, 1);
  assert.deepEqual(detail.prs, [PR1, PR2]);
  assert.equal(reviewDetail(events, first.file).project, 'probe');
});

test('regression: a review of 5 PRs whose last merge exists only as an older backfilled event is settled', () => {
  const prs = [1, 2, 3, 4, 5].map(number => `https://github.com/example/skills/pull/${number}`);
  // PR 5 merged before the review was posted and before its sibling PRs; its event was written late, into an older day's folder, with the real merge time.
  const backfilled = { ...merged(-3000, prs[4]), source: 'hub-reconcile', file: 'events/2026-10-31/090000-gh-example-skills-5-merged.json' };
  const events = [review(5, { prs }), ...prs.slice(0, 4).map((url, index) => merged(10 + index, url)), backfilled];
  const items = deriveEventItems(events);
  assert.equal(items.reviews.length, 0, 'every PR has a merged event, whatever its time or day');
  assert.equal(deriveEventItems(events.filter(event => event !== backfilled)).reviews[0]?.prsMerged, 4, 'without the backfill it reads 4/5 and stays');
  // The same PR merged twice (live post and a hand backfill) changes nothing.
  assert.equal(deriveEventItems([review(5, { prs: [PR1] }), merged(6, PR1), merged(7, PR1)]).reviews.length, 0);
});

test('Today recent shows one row per PR event kind and PR, the newest', () => {
  const now = new Date(T0 + 3600000);
  const first = { ...merged(40, PR1), file: 'a.json', title: 'newest' };
  const dup = { ...merged(30, PR1), file: 'b.json', title: 'older' };
  const other = { ...merged(35, OTHER), file: 'c.json' };
  const opened = { ...ev(20, { kind: 'pr-opened', url: PR1 }), file: 'd.json' };
  const newestFirst = [first, other, dup, opened];
  const today = buildToday({ asks: [], events: newestFirst, now });
  assert.deepEqual(today.recent.map(event => event.file), ['a.json', 'c.json', 'd.json'], 'the duplicate merged row is gone; a pr-opened for the same PR stays');
  assert.equal(today.counts.recent, 3);
  // Other kinds are untouched, even with the same url.
  const deployed = [30, 20].map((minute, index) => ({ ...ev(minute, { kind: 'deployed', url: PR1 }), file: `x${index}.json` }));
  assert.equal(buildToday({ asks: [], events: deployed, now }).recent.length, 2);
});
