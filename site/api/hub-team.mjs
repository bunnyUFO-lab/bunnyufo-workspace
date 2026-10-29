// The agent list, their statuses and the owner's avatar choices for the Team screen.
// Pure: no S3, no clock of its own. `hub.mjs` gathers the inputs and calls in.
//
// The agent list is app code (a later milestone adds an entry when an agent gets work). The only
// stored data is the owner's avatar choice: create-only `team/<agent>/avatar-<stamp>-<rand4>.json`
// files, written by the Hub (owner-only in the card API), newest name wins.

/** Mirrors `BUILTIN_KEYS` in src/hub/team/sprites.ts; site/api/test/hub-team.test.mjs keeps them equal. */
export const BUILTIN_KEYS = ['hermes', 'briefs', 'researcher', 'librarian', 'architect', 'developer', 'reviewer', 'qa', 'artist', 'lib_b', 'lib_c', 'lib_d', 'dev_teal', 'qa_violet', 'owl_snow', 'artist_blue', 'arch_red'];

/** Checked against the Hermes profile docs (services/assistant.md in the homelab repo) on 2026-10-29. */
export const AGENTS = [
  { id: 'hermes', name: 'Hermes', room: 'Command', runtime: 'Hermes profile main', model: 'Codex gpt-6-sol · Sonnet, DeepSeek fallback', role: 'chats, plans and dispatches' },
  { id: 'briefs', name: 'Briefs', room: 'Ops', runtime: 'Hermes profile briefs', model: 'Haiku 5.5 · DeepSeek fallback', role: 'daily brief and weekly digests' },
  { id: 'claude', name: 'Claude Code', room: 'Build', runtime: 'Claude Code on the Gaming PC', model: 'Max plan', role: 'your sessions on the PC' },
];

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
  return null;
}

/** The sprite a stored choice file gives this agent, or the default. `choice` is already checked. */
export function spriteOf(agent, choice) {
  if (!choice) return defaultSprite(agent);
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
  ];
}

/** The Team answer: each agent with its status, task and sprite. `choices` maps agent id to its newest choice. */
export function buildTeam({ statuses, choices = {} }) {
  const by = new Map(statuses.map(row => [row.id, row]));
  return AGENTS.map(agent => {
    const row = by.get(agent.id) ?? { status: 'offline', task: '' };
    return { ...agent, status: row.status, task: row.task, ...(row.sessions ? { sessions: row.sessions } : {}), sprite: spriteOf(agent, choices[agent.id] ?? null) };
  });
}
