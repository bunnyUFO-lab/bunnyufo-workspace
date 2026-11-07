// What an answer to an agent-edit Ask does (ws-im1.4.1, ws-im1.4.2), and the owner's own press on the Edit page (ws-ubo.4).
//
// An Ask with an `agentEdit` field is an AGENT's proposal to change one thing of an agent. Nothing changes until the owner answers Apply this edit
// over the web, behind the passkey:
//
//   op persona   one new persona version (role line, prompt, chat model), written by the Hub with `fromAsk` and `by: <the owner>`
//   op profile   a signed change of a Hermes profile's model and fallback order: create-only `agent-config/changes/<ask id>/approved.json`
//                for the Hermes host to apply (the format is in docs/workspaces.md, "Profile changes"). The site never reaches into the host.
//   skip         nothing
//
// The signed-in owner's press on the Edit page needs no Ask: `applyDirect` and `undo` sign the same file with the same `signChange`. They are called
// only by the web route that checked the request came through the login proxy from the app's own origin (hub.mjs, `requestProfileChange`). Nothing
// that an agent holds reaches that route, and an agent's Ask never goes through it: only `afterAnswer` (the owner's Apply) signs for an Ask.
// `signChange` and `signFile` are internal. Do not export them. `applyJobDirect` and `undoJob` sign a `job-change` (hub-job-change.mjs, the
// Schedules page) the same way, from a web route of its own that shares the press's guard; an agent's Ask never signs one in this file.
//
// The Ask is an agent's file, so `agentEdit` is only a proposal: every claim in it is checked
// here before anything is written (the shape in agent-edit.mjs, the limits and the secret check again in hub-personas.mjs, the models against the
// host's own published list for a profile). The answer is already stored when `afterAnswer` runs; nothing here can undo or fail it. Only the web
// route calls it. The Discord route never does, and discordEligible refuses these Asks outright.
import { validateAgentEdit } from './agent-edit.mjs';
import { effectiveSet, exportFreshness, changeState } from './hub-agent-config.mjs';
import { day8, randomId } from './hub-model.mjs';
import { newNonce, sign } from './signing.mjs';
import { changeOpen, fromOf, JOB_KIND, JOB_NAME_RE, JOB_OPS, JOB_PROFILE, jobChangeState, jobIs, pinOf, promptEditable, promptProblem, sha256Text, TARGET_RE, validSchedule } from './hub-job-change.mjs';

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/**
 * How long the host has to apply a signed change: a press means now. 70 minutes cover the longest `briefs` wait (60 minutes on Monday and Thursday)
 * and the 5-minute tick after it; the host accepts any lifetime up to 24 h 5 min (`MAX_LIFETIME` in its `check_shape`) and reports `expired` for a change it finds late.
 */
export const CHANGE_VALID_MS = 70 * 60 * 1000;
/** How long a change takes, in the words of the Edit page, the Ask page and the Ask text (the page keeps a copy in src/hub/profileChangeWords.ts). */
export const CHANGE_TIME_TEXT = "Usually done in about a minute, at most 5 if the host's quick check is off.";
export const STALE_TEXT = 'The settings changed while you were looking. Reload.';
const problem = (message, status = 409) => Object.assign(new Error(message), { status });

const refOf = item => `${item.provider} · ${item.model}`;
const sameSet = (a, b) => a.provider === b.provider && a.model === b.model && a.fallbacks.length === b.fallbacks.length
  && a.fallbacks.every((item, index) => item.provider === b.fallbacks[index].provider && item.model === b.fallbacks[index].model);

/**
 * @param personas  the persona store (hub-personas.mjs): `versions(agent)`, `save(agent, raw, user, at, { fromAsk })`
 * @param profiles  the Hermes profile side, from hub.mjs (absent in a test of personas alone):
 *                  `signingKey` (null: Apply is off), `exported(at)` (the newest valid export or null), `changes(profile, at)` ([{ change, result }], newest first),
 *                  `putApproval(id, doc)` (create-only; throws an error with `conflict: true` on a name that exists)
 * @param log       one-line log
 */
