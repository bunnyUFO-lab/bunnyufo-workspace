// The agent list, their statuses and the owner's avatar choices for the Team screen.
// Pure: no S3, no clock of its own. `hub.mjs` gathers the inputs and calls in.
//
// The agent list is app code (a later milestone adds an entry when an agent gets work). The only
// stored data is the owner's avatar choice: create-only `team/<agent>/avatar-<stamp>-<rand4>.json`
// files, written by the Hub (owner-only in the card API), newest name wins. A choice may name a
// custom pet sheet (hub-sheets.mjs) with its sha256; it counts only while that sheet still passes.
import { SHEET_ID_RE } from './hub-sheets.mjs';
// The chat model labels are those of chat-models.mjs: the Team card names the model an edited persona starts a chat on.
import { CHAT_MODELS } from './chat-models.mjs';
import { exportFreshness } from './hub-agent-config.mjs';

/** Mirrors `BUILTIN_KEYS` in src/hub/team/sprites.ts; site/api/test/hub-team.test.mjs keeps them equal. */
export const BUILTIN_KEYS = ['hermes', 'briefs', 'researcher', 'librarian', 'architect', 'developer', 'reviewer', 'qa', 'artist', 'lib_b', 'lib_c', 'lib_d', 'dev_teal', 'qa_violet', 'owl_snow', 'artist_blue', 'arch_red'];

/** Checked against the Hermes profile docs (services/assistant.md in the homelab repo) on 2026-10-29. */
export const AGENTS = [
  { id: 'hermes', profile: 'main', name: 'Hermes', room: 'Command', runtime: 'Hermes profile main', model: 'Codex gpt-6-sol · Sonnet, then DeepSeek fallback', role: 'chats, plans and dispatches', action: { label: 'Chat', chat: 'hermes' } },
  { id: 'briefs', profile: 'briefs', name: 'Briefs', room: 'Ops', runtime: 'Hermes profile briefs', model: 'Haiku 5.5 · DeepSeek fallback', role: 'daily brief and weekly digests', presets: ['projects-brief'], action: { label: 'Run now', preset: 'projects-brief', project: 'workspace-app', text: 'Write the daily projects brief now.' } },
  { id: 'claude', profile: null, name: 'Claude Code', room: 'Build', runtime: 'Claude Code on the Gaming PC', model: 'Max plan', role: 'your sessions on the PC', action: { label: 'Start a run', preset: 'code-task' } },
  // The three research agents are Hermes runs. `presets` are the Spawn presets each one takes (Details shows the first one's template).
  // `action` is the one main button of the card: `{ label, chat }` opens Chat on that persona, `{ label, preset, project?, text? }` opens Spawn.
  { id: 'researcher', profile: 'main', name: 'Researcher', room: 'Research', runtime: 'Hermes profile main', model: 'Codex gpt-6-sol · Sonnet, then DeepSeek fallback', role: 'research cards with sources', presets: ['research', 'mockup'], action: { label: 'Give work', preset: 'research' } },
  { id: 'market-researcher', profile: 'main', name: 'Market researcher', room: 'Research', runtime: 'Hermes profile main', model: 'Codex gpt-6-sol · Sonnet, then DeepSeek fallback', role: 'who makes it, what it costs, what players say', presets: ['market-research'], action: { label: 'Give work', preset: 'market-research' } },
  { id: 'teardown', profile: 'main', name: 'Teardown', room: 'Research', runtime: 'Hermes profile main', model: 'Codex gpt-6-sol · Sonnet, then DeepSeek fallback', role: 'how a public game works, from public sources', presets: ['game-teardown'], action: { label: 'Give work', preset: 'game-teardown' } },
  // The Planner is a chat agent with no job preset: it talks a plan through, then files one change-list Ask (ws-qdh.3).
  { id: 'planner', profile: 'main', name: 'Planner', room: 'Research', runtime: 'Hermes profile main', model: 'Codex gpt-6-sol · Sonnet, then DeepSeek fallback', role: 'talks a plan through and files it as a change list for you to approve', action: { label: 'Chat', chat: 'planner' } },
];

/** The agents with a chat persona the owner may edit (chat-personas.mjs has their prompts). chat-personas.test.mjs keeps this equal to the persona table. */
export const PERSONA_AGENTS = ['researcher', 'market-researcher', 'teardown', 'planner'];

export const AVATAR_FILE_RE = /^avatar-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}\.json$/;
export const STATUSES = ['working', 'needs-you', 'failed', 'idle', 'offline'];

/** The default sprite when no choice was made: a built-in of the agent's own id, else a name-seeded one. */
export function defaultSprite(agent) {
  return BUILTIN_KEYS.includes(agent.id) ? { kind: 'builtin', key: agent.id } : { kind: 'random', salt: 0, name: agent.name };
}

