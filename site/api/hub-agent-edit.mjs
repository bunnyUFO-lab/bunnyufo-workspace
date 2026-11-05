// What an answer to an agent-edit Ask does (ws-im1.4.1, ws-im1.4.2). An Ask with an `agentEdit` field is a proposal to change one thing of an agent.
// Nothing changes until the owner answers Apply this edit over the web, behind the passkey:
//
//   op persona   one new persona version (role line, prompt, chat model), written by the Hub with `fromAsk` and `by: <the owner>`
//   op profile   a signed change of a Hermes profile's model and fallback order: create-only `agent-config/changes/<ask id>/approved.json`
//                for the Hermes host to apply (the format is in docs/workspaces.md, "Profile changes"). The site never reaches into the host.
//   skip         nothing
//
// The Ask is an agent's file (or, for a profile, the Hub's own: `createProfileAsk`), so `agentEdit` is only a proposal: every claim in it is checked
// here before anything is written (the shape in agent-edit.mjs, the limits and the secret check again in hub-personas.mjs, the models against the
// host's own published list for a profile). The answer is already stored when `afterAnswer` runs; nothing here can undo or fail it. Only the web
// route calls it. The Discord route never does, and discordEligible refuses these Asks outright.
import { AGENT_EDIT_OPTIONS, validateAgentEdit } from './agent-edit.mjs';
import { effectiveSet, exportFreshness, changeState } from './hub-agent-config.mjs';
import { AGENTS } from './hub-team.mjs';
import { day8, randomId } from './hub-model.mjs';
import { newNonce, sign } from './signing.mjs';

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const HOUR = 3600 * 1000;
/**
 * How long the host has to apply a signed change: a press means now. Covers the host's 5-minute tick and a `briefs` wait, except a press in the first minutes of the hour-long Monday and Thursday wait, which ends `expired`;
 * the host accepts any lifetime up to 24 h 5 min and reports `expired` for a change it finds late.
 */
export const CHANGE_VALID_MS = HOUR;
const ASK_VALID_MS = 24 * HOUR;
/** How long a change takes, in the words of the Edit page, the Ask page and the Ask text (the page keeps a copy in src/hub/profileChangeWords.ts). */
export const CHANGE_TIME_TEXT = "Usually done in about a minute, at most 5 if the host's quick check is off.";
export const restartText = profile => `Changing this restarts Hermes ${profile}. ${CHANGE_TIME_TEXT} A chat or job running then stops.`;
const problem = (message, status = 409) => Object.assign(new Error(message), { status });

const refOf = item => `${item.provider} · ${item.model}`;
const chainOf = set => [set, ...set.fallbacks].map(refOf).join(', then ');
const sameSet = (a, b) => a.provider === b.provider && a.model === b.model && a.fallbacks.length === b.fallbacks.length
  && a.fallbacks.every((item, index) => item.provider === b.fallbacks[index].provider && item.model === b.fallbacks[index].model);
