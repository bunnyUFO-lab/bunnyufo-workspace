// Signed changes of a Hermes job (ws-eh2 G): the rules both sides hold, the shape of the signed file, and where a change stands.
// Pure: no S3, no clock of its own. `hub-agent-edit.mjs` signs, `hub.mjs` loads and answers. The host's copy of these rules is
// `job_change.py` in the homelab repo; `test/fixtures/job-change-vector.json` is its pinned vector, copied, and hub-job-edit.test.mjs checks the bytes.
//
// A job change is a second kind of file in the folder the model changes use, `agent-config/changes/<id>/approved.json`, with `kind: 'job-change'`.
// The key is the same one, the result path is the same, and nothing about the host's model flow loosens: each side's exact-keys check refuses
// the other's shape. The host finds the job BY NAME in its own file; no job id is ever signed.
import { createHash } from 'node:crypto';
import { cleanId, CHANGE_CODES, redactSecrets, CRON_PROMPT_MAX_BYTES } from './hub-agent-config.mjs';

export const JOB_KIND = 'job-change';
export const JOB_PROFILE = 'briefs';
export const JOB_OPS = ['edit', 'pause', 'resume', 'remove', 'add'];
export const JOB_NAME_RE = /^[a-z][a-z0-9-]{2,59}$/;
/** The id of a job change's folder: `<yyyymmdd>-job-briefs-<rand4>`. */
export const JOB_ID_RE = /^\d{8}-job-briefs-[a-z0-9]{4}$/;
export const JOB_PROMPT_MAX_BYTES = 8000;
/** The host takes one number for the minute and at most 4 hours, so a job runs at most 4 times a day. */
export const JOB_MAX_HOURS = 4;
const TOP_KEYS = ['v', 'kind', 'change', 'ask', 'profile', 'op', 'job', 'fromRev', 'from', 'to', 'expires', 'nonce', 'at', 'by', 'signature'];
const FROM_KEYS = ['schedule', 'prompt', 'provider', 'model'];
const EDIT_KEYS = ['schedule', 'prompt', 'provider', 'model'];
const ADD_KEYS = ['schedule', 'prompt', 'postsTo', 'provider', 'model'];
export const TARGET_RE = /^discord:[0-9]+(?::[0-9]+)?$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sha256Text = text => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** The host's schedule rule: five fields, the minute one number, the hour one number or up to four, the rest `0-9 * , - /` only. */
export function validSchedule(text) {
  if (typeof text !== 'string' || text.length > 120) return false;
  const parts = text.split(' ');
  if (parts.length !== 5) return false;
  const [minute, hour, ...rest] = parts;
  if (!/^[0-9]{1,2}$/.test(minute) || Number(minute) > 59) return false;
  const hours = hour.split(',');
  if (hours.length < 1 || hours.length > JOB_MAX_HOURS || new Set(hours).size !== hours.length) return false;
  if (!hours.every(item => /^[0-9]{1,2}$/.test(item) && Number(item) <= 23)) return false;
  return rest.every(part => /^[0-9*,/-]{1,30}$/.test(part));
}

