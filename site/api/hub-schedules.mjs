// One page of everything that runs on a schedule (ws-eh2). Pure: no S3, no clock of its own. `hub.mjs` finds the newest settings export
// of the Hermes host and calls in.
//
// The Hermes host's jobs and timers come from the export it publishes; the site host's timers, the PC's tasks and GitHub's schedules come from
// their own data (`hub-other-schedules.mjs` reads that) and say "not reporting" while it is missing. Nothing on this page
// is a name from the owner's machines: every label and name comes from data, so this file holds none. View only: nothing here changes a job.
import { exportFreshness, PROFILES } from './hub-agent-config.mjs';
import { jobChangeView, promptEditable, promptProblem } from './hub-job-change.mjs';

/** Which copy of a job is real. Shown at the top of the page. */
export const COPY_NOTE = 'These are the jobs the Hermes host runs now. The setup script in the homelab repo only adds a job that is missing, so changing it does not change a job that already exists.';
/** What a list says while its data has not arrived. */
export const NOT_REPORTING = 'Not reporting yet. This list arrives with a later update.';
/** What the timers list says when the host reports jobs but not its timers (an exporter that is older than the page). */
export const NO_TIMERS = 'The Hermes host does not list its timers yet.';
export const NO_EXPORT = 'The Hermes host has not published its settings yet.';

/** The PC refreshes its task list about hourly and the site host writes about every 15 minutes: a list this much older than that is marked old. */
export const PC_LIST_FRESH_MS = 3 * 60 * 60 * 1000;
export const HOST_FILE_FRESH_MS = 60 * 60 * 1000;
export const GITHUB_NOTE = "GitHub's list comes through the PC, so it is as old as the PC's last report.";

const lateEmpty = (id, label, text = NOT_REPORTING) => ({ id, label, state: 'not-reporting', as_of: null, items: [], text });
/** A list from another source: `live` while its time is recent, `old` past `freshMs`. */
const listed = (at, asOf, freshMs) => (at.getTime() - new Date(asOf).getTime() > freshMs ? 'old' : 'live');

/** The site host's timers: from its file, or the empty state. */
function siteTimers(hostFile, at) {
  if (!hostFile) return lateEmpty('site-timers', 'Site host timers');
  const { exportedAt, hostLabel, timers } = hostFile;
  return { id: 'site-timers', label: 'Site host timers', state: listed(at, exportedAt, HOST_FILE_FRESH_MS), as_of: exportedAt, host: hostLabel, items: timers, ...(timers.length ? {} : { text: 'The host lists no timer.' }) };
}

/** The PC's tasks and GitHub's schedules: two halves of the `schedules` field of the newest PC status. `total` is all the PC's non-OS tasks. */
function pcSources(status, at) {
  const part = status?.schedules;
  const tasks = part?.tasks
    ? { id: 'pc-tasks', label: 'PC tasks', state: listed(at, part.tasks.at, PC_LIST_FRESH_MS), as_of: part.tasks.at, host: 'PC', total: part.tasks.total, items: part.tasks.rows, ...(part.tasks.rows.length ? {} : { text: 'The PC lists no task.' }) }
    : lateEmpty('pc-tasks', 'PC tasks');
  const github = part?.github
    ? { id: 'github', label: 'GitHub Actions', state: listed(at, part.github.at, PC_LIST_FRESH_MS), as_of: part.github.at, host: 'PC', note: GITHUB_NOTE, items: part.github.rows, ...(part.github.rows.length ? {} : { text: 'The PC lists no GitHub schedule.' }) }
    : { ...lateEmpty('github', 'GitHub Actions'), note: GITHUB_NOTE };
  return [tasks, github];
}

/**
 * `{ sources, note, at }`
 * - `exported`: `validExport(...)` or null; `status`: `validStatus(...)` (the PC's) or null; `hostFile`: `cleanHostSchedules(...)` or null; `at`: a Date.
 *   A missing status, file or key is an empty list that says so, never an error.
 * - `sources`: `[{ id, label, state, as_of, items, text? }]`, in page order. `state` is `live`, `old` (the export is past the freshness rule of
 *   `exportFreshness`) or `not-reporting`. `as_of` is the ISO time the data is from, or null. `text` says why a list is empty; `note` is a line that belongs under the heading.
 *   The Hermes sources also carry `host` (the host's own label) and, for jobs, `timezone` (the zone the cron text runs in) and `profileModels` (the model a job follows when it pins none).
 * - a job item is the exporter's job with its `profile`; fields the exporter did not send are absent, not blank.
 */
