// The Hub on a fixture service: fake S3 seeded through site/api/test/hub-fixtures.mjs, an optional
// fake Hermes, and the local service over both. The UI tests start it; run directly with --serve it
// prints the address and stays up, for screenshots and for a reviewer to look at.
//
//   node server/test/hub-fixture.mjs --serve [--no-hermes] [--checklists]
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';
import { startFakeS3 } from '../../site/api/test/fake-s3.mjs';
import { startFakeHermes } from '../../site/api/test/fake-hermes.mjs';
import { askJson, beadsIssue, checklistJson, cujTwo, eventJson, minutesAgo, pcStatusJson, agentConfigJson, seedAgentConfig, requestJson, seedPcStatus, seeder, teamSheet, plainOptions, threeOptions, workFixture } from '../../site/api/test/hub-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURE_ASK = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-jump-arc-a1b2`;

/** The two Asks `discordAsks` seeds: one answered from Discord, one that only a passkey may answer. */
export const DISCORD_ASK = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-ship-the-build-d1d1`;
export const PASSKEY_ASK = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-merge-the-stack-p2p2`;

/** The two checklists `checklists: true` seeds: an open one with one of four items ticked, and one the owner already submitted. */
export const FIXTURE_CHECKLIST = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-finish-the-discord-bot-setup-c1c1`;
export const SUBMITTED_CHECKLIST = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-update-the-router-settings-d2d2`;