export function createAgentEdits({ personas, profiles = null, log = () => {} }) {
  const no = why => ({ applied: false, why });

  /**
   * What a profile edit would change, or a refusal with words for the owner (status 409). The same checks run when the Ask is made and again when
   * it is approved: a signing key; a fresh export of the host; every model in that export's own list; something different from what the host has now;
   *    * no earlier change of this profile still waiting for the host. `from` is read from the export at this moment, never from the Ask.
   * `base` (the owner's press): the order the page showed as current; another `from` is a 409, so a stale tab cannot press. `also` (a way back only):
   * models that need not be in the host's list because they come from a signed `from` of the change being undone; the host's own check still decides.
   */
  async function checkProfile(edit, at, { base = null, also = [] } = {}) {
    if (!profiles?.signingKey) throw problem('Changing a model is off: the server has no signing key.');
    const exported = await profiles.exported(at);
    const block = exported?.profiles[edit.profile];
    if (!exported || !block) throw problem('The Hermes host has not published its settings yet.');
    if (exportFreshness(exported, at) !== 'fresh') throw problem('The last export from the Hermes host is old, so its settings may have changed. Wait for a new one.');
    if (!block.model?.provider || !block.model?.default) throw problem('The Hermes host did not say which model this profile uses now.');
    const changes = await profiles.changes(edit.profile, at);
    const options = block.modelOptions;
    if (!options?.length) throw problem('The Hermes host has not published its model list yet.');
    const to = { ...edit.primary, fallbacks: edit.fallbacks.map(item => ({ ...item })) };
    for (const item of [to, ...to.fallbacks]) {
      const offered = options.some(option => option.provider === item.provider && option.model === item.model) || also.some(option => option.provider === item.provider && option.model === item.model);
      if (!offered) throw problem(`${refOf(item)} is not a model the Hermes host offers for this profile.`);
    }
    // What the profile runs now: the export, or a change the host confirmed after that export was made.
    const from = effectiveSet(exported, edit.profile, changes);
    if (from.fallbacks.length > 4) throw problem('The profile has more than four fallbacks now, which this page does not change.');
    // The old order is signed too, and Details shows it: a model listed twice there would be signed and never shown.
    if (new Set([from, ...from.fallbacks].map(refOf)).size !== from.fallbacks.length + 1) throw problem('The profile lists a model twice now, which this page does not change. Fix it on the host first.');
    if (base && !sameSet(from, base)) throw problem(STALE_TEXT);
    if (sameSet(from, to)) throw problem('That is what the profile uses already.');
    const waiting = changes.find(item => changeState({ change: item.change, result: item.result, exported, at }) === 'waiting');
    if (waiting) throw problem(`A change of the ${edit.profile} profile is still waiting for the Hermes host (${waiting.change.change}).`);
    return { from, to, exported };
  }

  /** Why the Ask cannot be applied as it stands, in words for the owner, or null. Never throws. */
  async function blockedReason(ask, at = new Date()) {
    try {
      if (!ask || ask.agentEdit === undefined) return null;
      const problems = validateAgentEdit(ask);
      if (problems.length) return `This edit cannot be applied: ${problems.slice(0, 3).join('; ')}.`;
      if (ask.agentEdit.op === 'profile') {
        await checkProfile(ask.agentEdit, at);
        return null;
      }
      const view = await personas.versions(ask.agentEdit.agent);
      if (view.current.version !== ask.agentEdit.base) return 'This persona changed after the edit was written, so Apply would be refused. Ask the agent for a new edit, or make the change on the Edit page.';
      return null;
    } catch (error) {
      if (error?.status === 404) return 'This agent has no persona to edit.';
      return error?.status === 409 ? error.message : null;
    }
  }

  /**
   * The one place a profile change is signed. The format is the host's and does not change, key for key: `ask` equals `change` because the host's exact-keys
   * check and `validChange` require it, even for an owner's press, which has no Ask. Nothing on the host learns which flow a change came from.
   */
  async function signChange({ id, edit, from, to, user, at }) {
    return await signFile(id, { kind: 'profile-change', profile: edit.profile, from, to }, user, at);
  }

  /** The tail every signed file shares: the common keys, the signature and the create-only store. */
  async function signFile(id, fields, user, at) {
    const doc = sign({
      v: 1, ...fields, change: id,
      expires: new Date(at.getTime() + CHANGE_VALID_MS).toISOString(), nonce: newNonce(), at: at.toISOString(), by: user, ask: id,
    }, profiles.signingKey);
    await profiles.putApproval(id, doc);
    return doc;
  }

  // One check-and-sign at a time per profile in this process; should it ever miss, the host answers `stale`.
  const queues = new Map();
  async function locked(profile, run) {
    const before = queues.get(profile) ?? Promise.resolve();
    const mine = before.then(run);
    const tail = mine.catch(() => {});
    queues.set(profile, tail);
    try { return await mine; } finally { if (queues.get(profile) === tail) queues.delete(profile); }
  }

  /** A profile edit, answered Apply (an agent's Ask): signs the change and stores it create-only. The host does the rest. */
  async function applyProfile({ ask, user, at }) {
    if (!user) return no('Sign in to apply an edit.');
    const edit = ask.agentEdit;
    return await locked(edit.profile, async () => {
      const { from, to } = await checkProfile(edit, at);
      const doc = await signChange({ id: ask.id, edit, from, to, user, at });
      return { applied: true, profile: edit.profile, change: ask.id, expires: doc.expires };
    });
  }

  async function signNew({ edit, from, to, user, at }) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = `${day8(at)}-profile-${edit.profile}-${randomId(4)}`;
      try {
        await signChange({ id, edit, from, to, user, at });
        return id;
      } catch (error) {
        if (error?.conflict !== true) throw error;
      }
    }
    throw problem('Could not pick a free name for the change; try again.');
  }

  /**
   * The signed-in owner's press: signs at once, with no Ask. The caller (hub.mjs) has checked the request. `edit` is `{ profile, primary, fallbacks }`,
   * `base` the order the page showed as current.
   * @returns {Promise<{ change: string, from: object, to: object }>}
   */
  async function applyDirect({ edit, base, user, at }) {
    if (!user) throw problem('Sign in to change a model.', 401);
    return await locked(edit.profile, async () => {
      const { from, to } = await checkProfile(edit, at, { base });
      return { change: await signNew({ edit, from, to, user, at }), from, to };
    });
  }

  /**
   * The way back: signs the order that `changeId` replaced. It must be the newest change of this profile, a signed one the Hub's own loader returned,
   * with an `ok` result, and still what runs. `to` comes from that signed file, never from the caller; its models may be outside the host's list
   * (`also`), and the host's own check decides.
   */
  async function undo({ profile, changeId, base, user, at }) {
    if (!user) throw problem('Sign in to change a model.', 401);
    return await locked(profile, async () => {
      const newest = (await profiles.changes(profile, at))[0];
      if (!newest || newest.change.change !== changeId || newest.change.profile !== profile) throw problem('Only the newest change can be undone. Reload.');
      if (newest.result?.outcome !== 'applied' || newest.result.code !== 'ok') throw problem('That change did not finish, so there is nothing to go back from.');
      const back = newest.change.from;
      const edit = { op: 'profile', profile, primary: { provider: back.provider, model: back.model }, fallbacks: back.fallbacks.map(item => ({ ...item })) };
      const { from, to } = await checkProfile(edit, at, { base, also: [back, ...back.fallbacks] });
      // A host edit after the change replaced it: going back would undo that edit, so the owner picks the order from the list instead.
      if (!sameSet(from, newest.change.to)) throw problem('That change no longer runs, because the settings were changed after it. Pick the order from the list.');
      return { change: await signNew({ edit, from, to, user, at }), from, to, undoOf: changeId };
    });
  }

  /**
   * Called right after the create-only `answer.json` is written on the web path. Returns what to add to the response as `agentEdit`, or
   * null when the Ask has no such field or the answer changes nothing. Never throws.
   */
  async function afterAnswer({ ask, answer, user, at }) {
    if (!ask || ask.agentEdit === undefined || !answer?.choice) return null;
    if (answer.choice !== 'apply') return null;
    try {
      const problems = validateAgentEdit(ask);
      if (problems.length) return no(`This edit cannot be applied: ${problems.slice(0, 3).join('; ')}.`);
      if (ask.agentEdit.op === 'profile') return await applyProfile({ ask, user, at });
      if (!user) return no('Sign in to apply an edit.');
      const edit = ask.agentEdit;
      const view = await personas.versions(edit.agent);
      if (view.current.version !== edit.base) return no('This persona changed after the edit was written, so nothing was applied.');
      const saved = await personas.save(edit.agent, {
        role: edit.role ?? view.current.role, prompt: edit.prompt ?? view.current.prompt, model: edit.model ?? view.current.model,
        note: clip(edit.why ? `Agent edit: ${edit.why}` : 'Agent edit', 200), base: edit.base,
      }, user, at, { fromAsk: ask.id });
      return { applied: true, version: saved.version };
    } catch (error) {
      log(`[hub] agent edit for ${ask.id} failed: ${error.message}`);
      return no(error?.status && error.status < 500 ? error.message : 'That did not work.');
    }
  }

  // --- job changes (ws-eh2 G) ---

  const TO_KEYS = ['schedule', 'prompt', 'provider', 'model'];
  const bad = message => problem(message, 400);

  function checkPin(to, options, also) {
    if (to.provider === null && to.model === null) return;
    if (typeof to.provider !== 'string' || typeof to.model !== 'string') throw bad('A model is two ids, or both empty to follow the profile.');
    const offered = [...options, ...also].some(option => option.provider === to.provider && option.model === to.model);
    if (!offered) throw problem(`${to.provider} · ${to.model} is not a model the Hermes host offers for this profile.`);
  }

  /**
   * What a job change would do, or a refusal with words (400 for a body that is wrong, 409 for a state that is). A press and a way back run the same checks:
   * a signing key; a fresh export; `jobEdits` on the briefs block; the job in that export; `base` equal to its `rev` (the signed `fromRev` is the export's, never the body's);
   * a real change; nothing of this job still waiting. `from` is read from the export at this moment. `also`: models that need not be in the host's list
   * (a way back, whose model comes from a signed `from`); the host's own check still decides.
   */
  async function checkJob({ op, job, base, to, at, also = [] }) {
    if (!profiles?.signingKey) throw problem('Changing a job is off: the server has no signing key.');
    if (!JOB_OPS.includes(op)) throw bad('That is not a job operation.');
    if (typeof job !== 'string' || !JOB_NAME_RE.test(job)) throw bad('That is not a job name.');
    const exported = await profiles.exported(at);
    const block = exported?.profiles[JOB_PROFILE];
    if (!exported || !block) throw problem('The Hermes host has not published its settings yet.');
    if (exportFreshness(exported, at) !== 'fresh') throw problem('The last export from the Hermes host is old, so its jobs may have changed. Wait for a new one.');
    if (block.jobEdits !== true) throw problem('This needs an update on the Hermes host first.');
    const live = (block.cron ?? []).find(item => item.name === job) ?? null;
    const options = block.modelOptions ?? [];
    let fromRev = '';
    let from = null;
    let out = null;
    if (op === 'add') {
      if (base !== '') throw bad('A new job has no version to compare.');
      if (live) throw problem('A job with that name exists already.');
      if (!to || typeof to !== 'object' || Array.isArray(to) || Object.keys(to).sort().join() !== 'model,postsTo,prompt,provider,schedule') throw bad('A new job needs a schedule, prompt, place to post and model.');
      if (!validSchedule(to.schedule)) throw bad(SCHEDULE_TEXT);
      const why = promptProblem(to.prompt);
      if (why) throw bad(why);
      if (to.prompt.startsWith('-')) throw bad('The prompt cannot start with a dash.');
      if (typeof to.postsTo !== 'string' || !TARGET_RE.test(to.postsTo) || !(block.deliverOptions ?? []).some(item => item.id === to.postsTo)) throw problem('The Hermes host does not offer that place to post.');
      checkPin(to, options, also);
      out = { schedule: to.schedule, prompt: to.prompt, postsTo: to.postsTo, provider: to.provider, model: to.model };
    } else {
      if (!live) throw problem('The Hermes host does not list that job any more. Reload.');
      if (!live.rev) throw problem("The Hermes host did not send this job's version yet.");
      fromRev = live.rev;
      if (typeof base !== 'string' || base !== fromRev) throw problem(JOB_STALE_TEXT);
      from = fromOf(live);
      if (op === 'edit') {
        if (!to || typeof to !== 'object' || Array.isArray(to) || !Object.keys(to).length || !Object.keys(to).every(name => TO_KEYS.includes(name))) throw bad('A job edit changes the schedule, prompt or model.');
        if (('provider' in to) !== ('model' in to)) throw bad('The provider and the model come together.');
        out = {};
        if ('schedule' in to) {
          if (!validSchedule(to.schedule)) throw bad(SCHEDULE_TEXT);
          if (to.schedule !== live.schedule) out.schedule = to.schedule;
        }
        if ('prompt' in to) {
          const why = promptProblem(to.prompt);
          if (why) throw bad(why);
          if (!promptEditable(live)) throw problem('This prompt was cut or had secret-like text replaced in the export, so it cannot be edited here.');
          if (!live.promptSha256) throw problem("The Hermes host did not send this prompt's hash yet.");
          if (sha256Text(to.prompt) !== live.promptSha256) out.prompt = to.prompt;
        }
        if ('provider' in to) {
          checkPin(to, options, also);
          const pin = pinOf(live);
          if (pin.half) throw problem('This job has a model without a provider, or the other way round, which this page does not change. Fix it on the host first.');
          if (to.provider !== pin.provider || to.model !== pin.model) Object.assign(out, { provider: to.provider, model: to.model });
        }
        if (!Object.keys(out).length) throw problem('That is what the job has already.');
      } else {
        if (to !== undefined && to !== null) throw bad('This operation has nothing to change.');
        const on = live.enabled === true && live.state !== 'paused';
        if (op === 'pause' && !on) throw problem('The job is paused already.');
        if (op === 'resume' && on) throw problem('The job is on already.');
      }
    }
    // A change not yet in the export would make the next one a `stale` on the host: wait for the export, up to 20 minutes after the host's result.
    const open = (await profiles.jobChanges(at)).filter(item => item.change.job === job).find(item => {
      const state = jobChangeState({ change: item.change, result: item.result, exported, at });
      return changeOpen({ state, result: item.result, at });
    });
    if (open) throw problem(`A change of the job ${job} is still waiting for the Hermes host (${open.change.change}).`);
    return { op, job, fromRev, from, to: out, live };
  }

  async function signJob(checked, user, at) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = `${day8(at)}-job-${JOB_PROFILE}-${randomId(4)}`;
      try {
        await signFile(id, { kind: JOB_KIND, profile: JOB_PROFILE, op: checked.op, job: checked.job, fromRev: checked.fromRev, from: checked.from, to: checked.to }, user, at);
        return id;
      } catch (error) {
        if (error?.conflict !== true) throw error;
      }
    }
    throw problem('Could not pick a free name for the change; try again.');
  }

  /**
   * The signed-in owner's press on a job: signs at once, with no Ask. The caller (hub.mjs, the job-change route) has checked the request.
   * `{ op, job, base, to }`; `base` is the `rev` the page showed ('' for add). `nextRunAt` is what the export said before, for "Next run moved".
   */
  async function applyJobDirect({ op, job, base, to, user, at }) {
    if (!user) throw problem('Sign in to change a job.', 401);
    return await locked('jobs', async () => {
      const checked = await checkJob({ op, job, base, to, at });
      return { change: await signJob(checked, user, at), op, job, from: checked.from, to: checked.to, nextRunAt: checked.live?.nextRunAt ?? null };
    });
  }

  /**
   * The way back of a job: the newest change of that job, one the Hub signed (the loader verified it), with an `ok` result, and still what runs. The values come
   * from its signed `from`, for the fields it changed only. A removal or a new job has none.
   */
  async function undoJob({ changeId, base, user, at }) {
    if (!user) throw problem('Sign in to change a job.', 401);
    return await locked('jobs', async () => {
      const all = await profiles.jobChanges(at);
      const target = all.find(item => item.change.change === changeId);
      if (!target) throw problem('That is not a change of a job. Reload.');
      if (all.find(item => item.change.job === target.change.job).change.change !== changeId) throw problem('Only the newest change of a job can be undone. Reload.');
      if (target.result?.outcome !== 'applied' || target.result.code !== 'ok') throw problem('That change did not finish, so there is nothing to go back from.');
      const change = target.change;
      if (!['edit', 'pause', 'resume'].includes(change.op)) throw problem('A removal or a new job has no way back from here.');
      const live = (await profiles.exported(at))?.profiles[JOB_PROFILE]?.cron?.find(item => item.name === change.job);
      if (!jobIs(live, change)) throw problem('That change no longer runs, because the job was changed after it. Edit the job instead.');
      let op = change.op;
      let to;
      if (op === 'pause') op = 'resume';
      else if (op === 'resume') op = 'pause';
      else {
        to = {};
        if ('schedule' in change.to) to.schedule = change.from.schedule;
        if ('prompt' in change.to) to.prompt = change.from.prompt;
        if ('provider' in change.to) Object.assign(to, { provider: change.from.provider, model: change.from.model });
      }
      const also = change.from.provider ? [{ provider: change.from.provider, model: change.from.model }] : [];
      const checked = await checkJob({ op, job: change.job, base, to, at, also });
      return { change: await signJob(checked, user, at), op, job: change.job, from: checked.from, to: checked.to, nextRunAt: checked.live?.nextRunAt ?? null, undoOf: changeId };
    });
  }

  return { afterAnswer, blockedReason, applyDirect, undo, applyJobDirect, undoJob };
}

const SCHEDULE_TEXT = 'That schedule is not allowed. It needs five fields, one minute and up to four hours, so a job runs at most four times a day.';
export const JOB_STALE_TEXT = 'The job changed on the host since you opened this. Reload.';
