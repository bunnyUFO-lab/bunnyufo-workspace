// Builders for the Hub's tests and for the UI fixture service: Asks, requests, events and Beads
// lines, plus a seeder that puts them into the stand-in S3. Nothing here is real data; hosts are
// example.test and projects are made up.
import { solidPng } from './png.mjs';

export const iso = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const minutesAgo = (now, minutes) => new Date(now.getTime() - minutes * 60000);
export const INBOX = 'sections/inbox';

export function askJson({ id, project = 'probe', bead, now = new Date(), expiresInDays = 7, question = 'Which jump arc feels right?', options, allowNote = true, allowDrawing = true, context = 'Pick the arc that reads best.', tool = 'claude-code' } = {}) {
  return {
    id, project, ...(bead ? { bead } : {}),
    createdAt: iso(now), expiresAt: iso(new Date(now.getTime() + expiresInDays * 86400000)),
    from: { session: 'sess-ask', host: 'pc.example.test', tool },
    question, context,
    ...(options ? { options } : {}),
    allowNote, allowDrawing,
  };
}

/** The four steps the UI tests and screenshots use: two groups, the second step with a guide that holds a fenced command and a link. */
export const checklistItems = () => [
  { text: 'Create the application', group: 'Discord developer portal', link: 'https://example.test/discord/applications' },
  {
    text: 'Copy the bot token into the vault', group: 'Discord developer portal',
    guide: 'Open **Bot** in the left menu, press *Reset Token* and copy it.\n\nThen store it on the server:\n\n```bash\nssh root@host.example.test\nbunnylink-secret set discord-bot-token\n```\n\nDo not paste the token anywhere else. More in [the portal guide](https://example.test/discord/guide).',
    link: 'https://example.test/discord/bot',
  },
  { text: 'Invite the bot to your server', group: 'Your server' },
  { text: 'Allow direct messages from server members', group: 'Your server', guide: 'In *Privacy Settings* of the server, switch on **Direct Messages**.' },
];

/** A checklist.json as `cards checklist create` writes it. */
export function checklistJson({ id, project = 'probe', bead, now = new Date(), title = 'Finish the Discord bot setup', context = 'The bot needs **four** steps that only you can do.', card, items = checklistItems(), tool = 'claude-code' } = {}) {
  return {
    id, project, createdAt: now.toISOString(), from: { host: 'pc.example.test', tool, session: 'sess-checklist' },
    ...(bead ? { bead } : {}), title, ...(context ? { context } : {}), ...(card ? { card } : {}),
    items: items.map((item, index) => ({ id: String(index + 1).padStart(2, '0'), ...item })),
  };
}

/** A design review: one picture and three decisions (the second has a detail line). */
export const threeDecisions = () => [
  { id: 'd1', text: 'Frame: warm oak, not dark walnut' },
  { id: 'd2', text: 'Stack counter in the top-right corner', detail: 'Matches the Wood board' },
  { id: 'd3', text: 'Drop the gold corner studs' },
];
export function designAskJson({ decisions = threeDecisions(), image = 'card-wood-v2.png', question = 'Review the wood card frame', ...rest } = {}) {
  return { ...askJson({ question, context: 'The new frame, one picture.', ...rest }), image, decisions };
}

/** Three options with no pictures: a plain Question. With pictures (`threeOptions`) the Ask is a design review. */
export const plainOptions = () => ['a', 'b', 'c'].map(letter => ({ id: letter.toUpperCase(), label: `Option ${letter.toUpperCase()}` }));
export const threeOptions = () => ['a', 'b', 'c'].map(letter => ({ id: letter.toUpperCase(), label: `Option ${letter.toUpperCase()}`, image: `${letter}.png` }));

export function requestJson({ id, project = 'probe', text = 'Add a wall-jump tutorial', when = 'next-sprint', by = 'owner', now = new Date() } = {}) {
  return { id, project, createdAt: iso(now), by, text, when };
}

