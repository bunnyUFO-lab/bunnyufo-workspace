// What an answer to an agent-edit Ask does (ws-im1.4.1). An Ask with an `agentEdit` field is an agent's proposal to change a chat persona
// (role line, prompt, chat model). Nothing changes until the owner answers Apply this edit over the web, behind the passkey:
//
//   apply  one new persona version, written by the Hub with `fromAsk` and `by: <the owner>`, if the edit was written against the version that is still current
//   skip   nothing
//
// The Ask is an agent's file, so `agentEdit` is only a proposal: every claim in it is checked here before anything is written (the shape in
// agent-edit.mjs, the limits and the secret check again in hub-personas.mjs). The answer is already stored when `afterAnswer` runs; nothing here
// can undo or fail it. Only the web route calls it. The Discord route never does, and discordEligible refuses these Asks outright.
import { validateAgentEdit } from './agent-edit.mjs';

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * @param personas  the persona store (hub-personas.mjs): `versions(agent)`, `save(agent, raw, user, at, { fromAsk })`
 * @param log       one-line log
 */
export function createAgentEdits({ personas, log = () => {} }) {
  const no = why => ({ applied: false, why });

  /** Why the Ask cannot be applied as it stands, in words for the owner, or null. Never throws. */
  async function blockedReason(ask) {
    try {
      if (!ask || ask.agentEdit === undefined) return null;
      const problems = validateAgentEdit(ask);
      if (problems.length) return `This edit cannot be applied: ${problems.slice(0, 3).join('; ')}.`;
      const view = await personas.versions(ask.agentEdit.agent);
      if (view.current.version !== ask.agentEdit.base) return 'This persona changed after the edit was written, so Apply would be refused. Ask the agent for a new edit, or make the change on the Edit page.';
      return null;
    } catch (error) {
      return error?.status === 404 ? 'This agent has no persona to edit.' : null;
    }
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

  return { afterAnswer, blockedReason };
}