/** The one checklist `commandChecklist: true` seeds: items with and without a `command`, and an inline `code` span in an item's text. */
export const COMMAND_CHECKLIST = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-add-the-deploy-secret-e3e3`;
export const COMMAND_ONE_LINE = 'gh secret set BUW_CARD_DEPLOY_TOKEN --repo example/workspace-skills';
export const COMMAND_LONG = 'ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/example_key admin@host.example.test "sudo systemctl restart bunnylink-example-service-with-a-long-name.service && journalctl -u bunnylink-example-service-with-a-long-name.service -n 50 --no-pager"';
export const COMMAND_MARKUP = 'echo "<b>bold</b> <img src=x onerror=alert(1)> *star* [link](https://example.test)"';
export const COMMAND_POWERSHELL = 'cd C:\\Users\\owner\\app\nnpm run check';

/** An Ask id for a test to seed: today's date, the probe project and a four-character tail. */
export const askId = (slug, tail) => `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-probe-${slug}-${tail}`;

const HOGS = [
  { name: 'node.exe', cmd: 'node scripts/probe-load.mjs --rounds 40', cores: 1.0, minutes: 22, orphan: true, ramMB: 310, action: 'reported' },
  { name: 'node.exe', cmd: 'node -e "while (1) {}"', cores: 1.0, minutes: 4, orphan: false, ramMB: 40, action: 'stopped' },
];

export async function startHubFixture({ hermes = false, hermesOptions = {}, seedData = true, discordAsks = false, checklists = false, commandChecklist = false, busyToday = false, secondSection = false, pc = false, agentConfig = false, oldSessions = false, heartbeat = false, work = false, workSide = false, workSearch = false, links = false, signing = false, chatRuns = false, sheets = false, env = {}, fetchImpl } = {}) {
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
  if (secondSection) {
    // A second, inactive section with one card, for tests of what spans sections.
    const other = path.join(base, 'two');
    await mkdir(path.join(other, 'zebra'), { recursive: true });
    await writeFile(path.join(other, 'zebra', 'index.md'), '# Zebra crossing\n\nA card in the second section.\n');
    await writeFile(path.join(other, 'workspace.json'), JSON.stringify({ entities: [{
      id: 'zebra', folder: 'zebra', title: 'Zebra crossing', description: 'A card.', category: 'test', created: today, updated: today, status: 'active',
      steps: [{ name: 'Notes', path: 'index.md' }],
    }] }, null, 2));
    await addWorkspace({ registryFile, path: other, name: 'Two', bucket: `s3://${fake.bucket}/sections/two` });
  }
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');

  const seed = seeder(fake);
  if (seedData) {
    // One open Ask with three pictures; a review and a blocked session: 3 need you. The one running session is the Beads task with a session started 5 minutes ago.
    seed.ask(askJson({ id: FIXTURE_ASK, bead: 'bd-7f3c', now: minutesAgo(now, 12), options: plainOptions().map((option, index) => ({ ...option, label: ['snappy', 'floatier', 'Celeste-ish'][index] })), context: 'The **wall-jump** can use one of three arcs.\n\n- A matches the current dash\n- C is closest to Celeste' }));
    seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(now, 30), bead: 'bd-7e19', title: 'PR ready for review: wall-jump', url: 'https://example.test/pr/41' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 20), session: 'sess-blocked', title: 'Permission needed: run unity test' }));
    seed.event(eventJson({ kind: 'deployed', ts: minutesAgo(now, 90), title: 'Deployed the WebGL preview', host: 'pc.example.test' }));
    const { issues, events } = cujTwo({ now });
    seed.beads('magic-loops', issues, { pushedAt: minutesAgo(now, 20).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/magic-loops' });
    for (const event of events) seed.event(event);
    // One merged PR on a closed task, 29 to 30 hours old: outside Today's 24-hour window, so its counts hold still.
    seed.event(eventJson({ kind: 'pr-opened', ts: minutesAgo(now, 30 * 60), project: 'magic-loops', bead: 'ml-wj-t1', url: 'https://example.test/pr/9', title: 'Detect wall contact: PR opened' }));
    seed.event(eventJson({ kind: 'pr-merged', ts: minutesAgo(now, 29 * 60), project: 'magic-loops', bead: 'ml-wj-t1', url: 'https://example.test/pr/9', title: 'Detect wall contact: PR merged' }));
    if (busyToday) {
      // Off by default, other tests count 3: two more blocked sessions (5 need you, Today shows 3) and one alert.
      seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 25), session: 'sess-blocked-2', title: 'Permission needed: run lint' }));
      seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 35), session: 'sess-blocked-3', title: 'Permission needed: run build' }));
      seed.event(eventJson({ kind: 'alert', ts: minutesAgo(now, 15), title: 'Nightly brief failed', summary: 'The upstream answered 529.' }));
    }
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
    // A project with a Wayfinder map issue: a destination, three decisions made and four questions open, shaped like a live map (a grilling and a research question that wait on nobody, two grilling questions that wait on them). Its own project, so magic-loops' counts hold.
    const wayfind = [
      beadsIssue({ id: 'wf-map', title: 'Wayfinder map', type: 'epic', labels: ['wayfinder:map'], created: '2026-10-01T09:00:00Z', updated: '2026-10-20T10:00:00Z', description: '## Destination\n\nA **tidy** Roadmap that tells the owner where to go next, and why, in one line.\n\n## Notes\n\nLater.' }),
      ...['one', 'two', 'three'].map((name, index) => beadsIssue({ id: `wf-d${index + 1}`, title: `Decision ${name}`, parent: 'wf-map', status: 'closed', closed: '2026-10-10T10:00:00Z', labels: ['wayfinder:decision'], created: `2026-10-02T1${index}:00:00Z` })),
      beadsIssue({ id: 'wf-q1', title: 'Which project comes first?', parent: 'wf-map', labels: ['wayfinder:grilling'], created: '2026-10-03T10:00:00Z', description: '## Question\n\nWhich project should the next sprint start with, and why?' }),
      beadsIssue({ id: 'wf-q2', title: 'Where does the chip go?', parent: 'wf-map', labels: ['wayfinder:research'], created: '2026-10-03T11:00:00Z', description: '## Question\n\nCheck where the other screens put their project chip.' }),
      beadsIssue({ id: 'wf-q3', title: 'Is the card text in or out?', parent: 'wf-map', labels: ['wayfinder:grilling'], blocks: ['wf-q1'], created: '2026-10-03T12:00:00Z' }),
      beadsIssue({ id: 'wf-q4', title: 'Which tuning items ship?', parent: 'wf-map', labels: ['wayfinder:grilling'], blocks: ['wf-q1', 'wf-q2'], created: '2026-10-03T13:00:00Z' }),
    ];
    seed.beads('wayfind', wayfind, { pushedAt: minutesAgo(now, 8).toISOString(), host: 'pc.example.test', count: wayfind.length, repo: 'example/wayfind' });
    seed.beads('nosprint', bare, { pushedAt: minutesAgo(now, 10).toISOString(), host: 'pc.example.test', count: bare.length, repo: 'example/nosprint' });
  }

  if (checklists) {
    // Off by default: one open list is one more in Needs you, and the other tests count 3.
    seed.checklist(checklistJson({ id: FIXTURE_CHECKLIST, now: minutesAgo(now, 40) }), [{ item: '01', at: minutesAgo(now, 25) }]);
    const submitted = checklistJson({
      id: SUBMITTED_CHECKLIST, now: minutesAgo(now, 180), title: 'Update the router settings', context: 'Two settings that only the router admin page can change.',
      items: [{ text: 'Reserve the address for the server', group: 'Router' }, { text: 'Turn off remote administration', group: 'Router', guide: 'Open **Administration** and switch it off.' }, { text: 'Reboot the router', group: 'After' }],
    });
    seed.checklist(submitted, [{ item: '01', at: minutesAgo(now, 150) }, { item: '02', at: minutesAgo(now, 140) }]);
    seed.submit(submitted.id, { at: minutesAgo(now, 5).toISOString(), note: 'Left the reboot for tonight.', done: ['01', '02'], open: ['03'] });
  }

  if (commandChecklist) {
    seed.checklist(checklistJson({
      id: COMMAND_CHECKLIST, now: minutesAgo(now, 20), title: 'Add the deploy secret', context: 'One secret, then a restart.',
      items: [
        { text: 'In Git Bash, with `gh` signed in, run this', command: COMMAND_ONE_LINE, shell: 'bash' },
        { text: 'Over SSH, restart the service (a long line)', command: COMMAND_LONG, shell: 'bash' },
        { text: 'In PowerShell, run the check (two lines)', command: COMMAND_POWERSHELL, shell: 'powershell' },
        { text: 'Tick this when it worked', guide: 'Nothing to run.' },
        { text: 'Markup in a command is only text', command: COMMAND_MARKUP, shell: 'bash' },
      ],
    }), []);
  }

  if (pc) {
    // Off by default. 'fresh': the PC reported a minute ago, with a busy and an idle session. 'stale': 40 minutes ago, so the PC counts as asleep or off.
    // 'low-memory': 2.5 of 24 GB available. 'no-memory': a status from an old reporter, with no memory field.
    // 'hogs': two busy processes, one reported and one stopped (made-up names and paths).
    seedPcStatus(fake, pcStatusJson({
      now, minutesOld: pc === 'stale' ? 40 : 1,
      extra: pc === 'low-memory' ? { memory: { totalGB: 24, availableGB: 2.5 } } : pc === 'no-memory' ? { memory: undefined } : pc === 'hogs' ? { hogs: HOGS } : {},
    }));
  }

  if (agentConfig) {
    // Off by default. The Hermes host's settings export, marked as the card API marks it. 'fresh': published 12 minutes ago, changed 2 days ago. 'stale': 9 hours ago.
    // The SOUL.md text holds a fake key (as if the host's cleaning had missed it) to show the site cleans it again.
    const soulText = ['## Role', 'You are the owner\'s assistant.', 'Always answer in plain words.', 'Key for tests: sk-ant-api03-FAKEFAKEFAKEFAKE1234567890', ''].join('\n');
    const model = (provider, name) => ({ provider, model: name });
    const modelOptions = { main: [model('openai-codex', 'gpt-6-sol'), model('anthropic', 'claude-sonnet-5-5'), model('anthropic', 'claude-haiku-5-5'), model('deepseek', 'deepseek-v4-pro'), model('deepseek', 'deepseek-flash')], briefs: [model('anthropic', 'claude-sonnet-5-5'), model('anthropic', 'claude-haiku-5-5'), model('deepseek', 'deepseek-v4-pro'), model('deepseek', 'deepseek-flash')] };
    seedAgentConfig(fake, agentConfigJson({ now, exportedMinutesAgo: agentConfig === 'stale' ? 9 * 60 : 12, soulText, modelOptions }));
  }

  if (oldSessions) {
    // Off by default. Four sessions that started 36 hours to 3 days ago and never ended, and one that started 20 minutes ago.
    for (const [session, hours] of [['old-bot', 36], ['old-sheet', 48], ['old-loops', 60], ['old-link', 72]]) seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(now, hours * 60), session, host: 'test-pc', title: `${session} session`, project: 'probe' }));
    seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(now, 20), session: 'live-one', host: 'cloud', title: 'Live cloud session', project: 'probe' }));
  }

  if (heartbeat) {
    // Off by default (`'without'` leaves out beat-one's heartbeat, for a before picture). Two sessions that started 3 hours ago on a host with no PC status: `beat-one` posted a heartbeat (a session-items event with
    // no `touched`) 4 minutes ago, `silent-one` never did. A third, `blocked-one`, is blocked and only a heartbeat followed.
    for (const session of ['beat-one', 'silent-one']) seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(now, 180), session, host: 'test-pc', title: `${session} session`, project: session.split('-')[0] }));
    if (heartbeat !== 'without') seed.event(eventJson({ kind: 'session-items', ts: minutesAgo(now, 4), session: 'beat-one', host: 'test-pc', title: 'beat: working', project: 'beat' }));
    seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(now, 150), session: 'blocked-one', host: 'test-pc', title: 'blocked-one session', project: 'blocked' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 140), session: 'blocked-one', host: 'test-pc', title: 'blocked: needs permission', project: 'blocked' }));
    seed.event(eventJson({ kind: 'session-items', ts: minutesAgo(now, 3), session: 'blocked-one', host: 'test-pc', title: 'blocked: working', project: 'blocked' }));
  }

  if (work) {
    // Off by default. Project `lanes` with a card in each of Work's six lanes (the cells of workFixture), twelve more in Backlog so it collapses,
    // a request, an open Ask on one task and a fresh PC session on another. The open Ask is one more in Needs you.
    const day = now.toISOString().slice(0, 10).replace(/-/g, '');
    const wf = workFixture({ now });
    const later = Array.from({ length: 12 }, (_, index) => beadsIssue({ id: `ws-later-${index + 1}`, title: `Backlog idea ${index + 1}`, status: 'deferred', created: `2026-10-02T10:${String(index).padStart(2, '0')}:00Z` }));
    const issues = [...wf.issues.map(({ project: _project, ...issue }) => issue), ...later];
    if (workSearch) {
      // Off by default; needs `work`. Text for the Work search: a rare word only in a description, a feature, a Wayfinder question with a label, and a bead closed long ago (no card on the board).
      issues.push(
        beadsIssue({ id: 'ws-rare', title: 'Tune the slide', description: 'The quokka handshake must settle before the next build.', updated: minutesAgo(now, 60).toISOString() }),
        beadsIssue({ id: 'ws-feat', title: 'Feel pass', type: 'feature', labels: ['area:feel'], updated: minutesAgo(now, 90).toISOString() }),
        beadsIssue({ id: 'ws-ques', title: 'Which feel wins?', type: 'task', labels: ['wayfinder:grilling'] }),
        beadsIssue({ id: 'ws-ancient', title: 'Ancient wall bug', status: 'closed', closed: minutesAgo(now, 60 * 24 * 40).toISOString(), description: 'Fixed the quokka drift on the wall.' }),
      );
    }
    seed.beads('lanes', issues, { pushedAt: minutesAgo(now, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/lanes' });
    for (const event of wf.events) seed.event({ ...event, project: 'lanes' });
    seed.ask(askJson({ id: `${day}-lanes-owner-call-e5e5`, bead: 'ws-ask', now: minutesAgo(now, 15), options: threeOptions() }));
    seed.request(requestJson({ id: `${day}-lanes-more-dust-f6f6`, project: 'lanes', text: 'Add dust to the wall-slide', now: minutesAgo(now, 25) }));
    seedPcStatus(fake, pcStatusJson({ now, minutesOld: 1, sessions: [
      { id: 'lane-sess', name: 'Lanes work', status: 'busy', kind: 'interactive', folder: 'probe-lanes', repo: 'probe', project: 'lanes', branch: 'sprint/ws-doing-lanes', startedAt: minutesAgo(now, 30).toISOString() },
    ] }));
  }

  if (workSide) {
    // Off by default; needs `work`. A second project with one open task, so the All board holds a card from a project that is not the default one.
    const side = [beadsIssue({ id: 'sd-one', title: 'Side quest', created: '2026-10-02T10:00:00Z' })];
    if (workSearch) side.push(beadsIssue({ id: 'sd-ancient', title: 'Side ancient', status: 'closed', closed: minutesAgo(now, 60 * 24 * 40).toISOString(), description: 'An old quokka story.' }));
    seed.beads('side', side, { pushedAt: minutesAgo(now, 6).toISOString(), host: 'pc.example.test', count: side.length, repo: 'example/side' });
  }

  if (links) {
    // Off by default; needs `work`. The PC reports two sessions: `lane-sess` told the Hub what it touched (three Beads items and a card, one of them
    // not on the board) and its branch names a fourth item; `old-sess` is a session from before the field (a title id the copy lacks, no chips).
    const owned = pcStatusJson({ now, minutesOld: 0, sessions: [
      { id: 'lane-sess', name: 'Lanes work', status: 'busy', kind: 'interactive', folder: 'probe-lanes', repo: 'probe', project: 'lanes', branch: 'sprint/ws-doing-lanes', startedAt: minutesAgo(now, 30).toISOString() },
      { id: 'old-sess', name: 'Older session about ws-nothere', status: 'idle', kind: 'interactive', folder: 'probe-old', repo: 'probe', project: 'lanes', branch: 'main', startedAt: minutesAgo(now, 90).toISOString() },
    ] });
    seedPcStatus(fake, owned);
    fake.seed('sections/one/workspace.json', JSON.stringify({ entities: [{ id: 'hub', folder: 'hub', title: 'The hub card', created: today, updated: today }] }), 'application/json');
    seed.event(eventJson({ kind: 'session-items', ts: minutesAgo(now, 2), project: 'lanes', session: 'lane-sess', title: 'lanes: session items', extra: {
      touched: { beads: [{ project: 'lanes', id: 'ws-pr' }, { project: 'lanes', id: 'ws-ready' }, { project: 'lanes', id: 'ws-gone' }], cards: [{ section: 'one', card: 'hub' }, { card: 'not-listed' }] },
    } }));
  }

  if (sheets) {
    // Off by default. One checked custom pet sheet for Claude Code (team/claude/), not chosen: the Custom tab lists it.
    const sheet = teamSheet('claude');
    for (const [name, body] of Object.entries(sheet.files)) seed.put(`team/claude/${name}`, body, name.endsWith('.png') ? 'image/png' : 'application/json');
  }

  const signingPair = signing ? generateKeyPairSync('ed25519') : null;
  const service = await createService({
    repo, uiDir: process.env.BUW_FIXTURE_DIST || path.join(root, 'dist'), registryFile,
    bucketOptions: { endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' },
    hubOptions: { env: {
      BUW_S3_BUCKET: '',
      // A throwaway Ed25519 key made for this run, so Approve can sign. Off by default: the service then only saves proposals.
      ...(signing ? { HUB_SIGNING_KEY: signingPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') } : {}),
      ...(upstream ? { HERMES_URL: upstream.url, HERMES_API_KEY: 'fixture-key', HUB_CHAT_RUNS: chatRuns ? '1' : '0' } : {}),
      // Cloud routines, the dry run and the like: a test sets them here, with a `fetchImpl` that stands in for the routine.
      ...env,
    }, ...(fetchImpl ? { fetchImpl } : {}) },
  });
  return {
    url: service.urls.workspace, origin: service.origin, dir, service, fake, hermes: upstream, seed, now, signingKey: signingPair?.privateKey ?? null,
    async close() { await service.close(); await upstream?.close(); await fake.close(); },
  };
}

if (process.argv.includes('--serve')) {
  const fixture = await startHubFixture({ hermes: !process.argv.includes('--no-hermes'), discordAsks: true, checklists: process.argv.includes('--checklists') });
  console.log(fixture.url);
  console.log(`Ask: ${fixture.origin}/#/~hub/ask/${FIXTURE_ASK}`);
  if (process.argv.includes('--checklists')) console.log(`Checklist: ${fixture.origin}/#/~hub/checklist/${FIXTURE_CHECKLIST}`);
  process.on('SIGINT', () => fixture.close().finally(() => process.exit(0)));
  setInterval(() => {}, 1 << 30);
}
