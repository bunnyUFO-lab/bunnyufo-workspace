// One scrub for every message that leaves the site API's Hermes and signing code as text: a hand-off error that
// goes into `waiting`, a `start-failed` summary in result.json, a 409 body, a log line. It removes URLs, bearer
// tokens and `Authorization` values, and the value of any secret the host holds in its environment, so an upstream
// error body that echoes a request cannot carry them out.
const SECRET_ENV = ['HERMES_API_KEY', 'HUB_SIGNING_KEY', 'HUB_DISCORD_NEEDS_YOU', 'HUB_DISCORD_TOKEN_SHA256'];

/** `createScrub(env)` → `(value, max?) → string`: flattened to one line, scrubbed, clipped to `max` (default 300). */
export function createScrub(env = {}) {
  const names = [...SECRET_ENV, ...Object.keys(env).filter(name => /^CLAUDE_ROUTINE_[A-Z0-9_]+_(TOKEN|URL)$/.test(name))];
  const secrets = names.map(name => String(env[name] ?? '').trim()).filter(value => value.length >= 6);
  return (value, max = 300) => {
    let text = String(value ?? '').replace(/\s+/g, ' ').trim();
    for (const secret of secrets) text = text.split(secret).join('');
    text = text
      .replace(/https?:\/\/[^\s)"']+/gi, '')
      .replace(/\bBearer\s+\S+/gi, '')
      .replace(/\bAuthorization\s*[:=]\s*\S+(\s+\S+)?/gi, '')
      .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, max);
  };
}