let counter = 0;
export function eventJson({ kind, ts = new Date(), project = 'probe', bead, session, host = 'pc.example.test', title, url, appUrl, summary, ask, source = 'test', card, review, extra = {} } = {}) {
  counter += 1;
  return {
    ts: iso(ts), kind, project, ...(bead ? { bead } : {}), ...(ask ? { ask } : {}), ...(session ? { session } : {}),
    host, source, title: title ?? `${kind} ${counter}`, ...(url ? { url } : {}), ...(appUrl ? { appUrl } : {}), ...(card ? { card } : {}), ...(review ? { review } : {}), ...(summary ? { summary } : {}), ...extra,
  };
}

/** One Beads 1.3.2 export line. `parent` and `blocks` become the dependencies the export holds. */
export function beadsIssue({ id, title, status = 'open', type = 'task', parent, blocks = [], labels = [], created = '2026-10-01T10:00:00Z', closed, description, updated } = {}) {
  const dependencies = [];
  if (parent) dependencies.push({ issue_id: id, depends_on_id: parent, type: 'parent-child', created_at: created });
  for (const blocker of blocks) dependencies.push({ issue_id: id, depends_on_id: blocker, type: 'blocks', created_at: created });
  return {
    _type: 'issue', id, title: title ?? id, status, priority: 2, issue_type: type, labels: [...labels].sort(),
    created_at: created, updated_at: updated ?? created, ...(description ? { description } : {}), ...(closed ? { closed_at: closed } : {}), dependencies,
  };
}

export const jsonl = lines => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;

/**
 * The CUJ 2 project: three milestones, Milestone 2 with the feature "Wall-jump" of seven tasks,
 * four of them labelled `sprint:sprint-3`. Task wj-t3 has a session running and wj-t5 an open PR.
 * Returns the issues and the events that go with them.
 */
export function cujTwo({ now = new Date(), prefix = 'ml' } = {}) {
  const id = name => `${prefix}-${name}`;
  const issues = [
    beadsIssue({ id: id('m1'), title: 'Milestone 1 · Core loop', type: 'milestone', status: 'closed', closed: '2026-10-10T10:00:00Z', created: '2026-10-01T10:00:00Z' }),
    beadsIssue({ id: id('m1f1'), title: 'Movement', type: 'epic', parent: id('m1'), status: 'closed', closed: '2026-10-09T10:00:00Z', created: '2026-10-01T11:00:00Z' }),
    beadsIssue({ id: id('m1t1'), title: 'Run and jump', parent: id('m1f1'), status: 'closed', closed: '2026-10-08T10:00:00Z', created: '2026-10-01T12:00:00Z' }),
    beadsIssue({ id: id('m2'), title: 'Milestone 2 · Traversal', type: 'milestone', blocks: [id('m1')], created: '2026-10-02T10:00:00Z' }),
    beadsIssue({ id: id('wj'), title: 'Wall-jump', type: 'epic', parent: id('m2'), created: '2026-10-02T11:00:00Z' }),
    ...[
      ['t1', 'Detect wall contact', 'closed'], ['t2', 'Wall slide', 'closed'], ['t3', 'Kick-off impulse', 'in_progress'],
      ['t4', 'Coyote time on walls', 'open'], ['t5', 'Wall-jump animation', 'in_progress'], ['t6', 'Particles', 'open'], ['t7', 'Tuning pass', 'open'],
    ].map(([key, title, status], index) => beadsIssue({
      id: id(`wj-${key}`), title, status, parent: id('wj'), created: `2026-10-02T12:0${index}:00Z`,
      ...(status === 'closed' ? { closed: '2026-10-05T10:00:00Z' } : {}),
      labels: index >= 2 && index <= 5 ? ['sprint:sprint-3'] : [],
      blocks: index >= 5 ? [id(`wj-t${index}`)] : [],
    })),
    beadsIssue({ id: id('m3'), title: 'Milestone 3 · Levels', type: 'milestone', blocks: [id('m2')], created: '2026-10-03T10:00:00Z' }),
    beadsIssue({ id: id('m3f1'), title: 'Tutorial level', type: 'epic', parent: id('m3'), created: '2026-10-03T11:00:00Z' }),
    beadsIssue({ id: id('m3t1'), title: 'Block out the level', parent: id('m3f1'), created: '2026-10-03T12:00:00Z' }),
  ];
  const events = [
    eventJson({ kind: 'session-started', ts: minutesAgo(now, 5), project: 'magic-loops', bead: id('wj-t3'), session: 'sess-wj', title: 'Kick-off impulse: session started' }),
    eventJson({ kind: 'pr-opened', ts: minutesAgo(now, 30), project: 'magic-loops', bead: id('wj-t5'), url: 'https://example.test/pr/12', title: 'Wall-jump animation: PR opened' }),
  ];
  return { issues, events };
}