/** A clean avatar choice from a request body, or null. Unknown fields are dropped. */
export function checkAvatar(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.kind === 'builtin') return typeof raw.key === 'string' && BUILTIN_KEYS.includes(raw.key) ? { kind: 'builtin', key: raw.key } : null;
  if (raw.kind === 'random') return Number.isInteger(raw.salt) && raw.salt >= 0 && raw.salt <= 9999 ? { kind: 'random', salt: raw.salt } : null;
  if (raw.kind === 'custom') {
    if (typeof raw.sheet !== 'string' || !SHEET_ID_RE.test(raw.sheet)) return null;
    // A request names only the sheet; the Hub adds the hash it computed. A stored file carries it.
    return typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256) ? { kind: 'custom', sheet: raw.sheet, sha256: raw.sha256 } : { kind: 'custom', sheet: raw.sheet };
  }
  return null;
}

/** The sprite a stored choice file gives this agent, or the default. `choice` is already checked; a custom one carries its resolved `sprite`. */
export function spriteOf(agent, choice) {
  if (!choice) return defaultSprite(agent);
  if (choice.kind === 'custom') return choice.sprite ?? defaultSprite(agent);
  return choice.kind === 'builtin' ? { kind: 'builtin', key: choice.key } : { kind: 'random', salt: choice.salt, name: agent.name };
}

const ago = (iso, at) => {
  const minutes = Math.max(0, Math.round((at.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
};

/**
 * One status per agent: `{ id, status, task, sessions? }`.
 * - working: Working now (`hub-pc.mjs`), PC pcSummary or null, hermes: `null` (not set up) or `{ ok }`,
 *   lastChat: ISO time or ''.
 */
export function agentStatuses({ working = [], pc = null, hermes = null, lastChat = '', at }) {
  const sessions = working.filter(item => item.agent === 'claude');
  let claude;
  if (sessions.some(item => item.state === 'needs-you')) claude = 'needs-you';
  else if (sessions.some(item => item.state === 'working')) claude = 'working';
  else if (sessions.length || pc?.state === 'on') claude = 'idle';
  else claude = 'offline';
  const claudeTask = sessions.length
    ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} · ${sessions[0].title}`
    : claude === 'idle' ? 'No sessions open' : pc ? 'The PC is asleep or off' : 'No PC status yet';

  const hermesStatus = hermes?.ok ? 'idle' : 'offline';
  const hermesTask = !hermes ? 'Not set up' : !hermes.ok ? 'Not answering' : lastChat ? `Last chat ${ago(lastChat, at)}` : 'No chats yet';

  return [
    { id: 'hermes', status: hermesStatus, task: hermesTask },
    { id: 'briefs', status: 'idle', task: 'Daily projects brief and weekly digests' },
    { id: 'claude', status: claude, task: claudeTask, sessions },
    ...PERSONA_AGENTS.map(id => ({ id, status: hermesStatus, task: !hermes ? 'Hermes is not set up' : !hermes.ok ? 'Hermes is not answering' : 'Ready for a job' })),
  ];
}

/** The Team card's model line from a profile's settings: the primary, then the fallbacks in order. */
const modelLine = block => `${block.model.default}${block.fallbacks.length ? ` · then ${block.fallbacks.map(item => item.model).join(', ')}` : ' · no fallback'}`;

/**
 * The Team answer: each agent with its status, task and sprite. `choices` maps agent id to its newest choice. `personas` is the effective persona
 * table (hub-personas.mjs): an agent in it takes the persona's role line, is `editable: { persona: true }`, and names its chat model once edited.
 * An agent on a Hermes profile is also `editable: { profile: true }` (the model and fallback order, ws-im1.4.2); with a fresh `exported` (hub-agent-config.mjs)
 * its `model` line is built from the host's own settings, else it stays the text above.
 */
export function buildTeam({ statuses, choices = {}, personas = [], exported = null, at = new Date() }) {
  const by = new Map(statuses.map(row => [row.id, row]));
  return AGENTS.map(agent => {
    const row = by.get(agent.id) ?? { status: 'offline', task: '' };
    const persona = personas.find(entry => entry.id === agent.id);
    const block = agent.profile && exported && exportFreshness(exported, at) === 'fresh' ? exported.profiles[agent.profile] : null;
    const model = block?.model?.default ? modelLine(block) : agent.model;
    const editable = persona || agent.profile ? { ...(persona ? { persona: true } : {}), ...(agent.profile ? { profile: true } : {}) } : null;
    return { ...agent, model, ...(editable ? { editable } : {}), ...(persona ? { role: persona.role, ...(persona.edited ? { chatModel: CHAT_MODELS.find(entry => entry.id === persona.model)?.label ?? persona.model } : {}) } : {}), status: row.status, task: row.task, ...(row.sessions ? { sessions: row.sessions } : {}), sprite: spriteOf(agent, choices[agent.id] ?? null) };
  });
}
