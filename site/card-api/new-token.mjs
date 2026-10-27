#!/usr/bin/env node
// Optional: an extra card API token, besides the passphrase (for a token limited to some sections
// or verbs, or one to revoke on its own). By default the token is printed once, for the place a
// session runs; with --out it is written to a file instead (mode 0600, never overwritten) and only
// its name, rights and path are printed. Its hash goes into ~/.buw/card-api-tokens
// (BUW_CARD_TOKENS_FILE), which deploy.sh hands to the stack. Neither the stack nor that file ever
// holds a token, so the file is safe to keep on disk.
//
//   node site/card-api/new-token.mjs <name> [--sections magic-loops,bunnylink] [--out <file>]
//   node site/card-api/new-token.mjs <name> [--rights 'read=*;write=inbox|assistant'] [--out <file>]
//   then: site/card-api/deploy.sh <bucket>        (tokens work once the stack is updated)
//
// --sections lets the token do everything on those sections. --rights lists the verbs (read, write,
// delete), each on `*` or on some sections; a verb not listed is not allowed. The two are exclusive.
// To revoke a token, delete its line from the file and deploy again.
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseScope } from './handler.mjs';

const args = process.argv.slice(2);
const flags = new Set(['--sections', '--rights', '--out']);
const valueOf = flag => {
  const at = args.indexOf(flag);
  return at < 0 ? null : (args[at + 1] ?? '');
};
const name = args.find((arg, at) => !arg.startsWith('--') && !flags.has(args[at - 1]));
const sectionsArg = valueOf('--sections');
const rightsArg = valueOf('--rights');
const out = valueOf('--out');
const sections = (sectionsArg ?? '').split(',').map(item => item.trim()).filter(Boolean);
const usage = () => {
  console.error("Usage: node site/card-api/new-token.mjs <name> [--sections a,b | --rights 'read=*;write=inbox'] [--out <file>]   (name: letters, digits, . _ -)");
  process.exit(1);
};
if (!name || !/^[\w.-]+$/.test(name)) usage();
if ((sectionsArg !== null && !sections.length) || (rightsArg !== null && !rightsArg) || (out !== null && !out)) usage();
if (sectionsArg !== null && rightsArg !== null) {
  console.error('--sections and --rights are exclusive: --sections gives every verb on those sections, --rights lists the verbs.');
  process.exit(1);
}
let scope = sections.join('|');
if (rightsArg !== null) {
  if (!rightsArg.includes('=')) {
    console.error("--rights is like 'read=*;write=inbox|assistant' (verbs: read, write, delete).");
    process.exit(1);
  }
  try {
    parseScope(rightsArg);
  } catch (error) {
    console.error(`--rights is not valid (${error.message}): use 'read=*;write=inbox|assistant'.`);
    process.exit(1);
  }
  scope = rightsArg;
}
const file = process.env.BUW_CARD_TOKENS_FILE || path.join(os.homedir(), '.buw', 'card-api-tokens');
const existing = await readFile(file, 'utf8').catch(() => '');
if (existing.split(/\r?\n/).some(line => line.startsWith(`${name}=`))) {
  console.error(`${file} already has a token named ${name}; delete its line first to replace it.`);
  process.exit(1);
}
const token = `buwc_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(token).digest('hex');
if (out) {
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  try {
    await writeFile(out, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      console.error(`${out} already exists; it is not overwritten.`);
      process.exit(1);
    }
    throw error;
  }
}
await mkdir(path.dirname(file), { recursive: true });
await appendFile(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${name}=${hash}${scope ? `:${scope}` : ''}\n`);
const what = rightsArg !== null ? `rights: ${rightsArg}` : sections.length ? `sections: ${sections.join(', ')}` : 'every section';
if (out) {
  console.log(`Token "${name}" (${what}) written to ${out}. Its hash is in ${file}; run site/card-api/deploy.sh <bucket> so the API accepts it.`);
} else {
  console.log(`Token "${name}" (${what}), shown once:\n\n  ${token}\n`);
  console.log(`Use it as BUW_CARDS_PASSWORD where the session runs (in place of the passphrase). Its hash is in ${file};\nrun site/card-api/deploy.sh <bucket> so the API accepts it.`);
}