/** A playtest checklist.json: a build link, the platform, what to look for, and the steps to try. */
export function playtestJson({ build = 'https://example.test/build/web', platform = 'web', lookFor = 'Any moment where it gets hard all at once.', title = 'Play the wall-jump build', items = [{ text: 'Reach the first ledge' }, { text: 'Chain three wall-jumps' }, { text: 'Beat the tutorial' }], ...rest } = {}) {
  return { ...checklistJson({ title, items, context: 'Ten minutes is enough.', ...rest }), kind: 'playtest', build, platform, lookFor };
}

/** Put an object per call into fake S3 under sections/inbox/. */
export function seeder(fake, prefix = INBOX) {
  const put = (rel, body, type = 'application/json', metadata = {}) => fake.seed(`${prefix}/${rel}`, typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body, null, 2)}\n`, type, metadata);
  return {
    put,
    ask(ask, { files = {}, extra = {} } = {}) {
      const folder = `asks/${ask.id}`;
      put(`${folder}/ask.json`, ask);
      if (typeof ask.image === 'string') put(`${folder}/${ask.image}`, solidPng(320, 240, 0x90), 'image/png');
      for (const option of ask.options ?? []) if (option.image) put(`${folder}/${option.image}`, solidPng(160, 120, 0x60 + option.id.charCodeAt(0) % 8 * 16), 'image/png');
      for (const [name, body] of Object.entries(extra)) put(`${folder}/${name}`, body);
      for (const [name, body] of Object.entries(files)) put(`${folder}/${name}`, body);
    },
    /** A checklist and its marks: `marks` is [{ item, done = true, at = Date, rand = 'a1b2' }], written the way the Hub names them. */
    checklist(list, marks = []) {
      const folder = `checklists/${list.id}`;
      put(`${folder}/checklist.json`, list);
      for (const { item, done = true, at = new Date(), rand = 'a1b2' } of marks) {
        put(`${folder}/${done ? 'tick' : 'untick'}-${item}-${at.toISOString().replace(/[-:.]/g, '')}-${rand}.json`, { item, done, at: at.toISOString(), by: 'owner' });
      }
    },
    submit(id, body = {}) { put(`checklists/${id}/submit.json`, { at: new Date().toISOString(), by: 'owner', done: [], open: [], ...body }); },
    /** `writer` is the user metadata the writer's token leaves on request.json: `site`, `agent` or `runner`. */
    request(request, { writer } = {}) { put(`requests/${request.id}/request.json`, request, 'application/json', writer ? { writer } : {}); },
    event(event, at = new Date(event.ts)) {
      const day = at.toISOString().slice(0, 10);
      counter += 1;
      const file = `${at.toISOString().slice(11, 19).replace(/:/g, '')}-pc-${String(counter).padStart(6, '0')}.json`;
      put(`events/${day}/${file}`, event);
      return file;
    },
    beads(project, issues, meta) {
      put(`beads/${project}.jsonl`, jsonl(issues), 'application/x-ndjson');
      put(`beads/${project}.meta.json`, meta);
    },
  };
}

/** One PC status file (v1), the way the report script writes it. Host `test-pc`, no real paths. */
export function pcStatusJson({ now = new Date(), minutesOld = 0, host = 'test-pc', sessions, inUse = true, extra = {} } = {}) {
  const at = minutesAgo(now, minutesOld);
  return {
    v: 1, host, at: at.toISOString(), reason: 'change', inUse, keepAwake: true,
    gpu: { util: 7, memMB: 3971, memTotalMB: 24564, band: 'idle' },
    comfy: { up: true, running: 0, pending: 0 },
    unity: { open: true, projects: ['probe'] },
    sessions: sessions ?? [
      { id: 'pc-sess-a', name: 'Wall-jump tutorial', status: 'busy', kind: 'interactive', folder: 'probe-work', repo: 'probe', project: 'magic-loops', branch: 'sprint/ml-wj-t2-wall-jump', startedAt: minutesAgo(now, minutesOld + 40).toISOString(), updatedAt: at.toISOString() },
      { id: 'pc-sess-b', name: 'Hub polish', status: 'idle', kind: 'interactive', folder: 'probe-hub', repo: 'probe', project: 'workspace-app', branch: 'main', startedAt: minutesAgo(now, minutesOld + 90).toISOString() },
    ],
    runs: [],
    ...extra,
  };
}

/** Put a status file into fake S3 under `<prefix>/pc/status-<stamp>.json` (the stamp is its `at`). */
export function seedPcStatus(fake, status, prefix = INBOX) {
  const stamp = new Date(status.at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  fake.seed(`${prefix}/pc/status-${stamp}.json`, `${JSON.stringify(status)}\n`, 'application/json');
  return `pc/status-${stamp}.json`;
}

/**
 * Beads issues for Work's lanes, one per table cell, in project `ws` (prefix `ws`): returns the
 * issues, the events and the open Ask that put some of them in Review and Blocked.
 */
export function workFixture({ now = new Date() } = {}) {
  const recent = minutesAgo(now, 30);
  const issues = [
    beadsIssue({ id: 'ws-grp', title: 'A feature group', type: 'epic' }),
    beadsIssue({ id: 'ws-child', title: 'Child of the group', parent: 'ws-grp' }),
    beadsIssue({ id: 'ws-ms', title: 'A milestone', type: 'milestone' }),
    beadsIssue({ id: 'ws-defer', title: 'Later idea', status: 'deferred' }),
    beadsIssue({ id: 'ws-ready', title: 'Ready to start' }),
    beadsIssue({ id: 'ws-doing', title: 'In progress', status: 'in_progress' }),
    beadsIssue({ id: 'ws-stuck', title: 'Marked blocked', status: 'blocked' }),
    beadsIssue({ id: 'ws-wait', title: 'Waits on another', blocks: ['ws-doing'] }),
    beadsIssue({ id: 'ws-ask', title: 'Has an Ask' }),
    beadsIssue({ id: 'ws-owner', title: 'Owner step', labels: ['needs-owner'] }),
    beadsIssue({ id: 'ws-pr', title: 'Has a PR', status: 'in_progress' }),
    beadsIssue({ id: 'ws-fresh', title: 'Closed today', status: 'closed', closed: iso(recent) }),
    beadsIssue({ id: 'ws-old', title: 'Closed long ago', status: 'closed', closed: iso(minutesAgo(now, 60 * 24 * 30)) }),
  ];
  const events = [eventJson({ kind: 'pr-opened', ts: recent, project: 'ws', bead: 'ws-pr', url: 'https://example.test/pr/1' })];
  const asks = [{ id: 'ask-1', bead: 'ws-ask', state: 'open' }];
  return { issues: issues.map(issue => ({ ...issue, project: 'ws' })), events, asks };
}

/** One worktree's Beads copy as the client writes it: `{ meta, text }` for `beads/<project>/<copy>.{meta.json,jsonl}`. */
export function beadsCopy({ issues, pushedAt, host = 'test-pc', worktree = 'wt-a', main = false, root = `C:/work/${worktree}`, branch = 'main' } = {}) {
  return {
    meta: { v: 2, pushedAt, host, count: issues.length, repo: 'example/ml', worktree, main, root, branch },
    text: jsonl(issues),
  };
}

/** An avatar choice file the way the Hub writes it. */
export function teamAvatarJson({ now = new Date(), kind = 'builtin', key = 'developer', salt = 3, by = 'owner' } = {}) {
  return { kind, ...(kind === 'random' ? { salt } : { key }), at: now.toISOString(), by };
}
