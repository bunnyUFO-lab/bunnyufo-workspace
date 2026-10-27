// The Hub on a fixture service: fake S3 seeded through site/api/test/hub-fixtures.mjs, an optional
// fake Hermes, and the local service over both. The UI tests start it; run directly with --serve it
// prints the address and stays up, for screenshots and for a reviewer to look at.
//
//   node server/test/hub-fixture.mjs --serve [--no-hermes]
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';
import { startFakeS3 } from '../../site/api/test/fake-s3.mjs';
import { startFakeHermes } from '../../site/api/test/fake-hermes.mjs';
import { askJson, beadsIssue, cujTwo, eventJson, minutesAgo, seeder, threeOptions } from '../../site/api/test/hub-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURE_ASK = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-jump-arc-a1b2`;

/** The two Asks `discordAsks` seeds: one answered from Discord, one that only a passkey may answer. */
export const DISCORD_ASK = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-ship-the-build-d1d1`;
export const PASSKEY_ASK = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-merge-the-stack-p2p2`;

/** An Ask id for a test to seed: today's date, the probe project and a four-character tail. */
export const askId = (slug, tail) => `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-${slug}-${tail}`;

export async function startHubFixture({ hermes = false, hermesOptions = {}, seedData = true, discordAsks = false } = {}) {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const base = await mkdtemp(path.join(root, '.cache', 'hub-fixture-'));
  const now = new Date();
  const fake = await startFakeS3();
  const upstream = hermes ? await startFakeHermes({ key: 'fixture-key', ...hermesOptions }) : null;

  // A workspace with a card whose id is `hub`: #/hub is a card, #/~hub/today is the Hub.
  const today = now.toISOString().slice(0, 10);
  const dir = path.join(base, 'one');
  await mkdir(path.join(dir, 'hub'), { recursive: true });
  await writeFile(path.join(dir, 'hub', 'index.md'), '# The hub card\n\nA card that happens to be called hub.\n');
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: [{
    id: 'hub', folder: 'hub', title: 'The hub card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active',
    steps: [{ name: 'Notes', path: 'index.md' }],
  }] }, null, 2));
  const repo = await mkdtemp(path.join(root, '.cache', 'hub-fixture-app-'));
  for (const folder of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, folder), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
  const registryFile = path.join(base, 'registry/workspaces.json');
  await mkdir(path.dirname(registryFile), { recursive: true });
  await addWorkspace({ registryFile, path: dir, name: 'One', bucket: `s3://${fake.bucket}/sections/one`, activate: true });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');

  const seed = seeder(fake);
  if (seedData) {
    // One open Ask with three pictures; a review and a blocked session: 3 need you. The one running session is the Beads task with a session started 5 minutes ago.
    seed.ask(askJson({ id: FIXTURE_ASK, bead: 'bd-7f3c', now: minutesAgo(now, 12), options: threeOptions().map((option, index) => ({ ...option, label: ['snappy', 'floatier', 'Celeste-ish'][index] })), context: 'The **wall-jump** can use one of three arcs.\n\n- A matches the current dash\n- C is closest to Celeste' }));
    seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(now, 30), bead: 'bd-7e19', title: 'PR ready for review: wall-jump', url: 'https://example.test/pr/41' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 20), session: 'sess-blocked', title: 'Permission needed: run unity test' }));
    seed.event(eventJson({ kind: 'deployed', ts: minutesAgo(now, 90), title: 'Deployed the WebGL preview', host: 'pc.example.test' }));
    const { issues, events } = cujTwo({ now });
    seed.beads('magic-loops', issues, { pushedAt: minutesAgo(now, 20).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/magic-loops' });
    for (const event of events) seed.event(event);
    // One merged PR on a closed task, 29 to 30 hours old: outside Today's 24-hour window, so its counts hold still.
    seed.event(eventJson({ kind: 'pr-opened', ts: minutesAgo(now, 30 * 60), project: 'magic-loops', bead: 'ml-wj-t1', url: 'https://example.test/pr/9', title: 'Detect wall contact: PR opened' }));
    seed.event(eventJson({ kind: 'pr-merged', ts: minutesAgo(now, 29 * 60), project: 'magic-loops', bead: 'ml-wj-t1', url: 'https://example.test/pr/9', title: 'Detect wall contact: PR merged' }));
    if (discordAsks) {
      // Made-up ids throughout. The first Ask was answered by a click in Discord; the second has no buttons there.
      const yesNo = [{ id: 'A', label: 'Ship it' }, { id: 'B', label: 'Hold off' }];
      seed.ask(askJson({ id: DISCORD_ASK, now: minutesAgo(now, 40), question: 'Ship the build to the preview?', options: yesNo, allowDrawing: false }), {
        files: { 'answer.json': { at: minutesAgo(now, 5).toISOString(), by: 'owner', via: 'discord', choice: 'A', rev: '0123456789abcdef', discord: { interaction: '200000000000000001', message: '300000000000000001' } } },
      });
      seed.ask({ ...askJson({ id: PASSKEY_ASK, now: minutesAgo(now, 8), question: 'Merge the stack once you are happy?', options: [{ id: 'A', label: 'Merge' }, { id: 'B', label: 'Not yet' }], allowDrawing: false }), requirePasskey: true });
    }
    // A Beads copy with no sprint:<name> labels at all, for the Sprints toggle's "none yet" note.
    const bare = [
      beadsIssue({ id: 'ns-m1', title: 'Only milestone', type: 'milestone', created: '2026-10-01T10:00:00Z' }),
      beadsIssue({ id: 'ns-t1', title: 'First task', parent: 'ns-m1', created: '2026-10-01T11:00:00Z' }),
      beadsIssue({ id: 'ns-t2', title: 'Second task', parent: 'ns-m1', created: '2026-10-01T12:00:00Z' }),
    ];
    seed.beads('nosprint', bare, { pushedAt: minutesAgo(now, 10).toISOString(), host: 'pc.example.test', count: bare.length, repo: 'example/nosprint' });
  }

  const service = await createService({
    repo, uiDir: process.env.BUW_FIXTURE_DIST || path.join(root, 'dist'), registryFile,
    bucketOptions: { endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' },
    hubOptions: { env: {
      BUW_S3_BUCKET: '',
      ...(upstream ? { HERMES_URL: upstream.url, HERMES_API_KEY: 'fixture-key', STT_URL: `${upstream.url}/v1/audio/transcriptions`, STT_API_KEY: 'fixture-key' } : {}),
    } },
  });
  return {
    url: service.urls.workspace, origin: service.origin, service, fake, hermes: upstream, seed, now,
    async close() { await service.close(); await upstream?.close(); await fake.close(); },
  };
}

if (process.argv.includes('--serve')) {
  const fixture = await startHubFixture({ hermes: !process.argv.includes('--no-hermes'), discordAsks: true });
  console.log(fixture.url);
  console.log(`Ask: ${fixture.origin}/#/~hub/ask/${FIXTURE_ASK}`);
  process.on('SIGINT', () => fixture.close().finally(() => process.exit(0)));
  setInterval(() => {}, 1 << 30);
}
