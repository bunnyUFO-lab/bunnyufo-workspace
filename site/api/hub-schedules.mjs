// One page of everything that runs on a schedule (ws-eh2). Pure: no S3, no clock of its own. `hub.mjs` finds the newest settings export
// of the Hermes host and calls in.
//
// Only the Hermes host reports yet. Its jobs and timers come from the export it already publishes; the other lists (the site host's
// timers, the PC's tasks, GitHub's schedules) are named here and say "not reporting" until their own data arrives. Nothing on this page
// is a name from the owner's machines: every label and name comes from data, so this file holds none. View only: nothing here changes a job.
import { exportFreshness, PROFILES } from './hub-agent-config.mjs';

/** Which copy of a job is real. Shown at the top of the page. */
export const COPY_NOTE = 'These are the jobs the Hermes host runs now. The setup script in the homelab repo only adds a job that is missing, so changing it does not change a job that already exists.';
/** What a list says while its data has not arrived. */
export const NOT_REPORTING = 'Not reporting yet. This list arrives with a later update.';
/** What the timers list says when the host reports jobs but not its timers (an exporter that is older than the page). */
export const NO_TIMERS = 'The Hermes host does not list its timers yet.';
export const NO_EXPORT = 'The Hermes host has not published its settings yet.';

const LATER = [
  { id: 'site-timers', label: 'Site host timers' },
  { id: 'pc-tasks', label: 'PC tasks' },
  { id: 'github', label: 'GitHub Actions' },
];

/**
 * `{ sources, note, at }`
 * - `exported`: `validExport(...)` or null; `status` (the PC's status file) and `hostFile` (the site host's timer file) are for the lists that
 *   come later and are not read yet; `at`: a Date.
 * - `sources`: `[{ id, label, state, as_of, items, text? }]`, in page order. `state` is `live`, `old` (the export is past the freshness rule of
 *   `exportFreshness`) or `not-reporting`. `as_of` is the ISO time the data is from, or null. `text` says why a list is empty.
 *   The Hermes sources also carry `host` (the host's own label) and, for jobs, `timezone` (the zone the cron text runs in) and `profileModels` (the model a job follows when it pins none).
 * - a job item is the exporter's job with its `profile`; fields the exporter did not send are absent, not blank.
 */
export function schedulesView({ exported, status = null, hostFile = null, at }) {
  void status; void hostFile;
  const state = exported ? (exportFreshness(exported, at) === 'fresh' ? 'live' : 'old') : 'not-reporting';
  const host = exported?.hostLabel ?? 'Hermes host';
  const profiles = exported ? PROFILES.filter(name => Array.isArray(exported.profiles[name]?.cron)) : [];
  const jobs = profiles.flatMap(profile => exported.profiles[profile].cron.map(job => ({ ...job, profile })));
  const timezone = profiles.map(profile => exported.profiles[profile].timezone).find(Boolean);
  // The model each profile follows, for a job that pins none.
  const profileModels = Object.fromEntries(profiles.map(profile => [profile, exported.profiles[profile].model?.default]).filter(([, model]) => model));

  const hermesJobs = exported
    ? { id: 'hermes-jobs', label: 'Hermes jobs', state, as_of: exported.exportedAt, host, items: jobs, ...(timezone ? { timezone } : {}), profileModels, ...(jobs.length ? {} : { text: 'The export lists no scheduled job.' }) }
    : { id: 'hermes-jobs', label: 'Hermes jobs', state, as_of: null, host, items: [], text: NO_EXPORT };
  const hasTimers = !!exported && Array.isArray(exported.hostTimers);
  const hermesTimers = hasTimers
    ? { id: 'hermes-timers', label: 'Hermes host timers', state, as_of: exported.exportedAt, host, items: exported.hostTimers, ...(exported.hostTimers.length ? {} : { text: 'The export lists no timer.' }) }
    : { id: 'hermes-timers', label: 'Hermes host timers', state: 'not-reporting', as_of: null, host, items: [], text: exported ? NO_TIMERS : NO_EXPORT };
  return {
    sources: [hermesJobs, hermesTimers, ...LATER.map(source => ({ ...source, state: 'not-reporting', as_of: null, items: [], text: NOT_REPORTING }))],
    note: COPY_NOTE,
    at: at.toISOString(),
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
