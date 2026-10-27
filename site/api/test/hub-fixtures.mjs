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
export function beadsIssue({ id, title, status = 'open', type = 'task', parent, blocks = [], labels = [], created = '2026-10-01T10:00:00Z', closed } = {}) {
  const dependencies = [];
  if (parent) dependencies.push({ issue_id: id, depends_on_id: parent, type: 'parent-child', created_at: created });
  for (const blocker of blocks) dependencies.push({ issue_id: id, depends_on_id: blocker, type: 'blocks', created_at: created });
  return {
    _type: 'issue', id, title: title ?? id, status, priority: 2, issue_type: type, labels: [...labels].sort(),
    created_at: created, updated_at: created, ...(closed ? { closed_at: closed } : {}), dependencies,
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

/** Put an object per call into fake S3 under sections/inbox/. */
export function seeder(fake, prefix = INBOX) {
  const put = (rel, body, type = 'application/json') => fake.seed(`${prefix}/${rel}`, typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body, null, 2)}\n`, type);
  return {
    put,
    ask(ask, { files = {}, extra = {} } = {}) {
      const folder = `asks/${ask.id}`;
      put(`${folder}/ask.json`, ask);
      for (const option of ask.options ?? []) if (option.image) put(`${folder}/${option.image}`, solidPng(160, 120, 0x60 + option.id.charCodeAt(0) % 8 * 16), 'image/png');
      for (const [name, body] of Object.entries(extra)) put(`${folder}/${name}`, body);
      for (const [name, body] of Object.entries(files)) put(`${folder}/${name}`, body);
    },
    request(request) { put(`requests/${request.id}/request.json`, request); },
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
