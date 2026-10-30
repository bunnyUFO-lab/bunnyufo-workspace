// The models a chat may ask Hermes for. The browser sends only an id from this table; the provider and the model strings
// below are the only ones that ever reach Hermes. No Opus and no Pro model is listed (cost guard).
// Checked against the assistant notes in the homelab repo on 2026-10-30.
export const CHAT_MODELS = [
  { id: 'auto', label: 'Auto', note: 'Codex on your ChatGPT plan, then Sonnet, then DeepSeek', provider: null, model: null },
  { id: 'sonnet', label: 'Sonnet', note: 'Anthropic API, paid', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { id: 'haiku', label: 'Haiku', note: 'Anthropic API, paid, cheaper', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { id: 'deepseek-flash', label: 'DeepSeek Flash', note: 'DeepSeek API, cheapest', provider: 'deepseek', model: 'deepseek-flash' },
];

/** The entry for an id. Nothing, null or '' is Auto; any other value that is not a listed id is a 400. */
export function chatModelOf(value) {
  if (value === undefined || value === null || value === '') return CHAT_MODELS[0];
  const found = typeof value === 'string' ? CHAT_MODELS.find(entry => entry.id === value) : undefined;
  if (!found) throw Object.assign(new Error('Unknown model.'), { status: 400 });
  return found;
}

/** What the page may see of the list: no provider, no model string. */
export const chatModelsForClient = () => CHAT_MODELS.map(({ id, label, note }) => ({ id, label, note }));
