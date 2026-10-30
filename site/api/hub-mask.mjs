// Secret-shaped text is masked before the Hub stores a help chat's excerpt in an answer or a submission: those files can
// be read with any inbox token, and a troubleshooting chat is where tokens and .env lines get pasted. The shapes follow
// the session hooks' masking (token prefixes, key=value, JWTs, long hex and base64), without the owner's own patterns,
// which live on the owner's PC.
export const MASKED = '[masked]';

// The rule list is shared with mods/hub-hooks/hooks/mask.ts in bunnyUFO-lab/workspace-skills, and so are the test vectors
// (here site/api/test/fixtures/mask-vectors.json; there mods/hub-hooks/hooks/mask-vectors.json). Change both together.
const RULES = [
  // Authorization: Bearer <token>. The scheme stays. A short all-letter word after "bearer" is prose and survives.
  text => text.replace(/\b(bearer)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi, (all, word, space, token) => (token.length >= 20 || /\d/.test(token) ? `${word}${space}${MASKED}` : all)),
  // https://user:pass@host: the user and the host stay.
  text => text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (_all, scheme, user) => `${scheme}${user}:${MASKED}@`),
  // password: hunter2, MY_API_KEY=abc, client-secret = abc, api key: abc, DB_PASSWORD="two words", {"password": "two words"}
  text => text.replace(/\b(\w*(?:password|passwd|passphrase|secret|token|api[_ -]?key)\w*)(["']?\s*[:=]\s*)(\[masked\]|"[^"\n]*"|'[^'\n]*'|\S+)/gi, (_all, name, sep) => `${name}${sep}${MASKED}`),
  text => text.replace(/(?<![A-Za-z0-9])(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}/g, MASKED),
  text => text.replace(/(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, MASKED),
  text => text.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, MASKED),
  text => text.replace(/\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g, MASKED),
  text => text.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, MASKED),
  text => text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASKED),
  text => text.replace(/\b[0-9a-fA-F]{40,}\b/g, MASKED),
  // Long base64: only with a digit, an upper-case and a lower-case letter and at most two slashes, so paths and URLs survive.
  text => text.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, match => (/\d/.test(match) && /[A-Z]/.test(match) && /[a-z]/.test(match) && (match.match(/\//g) ?? []).length <= 2 ? MASKED : match)),
];

export const maskSecrets = value => RULES.reduce((text, rule) => rule(text), String(value ?? ''));
