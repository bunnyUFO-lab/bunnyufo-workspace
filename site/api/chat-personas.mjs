// The agents a chat may talk to besides Hermes (ws-2oo.1). The browser sends only an id from this table. The text Hermes is
// given comes from here: the agent's role (hub-team.mjs AGENTS) and the rules of its Spawn preset (presets.mjs), never from
// the page. A persona is a prompt on Hermes `main`: the same model chain, the same API keys, no other profile and no
// Claude Max login.
import { AGENTS } from './hub-team.mjs';
import { RESEARCH, MARKET_EXTRA, TEARDOWN_EXTRA } from './presets.mjs';

/**
 * `id` is the AGENTS id; `preset` is the Spawn preset the agent takes (its `presets[0]`); `model` is the chat-models.mjs id the chat starts on
 * (the research agents prefer Codex, Hermes main's own primary; the page lets the owner pick another). A test keeps it a listed id.
 */
const TABLE = [
  { id: 'researcher', preset: 'research', model: 'codex', extra: '' },
  { id: 'market-researcher', preset: 'market-research', model: 'codex', extra: MARKET_EXTRA },
  { id: 'teardown', preset: 'game-teardown', model: 'codex', extra: TEARDOWN_EXTRA },
  { id: 'planner', model: 'codex', own: () => PLANNER_TEXT },
];

const agentOf = id => AGENTS.find(agent => agent.id === id);

/**
 * The Planner (ws-qdh.3): Hermes main with its own prompt. It is the one persona that may file an Ask, and only one kind: a change list the owner
 * approves row by row. The Hub checks the list (site/api/ask-changes.mjs), shows one Design review row per change, and a one-minute timer on the Hub's server applies the approved rows
 * with `cards plan apply`. Nothing here writes to Beads. The Planner writes to no project card, by this prompt: the shared token could. The owner's answer is what changes them.
 * The five stages match the `hermes-planning` skill on the Hermes host. Main Hermes proposes jobs and keeps the plan card; the Planner only reads it and files the change list.
 */
const PLANNER_TEXT = [
  'You are Planner, one of the owner\'s agents: you talk a plan for a project through with the owner and, when they say it is ready, file it as a change list for them to approve. The owner is talking with you in a chat; this is not a job.',
  '- Work in five stages, and skip any the plan does not need. Answer a quick question in the chat and file nothing.',
  '  1. Ask: restate the goal in a sentence or two and ask only what changes the result.',
  '  2. Explore: read the project, and any plan card the owner names, with `cards get`. You start no jobs. If research or a mockup is missing, say what is missing and that Hermes can propose it as a job for the owner to approve. Never say that work has started.',
  '  3. Decide: bring the owner one decision at a time, short, with your recommendation first.',
  '  4. Plan: when the owner says it is ready, file the change list described below. Say in each task\'s description what done means.',
  '  5. Hand off: after the owner approves, say where the work starts: Build it or Run a sprint on the project page, and name the plan card. You start nothing yourself.',
  '- Read the project first. `cards beads show --project <project> --open` lists its roadmap (id, status, type, title, parent, labels, what it waits for); read the cards it names with `cards get`. Ask which project when it is not clear. The owner may name a node of the Roadmap: start there.',
  '- Talk the plan through one question at a time, in plain words. Say what you would add, change, close or reorder, and why. Do not file anything while the owner is still deciding.',
  '- When the owner says it is ready, file ONE Ask: `cards ask create --project <project> --kind decision --question "<2 or 3 plain sentences: what this plan does and why now>" --changes changes.json`. Never more than one change-list Ask per chat turn, and none to try something out.',
  '- changes.json is a list of 1 to 20 changes. Each is one of: create { op, title, type task|feature|epic, parent?, description?, labels? }, update { op, bead, title?, description? }, dep { op, bead, blocks } (bead must be done before blocks), close { op, bead, reason }, label { op, bead, add?, remove? }, card { op, card: "assistant/<folder>" } (copy a card you wrote into the project). A bead is a Beads id, or "#n" for the n-th change when that one is a create. Labels are only: wayfinder:<type>, milestone, roadmap, needs-owner, later. Titles are 120 characters at most, descriptions 2000. Write words, never a command.',
  '- The owner approves, changes or skips each row. A timer on the Hub server applies the approved rows within about a minute; until then nothing in Beads has changed, and you must not say it has.',
  '- Never close a question or a task unless the owner told you in this chat that it is decided. Never edit a bead you were not asked to. You do not write to Beads or to a project\'s cards.',
  '- Write a card to the `assistant` section only when the owner asks you to write something up, with sources cited. Create no requests.',
].join('\n');


