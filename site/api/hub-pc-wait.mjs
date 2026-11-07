// Can the PC start an approved job, and if not, why (ws-3o5). Pure: the PC status, the clock and what the job asks for go in,
// words come out. The PC report says which projects its runner serves and whether launching is on (`status.runner`, from
// the PC's report script); the Hub never reads the runner's own files.
//
// Two kinds of answer:
//   blocked  a fixed cause the Hub knows will stop the start: `not-on-runner`, `launch-off`, `pc-silent`, `cap`. The Approve
//            answer, the Spawn sheet and the job page say so at once. Once the approved job has waited NOT_STARTED_MS with no
//            taken.json, it is `stuck` and Needs you carries one item for it.
//   wait     the runner will take it, just not yet: the owner is at the PC and the job opens windows, or another run of the
//            project is going. Shown as a line on the job page. Never an item.
import { defaultsOf } from './project-defaults.mjs';
import { STALE_SECONDS } from './hub-pc.mjs';

const MIN = 60 * 1000;
/** An approved PC job with no taken.json after this long is stuck. */
export const NOT_STARTED_MS = 10 * MIN;
export const CAUSES = ['not-on-runner', 'launch-off', 'pc-silent', 'cap'];

/** The commands the items show in a copyable block. */
export const ADD_REPO_COMMAND = 'install.ps1 -AddRepo <path> -Yes';
export const LAUNCH_ON_COMMAND = 'install.ps1 -Runs -Launch on';

/** "about 20 minutes", "about 2 hours", "less than a minute". */
export function span(ms) {
  const minutes = Math.round(ms / MIN);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 90) return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

const nameOf = project => defaultsOf(project)?.name ?? project;

/**
 * @param project      the job's project id
 * @param status       the cleaned PC status (`validStatus`), or null when there is none (then the Hub makes no claim)
 * @param at           the clock (Date)
 * @param approvedAt   when the job was approved (ISO), or null for "just now" (the Spawn sheet, the Approve answer)
 * @param opensWindows the job opens windows on the PC (the signed `run.opensWindows`)
 * @param endsAt       ISO times when the PC's running jobs must end (taken time plus their limit), for the "when" of a full cap
 * @returns `{ known: false }` when the status has no runner block (an old reporter): the Hub says nothing it cannot know.
 *   Otherwise `{ known: true, blocked: false, wait?: { kind, text } }` or `{ known: true, blocked: true, stuck, cause, title, text,
 *   short, command?, canWake?, until? }`. `text` is 2 or 3 sentences for the Needs you item, `short` is one for a toast or a line.
 */
export function pcStartVerdict({ project, status, at, approvedAt = null, opensWindows = false, endsAt = [] }) {
  const name = nameOf(project);
  const waited = approvedAt && Number.isFinite(Date.parse(approvedAt)) ? Math.max(0, at.getTime() - Date.parse(approvedAt)) : 0;
  const stuck = waited >= NOT_STARTED_MS;
  const blocked = (cause, fields) => ({ known: true, blocked: true, stuck, cause, ...fields });

  // No status file at all (none in the two days the Hub looks back) is unknown, not silent: a copy with no PC reporter, or a PC never set up,
  // gets no claim. A status that exists but is older than 15 minutes is the PC asleep, off or its watcher dead.
  if (!status) return { known: false };
  if ((at.getTime() - Date.parse(status.at)) / 1000 > STALE_SECONDS) {
    return blocked('pc-silent', {
      title: 'The PC is not answering',
      short: 'The PC looks asleep or off, so the job starts when it wakes.',
      text: `The PC has not reported for ${span(at.getTime() - Date.parse(status.at))}. It is probably asleep or off, so ${name} cannot start. Wake it, or run the job somewhere else.`,
      canWake: true,
    });
  }
  const runner = status.runner;
  if (!runner) return { known: false };

  if (!runner.projects.includes(project)) {
    return blocked('not-on-runner', {
      title: `The PC does not run ${name} yet`,
      short: `The PC's runner does not have ${name}, so this job will not start there.`,
      text: `The job was approved for the PC, but the runner there does not have ${name}. It will not start by itself. Add the project on the PC, or switch the job to the cloud.`,
      step: "Run this from the runner's checkout on the PC:",
      command: ADD_REPO_COMMAND,
    });
  }
  if (!runner.launch) {
    return blocked('launch-off', {
      title: 'Starting jobs is off on the PC',
      short: 'Starting jobs is off on the PC, so this job will not start until it is on.',
      text: `The runner on the PC has ${name}, but it is set not to start jobs. Nothing starts until you turn it on.`,
      step: 'Run this on the PC:',
      command: LAUNCH_ON_COMMAND,
    });
  }
  const paused = runner.pausedUntil && Date.parse(runner.pausedUntil) > at.getTime() ? Date.parse(runner.pausedUntil) : null;
  if (paused || runner.full) {
    let when;
    let until = null;
    if (paused) { when = `in ${span(paused - at.getTime())}, when the usage pause ends`; until = new Date(paused).toISOString(); }
    else if (runner.full === 'day') when = 'tomorrow, when the daily count starts again';
    else {
      const next = endsAt.map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b)[0];
      if (next !== undefined) { when = next > at.getTime() ? `in ${span(next - at.getTime())} at the latest, when the run now going ends` : 'as soon as the run now going ends'; until = new Date(next).toISOString(); }
      else when = 'when the run now going ends';
    }
    const why = paused ? 'The PC is paused after a usage limit.' : runner.full === 'day' ? 'The PC has started as many jobs today as it is set to.' : 'The PC is already running as many jobs as it is set to.';
    return blocked('cap', {
      title: 'The PC is full for now',
      short: `${why} It starts ${when}.`,
      text: `${why} This job waits its turn. It starts ${when}.`,
      ...(until ? { until } : {}),
    });
  }
  // The runner will take it. Say what it is probably waiting for, without raising an alert.
  if (opensWindows && status.inUse) {
    return { known: true, blocked: false, wait: { kind: 'away', text: 'Waiting until you are away from the PC. This job opens windows.' } };
  }
  if (runner.busy.includes(project)) {
    return { known: true, blocked: false, wait: { kind: 'busy', text: `Waiting for the run now going on ${name} to end.` } };
  }
  return { known: true, blocked: false };
}

/**
 * The verdict for one approved PC request, as the list rows and the job page carry it: only the fields a page shows.
 * `null` when there is nothing to say (the job can start, or the Hub cannot know).
 */
export function pcWaitOf(verdict) {
  if (!verdict?.known) return null;
  if (!verdict.blocked) return verdict.wait ? { state: 'wait', kind: verdict.wait.kind, text: verdict.wait.text } : null;
  return {
    state: verdict.stuck ? 'stuck' : 'blocked', cause: verdict.cause, title: verdict.title, short: verdict.short, text: verdict.text,
    ...(verdict.step ? { step: verdict.step } : {}), ...(verdict.command ? { command: verdict.command } : {}),
    ...(verdict.canWake ? { canWake: true } : {}), ...(verdict.until ? { until: verdict.until } : {}),
  };
}
