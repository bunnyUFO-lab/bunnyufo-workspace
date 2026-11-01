// Work's lanes: every cell of the lane table, groups left out, live sessions, and the route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { buildWork } from '../hub-work.mjs';
import { validStatus } from '../hub-pc.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { beadsIssue, eventJson, iso, jsonl, minutesAgo, pcStatusJson, requestJson, seedPcStatus, seeder, workFixture } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const laneOf = (work, key) => Object.entries(work.lanes).find(([, cards]) => cards.some(card => card.key === key))?.[0];
const card = (work, key) => Object.values(work.lanes).flat().find(item => item.key === key);

test('each Beads cell lands in its lane; groups and milestones are left out', () => {
  const work = buildWork({ ...workFixture({ now: NOW }), now: NOW });
  const expected = {
    'ws-defer': 'backlog', 'ws-ready': 'ready', 'ws-doing': 'running', 'ws-stuck': 'blocked', 'ws-wait': 'blocked',
    'ws-ask': 'blocked', 'ws-owner': 'blocked', 'ws-pr': 'review', 'ws-fresh': 'done', 'ws-child': 'ready',
  };
  for (const [id, lane] of Object.entries(expected)) assert.equal(laneOf(work, `bead:${id}`), lane, id);
  assert.equal(laneOf(work, 'bead:ws-grp'), undefined, 'A group has children: the map shows it.');
  assert.equal(laneOf(work, 'bead:ws-ms'), undefined, 'A milestone is left out.');
  assert.equal(laneOf(work, 'bead:ws-old'), undefined, 'Done keeps the last 14 days.');
  assert.equal(card(work, 'bead:ws-wait').why, 'blocked by ws-doing In progress');
  assert.equal(card(work, 'bead:ws-ask').why, 'needs you');
  assert.equal(card(work, 'bead:ws-owner').why, 'needs you');
  assert.deepEqual(card(work, 'bead:ws-pr').signs, ['pr']);
  assert.equal(card(work, 'bead:ws-pr').href, '#/~hub/map/ws/ws-pr');
  assert.equal(work.counts.blocked, 4);
  assert.equal(work.lanes.blocked.length, 4);
});

test('a blocker that is closed leaves the issue ready', () => {
  const work = buildWork({ issues: [beadsIssue({ id: 'a-1', status: 'closed', closed: iso(NOW) }), beadsIssue({ id: 'a-2', blocks: ['a-1'] })], now: NOW });
  assert.equal(laneOf(work, 'bead:a-2'), 'ready');
});

test('requests map by state; unknown states go to Backlog; declined and stopped are hidden', () => {
  const item = (id, state, extra = {}) => ({ kind: 'request', id, project: 'ws', title: `Request ${id}`, at: iso(NOW), state, ...extra });
  const work = buildWork({
    requests: [
      item('r-open', 'open'), item('r-prop', 'proposed'), item('r-appr', 'approved'), item('r-take', 'taken'), item('r-run', 'running'),
      item('r-lost', 'lost'), item('r-fail', 'failed'), item('r-pc', 'at-pc'), item('r-done', 'done'),
      item('r-dec', 'declined'), item('r-stop', 'stopped'), item('r-new', 'from-the-future'),
      item('r-pr', 'done', { bead: 'ws-pr' }), item('r-ask', 'asking'), item('r-exp', 'expired'), item('r-halt', 'stopping'),
    ],
    events: [eventJson({ kind: 'pr-opened', ts: minutesAgo(NOW, 5), bead: 'ws-pr' })], now: NOW,
  });
  const expected = {
    'r-open': 'backlog', 'r-prop': 'backlog', 'r-new': 'backlog', 'r-appr': 'ready', 'r-take': 'ready', 'r-run': 'running',
    'r-lost': 'blocked', 'r-fail': 'blocked', 'r-pc': 'blocked', 'r-done': 'done', 'r-pr': 'review',
    'r-ask': 'blocked', 'r-exp': 'blocked', 'r-halt': 'running',
  };
  for (const [id, lane] of Object.entries(expected)) assert.equal(laneOf(work, `request:${id}`), lane, id);
  assert.equal(laneOf(work, 'request:r-dec'), undefined);
  assert.equal(laneOf(work, 'request:r-stop'), undefined);
  assert.equal(card(work, 'request:r-open').state, 'proposed');
  assert.equal(card(work, 'request:r-lost').why, 'lost: no word from the run for 20 minutes');
  assert.equal(card(work, 'request:r-open').href, '#/~hub/request/r-open');
  assert.equal(card(work, 'request:r-ask').why, 'asked you a question');
  assert.equal(card(work, 'request:r-exp').why, 'the approval ran out');
  assert.equal(card(work, 'request:r-halt').why, 'stopping');
});

test('an approved cloud request that waits says what it waits on: the usage pause, or the daily limit', () => {
  const item = (id, cloud) => ({ kind: 'request', id, project: 'ws', title: `Request ${id}`, at: iso(NOW), state: 'approved', ...(cloud ? { cloud } : {}) });
  const work = buildWork({
    requests: [item('c-pause', { status: 'waiting', reason: 'usage-limit' }), item('c-cap', { status: 'waiting', reason: 'daily-cap' }), item('c-fired', { status: 'fired' }), item('c-plain')],
    now: NOW,
  });
  assert.equal(card(work, 'request:c-pause').why, 'waiting on the cloud usage pause');
  assert.equal(card(work, 'request:c-cap').why, 'waiting: the daily cloud limit is used');
  assert.equal(card(work, 'request:c-fired').why, undefined);
  assert.equal(card(work, 'request:c-plain').why, undefined);
});