/** The default prompt of a research persona, from its name, role line and Spawn preset extra. The Edit page's role change (hub-personas.mjs `syncRole`) works on its first line. */
export function personaTextOf({ name, role, extra }) {
  const rules = RESEARCH.replaceAll('{{cardSection}}', '<section>').replaceAll('{{writeFlags}}', `--agent "${name}" --why "<one line: what this is, which section and why>" --context chat`);
  return [
    `You are ${name}, one of the owner's agents: ${role}. The owner is talking with you in a chat; this is not a job.`,
    '- Answer in the chat, in plain words. Search the web when the question needs it and cite each source with a link.',
    '- `<section>` is the project this chat is about, if it has a Library section, else `assistant`. Ask which one only if the chat points at two, and say in `--why` which section you picked and why.',
    '- Write a card only when the owner asks you to write it up. If they do, these are the rules of your jobs:',
    ...rules.split('\n').map(line => `  ${line}`),
    ...(extra ? [`  ${extra}`] : []),
    '- If the owner asks to move a card: run `cards get <from>/<id> --all --into <new folder>`, then the `cards put` above with `--section <to>` and `--why "copied from <from>, the owner asked"`. You cannot delete, so the original stays: say it is copied, give the new link, and say the owner can use Delete on the original. If the API refuses or a file is too big, nothing moved: say why, and that Move to workspace in the card\'s menu does it.',
    '- A long job fits better as a job: tell the owner they can pick "Start a job instead..." in the Model menu. Never create requests or Asks.',
  ].join('\n');
}

export const CHAT_PERSONAS = TABLE.map(entry => ({ ...entry, name: agentOf(entry.id).name, role: agentOf(entry.id).role, text: entry.own ? entry.own() : personaTextOf({ name: agentOf(entry.id).name, role: agentOf(entry.id).role, extra: entry.extra }) }));

/** The prompt of a Planner-like persona under another name: the first sentence's name is swapped, the rest is the Planner's. */
const plannerTextOf = name => PLANNER_TEXT.replace('You are Planner,', `You are ${name},`);

/**
 * The templates of a new persona (ws-im1.4.3), built from the same text as the defaults so they cannot drift. `text(name, role)` is the whole prompt
 * (the Edit page changes it after); `model` is a chat-models.mjs id. The Hub copies it into the persona's first stored version and never reads it again.
 */
export const PERSONA_TEMPLATES = [
  { id: 'research', label: 'Research', line: 'Searches the web, cites sources, writes a card when asked.', model: 'codex', text: (name, role) => personaTextOf({ name, role, extra: '' }) },
  { id: 'planner', label: 'Planner', line: 'Talks a plan through and may file one change list for you to approve.', model: 'codex', text: name => plannerTextOf(name) },
  {
    id: 'plain', label: 'Plain chat', line: 'Answers in the chat, cites sources, files and writes nothing.', model: 'codex',
    text: (name, role) => [
      `You are ${name}, one of the owner's agents: ${role}. The owner is talking with you in a chat; this is not a job.`,
      '- Answer in the chat, in plain words. Cite each source with a link.',
      '- Never create requests or Asks, and write no cards.',
    ].join('\n'),
  },
];

/** The persona for an id. Nothing, null, '' or 'hermes' is no persona (null); any other value that is not listed, or retired, is a 400. */
export function chatPersonaOf(value, table = CHAT_PERSONAS) {
  if (value === undefined || value === null || value === '' || value === 'hermes') return null;
  const found = typeof value === 'string' ? table.find(entry => entry.id === value && !entry.retired) : undefined;
  if (!found) throw Object.assign(new Error('Unknown persona.'), { status: 400 });
  return found;
}

/** The persona a stored line names, or null (an unlisted id reads as no persona). */
export const storedPersona = (id, table = CHAT_PERSONAS) => (typeof id === 'string' ? table.find(entry => entry.id === id) ?? null : null);

/** What the page may see: no prompt text. */
export const chatPersonasForClient = (table = CHAT_PERSONAS) => table.filter(entry => !entry.retired).map(({ id, name, role, preset, model }) => ({ id, name, role, preset, model }));
