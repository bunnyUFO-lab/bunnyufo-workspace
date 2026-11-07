// The three lists that are not the Hermes host's (ws-eh2 E): the PC's Windows tasks and its GitHub schedules (a `schedules` field in the PC's
// status file) and the site host's timers (a small JSON file beside the API's env file). This is the one place that reads their shape: the field
// names below are part D's and are cleaned here and nowhere else, so a rename in review is a change to this file. All of it is an agent's file,
// so every value is cleaned again; what does not read is dropped, never guessed. A missing key or file reads as null: the page then says
// "not reporting". Pure: no S3, no clock, no file access (`hub.mjs` finds the file and passes its text in).

/** The site host's file, found in the folder of the API's env file. */
export const HOST_SCHEDULES_FILE = 'host-schedules.json';
export const HOST_SCHEDULES_MAX_BYTES = 64 * 1024;
/** Most rows of each list: the PC sends 60 tasks and says how many there are in all. */
export const MAX_TASKS = 60;
export const MAX_GITHUB = 100;
export const MAX_HOST_TIMERS = 60;

const TASK_STATES = ['ready', 'running', 'disabled', 'queued', 'unknown'];
const GITHUB_STATES = ['active', 'disabled'];
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const line = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** An ISO time that names its zone, as a canonical ISO string; '' for anything else (a time with no zone is not read in the server's). */
export function zonedIso(value) {
  if (typeof value !== 'string' || value.length > 40 || !ZONED.test(value.trim())) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** The time a list was made: any ISO time. A report time is only for "how old is this", so a missing zone does not drop the list (a run time without one is dropped). */
const madeAt = value => {
  const date = typeof value === 'string' && value.length <= 40 ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
};

function cleanTask(raw) {
  if (!isObject(raw)) return null;
  const name = line(raw.name, 120);
  if (!name) return null;
  const nextRun = zonedIso(raw.nextRun);
  const lastRun = zonedIso(raw.lastRun);
  return {
    name, folder: line(raw.folder, 120), state: TASK_STATES.includes(raw.state) ? raw.state : 'unknown', schedule: line(raw.schedule, 160),
    ...(nextRun ? { nextRun } : {}), ...(lastRun ? { lastRun } : {}), lastResult: line(raw.lastResult, 40),
    ...(raw.ours === true ? { ours: true } : {}),
  };
}

function cleanWorkflow(raw) {
  if (!isObject(raw)) return null;
  const repo = line(raw.repo, 100);
  const workflow = line(raw.workflow, 100);
  const cron = line(raw.cron, 60);
  if (!repo || !workflow || !cron) return null;
  const lastRun = zonedIso(raw.lastRun);
  const conclusion = line(raw.lastConclusion, 30);
  return { repo, workflow, cron, state: GITHUB_STATES.includes(raw.state) ? raw.state : 'unknown', ...(lastRun ? { lastRun } : {}), ...(conclusion ? { lastConclusion: conclusion } : {}) };
}

/**
 * The `schedules` field of a PC status: `{ tasks?: { at, total, rows }, github?: { at, rows } }`, or null when there is none. Each half is
 * present only when its own time reads; it is left out if the PC never read it. `total` is every non-OS task, which can be more than the rows.
 */
export function cleanPcSchedules(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  const tasksAt = madeAt(raw.tasksAt);
  if (tasksAt && Array.isArray(raw.tasks)) {
    const rows = raw.tasks.map(cleanTask).filter(Boolean).slice(0, MAX_TASKS);
    const total = Number.isInteger(raw.tasksTotal) && raw.tasksTotal >= rows.length && raw.tasksTotal <= 1e5 ? raw.tasksTotal : rows.length;
    out.tasks = { at: tasksAt, total, rows };
  }
  const githubAt = madeAt(raw.githubAt);
  if (githubAt && Array.isArray(raw.github)) out.github = { at: githubAt, rows: raw.github.map(cleanWorkflow).filter(Boolean).slice(0, MAX_GITHUB) };
  return out.tasks || out.github ? out : null;
}

function cleanTimer(raw) {
  if (!isObject(raw)) return null;
  const name = line(raw.name, 120);
  if (!name) return null;
  const nextRun = zonedIso(raw.nextRun);
  const lastRun = zonedIso(raw.lastRun);
  return {
    name, description: line(raw.description, 200), schedule: line(raw.schedule, 200), enabled: raw.enabled === true,
    ...(nextRun ? { nextRun } : {}), ...(lastRun ? { lastRun } : {}), lastResult: line(raw.lastResult, 40),
  };
}

/** The site host's file as `{ exportedAt, hostLabel, timers }`, or null when its text is too big, is not JSON, or is not a `v: 1` file with a time. */
export function cleanHostSchedules(text) {
  if (typeof text !== 'string' || text.length > HOST_SCHEDULES_MAX_BYTES) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObject(raw) || raw.v !== 1 || !Array.isArray(raw.timers)) return null;
  const exportedAt = madeAt(raw.exportedAt);
  if (!exportedAt) return null;
  return { exportedAt, hostLabel: line(raw.hostLabel, 40) || 'Site host', timers: raw.timers.map(cleanTimer).filter(Boolean).slice(0, MAX_HOST_TIMERS) };
}
