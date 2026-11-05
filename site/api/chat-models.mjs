// The models a chat may ask Hermes for. The browser sends only an id from this table; the provider and the model strings
// below are the only ones that ever reach Hermes.
// Cost rule: Opus bills through the API, so it is a choice the owner makes for one chat and nothing else. It is never in CHAT_CHAIN, never a persona's
// model and never a job's. No Pro model is listed. Codex runs on the ChatGPT plan, with no API cost.
// This is a fixed list, kept by hand. The agent picker's list comes live from the Hermes host; a new Codex version here is one row.
// Checked on 2026-11-04 against the account's own list. `openai-codex` / `gpt-6-sol` are Hermes main's own primary
// (scripts/assistant/deploy.sh MAIN_PROVIDER / MAIN_MODEL), and `openai-codex` is the provider name `hermes auth reset` takes.
export const CHAT_MODELS = [
  { id: 'auto', label: 'Auto', note: 'Codex on your ChatGPT plan, then Sonnet, then DeepSeek', provider: null, model: null },
  { id: 'codex', label: 'Codex 6 Sol', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6-sol' },
  { id: 'codex-6-1-sol', label: 'Codex 6.1 Sol', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6.1-sol' },
  { id: 'codex-6-1-terra', label: 'Codex 6.1 Terra', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6.1-terra' },
  { id: 'codex-6-astra', label: 'Codex 6 Astra', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6-astra' },
  { id: 'codex-6-luna', label: 'Codex 6 Luna', note: 'ChatGPT plan, no API cost', provider: 'openai-codex', model: 'gpt-6-luna' },
  { id: 'sonnet', label: 'Sonnet', note: 'Anthropic API, paid', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { id: 'haiku', label: 'Haiku', note: 'Anthropic API, paid, cheaper', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { id: 'opus', label: 'Opus', note: 'Billed through the Anthropic API, the most expensive here', provider: 'anthropic', model: 'claude-opus-5-5', explicitOnly: true },
  { id: 'deepseek-flash', label: 'DeepSeek Flash', note: 'DeepSeek API, cheapest', provider: 'deepseek', model: 'deepseek-flash' },
];

/** The order Auto tries, and so the order a paused default falls down: Codex, then Sonnet, then DeepSeek. Never Opus. */
export const CHAT_CHAIN = ['codex', 'sonnet', 'deepseek-flash'];

/** The entry for an id. Nothing, null or '' is Auto; any other value that is not a listed id is a 400. */
export function chatModelOf(value) {
  if (value === undefined || value === null || value === '') return CHAT_MODELS[0];
  const found = typeof value === 'string' ? CHAT_MODELS.find(entry => entry.id === value) : undefined;
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