test('a task that inherited the milestone label is a task; the milestone itself stays out', () => {
  const work = buildWork({
    issues: [
      beadsIssue({ id: 'ws-mile', type: 'milestone', labels: ['milestone'] }),
      beadsIssue({ id: 'ws-kid1', parent: 'ws-mile', labels: ['milestone'] }),
      beadsIssue({ id: 'ws-kid2', parent: 'ws-mile', labels: ['milestone'], status: 'closed', closed: iso(NOW) }),
    ].map(issue => ({ ...issue, project: 'ws' })), now: NOW,
  });
  assert.equal(laneOf(work, 'bead:ws-kid1'), 'ready');
  assert.equal(laneOf(work, 'bead:ws-kid2'), 'done');
  assert.equal(laneOf(work, 'bead:ws-mile'), undefined);
});

test('Hermes runs map as the table says', () => {
  const work = buildWork({
    hermesRuns: [
      { id: 'h1', state: 'running', title: 'Digest', updatedAt: iso(NOW) },
      { id: 'h2', state: 'waiting', title: 'Wants a go', updatedAt: iso(NOW) },
      { id: 'h3', state: 'completed', title: 'Done run', updatedAt: iso(NOW) },
      { id: 'h4', state: 'completed', title: 'Old run', updatedAt: iso(minutesAgo(NOW, 60 * 24 * 20)) },
      { id: 'h5', state: 'mystery', updatedAt: iso(NOW) },
    ], now: NOW,
  });
  assert.equal(laneOf(work, 'run:h1'), 'running');
  assert.equal(laneOf(work, 'run:h2'), 'blocked');
  assert.equal(card(work, 'run:h2').why, 'needs you');
  assert.equal(laneOf(work, 'run:h3'), 'done');
  assert.equal(laneOf(work, 'run:h4'), undefined);
  assert.equal(laneOf(work, 'run:h5'), undefined);
});

test('a session on a branch that names a bead marks it live; a stale status marks nothing', () => {
  const issues = [beadsIssue({ id: 'ws-abcd', status: 'in_progress' }), beadsIssue({ id: 'ws-zzzz', status: 'in_progress' })].map(issue => ({ ...issue, project: 'ws' }));
  const sessions = [{ id: 's1', name: 'x', status: 'busy', kind: 'interactive', folder: 'f', repo: 'r', branch: 'sprint/ws-abcd-x' }];
  const fresh = validStatus(pcStatusJson({ now: NOW, sessions }));
  const work = buildWork({ issues, status: fresh, now: NOW });
  assert.deepEqual(card(work, 'bead:ws-abcd').live, { host: 'test-pc', session: 's1', state: 'working' });
  assert.equal(card(work, 'bead:ws-zzzz').live, undefined);
  const stale = validStatus(pcStatusJson({ now: NOW, minutesOld: 30, sessions }));
  assert.equal(card(buildWork({ issues, status: stale, now: NOW }), 'bead:ws-abcd').live, undefined);
});

test('Backlog keeps 50 and counts the rest; Done keeps the newest 30', () => {
  const issues = [
    ...Array.from({ length: 60 }, (_, index) => beadsIssue({ id: `ws-b${index}`, status: 'deferred' })),
    ...Array.from({ length: 40 }, (_, index) => beadsIssue({ id: `ws-d${index}`, status: 'closed', closed: iso(minutesAgo(NOW, index + 1)) })),
  ];
  const work = buildWork({ issues, now: NOW });
  assert.equal(work.lanes.backlog.length, 50);
  assert.equal(work.counts.backlog, 60);
  assert.equal(work.lanes.done.length, 30);
  assert.equal(work.lanes.done[0].id, 'ws-d0', 'Newest first.');
});

test('GET /hub/work reads every project with a Beads copy, or one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-work-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await listenOnGoodPort(server, '127.0.0.1');
  const get = async route => { const answer = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  try {
    const seed = seeder(fake);
    seed.put('beads/magic-loops.jsonl', jsonl([beadsIssue({ id: 'ml-abcd', status: 'in_progress' })]), 'application/x-ndjson');
    seed.put('beads/magic-loops.meta.json', { pushedAt: iso(NOW) });
    seed.put('beads/bunnylink.jsonl', jsonl([beadsIssue({ id: 'bl-abcd' })]), 'application/x-ndjson');
    seed.put('beads/bunnylink.meta.json', { pushedAt: iso(NOW) });
    seed.request(requestJson({ id: '20261029-bunnylink-add-x-aaaa', project: 'bunnylink', now: NOW }));
    seed.request(requestJson({ id: '20261029-magic-loops-add-y-bbbb', project: 'magic-loops', now: NOW }));
    seedPcStatus(fake, pcStatusJson({ now: NOW, sessions: [{ id: 'pc1', name: 'x', status: 'idle', kind: 'interactive', folder: 'f', repo: 'r', branch: 'sprint/ml-abcd-x' }] }));

    const all = (await get('/hub/work')).body;
    assert.deepEqual(Object.keys(all), ['lanes', 'counts', 'at']);
    assert.deepEqual(all.lanes.running.map(item => item.key), ['bead:ml-abcd']);
    assert.equal(all.lanes.running[0].live.state, 'idle');
    assert.equal(all.lanes.ready.some(item => item.key === 'bead:bl-abcd'), true);
    assert.equal(all.counts.backlog, 2, 'Both requests are proposed.');

    const one = (await get('/hub/work?project=bunnylink')).body;
    assert.deepEqual(one.lanes.running, []);
    assert.deepEqual(one.lanes.backlog.map(item => item.project), ['bunnylink']);
    assert.equal((await get('/hub/work?project=Bad_Id')).status, 404);
    assert.equal((await get('/hub/work?project=probe')).body.counts.ready, 0);
  } finally { server.close(); await fake.close(); }
});
