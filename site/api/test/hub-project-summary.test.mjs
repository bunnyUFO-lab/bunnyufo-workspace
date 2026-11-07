// The Projects list's one read: done of all, and the milestone in hand, for every project with a Beads copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { projectSummary } from '../hub-project-summary.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { beadsIssue, cujTwo, iso, jsonl, seeder } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();

test('a project counts every task and names the first milestone with open work', () => {
  const { issues } = cujTwo({ now: NOW });
  const summary = projectSummary({ project: 'magic-loops', issues, now: NOW });
  assert.deepEqual(summary, { id: 'magic-loops', done: 3, total: 9, now: 'Milestone 2 · Traversal' });
});

test('deferred work stays in the total and is never the milestone in hand', () => {
  const issues = [
    beadsIssue({ id: 'wa-m1', title: 'First', type: 'milestone' }),
    beadsIssue({ id: 'wa-m1t', title: 'Later thing', parent: 'wa-m1', status: 'deferred' }),
    beadsIssue({ id: 'wa-m2', title: 'Second', type: 'milestone', blocks: ['wa-m1'] }),
    beadsIssue({ id: 'wa-m2t', title: 'Real thing', parent: 'wa-m2' }),
  ];
  const summary = projectSummary({ project: 'workspace', issues, now: NOW });
  assert.equal(summary.total, 2);
  assert.equal(summary.now, 'Second');
  assert.equal(projectSummary({ project: 'workspace', issues: [], now: NOW }).now, null, 'A project with no work has no milestone.');
});

test('GET /hub/project-summary lists each project with a Beads copy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-summary-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await listenOnGoodPort(server, '127.0.0.1');
  try {
    const seed = seeder(fake);
    seed.put('beads/magic-loops.jsonl', jsonl(cujTwo({ now: NOW }).issues), 'application/x-ndjson');
    seed.put('beads/magic-loops.meta.json', { pushedAt: iso(NOW) });
    seed.put('beads/bunnylink.jsonl', jsonl([beadsIssue({ id: 'bl-aaaa', type: 'milestone', title: 'Only one' }), beadsIssue({ id: 'bl-bbbb', parent: 'bl-aaaa', status: 'closed', closed: iso(NOW) })]), 'application/x-ndjson');
    seed.put('beads/bunnylink.meta.json', { pushedAt: iso(NOW) });
    const answer = await fetch(`http://127.0.0.1:${server.address().port}/api/hub/project-summary`, { headers: { 'Remote-User': 'owner' } });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.deepEqual(Object.keys(body), ['projects', 'at']);
    const byId = Object.fromEntries(body.projects.map(row => [row.id, row]));
    assert.deepEqual(Object.keys(byId).sort(), ['bunnylink', 'magic-loops']);
    assert.deepEqual([byId['magic-loops'].done, byId['magic-loops'].total], [3, 9]);
    assert.deepEqual([byId.bunnylink.done, byId.bunnylink.total, byId.bunnylink.now], [1, 1, null]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fake.close();
  }
});
