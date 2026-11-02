// The badges of Needs you (ws-qg1.7): which badge each item gets, the sub-type labels, and the colour tokens in both
// themes against the 4.5:1 contrast rule for text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { subBadge, typeBadge, canonicalFilter, isKnownFilter, splitFilter, SUBTYPE_LABEL, FILTER_SUBTYPES } from '../../src/lib/needsKinds.ts';
import { needsHref, parseNeedsRoute } from '../../src/lib/needsView.mjs';

const css = readFileSync(new URL('../../src/hub/badges.css', import.meta.url), 'utf8');
const tokens = block => Object.fromEntries([...block.matchAll(/--(nb-[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map(match => [match[1], match[2].toLowerCase()]));
const dark = tokens(/:root\s*\{([^}]*)\}/.exec(css)[1]);
const light = tokens(/html\[data-workspace-theme=light\]\s*\{([^}]*)\}/.exec(css)[1]);

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TYPES = ['approval-request', 'hermes-approval', 'hermes-asks', 'question', 'design', 'steps', 'playtest', 'pr', 'unstick'];
const SUBS = ['approval', 'verify', 'design', 'decision', 'setup', 'investigate', 'develop'];
// The surfaces a badge sits on: the card (--s1) and the page ground, per theme.
const SURFACES = { dark: ['#101113', '#0a0b0d'], light: ['#ffffff', '#f7f8fa'] };

test('every type badge pair and sub-type colour has 4.5:1 text contrast, in the light and the dark theme', () => {
  for (const [theme, set] of [['dark', dark], ['light', light]]) {
    for (const type of TYPES) {
      const bg = set[`nb-${type}-bg`], fg = set[`nb-${type}-fg`];
      assert.ok(bg && fg, `${theme}: ${type} has a pair`);
      assert.ok(contrast(bg, fg) >= 4.5, `${theme} ${type}: ${contrast(bg, fg).toFixed(2)}`);
    }
    for (const sub of SUBS) {
      const colour = set[`nb-sub-${sub}`];
      assert.ok(colour, `${theme}: ${sub} has a colour`);
      for (const surface of SURFACES[theme]) assert.ok(contrast(colour, surface) >= 4.5, `${theme} ${sub} on ${surface}: ${contrast(colour, surface).toFixed(2)}`);
    }
  }
});

test('the types are told apart: no two share a fill in a theme', () => {
  for (const set of [dark, light]) assert.equal(new Set(TYPES.map(type => set[`nb-${type}-bg`])).size, TYPES.length);
});

test('each item gets its own type badge; a request approval is not a Question', () => {
  const at = '2026-11-01T10:00:00Z';
  const badge = item => { const found = typeBadge({ id: 'x', title: 't', at, ...item }); return [found.type, found.label]; };
  assert.deepEqual(badge({ kind: 'approval' }), ['approval-request', 'Approval request']);
  assert.deepEqual(badge({ kind: 'request' }), ['approval-request', 'Approval request']);
  assert.deepEqual(badge({ kind: 'hermes-approval' }), ['hermes-approval', 'Hermes approval']);
  assert.deepEqual(badge({ kind: 'run-question' }), ['hermes-asks', 'Hermes asks']);
  assert.deepEqual(badge({ kind: 'ask' }), ['question', 'Question']);
  assert.deepEqual(badge({ kind: 'ask', design: true }), ['design', 'Design review']);
  assert.deepEqual(badge({ kind: 'checklist' }), ['steps', 'Steps']);
  assert.deepEqual(badge({ kind: 'checklist', playtest: true }), ['playtest', 'Playtest']);
  assert.deepEqual(badge({ kind: 'review' }), ['pr', 'PR review']);
  assert.deepEqual(badge({ kind: 'blocked', tool: 'claude-code', reason: 'permission' }), ['unstick', 'Claude permission']);
});

test('sub-type badges: four labels for a Question, four for Steps, none for the rest', () => {
  const at = '2026-11-01T10:00:00Z';
  const sub = item => { const found = subBadge({ id: 'x', title: 't', at, ...item }); return found && [found.group, found.sub, found.label, found.inferred]; };
  assert.deepEqual(['approval', 'verify', 'design', 'decision'].map(name => sub({ kind: 'ask', subtype: name })?.[2]), ['Approval', 'Verify', 'Design choice', 'Decision']);
  assert.deepEqual(['verify', 'setup', 'investigate', 'develop'].map(name => sub({ kind: 'checklist', subtype: name })?.[2]), ['Verify', 'Set up', 'Investigate', 'Develop']);
  assert.deepEqual(sub({ kind: 'ask', subtype: 'verify', kindInferred: true }), ['question', 'verify', 'Verify', true]);
  assert.equal(sub({ kind: 'ask' }), null, 'An older Hub sends no sub-type: no badge.');
  assert.equal(sub({ kind: 'checklist', playtest: true }), null);
  assert.equal(sub({ kind: 'review', subtype: 'verify' }), null);
  assert.equal(sub({ kind: 'approval', subtype: 'approval' }), null, 'A request approval is a type, not a Question sub-type.');
  assert.equal(sub({ kind: 'ask', design: true, subtype: 'design' }), null, 'A design review says so already.');
  assert.deepEqual(sub({ kind: 'ask', design: true, subtype: 'approval' }), ['question', 'approval', 'Approval', false]);
  assert.equal(sub({ kind: 'ask', subtype: 'nonsense' }), null);
});

test('the sub filter addresses: question:verify keeps its colon and the project composes with it', () => {
  assert.equal(needsHref('question:verify'), '#/~hub/needs/question:verify');
  assert.equal(needsHref('steps:setup', 'magic-loops'), '#/~hub/needs/steps:setup/magic-loops');
  assert.deepEqual(parseNeedsRoute('question:verify/magic-loops', isKnownFilter), { filter: 'question:verify', project: 'magic-loops', linked: '' });
  assert.deepEqual(parseNeedsRoute('question%3Averify', isKnownFilter), { filter: 'question:verify', project: '', linked: '' });
  assert.equal(canonicalFilter('question:verify'), 'question:verify');
  assert.equal(canonicalFilter('question:setup'), 'all', 'A sub-type of another kind is not a filter.');
  assert.equal(canonicalFilter('playtest:verify'), 'all');
  assert.deepEqual(splitFilter('steps:develop'), ['steps', 'develop']);
  assert.deepEqual(splitFilter('question'), ['question', '']);
  assert.deepEqual(Object.keys(FILTER_SUBTYPES), ['question', 'steps']);
  for (const [kind, subs] of Object.entries(FILTER_SUBTYPES)) for (const name of subs) assert.ok(SUBTYPE_LABEL[kind][name], `${kind}:${name} has a label`);
});