export function schedulesView({ exported, status = null, hostFile = null, at, changes = [], signedIn = false }) {
  const state = exported ? (exportFreshness(exported, at) === 'fresh' ? 'live' : 'old') : 'not-reporting';
  const host = exported?.hostLabel ?? 'Hermes host';
  const profiles = exported ? PROFILES.filter(name => Array.isArray(exported.profiles[name]?.cron)) : [];
  const edits = exported ? editsOf({ exported, state, signedIn }) : null;
  const jobs = profiles.flatMap(profile => exported.profiles[profile].cron.map(job => ({ ...job, profile, ...(profile === 'briefs' ? jobEditing({ job, exported, edits, changes, at }) : {}) })));
  const timezone = profiles.map(profile => exported.profiles[profile].timezone).find(Boolean);
  // The model each profile follows, for a job that pins none.
  const profileModels = Object.fromEntries(profiles.map(profile => [profile, exported.profiles[profile].model?.default]).filter(([, model]) => model));

  const hermesJobs = exported
    ? { id: 'hermes-jobs', label: 'Hermes jobs', state, as_of: exported.exportedAt, host, items: jobs, ...(timezone ? { timezone } : {}), profileModels, ...(edits ? { edits: { available: edits.available, ...(edits.editable ? { models: edits.models, targets: edits.targets } : {}) } } : {}), ...(jobs.length ? {} : { text: 'The export lists no scheduled job.' }) }
    : { id: 'hermes-jobs', label: 'Hermes jobs', state, as_of: null, host, items: [], text: NO_EXPORT };
  const hasTimers = !!exported && Array.isArray(exported.hostTimers);
  const hermesTimers = hasTimers
    ? { id: 'hermes-timers', label: 'Hermes host timers', state, as_of: exported.exportedAt, host, items: exported.hostTimers, ...(exported.hostTimers.length ? {} : { text: 'The export lists no timer.' }) }
    : { id: 'hermes-timers', label: 'Hermes host timers', state: 'not-reporting', as_of: null, host, items: [], text: exported ? NO_TIMERS : NO_EXPORT };
  return {
    sources: [hermesJobs, hermesTimers, siteTimers(hostFile, at), ...pcSources(status, at)],
    note: COPY_NOTE,
    at: at.toISOString(),
  };
}

// --- job edits (ws-eh2 G) ---

/** What the page says while the host cannot apply a job change (the export has no `jobEdits: true`). */
export const EDITS_NOT_YET = 'Editing jobs is not available yet. The Hermes host needs an update first.';

/**
 * Whether jobs can be edited from the page: the host says so (`jobEdits: true` on the briefs block), the viewer is signed in and the export is fresh.
 * `targets` (the raw places a new job may post to) leave only here, in a reply to a signed-in viewer.
 */
function editsOf({ exported, state, signedIn }) {
  const block = exported.profiles.briefs;
  const available = block?.jobEdits === true;
  const editable = available && signedIn && state === 'live';
  return { available, editable, models: block?.modelOptions ?? [], targets: editable ? block?.deliverOptions ?? [] : [] };
}

const DAY_MS = 24 * 3600 * 1000;

/** A job's own edit fields: `editable`, whether its prompt may be edited, its newest recent change (`change`) and whether that change has a way back. */
function jobEditing({ job, exported, edits, changes, at }) {
  const mine = changes.filter(item => item.change.job === job.name);
  const newest = mine[0];
  const recent = newest && at.getTime() - Date.parse(newest.result?.at ?? newest.change.expires) < DAY_MS;
  const view = recent ? jobChangeView({ ...newest, exported, at }) : null;
  const editable = !!edits?.editable && !!job.rev;
  let canUndo = false;
  if (view && editable && newest.result?.outcome === 'applied' && newest.result.code === 'ok' && view.state === 'live' && ['edit', 'pause', 'resume'].includes(newest.change.op)) {
    canUndo = !('prompt' in (newest.change.to ?? {})) || promptProblem(newest.change.from.prompt) === '';
  }
  return {
    ...(editable ? { editable: true, promptEditable: promptEditable(job) && !!job.promptSha256 } : {}),
    ...(view ? { change: { ...view, ...(canUndo ? { canUndo: true } : {}) } } : {}),
  };
}

