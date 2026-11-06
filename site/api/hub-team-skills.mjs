// What each agent can use (ws-cl0.6.10). Pure: no S3, no clock of its own. `hub.mjs` finds the newest settings export and calls in.
//
// There is no single source. The Hermes export names, per profile, the skills it auto-loads and the skills it has installed,
// and one global list of the owner's skills. Agents on one profile share one list. Claude Code's plugins and skills live on
// the PC, and the Hub has no list of them. So this answer claims only what the export says, names the list each fact comes
// from (`sources`), and gives `null` where nothing is known. It reads; nothing here switches a skill.
import { exportFreshness, PROFILES } from './hub-agent-config.mjs';

export const PLUGINS_LINE = 'Claude Code\'s plugins and skills live on the PC. The Hub has no list of them.';

/** The export keeps at most this many installed and auto-loaded names per profile: a list at its cap may be cut. */
const INSTALLED_CAP = 100;
const AUTOLOAD_CAP = 50;

const person = agent => ({ id: agent.id, name: agent.name, profile: agent.profile });

/**
 * `{ exportedAt, fresh, maybeCut, skills, agents, plugins }`
 * - `exported`: `validExport(...)` or null; `agents`: the Team agent list (`allAgents()`); `at`: a Date.
 * - `skills`: `[{ id, autoLoad, owner, profiles, autoLoadProfiles, sources, agents }]`, by id. `profiles` are the profiles that have it
 *   installed or auto-loaded. `sources` are the export lists that name it (`autoLoad`, `installed`, `owner`). `agents` are the agents
 *   on those profiles. An owner skill no profile has is listed with no profiles and no agents: the export does not say who can use it.
 * - `agents`: `[{ id, name, profile, skills, autoLoad, note? }]`; `skills` is the ids the agent can use, or null when not known
 *   (no profile, no export, or the export has no block for the profile).
 */
export function teamSkills({ exported, agents, at }) {
  const blocks = exported ? PROFILES.filter(name => exported.profiles[name]) : [];
  const rows = new Map();
  const row = id => {
    if (!rows.has(id)) rows.set(id, { id, autoLoad: false, owner: false, profiles: [], autoLoadProfiles: [], sources: [] });
    return rows.get(id);
  };
  const mark = (item, source) => { if (!item.sources.includes(source)) item.sources.push(source); };
  for (const name of blocks) {
    const { autoLoad = [], installed = [] } = exported.profiles[name].skills ?? {};
    for (const id of installed) { const item = row(id); mark(item, 'installed'); if (!item.profiles.includes(name)) item.profiles.push(name); }
    for (const id of autoLoad) {
      const item = row(id);
      mark(item, 'autoLoad'); item.autoLoad = true;
      if (!item.profiles.includes(name)) item.profiles.push(name);
      item.autoLoadProfiles.push(name);
    }
  }
  for (const id of exported?.ownerSkills ?? []) { const item = row(id); item.owner = true; mark(item, 'owner'); }

  const skills = [...rows.values()]
    .map(item => ({ ...item, sources: ['autoLoad', 'installed', 'owner'].filter(source => item.sources.includes(source)), agents: agents.filter(agent => agent.profile && item.profiles.includes(agent.profile)).map(person) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const forAgent = agent => {
    if (!agent.profile) return { ...person(agent), skills: null, autoLoad: null, note: PLUGINS_LINE };
    if (!blocks.includes(agent.profile)) return { ...person(agent), skills: null, autoLoad: null, note: exported ? 'The settings export has nothing for this profile.' : 'No settings export has been found.' };
    const { autoLoad, installed } = exported.profiles[agent.profile].skills;
    return { ...person(agent), skills: [...new Set([...installed, ...autoLoad])].sort(), autoLoad: [...autoLoad] };
  };

  const maybeCut = blocks.some(name => { const list = exported.profiles[name].skills; return list.installed.length >= INSTALLED_CAP || list.autoLoad.length >= AUTOLOAD_CAP; });
  return {
    exportedAt: exported ? exported.exportedAt : null,
    fresh: exported ? exportFreshness(exported, at) === 'fresh' : false,
    maybeCut, skills, agents: agents.map(forAgent),
    plugins: { known: false, text: PLUGINS_LINE },
  };
}
