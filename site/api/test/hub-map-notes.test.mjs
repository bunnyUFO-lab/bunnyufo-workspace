// What the Roadmap sheet says about an issue: summary, Beads PRs and commits, Library card refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardRefsOf, commitsFromIssue, githubSlug, prsFromIssue, summaryOf } from '../hub-map-notes.mjs';

const BACKFILL = 'Backfilled 2026-10-26 from git, PRs and cards.';

test('summaryOf: a backfill description with only a hash has no summary', () => {
  assert.equal(summaryOf(`a62a2bb4\n\n${BACKFILL}`), null);
  assert.equal(summaryOf(`${BACKFILL}\n\nPR: #138 merged`), null);
  assert.equal(summaryOf('a62a2bb4, 205e63a5 2026-10-24'), null);
  assert.equal(summaryOf(undefined), null);
  assert.equal(summaryOf(''), null);
});

test('summaryOf: three words are not a description', () => {
  assert.equal(summaryOf(`TODO in backups.md\n\n${BACKFILL}`), null);
});

test('summaryOf: a fragment of four words shows, boilerplate lines in its paragraph do not', () => {
  assert.equal(summaryOf(`commits 2026-10-24, PR opened 25 Oct, awaiting review\n${BACKFILL}`), 'commits 2026-10-24, PR opened 25 Oct, awaiting review');
  assert.equal(summaryOf(`Copy the weekly backups off the host.\nPR: #12 open\n\n${BACKFILL}`), 'Copy the weekly backups off the host.');
});

test('summaryOf: a Question issue gives the paragraph under its heading', () => {
  const text = '## Question\n\nShould the hex map wrap at the edges, or stop? Wrapping breaks the minimap.\n\n## Why\n\nBecause.';
  assert.equal(summaryOf(text), 'Should the hex map wrap at the edges, or stop? Wrapping breaks the minimap.');
});

test('summaryOf: two sentences at most, clipped to 240 characters with an ellipsis, Markdown links keep their text', () => {
  const text = 'Add the **wall slide** to the [movement kit](https://example.test/x) so characters stick to walls. It reuses the `Grounded` check. A third sentence is dropped.';
  assert.equal(summaryOf(text), 'Add the wall slide to the movement kit so characters stick to walls. It reuses the Grounded check.');
  const long = `${'Word '.repeat(80)}ends here. Second sentence.`;
  const clipped = summaryOf(long);
  assert.ok(clipped.length <= 240 && clipped.endsWith('…'), clipped.length);
  assert.equal(summaryOf('Short one here today. Second one follows now. Third one never.'), 'Short one here today. Second one follows now.');
});

test('summaryOf: a Markdown-heavy description starts at the first real paragraph', () => {
  const text = '# Title\n\n- Make the loader stream chunks\n- keep memory flat\n\n## Notes\n\nlater';
  assert.equal(summaryOf(text), 'Make the loader stream chunks keep memory flat');
});

test('githubSlug accepts GitHub remotes and a bare owner/name only', () => {
  assert.equal(githubSlug('git@github.com:someone/some_repo.git'), 'someone/some_repo');
  assert.equal(githubSlug('https://github.com/someone/some_repo'), 'someone/some_repo');
  assert.equal(githubSlug('someone/some_repo'), 'someone/some_repo');
  assert.equal(githubSlug('git@git.example.test:someone/some_repo.git'), null);
  assert.equal(githubSlug(''), null);
});

test('prsFromIssue: external_ref and the PR line are one row, with the URL from a GitHub remote', () => {
  const issue = { external_ref: 'gh-221', description: `Do it.\n\nPR: #221 open\n${BACKFILL}` };
  assert.deepEqual(prsFromIssue(issue, 'git@github.com:someone/some_repo.git'), [{ number: 221, url: 'https://github.com/someone/some_repo/pull/221', state: 'open', source: 'beads' }]);
});

test('prsFromIssue: several numbers on one line, states kept or dropped, once per number', () => {
  const rows = prsFromIssue({ description: 'PRs: #12 merged, #14 open, #15 weird\nPR: #12 open', external_ref: 'gh-14' }, 'https://github.com/someone/some_repo.git');
  assert.deepEqual(rows.map(({ number, state }) => [number, state]), [[14, 'open'], [12, 'merged'], [15, undefined]]);
  assert.equal(rows.find(row => row.number === 15).state, undefined);
});

test('prsFromIssue: a non-GitHub repo gives rows without a URL; an issue with no PR gives none', () => {
  assert.deepEqual(prsFromIssue({ external_ref: 'gh-7' }, 'git@git.example.test:a/b.git'), [{ number: 7, source: 'beads' }]);
  assert.deepEqual(prsFromIssue({ external_ref: 'jira-7', description: 'PR number 3' }, 'a/b'), []);
});

test('commitsFromIssue: hash-only lines, five at most, linked on GitHub', () => {
  const issue = { description: 'a62a2bb4\n205e63a5, 2026-10-24 b1b1b1b1\nnot a hash line a62a2bb4\nc2c2c2c2 d3d3d3d3 e4e4e4e4 f5f5f5f5' };
  const commits = commitsFromIssue(issue, 'someone/some_repo');
  assert.deepEqual(commits.map(row => row.sha), ['a62a2bb4', '205e63a5', 'b1b1b1b1', 'c2c2c2c2', 'd3d3d3d3']);
  assert.equal(commits[0].url, 'https://github.com/someone/some_repo/commit/a62a2bb4');
  assert.equal('url' in commitsFromIssue({ description: 'a62a2bb4' }, '')[0], false);
});

test('cardRefsOf: the string and array forms, Library links and section paths, junk refused', () => {
  assert.deepEqual(cardRefsOf({ metadata: { cards: 'agent-plans/2026-10-27_x, sprite-studio/sheet' } }), ['agent-plans/2026-10-27_x', 'sprite-studio/sheet']);
  assert.deepEqual(cardRefsOf({ metadata: { cards: ['a/b', 'a/b', 'c/d'] } }), ['a/b', 'c/d']);
  const text = 'See https://site.example/agent-plans#/hermes-plan and sections/magic-loops/2026-10-01_plan/report.md.';
  assert.deepEqual(cardRefsOf({ description: text }), ['agent-plans#hermes-plan', 'magic-loops/2026-10-01_plan']);
  assert.deepEqual(cardRefsOf({ metadata: { cards: ['Bad/Upper', 'no-slash', '../x/y', 'a/b/c', 'a/', 5] } }), []);
  assert.deepEqual(cardRefsOf({}), []);
});