// --- the prompt alert ---
// The Hub remembers, in `agent-config/job-prompts-seen.json`, the hash of every job's whole prompt as it last saw it. When the export shows another
// hash and no change the Hub signed names it, the prompt changed behind the Hub's back (an agent may edit a job on the host), and the owner hears.

export const SEEN_FILE = 'agent-config/job-prompts-seen.json';
/** Most alerts one sweep writes: a baseline that was lost must not flood Today. */
export const MAX_JOB_ALERTS = 8;

const HASH_RE = /^[0-9a-f]{64}$/;
const jobKey = (profile, name) => `${profile}/${name}`;

/** The baseline file as `{ 'profile/name': sha256 }`, or null when it is missing or does not read (then the next sweep starts a new one, quietly). */
export function validSeen(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !raw.jobs || typeof raw.jobs !== 'object' || Array.isArray(raw.jobs)) return null;
  const jobs = {};
  for (const [name, hash] of Object.entries(raw.jobs)) if (typeof hash === 'string' && HASH_RE.test(hash)) jobs[name] = hash;
  return jobs;
}

/** The baseline file's text for `jobs`. */
export const seenText = (jobs, at) => `${JSON.stringify({ v: 1, at: at.toISOString(), jobs }, null, 2)}\n`;

/**
 * What a sweep does with the newest fresh export.
 * - `seen`: `validSeen(...)` or null (first run: store the baseline, no alert).
 * - `signed`: hashes of prompts the Hub itself signed, which are not news (none exist until the Hub can sign a job change).
 * → `{ jobs, alerts, changed }`: the baseline to keep, the alerts to write (`{ job, profile, hash, kind, title }`), and whether the baseline differs from `seen`.
 * A profile whose block has no job list is left alone, and so is a job without a hash: an older exporter must not read as "everything is gone".
 * The words are fixed; the only text taken from the host is the job's name, and never any of its prompt.
 */
export function jobPromptChanges({ seen, exported, signed = new Set() }) {
  const jobs = { ...(seen ?? {}) };
  const alerts = [];
  const listed = exported ? PROFILES.filter(name => Array.isArray(exported.profiles[name]?.cron)) : [];
  const now = new Map();
  for (const profile of listed) for (const job of exported.profiles[profile].cron) now.set(jobKey(profile, job.name), job.promptSha256 ?? null);
  if (![...now.values()].some(Boolean)) return { jobs, alerts, changed: false };

  for (const [name, hash] of now) {
    if (!hash) continue;
    const before = jobs[name];
    const job = name.slice(name.indexOf('/') + 1);
    const profile = name.slice(0, name.indexOf('/'));
    if (seen && before !== hash && !signed.has(hash)) {
      alerts.push(before
        ? { job, profile, hash, kind: 'changed', title: `The prompt of ${job} changed on the Hermes host, not from Schedules. Check it.` }
        : { job, profile, hash, kind: 'new', title: `A new job, ${job}, appeared on the Hermes host, not from Schedules. Check it.` });
    }
    jobs[name] = hash;
  }
  if (seen) {
    for (const name of Object.keys(jobs)) {
      const profile = name.slice(0, name.indexOf('/'));
      if (!listed.includes(profile) || now.has(name)) continue;
      const job = name.slice(name.indexOf('/') + 1);
      alerts.push({ job, profile, hash: 'gone', kind: 'gone', title: `The job ${job} is gone from the Hermes host, not removed from Schedules. Check it.` });
      delete jobs[name];
    }
  }
  const changed = !seen || JSON.stringify(Object.entries(jobs).sort()) !== JSON.stringify(Object.entries(seen).sort());
  return { jobs, alerts: alerts.slice(0, MAX_JOB_ALERTS), changed };
}
