import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from './ci-affected.mjs';

const uiTests = ['hub-ui.mjs', 'hub-work-ui.mjs', 'hub-work-sheet-ui.mjs', 'pin-ui.mjs', 'ui.mjs'];
const read = name => (name === 'pin-ui.mjs' ? 'checks the Pinboard widget' : '');
const run = files => classify(files, { uiTests, read });

test('cards, notes and the other workflows run nothing', () => {
  assert.deepEqual(run(['workspace/index.md', 'README.md', '.github/workflows/hub-events.yml']), { check: 'none', ui: 'none', fragments: [] });
});
test('docs run the docs tests only', () => {
  assert.deepEqual(run(['docs/updating.md', 'workspace/index.md']), { check: 'docs', ui: 'none', fragments: [] });
});
test('a UI test file runs by its exact file name', () => {
  assert.deepEqual(run(['server/test/hub-work-ui.mjs']), { check: 'all', ui: 'some', fragments: ['hub-work-ui.mjs'] });
});
test('a unit test and site code outside the service run no UI test', () => {
  assert.equal(run(['server/test/need-badges.test.mjs', 'site/card-api/cards.mjs', 'scripts/cards.mjs']).ui, 'none');
});
test('a component found in a test text runs that test; a hub file without a hit runs the hub tests', () => {
  assert.deepEqual(run(['src/components/Pinboard.tsx']).fragments, ['pin-ui.mjs']);
  assert.deepEqual(run(['src/hub/Delivery.tsx']).fragments, ['hub-ui.mjs', 'hub-work-sheet-ui.mjs', 'hub-work-ui.mjs']);
  assert.deepEqual(run(['site/api/hub-work.mjs']).fragments, ['hub-ui.mjs', 'hub-work-sheet-ui.mjs', 'hub-work-ui.mjs']);
});
test('anything shared or unknown runs every UI test', () => {
  for (const file of ['package.json', 'src/styles/base.css', 'src/App.tsx', 'src/components/Zzz.tsx', 'server/server.mjs', 'site/api/s3.mjs', 'server/test/ui.mjs', 'server/test/ui-timeouts.mjs', 'server/test/combobox.mjs', 'src/lib/route.ts', 'scripts/vite-workspace.mjs', '.github/workflows/ci.yml', 'weird/file.bin']) {
    assert.equal(run([file]).ui, 'all', file);
  }
});
test('one shared file wins over a narrow one', () => {
  assert.equal(run(['server/test/hub-work-ui.mjs', 'package.json']).ui, 'all');
});
