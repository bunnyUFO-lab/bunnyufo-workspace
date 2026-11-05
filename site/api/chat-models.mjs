// The models a chat may ask Hermes for. The browser sends only an id from this table; the provider and the model strings
// below are the only ones that ever reach Hermes.
// Cost rule: Opus bills through the API, so it is a choice the owner makes for one chat and nothing else. It is never in CHAT_CHAIN, never a persona's
// model and never a job's. No Pro model is listed. Codex runs on the ChatGPT plan, with no API cost.
// One row per model family, the newest version only, with the version in the label ("Sonnet 5.5"). The ids carry no version, so a release
// is a one-row edit and no saved chat is orphaned. The table is kept by hand until ws-2vh.32 (the export may then override the model and
// label of an existing, non-default row; it can never add a row).
// `codex` is the one Sol row: Auto's chain, every persona and every template start on it. It runs `gpt-6.1-sol` by the owner's choice; if
// Hermes refuses the slug, those replies fall back to paid Sonnet while the label still says Codex. Auto itself sends no pair, so it runs
// the host's own `main` primary, which only the owner's passkey changes (Team, Edit the model).
// Checked on 2026-11-04 against the account's own list. `openai-codex` / `gpt-6-sol` are Hermes main's own primary
// (scripts/assistant/deploy.sh MAIN_PROVIDER / MAIN_MODEL), and `openai-codex` is the provider name `hermes auth reset` takes.
export const CHAT_MODELS = [
  { id: 'auto', label: 'Auto', note: 'Codex on your ChatGPT plan, then Sonnet, then DeepSeek', provider: null, model: null },
  { id: 'codex', label: 'Codex 6.1 Sol', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6.1-sol' },
  { id: 'codex-terra', label: 'Codex 6.1 Terra', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6.1-terra' },
  { id: 'codex-astra', label: 'Codex 6 Astra', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6-astra' },
  { id: 'codex-luna', label: 'Codex 6 Luna', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6-luna' },
  { id: 'sonnet', label: 'Sonnet 5.5', note: 'Anthropic API, paid', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { id: 'haiku', label: 'Haiku 5.5', note: 'Anthropic API, paid, cheaper', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { id: 'opus', label: 'Opus 5.5', note: 'Billed through the Anthropic API, the most expensive here', provider: 'anthropic', model: 'claude-opus-5-5', explicitOnly: true },
  { id: 'deepseek-flash', label: 'DeepSeek Flash', note: 'DeepSeek API, cheapest', provider: 'deepseek', model: 'deepseek-flash' },
];

/** The order Auto tries, and so the order a paused default falls down: Codex, then Sonnet, then DeepSeek. Never Opus. */
export const CHAT_CHAIN = ['codex', 'sonnet', 'deepseek-flash'];

// Ids an earlier version of this PR listed, one per family now. A Map, so `__proto__` and `constructor` stay unknown ids.
const RETIRED = new Map([['codex-6-1-sol', 'codex'], ['codex-sol', 'codex'], ['codex-6-1-terra', 'codex-terra'], ['codex-6-astra', 'codex-astra'], ['codex-6-luna', 'codex-luna']]);

/** The row an id stored earlier means now: a retired id gives its family's row; any other id is returned as is. */
export const currentModelId = value => RETIRED.get(value) ?? value;

/** The entry for an id. Nothing, null or '' is Auto; a retired id is its family's row; any other value that is not a listed id is a 400. */
export function chatModelOf(value) {
  if (value === undefined || value === null || value === '') return CHAT_MODELS[0];
  const found = typeof value === 'string' ? CHAT_MODELS.find(entry => entry.id === currentModelId(value)) : undefined;
  if (!found) throw Object.assign(new Error('Unknown model.'), { status: 400 });
  return found;
}

/** What the page may see of the list: no provider, no model string. */
export const chatModelsForClient = () => CHAT_MODELS.map(({ id, label, note }) => ({ id, label, note }));

/** The ids a persona may start a chat on: every id except an `explicitOnly` one, because a persona's model is a default. */
export const personaModelIds = () => CHAT_MODELS.filter(entry => !entry.explicitOnly).map(entry => entry.id);

/** The Spawn menu, for pinning a paid model: no Codex row (Auto already tries Codex first) and no `explicitOnly` row (a job runs unattended). */
export const spawnModelsForClient = () => CHAT_MODELS
  .filter(entry => entry.provider !== 'openai-codex' && !entry.explicitOnly)
  .map(({ id, label, note }) => ({ id, label, note }));