/** The host's prompt rule, in words for the owner, or '' when it passes. 1 to 8000 bytes, no control character but newline and tab, no secret-like text. */
export function promptProblem(text) {
  if (typeof text !== 'string' || !text.trim()) return 'The prompt cannot be empty.';
  if (Buffer.byteLength(text, 'utf8') > JOB_PROMPT_MAX_BYTES) return `The prompt is longer than ${JOB_PROMPT_MAX_BYTES} bytes.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return 'The prompt holds a control character.';
  if (/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) return 'The prompt holds a broken character.';
  if (redactSecrets(text).count > 0) return 'The prompt looks like it holds a secret.';
  return '';
}

/** The pin of an exported job as the host stores it: both ids, or both null. A half pin (one without the other) is `null` here and `half: true`. */
export function pinOf(job) {
  const provider = job.provider ?? null;
  const model = job.model ?? null;
  return { provider, model, half: (provider === null) !== (model === null) };
}

/** What the Hub read from the export, for the record and for Go back. A half pin is recorded as none; changes to the pin are refused for such a job. */
export function fromOf(job) {
  const pin = pinOf(job);
  return { schedule: job.schedule, prompt: job.prompt ?? '', provider: pin.half ? null : pin.provider, model: pin.half ? null : pin.model };
}

/**
 * Whether the exported job already is what `change` asks for (only the fields it names); a removed job is one the export no longer lists.
 * The prompt is compared by the hash of the whole prompt, which the exporter sends.
 */
export function jobIs(job, change) {
  const to = change.to ?? {};
  if (change.op === 'remove') return !job;
  if (!job) return false;
  if (change.op === 'pause') return job.enabled === false || job.state === 'paused';
  if (change.op === 'resume') return job.enabled === true && job.state !== 'paused';
  if ('schedule' in to && job.schedule !== to.schedule) return false;
  if ('prompt' in to && job.promptSha256 !== sha256Text(to.prompt)) return false;
  if ('provider' in to && ((job.provider ?? null) !== to.provider || (job.model ?? null) !== to.model)) return false;
  if (change.op === 'add' && job.enabled !== true) return false;
  return true;
}

function cleanPin(block) {
  const { provider, model } = block;
  if (provider === null && model === null) return { provider, model };
  return cleanId(provider) && cleanId(model) ? { provider, model } : null;
}

/**
 * A clean signed job change from the parsed `approved.json`, or null. The shape only: this site wrote the file (the caller has verified the
 * signature) and the host checks it again. → { change, profile, op, job, fromRev, from, to, expires, at, by }
 */
export function validJobChange(raw) {
  if (!isObject(raw) || raw.v !== 1 || raw.kind !== JOB_KIND) return null;
  if (Object.keys(raw).length !== TOP_KEYS.length || !TOP_KEYS.every(name => Object.hasOwn(raw, name))) return null;
  if (typeof raw.change !== 'string' || raw.change !== raw.ask || !JOB_ID_RE.test(raw.change) || raw.profile !== JOB_PROFILE) return null;
  if (!JOB_OPS.includes(raw.op) || typeof raw.job !== 'string' || !JOB_NAME_RE.test(raw.job) || typeof raw.by !== 'string') return null;
  const time = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : '');
  const expires = time(raw.expires);
  const at = time(raw.at);
  if (!expires || !at || typeof raw.fromRev !== 'string' || (raw.op === 'add' ? raw.fromRev !== '' : !/^[0-9a-f]{64}$/.test(raw.fromRev))) return null;
  let from = null;
  if (raw.op !== 'add') {
    if (!isObject(raw.from) || Object.keys(raw.from).length !== FROM_KEYS.length || !FROM_KEYS.every(name => Object.hasOwn(raw.from, name))) return null;
    if (typeof raw.from.schedule !== 'string' || typeof raw.from.prompt !== 'string' || !cleanPin(raw.from)) return null;
    from = { schedule: raw.from.schedule, prompt: raw.from.prompt, provider: raw.from.provider, model: raw.from.model };
  } else if (raw.from !== null) return null;
  let to = null;
  if (raw.op === 'edit' || raw.op === 'add') {
    const allowed = raw.op === 'add' ? ADD_KEYS : EDIT_KEYS;
    if (!isObject(raw.to) || !Object.keys(raw.to).length || !Object.keys(raw.to).every(name => allowed.includes(name))) return null;
    if (('provider' in raw.to) !== ('model' in raw.to)) return null;
    if (raw.op === 'add' && Object.keys(raw.to).length !== ADD_KEYS.length) return null;
    to = { ...raw.to };
    if ('provider' in to && !cleanPin(to)) return null;
    if ('schedule' in to && typeof to.schedule !== 'string') return null;
    if ('prompt' in to && typeof to.prompt !== 'string') return null;
  } else if (raw.to !== null) return null;
  return { change: raw.change, profile: raw.profile, op: raw.op, job: raw.job, fromRev: raw.fromRev, from, to, expires, at, by: raw.by.slice(0, 80) };
}

/** The words for each result code of a job change. `job-check` and `expired` can mean the change is live, so they never say nothing changed. */
export const JOB_FAIL_WORDS = {
  stale: 'The job changed on the host since you opened this.',
  expired: 'The host did not get to it in time. It may still have gone through.',
  'job-check': 'The host could not confirm the change. It may have gone through.',
  'unknown-job': 'The host does not have a job of that name.',
  'bad-signature': CHANGE_CODES['bad-signature'],
  'bad-shape': CHANGE_CODES['bad-shape'],
  'config-write': 'The host could not write its list of removed jobs.',
};

/** What Hermes refused, for the owner: "Hermes refused this prompt." when the prompt was what changed. */
export function refusedWords(change) {
  const to = change.to ?? {};
  if (change.op === 'add' || (change.op === 'edit' && 'prompt' in to && 'schedule' in to)) return 'Hermes refused this change.';
  if ('prompt' in to) return 'Hermes refused this prompt.';
  if ('schedule' in to) return 'Hermes refused this schedule.';
  return 'Hermes refused this change.';
}

export function failWords(change, code) {
  if (code === 'job-refused') return refusedWords(change);
  // On an add, the job exists by the time the removed-names list is written: only that list failed.
  if (code === 'config-write' && change.op === 'add') return 'The job was added, but the host could not update its list of removed jobs.';
  return JOB_FAIL_WORDS[code] ?? 'The host did not apply the change.';
}

/** The title of the alert for a failed change. `job-check` and `expired` can mean it went through, and an add that failed at `config-write` did create the job. */
export function failTitle(change, code) {
  if (code === 'job-check' || code === 'expired') return `The change to ${change.job} could not be confirmed. It may have gone through. Open the job and check its schedule, prompt and model.`;
  if (code === 'config-write' && change.op === 'add') return `The job ${change.job} was added, but the host could not update its list of removed jobs. The job exists. Check it.`;
  return `The change to ${change.job} did not go through: ${failWords(change, code).replace(/\.$/, '')}. The job is as it was.`;
}

/** How long after the host's result a change still holds the job's next press: an export that never shows it must not lock the job for a day. */
export const JOB_OPEN_MS = 20 * 60 * 1000;
/** One rule for the server's press check and the page's form: open while `waiting`, or `applied` for under 20 minutes after the host's result. */
export const changeOpen = ({ state, result = null, at }) => state === 'waiting' || (state === 'applied' && !!result && at.getTime() - Date.parse(result.at) < JOB_OPEN_MS);

/**
 * The jobs the Hub removed, as `Map(name -> time of the host's newest `ok` result for a removal)`. Only a removal with a result saying it applied counts: one
 * with no result yet, or a failed one, says nothing about a job that is gone. The prompt alert also compares this time with its baseline (see `jobPromptChanges`),
 * so an old removal cannot hide a later removal by hand.
 */
export function signedRemovedJobs(changes) {
  const out = new Map();
  for (const item of changes) {
    if (item.change.op !== 'remove' || item.result?.outcome !== 'applied' || item.result.code !== 'ok') continue;
    if (!out.has(item.change.job) || item.result.at > out.get(item.change.job)) out.set(item.change.job, item.result.at);
  }
  return out;
}

/**
 * Where a signed job change stands. `live` wins over `failed` and `late`: when an export made at or after the result (or, with none, after
 * the signing) shows the job as asked, the change is on the host whatever the code says.
 * - waiting: signed, no result yet, not past `expires`
 * - late: past `expires` with no result
 * - failed: the host says it failed and the export does not show the job as asked
 * - applied: the host says it worked; the export does not show it yet
 * - live: an export made at or after shows the job as asked
 */
export function jobChangeState({ change, result = null, exported = null, at }) {
  const mine = result && result.change === change.change ? result : null;
  const job = exported?.profiles?.[JOB_PROFILE]?.cron?.find(item => item.name === change.job);
  const made = exported ? Date.parse(exported.exportedAt) : NaN;
  const since = Date.parse(mine ? mine.at : change.at);
  const shows = exported && Array.isArray(exported.profiles?.[JOB_PROFILE]?.cron) && made >= since && jobIs(job, change);
  if (shows) return 'live';
  if (mine?.outcome === 'failed') return 'failed';
  if (mine) return 'applied';
  return at.getTime() > Date.parse(change.expires) ? 'late' : 'waiting';
}

/** One job change as the page gets it. The prompt text is not sent: `promptChanged` says it moved. */
export function jobChangeView({ change, result = null, landedAt = '', exported = null, at }) {
  const state = jobChangeState({ change, result, exported, at });
  const mine = result && result.change === change.change ? result : null;
  const to = change.to ? { ...(('schedule' in change.to) ? { schedule: change.to.schedule } : {}), ...(('provider' in change.to) ? { provider: change.to.provider, model: change.to.model } : {}), ...(('prompt' in change.to) ? { promptChanged: true } : {}) } : null;
  const from = change.from ? { schedule: change.from.schedule, provider: change.from.provider, model: change.from.model } : null;
  return {
    id: change.change, op: change.op, job: change.job, state, open: changeOpen({ state, result: mine, at }), at: change.at, by: change.by, from, to,
    ...(mine ? { resultAt: mine.at } : {}),
    ...(mine?.outcome === 'applied' ? { runningAt: landedAt || mine.at } : {}),
    ...(state === 'failed' ? { code: mine.code, reason: failWords(change, mine.code) } : {}),
    ...(state === 'late' ? { reason: 'The Hermes host did not pick this up.' } : {}),
  };
}

/** Hashes of every prompt a signed change put in a job: the prompt alert (C) does not treat these as news. */
export const signedPromptHashes = changes => new Set(changes.filter(item => item.change.to && 'prompt' in item.change.to).map(item => sha256Text(item.change.to.prompt)));

/** Whether a prompt in the export can be edited from the page: a cut or redacted one would be stored cut or as `[redacted]`. */
export const promptEditable = job => !job.promptCut && !job.promptRedacted && (job.promptBytes === undefined || job.promptBytes <= CRON_PROMPT_MAX_BYTES);
