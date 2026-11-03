// The owner's marks on the Roadmap, with no I/O: "done", "no longer needed" and "unblock" (it does not
// wait on the owner) for a task that waits on the owner. A mark is a create-only file in the inbox,
//   bead-marks/<project>/<bead id>/<stamp>-<verdict>-<rand4>.json
// where the verdict is done | not-needed | unblock | undo (written by the Hub only) or applied (written by an
// agent after `bd close` or `bd label remove <id> needs-owner`). Nothing here writes into Beads: the Roadmap shows an overlay that turns an
// open issue closed until Beads says so itself.

export const MARK_FILE = /^(\d{8}T\d{9}Z)-(done|not-needed|unblock|undo|applied)-([a-z0-9]{4})\.json$/;
export const BEAD_ID = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]{0,60}$/;
export const REASON_MAX = 500;
/** The option id that means "not decided yet" on a decision Ask: picking it records the answer and writes no mark, so the question stays open. */
export const NOT_YET = 'not-yet';
const OWNER_VERDICTS = new Set(['done', 'not-needed', 'unblock', 'undo']);

/** The close reason the overlay shows. A done mark with a reason is an answer to a Wayfinder question: "Decided: <answer>". */
export const markReason = (verdict, reason = '') => (verdict === 'not-needed' ? 'Not needed (you, on the Roadmap)' : reason ? `Decided: ${reason}` : 'Done (you, on the Roadmap)');

/**
 * One mark file as an entry, or null when its name or body is not one. `rel` is the path under
 * `bead-marks/` (`<project>/<bead>/<file>`), `body` the parsed JSON, `writer` the object's writer
 * metadata (the card API tags what it writes; the Hub's own writes carry none).
 */
export function markEntry(rel, body, writer = null) {
  const [project, bead, file, extra] = String(rel).split('/');
  const name = MARK_FILE.exec(file ?? '');
  if (!project || !bead || !name || extra !== undefined || !BEAD_ID.test(bead) || !body || typeof body !== 'object') return null;
  const [, stamp, verdict] = name;
  if (body.v !== 1 || body.verdict !== verdict || body.project !== project || body.bead !== bead) return null;
  const at = typeof body.at === 'string' && !Number.isNaN(new Date(body.at).getTime()) ? body.at : null;
  if (!at) return null;
  return {
    project, bead, file, stamp, verdict, at, writer: writer || null,
    by: typeof body.by === 'string' ? body.by : '',
    ...(typeof body.reason === 'string' && body.reason.trim() ? { reason: body.reason.trim().slice(0, REASON_MAX) } : {}),
    ...(verdict === 'applied' && typeof body.mark === 'string' ? { mark: body.mark } : {}),
  };
}

/**
 * Where one bead stands. The current owner verdict is the newest done / not-needed / unblock / undo written by
 * the Hub (a verdict file with a writer was put through the card API and is ignored). It is active
 * when it is done or not-needed, no `applied` file names it, and the issue is not closed.
 * Null when the owner never marked the bead.
 */
export function markState(entries, { closed = false, waiting = true } = {}) {
  const owner = entries.filter(entry => OWNER_VERDICTS.has(entry.verdict) && !entry.writer).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const current = owner.at(-1);
  if (!current) return null;
  const applied = entries.some(entry => entry.verdict === 'applied' && entry.mark === current.file);
  const marked = current.verdict !== 'undo';
  return {
    verdict: current.verdict, at: current.at, file: current.file, ...(current.reason ? { reason: current.reason } : {}),
    applied: marked && applied, active: marked && !applied && !closed && (current.verdict !== 'unblock' || waiting),
  };
}

/** `marksByBead` keys: `<project>/<bead>`. */
export const markKey = (project, bead) => `${project}/${bead}`;

/** The raw issue still waits on the owner: it has the needs-owner label or status blocked. */
export const isWaiting = issue => (issue.labels ?? []).includes('needs-owner') || issue.status === 'blocked';

/**
 * Copies of `issues` where an active mark closes the issue: status closed, `closed_at` the mark's time,
 * a close reason and `_mark`. It only ever turns an open issue closed, so it stops by itself once Beads
 * says closed or an `applied` file exists. An active unblock instead drops the needs-owner label and
 * turns status blocked into open (with `_mark`, and no close fields). `project` names the project of every issue, or each issue's own `project`.
 * @param marksByBead Map of `<project>/<bead>` to that bead's entries
 */
export function applyMarks(issues, marksByBead, project) {
  return issues.map(issue => {
    const entries = marksByBead.get(markKey(project ?? issue.project, issue.id));
    if (!entries?.length) return issue;
    const state = markState(entries, { closed: issue.status === 'closed', waiting: isWaiting(issue) });
    if (!state?.active) return issue;
    if (state.verdict === 'unblock') {
      return {
        ...issue, labels: (issue.labels ?? []).filter(label => label !== 'needs-owner'), ...(issue.status === 'blocked' ? { status: 'open' } : {}),
        _mark: { verdict: 'unblock', at: state.at, file: state.file },
      };
    }
    return {
      ...issue, status: 'closed', closed_at: state.at, close_reason: markReason(state.verdict, state.reason),
      _mark: { verdict: state.verdict, at: state.at, file: state.file, ...(state.reason ? { reason: state.reason } : {}) },
    };
  });
}

/** The request body of POST /hub/map/:project/marks, checked: `{ bead, verdict, reason? }`; throws a message. */
export function checkMarkRequest(raw) {
  const bead = typeof raw?.bead === 'string' ? raw.bead : '';
  if (!BEAD_ID.test(bead)) throw new Error('bead must be a Beads issue id.');
  if (!['done', 'not-needed', 'unblock', 'undo'].includes(raw?.verdict)) throw new Error('verdict must be done, not-needed, unblock or undo.');
  let reason = '';
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason !== 'string') throw new Error('reason must be text.');
    reason = raw.reason.replace(/\s+/g, ' ').trim();
    if (reason.length > REASON_MAX) throw new Error(`reason is at most ${REASON_MAX} characters.`);
  }
  return { bead, verdict: raw.verdict, reason: raw.verdict === 'not-needed' || raw.verdict === 'done' ? reason : '' };
}
