// Can the PC start an approved job, and if not, why (ws-3o5). Pure: the PC status, the clock and what the job asks for go in,
// words come out. The PC report says which projects its runner serves and whether launching is on (`status.runner`, from
// the PC's report script); the Hub never reads the runner's own files.
//
// Two kinds of answer:
//   blocked  a fixed cause the Hub knows will stop the start with no end in sight: `pc-silent`, `not-on-runner`, `launch-off`,
//            `login-expired`, or a `cap` that ends more than LONG_WAIT_MS away or at an unknown time. The Approve answer, the Spawn
//            sheet and the job page say so at once. Once the approved job has waited NOT_STARTED_MS with no taken.json, it is
//            `stuck` and Needs you carries one item for it.
//   wait     the runner will take it, just not yet: the owner is at the PC and the job opens windows, a run of the project is going,
//            a full cap or a usage pause ends soon, a resumed session or an install is running. A line on the job page. Never an item.
import { defaultsOf } from './project-defaults.mjs';
import { STALE_SECONDS } from './hub-pc.mjs';

const MIN = 60 * 1000;
/** An approved PC job with no taken.json after this long is stuck. */
export const NOT_STARTED_MS = 10 * MIN;
/** A pause or a full cap that ends sooner than this is a normal queue: a line on the job page. Longer, or with no known end, is an alert. */
export const LONG_WAIT_MS = 4 * 60 * MIN;
export const CAUSES = ['not-on-runner', 'launch-off', 'pc-silent', 'login-expired', 'cap'];

/** The commands the items show in a copyable block. */
export const ADD_REPO_COMMAND = 'install.ps1 -AddRepo <path> -Yes';
export const LAUNCH_ON_COMMAND = 'install.ps1 -Runs -Launch on';
export const LOGIN_COMMAND = 'claude auth login\nnode $HOME\\.config\\pc-dispatch\\dispatch.mjs resume';

/** "about 20 minutes", "about 2 hours", "about 3 days", "less than a minute". */
export function span(ms) {
  const minutes = Math.round(ms / MIN);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 90) return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `about ${Math.round(hours / 24)} days`;
}

const nameOf = project => defaultsOf(project)?.name ?? project;

/**
 * @param project      the job's project id
 * @param status       the cleaned PC status (`validStatus`), or null when there is none in the lookback
 * @param silent       with no status: this host has had a PC reporter before and none is recent ("This PC hasn't reported lately").
 *                     With no status and `silent` false (no reporter ever) the Hub makes no claim.
 * @param at           the clock (Date)
 * @param approvedAt   when the job was approved (ISO), or null for "just now" (the Spawn sheet, the Approve answer)
 * @param opensWindows the job opens windows on the PC (the signed `run.opensWindows`)
 * @param endsAt       ISO times when the PC's running jobs must end (taken time plus their limit), for the "when" of a full cap
 * @returns `{ known: false }` when nothing can be said. `{ known: true, blocked: false, wait? }`, or `{ known: true, blocked: true, stuck, cause,
 *   title, text, short, step?, command?, canWake?, until? }`.
 */
export function pcStartVerdict({ project, status, silent = false, at, approvedAt = null, opensWindows = false, endsAt = [] }) {
  const name = nameOf(project);
  const waited = approvedAt && Number.isFinite(Date.parse(approvedAt)) ? Math.max(0, at.getTime() - Date.parse(approvedAt)) : 0;
  const stuck = waited >= NOT_STARTED_MS;
  const blocked = (cause, fields) => ({ known: true, blocked: true, stuck, cause, ...fields });
  const wait = (kind, text) => ({ known: true, blocked: false, wait: { kind, text } });
  const silentFields = quiet => ({
    title: 'The PC is not answering',
    short: 'The PC looks asleep or off, so the job starts when it wakes.',
    text: `${quiet} It is probably asleep or off, so ${name} cannot start. Wake it, or run the job somewhere else.`,
    canWake: true,
  });

  // No status file in the lookback: silent when this host has had a reporter before, unknown when it never has (a copy with no PC reporter).
  if (!status) return silent ? blocked('pc-silent', silentFields("This PC hasn't reported lately.")) : { known: false };
  if ((at.getTime() - Date.parse(status.at)) / 1000 > STALE_SECONDS) return blocked('pc-silent', silentFields(`The PC has not reported for ${span(at.getTime() - Date.parse(status.at))}.`));
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
  if (paused) {
    if (runner.pausedReason === 'login-expired') {
      return blocked('login-expired', {
        title: 'The PC needs you to sign in again',
        short: "The PC's sign-in expired, so no job starts until you sign in again.",
        text: 'The login on the PC expired, so the runner paused and starts nothing. It stays paused until you sign in again and resume it.',
        step: 'Run these on the PC, in order:',
        command: LOGIN_COMMAND,
      });
    }
    if (runner.pausedReason === 'open-run') return wait('open-run', 'You are in a resumed session at the PC, so the job waits until it ends.');
    if (runner.pausedReason === 'add-repo') return wait('add-repo', 'The PC is installing a project, so the job starts when that is done.');
    // A usage limit (or a pause with no reason from an older reporter): a queue when it ends soon.
    if (paused - at.getTime() <= LONG_WAIT_MS) return wait('usage-limit', `Paused after a usage limit. The job starts in ${span(paused - at.getTime())}, when the pause ends.`);
    return blocked('cap', {
      title: 'The PC is paused for a while',
      short: `The PC is paused after a usage limit. It starts in ${span(paused - at.getTime())}.`,
      text: `The PC is paused after a usage limit. This job waits. It starts in ${span(paused - at.getTime())}, when the pause ends.`,
      until: new Date(paused).toISOString(),
    });
  }
  // A run of this project is going: the runner starts the next job of a project when it ends (this also holds when one run is all it allows).
  if (runner.busy.includes(project)) return wait('busy', `Waiting for the run now going on ${name} to end.`);
  if (runner.full) {
    const next = runner.full === 'concurrent' ? endsAt.map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b)[0] : undefined;
    if (next !== undefined && next - at.getTime() <= LONG_WAIT_MS) {
      return wait('cap', next > at.getTime()
        ? `The PC is running as many jobs as it is set to. This one starts in ${span(next - at.getTime())} at the latest, when the run now going ends.`
        : 'The PC is running as many jobs as it is set to. This one starts as soon as the run now going ends.');
    }
    const day = runner.full === 'day';
    const why = day ? 'The PC has started as many jobs today as it is set to.' : 'The PC is already running as many jobs as it is set to.';
    const when = day ? 'tomorrow, when the daily count starts again' : 'when the run now going ends';
    return blocked('cap', { title: 'The PC is full for now', short: `${why} It starts ${when}.`, text: `${why} This job waits its turn. It starts ${when}.` });
  }
  // The runner will take it. Say what it is probably waiting for, without raising an alert.
  if (opensWindows && status.inUse) return wait('away', 'Waiting until you are away from the PC. This job opens windows.');
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
