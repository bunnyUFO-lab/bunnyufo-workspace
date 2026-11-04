// The `agentEdit` field of an Ask (ws-im1.4.1): an agent's proposal to change one thing of an agent, which only the owner's answer applies.
// No I/O. One validator for the card API (a limited token may not put an ask.json with a bad `agentEdit`), the site (it applies an
// approved edit, hub-agent-edit.mjs) and the cards client (`cards ask create --agent-edit`). The cards client is one file with no
// imports, so it carries a copy of the block below; scripts/cards.test.mjs keeps the two equal. `op: 'profile'` (ws-im1.4.2) proposes the model and fallback order of a Hermes profile.
// The checks that need the Hub's tables (a listed chat model, a text that looks like a secret) are made again when the edit is applied.

// --- agent-edit:start (the same block is in site/api/agent-edit.mjs and site/card-api/cards.mjs; scripts/cards.test.mjs keeps them equal) ---
/**
 * `validateAgentEdit(ask)` returns the problems with an Ask's `agentEdit` field (an empty array when it is good); it never throws.
 * The field is one of two shapes, by `op`:
 *   { op: 'persona', agent, base, role?, prompt?, model?, why? }  at least one of role, prompt and model, the limits of the Edit page, and
 *     `base`, the version the proposal was written against (`default` or a persona-<stamp>-<rand4> id).
 *   { op: 'profile', profile, primary: { provider, model }, fallbacks: [{ provider, model }], why? }  the Hermes profile's model and its fallback
 *     order (0 to 4), every model once. The Hub checks the models against the list the Hermes host published, and the host checks again.
 * The Ask must require a passkey and offer exactly Apply and Leave it. Toolsets, skills, SOUL.md, jobs and the terminal are view-only and refused.
 */
const AGENT_EDIT_PERSONA_KEYS = ['op', 'agent', 'base', 'role', 'prompt', 'model', 'why'];
const AGENT_EDIT_PROFILE_KEYS = ['op', 'profile', 'primary', 'fallbacks', 'why'];
const AGENT_EDIT_VIEW_ONLY = ['toolsets', 'platformToolsets', 'skills', 'soul', 'cron', 'jobs', 'terminal', 'fallbacks', 'provider'];
const AGENT_EDIT_LIMITS = { role: 200, prompt: 8000, why: 400 };
const AGENT_EDIT_PROFILES = ['main', 'briefs'];
const AGENT_EDIT_MAX_FALLBACKS = 4;
const AGENT_EDIT_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
export const AGENT_EDIT_OPTIONS = [{ id: 'apply', label: 'Apply this edit' }, { id: 'skip', label: 'Leave it as it is' }];

export function validateAgentEdit(ask) {
  const problems = [];
  const edit = ask?.agentEdit;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return ['agentEdit is an object'];
  const profile = edit.op === 'profile';
  const keys = profile ? AGENT_EDIT_PROFILE_KEYS : AGENT_EDIT_PERSONA_KEYS;
  const viewOnly = Object.keys(edit).filter(name => AGENT_EDIT_VIEW_ONLY.includes(name) && !keys.includes(name));
  if (viewOnly.length) problems.push(`agentEdit cannot change ${viewOnly.join(', ')}: toolsets, skills, SOUL.md and scheduled jobs are view-only`);
  const extra = Object.keys(edit).filter(name => !keys.includes(name) && !AGENT_EDIT_VIEW_ONLY.includes(name));
  if (extra.length) problems.push(`agentEdit has no field ${extra.slice(0, 3).join(', ')}`);
  if (edit.op !== 'persona' && !profile) problems.push('agentEdit.op is persona or profile');
  const text = (name, max, multiline) => {
    const value = edit[name];
    if (value === undefined) return;
    if (typeof value !== 'string' || !value.trim() || value.length > max) problems.push(`agentEdit.${name} is 1 to ${max} characters of text`);
    else if ((multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/ : /[\u0000-\u001f\u007f\u2028\u2029]/).test(value)) problems.push(`agentEdit.${name} has a control character`);
  };
  text('why', AGENT_EDIT_LIMITS.why, false);
  if (profile) {
    if (!AGENT_EDIT_PROFILES.includes(edit.profile)) problems.push(`agentEdit.profile is ${AGENT_EDIT_PROFILES.join(' or ')}`);
    const model = item => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 2 && AGENT_EDIT_MODEL_ID.test(item.provider ?? '') && AGENT_EDIT_MODEL_ID.test(item.model ?? '');
    if (!model(edit.primary)) problems.push('agentEdit.primary is { provider, model }');
    if (!Array.isArray(edit.fallbacks) || edit.fallbacks.length > AGENT_EDIT_MAX_FALLBACKS || !edit.fallbacks.every(model)) problems.push(`agentEdit.fallbacks is a list of 0 to ${AGENT_EDIT_MAX_FALLBACKS} { provider, model }`);
    else if (model(edit.primary)) {
      const names = [edit.primary, ...edit.fallbacks].map(item => `${item.provider}/${item.model}`);
      if (new Set(names).size !== names.length) problems.push('agentEdit lists a model twice: the primary and each fallback are different');
    }
  } else {
    if (typeof edit.agent !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(edit.agent)) problems.push('agentEdit.agent is an agent id');
    if (typeof edit.base !== 'string' || !(edit.base === 'default' || /^persona-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}$/.test(edit.base))) problems.push('agentEdit.base is the version the edit was written against: default, or a persona-<stamp>-<rand4> id');
    text('role', AGENT_EDIT_LIMITS.role, false);
    text('prompt', AGENT_EDIT_LIMITS.prompt, true);
    if (edit.model !== undefined && (typeof edit.model !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,39}$/.test(edit.model))) problems.push('agentEdit.model is a chat model id');
    if (edit.role === undefined && edit.prompt === undefined && edit.model === undefined) problems.push('agentEdit changes the role, the prompt or the model');
  }
  if (ask.requirePasskey !== true) problems.push('an Ask with agentEdit requires a passkey (--require-passkey)');
  const options = ask.options;
  if (!Array.isArray(options) || options.length !== 2 || options.some((option, index) => option?.id !== AGENT_EDIT_OPTIONS[index].id || option?.label !== AGENT_EDIT_OPTIONS[index].label || Object.keys(option).length !== 2)) {
    problems.push('an Ask with agentEdit offers exactly the options apply ("Apply this edit") and skip ("Leave it as it is")');
  }
  if (ask.changes !== undefined || ask.decisions !== undefined || ask.image !== undefined || ask.avatar !== undefined || ask.rerun !== undefined) problems.push('an Ask with agentEdit has no changes, decisions, image, avatar or rerun');
  return problems;
}
// --- agent-edit:end ---
