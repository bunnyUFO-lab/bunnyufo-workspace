#!/usr/bin/env node
// Makes the Asks bot's narrow token: `buwd_` and 32 random bytes in base64url. The token is written to
// --out (mode 0600, never overwritten) and its sha256 to <out>.sha256; only the two paths are printed.
// The hash goes into api.env (HUB_DISCORD_TOKEN_SHA256) and the token into the bot's env file, both
// through the homelab script asks-bot-env.sh. Neither is ever printed.
//
//   node site/asks-bot/new-token.mjs --out ~/.buw/secrets/hub-discord-token
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const at = process.argv.indexOf('--out');
const out = at < 0 ? '' : process.argv[at + 1] ?? '';
if (!out || out.startsWith('--') || process.argv.length !== 4) {
  console.error('Usage: node site/asks-bot/new-token.mjs --out <file>');
  process.exit(1);
}
const file = path.resolve(out.replace(/^~(?=$|[\/])/, process.env.HOME || process.env.USERPROFILE || '~'));
const token = `buwd_${randomBytes(32).toString('base64url')}`;
try {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(`${file}.sha256`, `${createHash('sha256').update(token).digest('hex')}\n`, { flag: 'wx', mode: 0o600 });
} catch (error) {
  console.error(error.code === 'EEXIST' ? `${error.path} already exists; it is never overwritten. Remove it first to make a new token.` : `Could not write the token: ${error.message}`);
  process.exit(1);
}
console.log(file);
console.log(`${file}.sha256`);
