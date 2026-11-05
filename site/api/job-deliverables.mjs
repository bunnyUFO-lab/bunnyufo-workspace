// What a job delivered: its card, PR, Asks, lists of steps, other jobs and tasks, each one a reference the Hub looks up when it is read.
// Pure code, no I/O and no Beads: hub.mjs loads the inputs. A task is only `{ project, id }`, so where Beads keeps its copies can change
// without changing this. Everything a run files about itself is self-reported, so a link only counts when its project and time fit.
import { ID_RE } from './hub-model.mjs';
import { asksOf } from './run-outcome.mjs';

export const JOB_LIMITS = { finished: 100, deliverables: 12 };
/** Request lists read this month and the last one, so the Jobs list reaches back about this far. */
export const JOBS_WINDOW = 'two months';

export const RUNNING_STATES = ['approved', 'taken', 'running', 'stopping', 'lost'];
export const FINISHED_STATES = ['done', 'failed', 'stopped', 'asking', 'expired'];

/** The tab a job's state lists under: `running`, `finished`, or null for the ones the list leaves out (proposed, declined, unknown). */
export const jobTab = state => (RUNNING_STATES.includes(state) ? 'running' : FINISHED_STATES.includes(state) ? 'finished' : null);

const SECTION_CARD = /^([a-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** `owner/repo #12` for a GitHub PR link, else the host and path, so a PR from anywhere still reads. */
export function prLabel(href) {
  const github = PR_URL.exec(href);
  if (github) return `${github[1]} #${github[2]}`;
  try { const url = new URL(href); return `${url.host}${url.pathname}`.slice(0, 80); } catch { return 'Pull request'; }
}

const time = value => { const ms = new Date(value ?? '').getTime(); return Number.isFinite(ms) ? ms : NaN; };

/** Linked work counts only in the job's own project and not before the job: an agent writes `from.request` itself. */
const belongs = (job, row) => !!row && row.project === job.project && !(time(row.at) < time(job.at));

/**
 * Everything a job delivered, each one openable.
 * @param item       the job's request list row (`id`, `project`, `at`, `bead`, `finish`)
 * @param result     the result.json when at hand, else `item.finish` is read
 * @param reportText the report, when at hand (the result page only): older Hermes jobs name their Asks only there
 * @param asks       Ask list rows (`id`, `project`, `at`, `title`, `state`, `fromRequest`)
 * @param checklists checklist list rows, as for `asks`
 * @param requests   request list rows: another job counts when its `origin` is `{ kind: 'run', name: <this id> }`
 * @param touched    `{ beads: [{ project, id }] }` of the job's session, or null
 * @param card       `(section/folder) => { href, title } | undefined`, from the card index
 * @param taskTitle  `(project, id) => string | undefined`, best effort: a miss only costs the label
 */
export function deliverablesOf({ item, result, reportText, asks = [], checklists = [], requests = [], touched = null, card = () => undefined, taskTitle = () => undefined }) {
  const done = result ?? item.finish ?? {};
  const out = [];
  const cardRef = typeof done.card === 'string' && SECTION_CARD.test(done.card) ? done.card : null;
  if (cardRef) {
    const found = card(cardRef);
    out.push({ kind: 'card', ref: cardRef, section: cardRef.split('/')[0], ...(found?.title ? { title: found.title } : {}), ...(found?.href ? { href: found.href } : {}) });
  }
  if (typeof done.pr === 'string' && /^https:\/\//i.test(done.pr)) out.push({ kind: 'pr', href: done.pr.slice(0, 500), label: prLabel(done.pr) });

  const askIds = new Set([...(Array.isArray(done.asks) ? done.asks : []), ...(reportText ? asksOf(reportText) : [])].filter(id => typeof id === 'string' && ID_RE.test(id)));
  const seen = new Set();
  const pushAsk = row => { if (!seen.has(row.id) && belongs(item, row)) { seen.add(row.id); out.push({ kind: 'ask', id: row.id, title: row.title, state: row.state }); } };
  for (const row of asks) if (row.fromRequest === item.id || askIds.has(row.id)) pushAsk(row);
  for (const row of checklists) if (row.fromRequest === item.id && belongs(item, row)) out.push({ kind: 'checklist', id: row.id, title: row.title, state: row.state });
  for (const row of requests) {
    if (row.id !== item.id && row.origin?.kind === 'run' && row.origin.name === item.id && belongs(item, row) && row.state !== 'declined') out.push({ kind: 'job', id: row.id, title: row.title, state: row.state });
  }
  const tasks = new Set();
  for (const row of touched?.beads ?? []) {
    const key = `${row.project}/${row.id}`;
    if (tasks.has(key)) continue;
    tasks.add(key);
    const title = taskTitle(row.project, row.id);
    out.push({ kind: 'task', project: row.project, id: row.id, ...(title ? { title } : {}) });
  }
  return out.slice(0, JOB_LIMITS.deliverables);
}

const countWord = (count, one, many) => (count === 1 ? one : `${count} ${many}`);

/**
 * The pills of a job row, from what it delivered and how it ended. `job` is `{ state, stale?, nothing?, finish?, deliverables }`. Pills are
 * `{ text, tone }` with tone `good`, `warn` or `quiet`, in this order: what it delivered, then how it ended.
 */
export function pillsOf(job) {
  const pills = [];
  const list = job.deliverables ?? [];
  const of = kind => list.filter(row => row.kind === kind);
  if (of('card').length) pills.push({ text: 'Card', tone: 'good' });
  if (of('pr').length) pills.push({ text: 'PR', tone: 'good' });
  if (of('ask').length) pills.push({ text: countWord(of('ask').length, 'Ask', 'Asks'), tone: 'good' });
  if (of('checklist').length) pills.push({ text: 'Checklist', tone: 'good' });
  if (of('task').length) pills.push({ text: 'Task', tone: 'good' });
  if (of('job').length) pills.push({ text: 'Job', tone: 'good' });
  const finished = FINISHED_STATES.includes(job.state);
  let ended = false;
  if (job.state === 'asking') { pills.push({ text: 'Asking you', tone: 'warn' }); ended = true; }
  if (job.nothing) { pills.push({ text: 'Nothing to change', tone: 'quiet' }); ended = true; }
  if (job.state === 'failed') { pills.push({ text: 'Failed', tone: 'bad' }); ended = true; }
  if (job.state === 'stopped') { pills.push({ text: 'Stopped', tone: 'quiet' }); ended = true; }
  if (job.state === 'expired') { pills.push({ text: 'Expired', tone: 'quiet' }); ended = true; }
  if (job.stale) pills.push({ text: 'No word', tone: 'warn' });
  if (job.finish?.outcome === 'manual') { pills.push({ text: 'You marked it done', tone: 'quiet' }); ended = true; }
  if (finished && !ended && !list.length) pills.push({ text: 'Nothing delivered', tone: 'quiet' });
  return pills;
}

/**
 * One row of `GET /hub/jobs`. `preset` is the preset table entry (the agent's name), `list` the deliverables as `deliverablesOf` made them.
 * A job's deliverables here come from list rows only: no report is read for a list.
 */
export function jobListRow({ item, preset, deliverables }) {
  const base = { id: item.id, title: item.title, project: item.project, preset: item.preset, state: item.state };
  const row = {
    ...base, ...(preset ? { agent: preset.agent } : {}), ...(item.run?.runner ? { runner: item.run.runner } : item.target ? { runner: item.target } : {}),
    ...(item.stale ? { stale: item.stale } : {}), at: item.run?.at ?? item.at, ...(item.finish ? { finishedAt: item.finish.at } : {}),
    ...(item.nothing ? { nothing: true } : {}), deliverables,
  };
  return { ...row, pills: pillsOf({ ...row, finish: item.finish }) };
}

/** The `GET /hub/jobs` answer from the requests and what they delivered. `build(item)` makes one job's deliverables. */
export function jobsList({ requests, project = '', tab = '', preset, build }) {
  const mine = requests.filter(item => item.preset && jobTab(item.state) && (!project || item.project === project));
  const counts = { running: mine.filter(item => jobTab(item.state) === 'running').length, finished: mine.filter(item => jobTab(item.state) === 'finished').length };
  const newest = (a, b) => String(b.finish?.at ?? b.run?.at ?? b.at).localeCompare(String(a.finish?.at ?? a.run?.at ?? a.at));
  // With no tab both are answered, so the page switches without asking again; Finished is capped either way.
  const of = name => mine.filter(item => jobTab(item.state) === name).sort(newest);
  const shown = tab === 'running' ? of('running') : tab === 'finished' ? of('finished').slice(0, JOB_LIMITS.finished) : [...of('running'), ...of('finished').slice(0, JOB_LIMITS.finished)];
  const rows = shown.map(item => jobListRow({ item, preset: preset(item.preset), deliverables: build(item) }));
  return { counts, jobs: rows, window: JOBS_WINDOW };
}