const sharedBy = (profile, agents) => agents.filter(agent => agent.profile === profile).map(agent => agent.name);
const listed = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * @param personas  the persona store (hub-personas.mjs): `versions(agent)`, `save(agent, raw, user, at, { fromAsk })`
 * @param profiles  the Hermes profile side, from hub.mjs (absent in a test of personas alone):
 *                  `signingKey` (null: Apply is off), `exported(at)` (the newest valid export or null), `changes(profile, at)` ([{ change, result }], newest first),
 *                  `putApproval(id, doc)` and `putAsk(id, ask)` (create-only; throw the `conflict` they are given on a name that exists)
 * @param agents    `() => agents`: the agents of the app and the personas the owner made, for who shares a profile (default: the app's)
 * @param log       one-line log
 */
export function createAgentEdits({ personas, profiles = null, agents = async () => AGENTS, log = () => {} }) {
  const no = why => ({ applied: false, why });

  /**
   * What a profile edit would change, or a refusal with words for the owner (status 409). The same checks run when the Ask is made and again when
   * it is approved: a signing key; a fresh export of the host; every model in that export's own list; something different from what the host has now;
   * no earlier change of this profile still waiting for the host. `from` is read from the export at this moment, never from the Ask.
   */
  async function checkProfile(edit, at) {
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
      if (!options.some(option => option.provider === item.provider && option.model === item.model)) throw problem(`${refOf(item)} is not a model the Hermes host offers for this profile.`);
    }
    // What the profile runs now: the export, or a change the host confirmed after that export was made.
    const from = effectiveSet(exported, edit.profile, changes);
    if (from.fallbacks.length > 4) throw problem('The profile has more than four fallbacks now, which this page does not change.');
    // The old order is signed too, and Details shows it: a model listed twice there would be signed and never shown.
    if (new Set([from, ...from.fallbacks].map(refOf)).size !== from.fallbacks.length + 1) throw problem('The profile lists a model twice now, which this page does not change. Fix it on the host first.');
    if (sameSet(from, to)) throw problem('That is what the profile uses already.');
    const waiting = changes.find(item => changeState({ change: item.change, result: item.result, exported, at }) === 'waiting');
    if (waiting) throw problem(`A change of the ${edit.profile} profile is still waiting for the Hermes host (${waiting.change.change}).`);
    return { from, to, exported };
  }

  /** The Ask text for a profile edit: old and new order, who shares the profile, and what the restart costs. */
  function profileAsk({ edit, from, to, sharers, user, at }) {
    const id = `${day8(at)}-profile-${edit.profile}-${randomId(4)}`;
    return {
      id, project: 'workspace-app', createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + ASK_VALID_MS).toISOString(),
      from: { tool: 'hub' },
      question: `Change the model of the Hermes ${edit.profile} profile?`,
      context: [
        `Now: ${chainOf(from)}.`, `New: ${chainOf(to)}.`,
        `The profile ${edit.profile} is shared by ${listed(sharedBy(edit.profile, sharers))}.`,
        restartText(edit.profile),
        ...(user ? [`Asked by ${user}.`] : []),
      ].join('\n'),
      options: AGENT_EDIT_OPTIONS.map(option => ({ ...option })), allowNote: false, allowDrawing: false, kind: 'approval', requirePasskey: true,
      agentEdit: { op: 'profile', profile: edit.profile, primary: { ...edit.primary }, fallbacks: edit.fallbacks.map(item => ({ ...item })), ...(edit.why ? { why: edit.why } : {}) },
    };
  }

  /**
   * The owner's request from the Edit page (hub.mjs checked the body): writes the Ask `asks/<id>/ask.json` itself, the one Ask the site writes, and
   * returns `{ ask: <id>, from, to }`. Throws an error with `status` when the change cannot be asked for. No ping: the owner is on the page.
   */
  async function createProfileAsk({ edit, user, at }) {
    const { from, to } = await checkProfile(edit, at);
    const sharers = await agents();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const ask = profileAsk({ edit, from, to, sharers, user, at });
      const problems = validateAgentEdit(ask);
      if (problems.length) throw problem(`This edit cannot be asked for: ${problems.slice(0, 3).join('; ')}.`, 400);
      try {
        await profiles.putAsk(ask.id, ask);
        return { ask: ask.id, from, to };
      } catch (error) {
        if (error?.conflict !== true) throw error;
      }
    }
    throw problem('Could not pick a free name for the Ask; try again.');
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

  /** A profile edit, answered Apply: signs the change and stores it create-only. The host does the rest. */
  async function applyProfile({ ask, user, at }) {
    if (!user) return no('Sign in to apply an edit.');
    const edit = ask.agentEdit;
    const { from, to } = await checkProfile(edit, at);
    const doc = sign({
      v: 1, kind: 'profile-change', change: ask.id, profile: edit.profile, from, to,
      expires: new Date(at.getTime() + CHANGE_VALID_MS).toISOString(), nonce: newNonce(), at: at.toISOString(), by: user, ask: ask.id,
    }, profiles.signingKey);
    await profiles.putApproval(ask.id, doc);
    return { applied: true, profile: edit.profile, change: ask.id, expires: doc.expires };
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

  return { afterAnswer, blockedReason, createProfileAsk };
}
