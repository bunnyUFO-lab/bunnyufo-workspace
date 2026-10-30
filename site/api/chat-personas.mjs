// The agents a chat may talk to besides Hermes (ws-2oo.1). The browser sends only an id from this table. The text Hermes is
// given comes from here: the agent's role (hub-team.mjs AGENTS) and the rules of its Spawn preset (presets.mjs), never from
// the page. A persona is a prompt on Hermes `main`: the same model chain, the same API keys, no other profile and no
// Claude Max login.
import { AGENTS } from './hub-team.mjs';
import { RESEARCH, MARKET_EXTRA, TEARDOWN_EXTRA } from './presets.mjs';

/** `id` is the AGENTS id; `preset` is the Spawn preset the agent takes (its `presets[0]`). */
const TABLE = [
  { id: 'researcher', preset: 'research', extra: '' },
  { id: 'market-researcher', preset: 'market-research', extra: MARKET_EXTRA },
  { id: 'teardown', preset: 'game-teardown', extra: TEARDOWN_EXTRA },
];

const agentOf = id => AGENTS.find(agent => agent.id === id);

function textOf({ id, extra }) {
  const agent = agentOf(id);
  return [
    `You are ${agent.name}, one of the owner's agents: ${agent.role}. The owner is talking with you in a chat; this is not a job.`,
    '- Answer in the chat, in plain words. Search the web when the question needs it and cite each source with a link.',
    '- Write a card only when the owner asks you to write it up. If they do, these are the rules of your jobs:',
    ...RESEARCH.split('\n').map(line => `  ${line}`),
    ...(extra ? [`  ${extra}`] : []),
    '- A long job fits better as a job: tell the owner they can pick "Start a job instead..." in the Model menu. Never create requests or Asks.',
  ].join('\n');
}

export const CHAT_PERSONAS = TABLE.map(entry => ({ ...entry, name: agentOf(entry.id).name, role: agentOf(entry.id).role, text: textOf(entry) }));

/** The persona for an id. Nothing, null, '' or 'hermes' is no persona (null); any other value that is not listed is a 400. */
export function chatPersonaOf(value) {
  if (value === undefined || value === null || value === '' || value === 'hermes') return null;
  const found = typeof value === 'string' ? CHAT_PERSONAS.find(entry => entry.id === value) : undefined;
  if (!found) throw Object.assign(new Error('Unknown persona.'), { status: 400 });
  return found;
}

/** The persona a stored line names, or null (an unlisted id reads as no persona). */
export const storedPersona = id => (typeof id === 'string' ? CHAT_PERSONAS.find(entry => entry.id === id) ?? null : null);

/** What the page may see: no prompt text. */
export const chatPersonasForClient = () => CHAT_PERSONAS.map(({ id, name, role, preset }) => ({ id, name, role, preset }));
