// A tab an agent added to a card that is not its own gets no card bridge (ws brief 2.5, "HTML risk"); every other card page keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeFor } from '../../src/lib/bridgeFor.ts';

test('the bridge names the card, unless the tab was added by an agent', () => {
  assert.deepEqual(bridgeFor({ workspace: 'one', id: 'hub', path: 'index.html' }), { workspace: 'one', id: 'hub' });
  assert.deepEqual(bridgeFor({ workspace: 'one', id: 'hub', agentTab: false }), { workspace: 'one', id: 'hub' });
  assert.equal(bridgeFor({ workspace: 'one', id: 'hub', agentTab: true }), undefined);
  assert.equal(bridgeFor(undefined), undefined);
});
