// Secret-shaped text is masked before the Hub stores a help chat's excerpt in an answer or a submission: those files can
// be read with any inbox token, and a troubleshooting chat is where tokens and .env lines get pasted. The shapes follow
// the session hooks' masking (token prefixes, key=value, JWTs, long hex and base64), without the owner's own patterns,
// which live on the owner's PC.
export const MASKED = '[masked]';

const RULES = [
  // password: hunter2, MY_API_KEY=abc, client-secret = abc
  text => text.replace(/\b(\w*(?:password|passwd|passphrase|secret|token|api[_-]?key)\w*)(\s*[:=]\s*)(\S+)/gi, (_all, name, sep) => `${name}${sep}${MASKED}`),
  text => text.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, MASKED),
  text => text.replace(/\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g, MASKED),
  text => text.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, MASKED),
  text => text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASKED),
  text => text.replace(/\b[0-9a-fA-F]{40,}\b/g, MASKED),
  // Long base64: only with a digit, an upper-case and a lower-case letter and at most two slashes, so paths and URLs survive.
  text => text.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, match => (/\d/.test(match) && /[A-Z]/.test(match) && /[a-z]/.test(match) && (match.match(/\//g) ?? []).length <= 2 ? MASKED : match)),
];

export const maskSecrets = value => RULES.reduce((text, rule) => rule(text), String(value ?? ''));
