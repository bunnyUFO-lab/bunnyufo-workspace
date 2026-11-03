// What the owner reads first on a review, and which reviews reach Needs you at all (ws-8w1).
// The five fixtures are the real review events of 2026-11-02/03 with names, hosts and ids replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEventItems, plainReviewTitle, reviewDetail } from '../hub-model.mjs';
import { eventJson } from './hub-fixtures.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/review-items');
const samples = Object.fromEntries(readdirSync(dir).filter(name => name.endsWith('.json')).map(name => [name.split('-').pop().replace('.json', ''), { ...JSON.parse(readFileSync(path.join(dir, name), 'utf8')), file: name }]));
const T0 = Date.UTC(2026, 10, 3, 6, 0);
const merged = (url, minute = 0) => ({ ...eventJson({ kind: 'pr-merged', url, ts: new Date(T0 + minute * 60000) }), file: `m-${url.split('/').pop()}-${url.split('/')[4]}.json` });

test('the five samples: the three closed without a pull request or an ask leave Needs you, the two with pull requests stay', () => {
  const kept = Object.entries(samples).filter(([, event]) => deriveEventItems([event]).reviews.length === 1).map(([key]) => key).sort();
  assert.deepEqual(kept, ['baph7z', 'br3x2c']);
});

test('regression: the ws-t3a close (no pull request, no ask) produces no Needs-you item, with other events around it', () => {
  const events = [samples.uged86, merged('https://github.com/example/app/pull/1')];
  assert.equal(deriveEventItems(events).reviews.length, 0);
  assert.ok(reviewDetail(events, samples.uged86.file), 'its page still opens from a link');
});

test('regression: the cleanup batch with five pull requests shows 4 of 5 until the last merge arrives, then clears', () => {
  const event = samples.baph7z;
  assert.equal(event.prs.length, 5);
  const [last, ...rest] = [...event.prs].reverse();
  const events = [event, ...rest.map((url, index) => merged(url, index))];
  const [item] = deriveEventItems(events).reviews;
  assert.equal(item.prsMerged, 4);
  assert.equal(item.prs.length, 5);
  assert.equal(deriveEventItems([...events, merged(last, 9)]).reviews.length, 0, 'the fifth merge clears it');
});

test('an old event shows its title without the sprint label and without the trailing brief', () => {
  for (const [key, event] of Object.entries(samples)) {
    const shown = plainReviewTitle(event.title);
    assert.doesNotMatch(shown, /^mc-s-m1:/, key);
    assert.doesNotMatch(shown, /Briefs?:/, key);
    assert.ok(shown.length > 10, key);
  }
  assert.equal(plainReviewTitle('mc-s-m1: Cleanup batch. Briefs: sprint/briefs/a.md, b.md…'), 'Cleanup batch');
  assert.equal(plainReviewTitle(samples.uged86.title), "refresh-cards.test.mjs 'fetch failed' to its 127.0.0.1 fake under load; find the cause and drop the connect retry");
  assert.equal(plainReviewTitle('Plain title'), 'Plain title');
  assert.equal(plainReviewTitle('Note: keep this'), 'Note: keep this', 'a word before a colon is not a sprint label');
  assert.equal(deriveEventItems([samples.br3x2c]).reviews[0].title, plainReviewTitle(samples.br3x2c.title));
});

test('a review with an ask and no pull request stays; ownerTitle, ownerSummary and ask lead', () => {
  const event = { ...samples.uged86, ownerTitle: 'Flaky test: cause found', ownerSummary: 'The cause is the busy PC, not the code. Nothing was changed.', ask: 'Nothing to do: Mark done', tryIt: 'Open the page', doneMeans: 'Hides it from Needs you.' };
  const [item] = deriveEventItems([event]).reviews;
  assert.equal(item.title, 'Flaky test: cause found');
  assert.equal(item.ownerSummary, event.ownerSummary);
  assert.equal(item.ask, 'Nothing to do: Mark done');
  const detail = reviewDetail([event], event.file);
  assert.equal(detail.title, 'Flaky test: cause found');
  assert.equal(detail.fullTitle, event.title);
  assert.deepEqual([detail.ownerSummary, detail.ask, detail.tryIt, detail.doneMeans], [event.ownerSummary, event.ask, 'Open the page', 'Hides it from Needs you.']);
  assert.equal(deriveEventItems([{ ...samples.uged86, ask: '   ' }]).reviews.length, 0, 'a blank ask is no ask');
});

test('old events keep their fields: no owner fields appear', () => {
  const detail = reviewDetail([samples.br3x2c], samples.br3x2c.file);
  assert.equal(detail.ownerSummary, undefined);
  assert.equal(detail.ask, undefined);
  assert.equal(detail.tryIt, undefined);
  assert.equal(detail.title, plainReviewTitle(samples.br3x2c.title));
  assert.equal(detail.fullTitle, samples.br3x2c.title);
  assert.ok(detail.summary);
});
