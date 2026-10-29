#!/usr/bin/env node
// Read and publish cards from a session with no registered workspace: a cloud session, another
// machine, a phone's terminal. It reaches the cards one of two ways, the API first:
//
//   1. The card API, when there is a passphrase: from BUW_CARDS_PASSWORD, else from
//      ~/.buw/card-api-password (`login` writes it). Its address is BUW_CARD_API, else "cardApi" in
//      ~/.buw/config.json (BUW_CONFIG moves that file); when the API serves this file at /cards.mjs
//      it fills in its own address. There is no built-in host.
//   2. AWS credentials, when there is no passphrase and this machine has keys
//      (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or a profile in ~/.aws/credentials) and knows the
//      bucket (BUW_S3_BUCKET, or a bucket in the workspace registry). The card API's own handler
//      then runs here, against the bucket, so the rules are the same either way.
//
// With neither, it asks the API with no Authorization at all, for an environment that adds the
// header itself (a Claude Code cloud secret).
//
// `--via s3` or `--via api` (or BUW_CARDS_VIA) picks one instead. The API serves this file at
// /cards.mjs, and it runs there on its own with Node 22; it then has only the API. In the app
// repository, scripts/cards.mjs (`npm run cards`) runs it.
//
//   npm run cards -- login                             ask for the passphrase once and keep it
//   npm run cards -- sections                          the sections this token may use
//   npm run cards -- list <section>                    a section's cards
//   npm run cards -- get <link | section/card | name> [--into <folder>]
//        fetch a card into <folder>/<card folder>/ and add its entry to <folder>/workspace.json
//   npm run cards -- put <folder> --section <section> --card <id> [--dry-run]
//        upload the card folder (what differs, and remove what is gone), then its entry
//
// <folder> is a workspace folder: a workspace.json and the card folders beside it. `get` makes
// one if it is not there, so `get` → edit → `put` works in an empty directory.
//
// The hidden `inbox` section holds what agents and the Hub pass to each other (all files, written
// create-only unless said). Every command works over both ways in; `--via` picks one.
//
//   cards event <kind> --title <t> [--project <p> --bead <b> --ask <id> --review <file> --url <u> --summary <s> --source <s>]
//        post an event to events/<date>/. A failed send is kept in ~/.buw/spool.jsonl (BUW_SPOOL) and
//        retried by the next inbox command.
//   cards ask create --project <p> [--bead <b>] (--file ask.json | --question <text>) [--option <id>=<label>[@<image file>]]...
//        [--decision <text[|detail]>]... [--image <file>]... [--require-passkey]
//        put an Ask (its pictures first, ask.json last) and post an ask-created event; prints its id
//        then, when a #needs-you webhook is configured (BUW_DISCORD_NEEDS_YOU, `discord.needsYou` in
//        ~/.buw/hub.json, or ~/.buw/secrets/discord-webhook-needs-you), post a short note there with a
//        link to the Ask (`siteUrl` in hub.json or BUW_SITE_URL). A failed post is spooled for hub-hooks to
//        replay and never changes the exit code; the webhook address is never printed or stored.
//        A simple multiple-choice Ask (2 to 5 options, no pictures, no drawing) also gets Discord buttons once the
//        Asks bot runs. --require-passkey (or "requirePasskey": true in ask.json) keeps an Ask in the Hub, where only you,
//        signed in, can answer it: set it on any Ask that approves a merge, a deploy, spending, a deletion or secrets.
//        Never put a secret in an Ask: its question and option labels can reach Discord.
//        --question makes an Ask without a file; --option repeats (an option's picture must be among the --image files).
//        --decision repeats (1 to 10) and makes a Design review: each becomes { id: d1, d2, ... , text, detail } (a "|" splits
//        the text from a detail); a file that has decisions refuses them on the command line. With decisions and exactly one
//        --image and no options, that picture is the one the decisions are about; allowDrawing is on unless the file says no.
//   cards ask list [--project <p>] [--answered | --open] [--all]     id, state, project, question
//   cards ask get <id>                                                ask.json, answer.json, pickup.json, cancel.json; for a design
//        review also one line per decision ("d1 approve", "d2 change: Bottom-left")
//   cards ask pickup <id> | cards ask cancel <id>                     exit 3 when someone else already did
//   cards checklist create --project <p> (--file checklist.json | --title <t> --item <text>...) [--bead <b>] [--card <url>]
//        [--playtest --build <https url> [--platform web|windows|mac|linux|android|ios] [--look-for <text>]]
//        put a checklist for the owner to tick off in the Hub (a list of steps, each with an optional guide) and post a
//        checklist-created event; prints its id, then pings #needs-you like an Ask. The Hub writes ticks and the submission
//        (owner-only files); nothing is ever overwritten. --file takes the checklist.json shape without id, project,
//        createdAt, from and the item ids (the CLI adds them): title, context?, card?, items[{ text, group?, guide?, link? }].
//        --playtest makes it a Playtest: the items are what to try, --build (https only) is the build to open, --platform
//        defaults to web, --look-for says what to watch for. The #needs-you ping reads "Playtest: <title>".
//   cards checklist list [--project <p>] [--open | --submitted] [--all]    id, state, done/total, project, title
//   cards checklist get <id> [--json] [--into <dir>]                        progress, the items, submit.json (for a playtest also its
//        build, rating, verdict and issues in plain lines); --into downloads the
//        owner's pictures (evidence-<step>-….png|jpg per step, shot-….png|jpg per playtest issue) and prints their paths
//   cards checklist wait <id> [--timeout <minutes, 30, max 240>] [--every <seconds, 20, min 5>]
//        exit 0 on submit (prints what get prints), 3 on cancel, 4 on timeout
//   cards checklist pickup <id>     exit 2 when not submitted, 3 when already picked up
//   cards checklist cancel <id>     exit 3 when already cancelled or submitted
//   cards request list [--project <p>] [--open | --approved] [--target pc|cloud|hermes]   --approved: signed, not yet taken, not stopped, declined, finished or expired
//   cards request take <id> --bead <b>                                exit 3 when already taken; exit 4 for a request with a
//        preset (a dispatched run starts only from its approval)
//   cards request take <id> --runner pc|cloud --nonce <n> [--session <id or link>]   a runner claims an approval it has verified
//        (taken.json with the nonce, no bead); exit 5 when the nonce is not the approval's
//   cards request verify <id> [--target pc|cloud] [--repo owner/name]   check the owner's signature and every limit; prints one JSON line
//        { id, project, repo, target, limits, nonce, preset }, or exits 5 with the first failed check (unsigned, bad-signature,
//        wrong-request, hash-mismatch, expired, bad-limits, no-run-block, stopped, declined, finished, nonce-used, wrong-target, wrong-repo;
//        a hermes approval is always wrong-target here, and an unreadable taken.json is nonce-used).
//        The public key: HUB_SIGNING_PUBKEY (base64 SPKI or PEM), else the file BUW_APPROVAL_PUBKEY names, else
//        ~/.buw/secrets/approval-signing-key.pub; none is exit 5
//   cards request brief <id> [--target pc|cloud] [--repo owner/name]                                          verify, then print the run's brief (exit 5 when invalid)
//   cards request run <id> --state started|working|turn-ended|usage-limit [--last <text>] [--link <url>]   a progress file (secrets masked)
//   cards request finish <id> --outcome pr|card|failed --summary <s> [--pr <url>] [--card <link>] [--reason <r>] [--report <file.md>]
//        report.md then result.json, both create-only (exit 3 when result.json exists); posts pr-opened or alert
//   cards request state <id>                                          proposed | approved | taken | running | stopping | stopped | done | failed | lost | expired | declined
//   cards request create --project <p> --text <t> [--when next-sprint|nightly|record] [--by <name>]
//        [--preset <id> [--title <t>] [--repo owner/name] [--needs unity,gpu,comfyui,sprite-studio,lan,local-files]
//        [--target pc|cloud|hermes|at-pc] [--done-when <t>] [--origin-run <id>]]
//        --preset makes a request the owner approves in the Hub (no --when); it pings #needs-you like an Ask, linking
//        /#/~hub/request/<id>. --target is only a proposal. origin is { kind: run } when --origin-run or BUW_REQUEST_ID
//        is set, else { kind: agent }; never owner.
//   cards beads push --project <p> [--from <file.jsonl>] [--copy <id>]   this worktree's Beads copy (`bd export` by default; <id> defaults to <host>-<hash of the worktree root>)
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Node's fetch ignores HTTPS_PROXY unless told at startup (Node 22.21 and later), and a cloud
// session reaches the internet only through its proxy. Start again with it on; an older Node
// ignores the variable and carries on as before.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const again = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(again.status ?? 1);
}

const MAX_INLINE = 4 * 1024 * 1024;
const USAGE = 'Usage: npm run cards -- login | sections | list <section> | get <ref> [--into <folder>] | put <folder> --section <s> --card <id> [--dry-run]  [--via s3|api]\n'
  + '       npm run cards -- event <kind> --title <t> | ask create|list|get|pickup|cancel | checklist create|list|get|wait|pickup|cancel | request list|take|create [--preset <id> ...]|verify|brief|run|finish|state | beads push --project <p>\n'
  + '       ask create --project <p> (--file ask.json | --question <t>) [--option <id>=<label>[@<image>]]... [--decision <text[|detail]>]... [--image <file>]...\n'
  + '       checklist create --project <p> (--file checklist.json | --title <t> --item <text>...) [--playtest --build <https url> [--platform <p>] [--look-for <t>]]';
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** The cards bucket this machine knows of: BUW_S3_BUCKET, else the first one the registry names. */
async function knownBucket(env = process.env) {
  if (env.BUW_S3_BUCKET) return env.BUW_S3_BUCKET;
  const file = env.BUW_REGISTRY || path.join(os.homedir(), '.buw', 'workspaces.json');
  try {
    const registry = JSON.parse(await readFile(file, 'utf8'));
    const url = (registry.workspaces ?? []).map(item => item?.bucket).find(value => /^s3:\/\/[^/]+/.test(value ?? ''));
    return url ? /^s3:\/\/([^/]+)/.exec(url)[1] : null;
  } catch {
    return null;
  }
}

/**
 * Straight to the bucket with this machine's AWS credentials: the card API's handler, run here.
 * Null when the repo's modules are not beside this file, or there is no bucket or no key.
 */
async function directTransport() {
  let s3, cardApi;
  try {
    s3 = await import('../api/s3.mjs');
    cardApi = await import('./handler.mjs');
  } catch {
    return null;
  }
  const bucket = await knownBucket();
  if (!bucket || !(await s3.loadCredentials())) return null;
  const local = randomBytes(24).toString('hex');
  const handle = cardApi.createCardApi({
    bucket: s3.createBucket({ bucket, region: process.env.BUW_S3_REGION, endpoint: process.env.BUW_S3_ENDPOINT || undefined }),
    tokens: [{ name: 'local', hash: sha256(local), rights: { read: null, write: null, delete: null } }],
    prefix: process.env.BUW_S3_PREFIX || 'sections',
  });
  return {
    label: `s3://${bucket} with this machine's AWS credentials`,
    async send(method, route, { headers, body }) {
      const url = new URL(route, 'http://local');
      const result = await handle({
        requestContext: { http: { method } },
        rawPath: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: { ...headers, authorization: `Bearer ${local}` },
        body: body === undefined ? undefined : Buffer.from(body).toString('base64'),
        isBase64Encoded: true,
      });
      return new Response(Buffer.from(result.body, result.isBase64Encoded ? 'base64' : 'utf8'), { status: result.statusCode, headers: result.headers });
    },
  };
}

// filled in by the card API when it serves this file (handler.mjs)
const SERVED_API = '';

const PASSWORD_FILE = () => process.env.BUW_CARDS_PASSWORD_FILE || path.join(os.homedir(), '.buw', 'card-api-password');

/** "cardApi" from ~/.buw/config.json (BUW_CONFIG moves it), or ''. */
function configuredApi() {
  try {
    const file = process.env.BUW_CONFIG || path.join(os.homedir(), '.buw', 'config.json');
    const value = JSON.parse(readFileSync(file, 'utf8')).cardApi;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** The card API's address: BUW_CARD_API, else config.json, else the host that served this file, else ''. */
const apiBase = () => (process.env.BUW_CARD_API || configuredApi() || SERVED_API).replace(/\/+$/, '');

/** apiBase(), or an error saying where to set it. */
function requireApi() {
  const api = apiBase();
  if (!api) throw new Error('No card API is set: set BUW_CARD_API, or "cardApi" in ~/.buw/config.json.');
  return api;
}

/** The passphrase: BUW_CARDS_PASSWORD, else the file `login` wrote, else none. */
async function password() {
  if (process.env.BUW_CARDS_PASSWORD) return { token: process.env.BUW_CARDS_PASSWORD, from: 'BUW_CARDS_PASSWORD' };
  try {
    const token = (await readFile(PASSWORD_FILE(), 'utf8')).trim();
    if (token) return { token, from: PASSWORD_FILE() };
  } catch {}
  return { token: '', from: null };
}

/**
 * Over HTTPS to the card API. With no passphrase it sends no Authorization header: a Claude Code
 * cloud secret adds the header on its way out, and the session never holds the value.
 */
function apiTransport(api, { token, from }) {
  const label = `the card API at ${api}${from ? '' : ' (no passphrase here; relying on the environment to add it)'}`;
  return {
    label,
    anonymous: !token,
    send: (method, route, { headers, body }) => fetch(`${api}${route}`, { method, headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers, body }),
  };
}

/** Ask for the passphrase without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return reject(new Error('login needs a terminal to type the passphrase into.'));
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let typed = '';
    const done = value => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      value === null ? reject(new Error('Cancelled.')) : resolve(value);
    };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(typed);
        if (char === '\u0003') return done(null);
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else if (char >= ' ') typed += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** `login`: ask for the passphrase, check it against the API, and keep it for later runs. */
async function login() {
  const api = requireApi();
  const token = (await askHidden(`Card API passphrase (for ${api}): `)).trim();
  if (!token) throw new Error('No passphrase typed.');
  const response = await fetch(`${api}/sections`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new Error('The card API does not know that passphrase. Nothing was saved.');
  if (!response.ok) throw new Error(`GET /sections: ${response.status}. Nothing was saved.`);
  const { sections } = await response.json();
  const file = PASSWORD_FILE();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  console.log(`Saved to ${file} (readable by you only, where the system allows). ${sections.length} section(s): ${sections.map(item => item.id).join(', ')}`);
}

async function pickTransport(via) {
  if (via && !['s3', 'api'].includes(via)) throw new Error('--via is s3 or api.');
  // The API first: one passphrase, the same everywhere. S3 when asked for, or when there is no
  // passphrase and this machine has keys.
  const pass = await password();
  if (via !== 's3' && (pass.token || via === 'api')) return apiTransport(requireApi(), pass);
  const direct = await directTransport();
  if (direct) return direct;
  if (via === 's3') throw new Error('No way to the bucket here: needs AWS credentials (env or ~/.aws/credentials) and BUW_S3_BUCKET or a registered workspace bucket.');
  return apiTransport(requireApi(), pass);
}

const noPassphrase = () => 'The card API wants its passphrase, and none reached it. On a terminal, run `node cards.mjs login` '
  + '(or `npm run cards -- login`) once. In a Claude Code cloud environment, add a secret for '
  + `${new URL(apiBase()).host} with the header Authorization: Bearer <passphrase>. Elsewhere, set BUW_CARDS_PASSWORD.`;

let transport;
async function call(method, route, { body, raw, contentType } = {}) {
  const response = await send(method, route, {
    headers: body !== undefined ? { 'content-type': 'application/json' } : raw !== undefined ? { 'content-type': contentType || 'application/octet-stream' } : {},
    body: body !== undefined ? JSON.stringify(body) : raw,
  });
  if (response.status === 401 && transport.anonymous) throw Object.assign(new Error(noPassphrase()), { status: 401 });
  if (raw === undefined && method === 'GET' && route.includes('/files/')) {
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`${method} ${route}: ${response.status} ${data.error ?? ''}`), { status: response.status, data });
  return data;
}

const enc = value => value.split('/').map(encodeURIComponent).join('/');
const md5 = buffer => createHash('md5').update(buffer).digest('hex');

async function filesUnder(root) {
  const found = [];
  const visit = async (dir, relative) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  await visit(root, '');
  return found.map(file => file.slice(1)).sort();
}

async function readRegistry(folder) {
  try {
    return JSON.parse(await readFile(path.join(folder, 'workspace.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { entities: [] };
    throw error;
  }
}

async function get(ref, into) {
  const { matches } = await call('GET', `/resolve?ref=${encodeURIComponent(ref)}`);
  if (matches.length > 1) {
    console.error(`"${ref}" matches several cards; name one as section/card:`);
    for (const match of matches) console.error(`  ${match.section}/${match.id}  ${match.title}`);
    process.exit(2);
  }
  const [{ section, id }] = matches;
  const card = await call('GET', `/sections/${section}/cards/${encodeURIComponent(id)}`);
  for (const file of card.files) {
    const target = path.join(into, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    // Small files through the API, so a session that may reach only the API host still works;
    // bigger ones from the bucket by their short-lived URL.
    const body = file.size <= MAX_INLINE
      ? await call('GET', `/sections/${section}/files/${enc(file.path)}`)
      : Buffer.from(await (await fetch(file.url)).arrayBuffer());
    await writeFile(target, body);
  }
  const registry = await readRegistry(into);
  const entities = [...(registry.entities ?? []).filter(item => item?.id !== card.entity.id), card.entity];
  await mkdir(into, { recursive: true });
  await writeFile(path.join(into, 'workspace.json'), `${JSON.stringify({ ...registry, entities }, null, 2)}\n`);
  console.log(`${section}/${id} -> ${path.join(into, card.entity.folder)} (${card.files.length} file(s)); entry in ${path.join(into, 'workspace.json')}`);
}

async function put(folder, section, id, dryRun) {
  const registry = await readRegistry(folder);
  const entity = registry.entities?.find(item => item?.id === id);
  if (!entity) throw new Error(`${path.join(folder, 'workspace.json')} has no card "${id}".`);
  const local = await filesUnder(path.join(folder, entity.folder));
  if (!local.length) throw new Error(`${path.join(folder, entity.folder)} has no files.`);

  let remote = [];
  try {
    remote = (await call('GET', `/sections/${section}/cards/${encodeURIComponent(id)}`)).files;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const remoteByPath = new Map(remote.map(file => [file.path, file]));
  const upload = [];
  for (const file of local) {
    const body = await readFile(path.join(folder, entity.folder, ...file.split('/')));
    const key = `${entity.folder}/${file}`;
    if (remoteByPath.get(key)?.etag !== md5(body)) upload.push({ key, body });
  }
  const localKeys = new Set(local.map(file => `${entity.folder}/${file}`));
  const remove = remote.map(file => file.path).filter(key => !localKeys.has(key));
  console.log(`${section}/${id}: ${upload.length} to upload, ${remove.length} to remove, ${local.length - upload.length} unchanged`);
  if (dryRun) {
    for (const { key } of upload) console.log(`  + ${key}`);
    for (const key of remove) console.log(`  - ${key}`);
    return;
  }

  const big = upload.filter(item => item.body.length > MAX_INLINE);
  const urls = big.length ? new Map((await call('POST', `/sections/${section}/uploads`, { body: { files: big.map(item => ({ path: item.key })) } })).uploads.map(item => [item.path, item.url])) : new Map();
  for (const { key, body } of upload) {
    if (body.length > MAX_INLINE) {
      const response = await fetch(urls.get(key), { method: 'PUT', body });
      if (!response.ok) throw new Error(`Upload of ${key} failed: ${response.status} ${await response.text()}`);
    } else {
      await call('PUT', `/sections/${section}/files/${enc(key)}`, { raw: body });
    }
  }
  for (const key of remove) await call('DELETE', `/sections/${section}/files/${enc(key)}`);
  const result = await call('PUT', `/sections/${section}/cards/${encodeURIComponent(id)}`, { body: entity });
  console.log(`${result.created ? 'Added' : 'Updated'} ${section}/${id}.`);
}

// ---------------------------------------------------------------------------------------------
// The inbox: events, Asks, requests and Beads copies, all files in the hidden `inbox` section.
// ---------------------------------------------------------------------------------------------

const EVENT_KINDS = ['session-started', 'session-ended', 'blocked', 'ready-for-review', 'pr-opened', 'pr-merged', 'ci-failed', 'ci-passed', 'deployed', 'ask-created', 'alert', 'review-done', 'resumed', 'checklist-created', 'checklist-submitted'];
const WHEN = ['next-sprint', 'nightly', 'record'];
// The handler's filter on file names; checked here too, so a bad name fails before it is sent.
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;
const SECRET_WORDS = /token|secret|password|credential/i;
const DAY = 24 * 3600 * 1000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** An error that ends the command with a given exit code (3: someone else got there first). */
class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const hostName = () => (os.hostname() || 'host').toLowerCase().replace(/[^a-z0-9-]/g, '-');
const rand = bytes => randomBytes(bytes).toString('hex');
const isoNow = () => new Date().toISOString();
const clip = (text, length) => (String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, length));

/** Every inbox path goes through here: lower-case ids, no `..`, no names the card API would refuse. */
function inboxPath(...parts) {
  const clean = parts.join('/').split('/').filter(part => part !== '');
  if (clean.length < 2 || clean.some(part => part === '.' || part === '..' || part.startsWith('.') || /[\\\0]/.test(part)) || clean[0].startsWith('_')) {
    throw new Error(`Not an inbox path: ${parts.join('/')}`);
  }
  const joined = clean.join('/');
  if (SECRET.test(joined)) throw new Error(`${joined} looks like a secret, so the card API would refuse it.`);
  return joined;
}

/** "Should we rotate the API token?" → "should-we-rotate-the-api"; the words the file-name filter refuses are dropped. */
function slugOf(text, words = 5) {
  const slug = String(text ?? '').toLowerCase().split(/\s+/)
    .map(word => word.replace(/[^a-z0-9]+/g, ''))
    .filter(word => word && !SECRET_WORDS.test(word))
    .slice(0, words).join('-');
  return slug || 'item';
}

const idSafe = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');   // 20261026T143012
const newId = (project, text) => `${stamp().slice(0, 8)}-${idSafe(project)}-${slugOf(text)}-${rand(2)}`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRIES = 3;
/** One request, retried on network errors, 429 and 5xx: 500 ms, 1 s, 2 s, each give or take 20%. */
async function send(method, route, options, { retry = true } = {}) {
  const base = Number(process.env.BUW_CARDS_RETRY_MS) || 500;
  for (let attempt = 0; ; attempt += 1) {
    const last = !retry || attempt >= RETRIES;
    let response;
    try {
      response = await transport.send(method, route, options);
    } catch (error) {
      if (last) throw error;
    }
    if (response && !(response.status === 429 || response.status >= 500)) return response;
    if (last) return response;
    await delay(base * 2 ** attempt * (0.8 + Math.random() * 0.4));
  }
}

/** The inbox section: `inbox`, or `inbox-<name>` for the development copy (BUW_INBOX_SECTION). */
const INBOX_RE = /^inbox(-[a-z0-9]+)?$/;
const INBOX = (() => {
  const wanted = process.env.BUW_INBOX_SECTION || 'inbox';
  if (!INBOX_RE.test(wanted)) {
    console.error(`BUW_INBOX_SECTION must be "inbox" or "inbox-<name>", not "${wanted}".`);
    process.exit(2);
  }
  return wanted;
})();
const fileRoute = file => `/sections/${INBOX}/files/${enc(file)}`;
const failure = async (method, route, response) => {
  if (response.status === 401 && transport.anonymous) return new Error(noPassphrase());
  const data = await response.json().catch(() => ({}));
  return Object.assign(new Error(`${method} ${route}: ${response.status} ${data.error ?? ''}`.trim()), { status: response.status });
};

/**
 * Put one inbox file. Resolves { state: 'ok' | 'exists' | 'transient' }: 'exists' is a 412 on a
 * create-only write, 'transient' a network error, 429 or 5xx that outlasted the retries. Anything
 * else (a 4xx) throws.
 */
async function putInbox(file, body, { createOnly = false, contentType = 'application/json', retry = true, section = INBOX } = {}) {
  const route = `/sections/${section}/files/${enc(file)}`;
  let response;
  try {
    response = await send('PUT', route, { headers: { 'content-type': contentType, ...(createOnly ? { 'if-none-match': '*' } : {}) }, body }, { retry });
  } catch (error) {
    return { state: 'transient', reason: error.cause?.code ?? error.message };
  }
  if (response.ok) return { state: 'ok' };
  if (response.status === 412) return { state: 'exists' };
  if (response.status === 429 || response.status >= 500) return { state: 'transient', reason: `HTTP ${response.status}` };
  throw await failure('PUT', route, response);
}

/** A write that must land: a transient failure is an error here, and 'exists' is for the caller. */
async function mustPut(file, body, options) {
  const result = await putInbox(file, body, options);
  // A create-only retry that gets 412 may be meeting its own first write, whose answer was lost.
  if (result.state === 'exists' && typeof body === 'string' && await readInbox(file).catch(() => null) === body) return 'ok';
  if (result.state === 'transient') throw new Error(`Could not write inbox/${file} (${result.reason}). Nothing was spooled; run it again.`);
  return result.state;
}

/** The text of an inbox file, or null when it is not there. */
async function readInbox(file) {
  const route = fileRoute(file);
  const response = await send('GET', route, { headers: {} });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure('GET', route, response);
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

async function readJson(file) {
  const text = await readInbox(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Files under a prefix, as the API lists them. A prefix keeps to a month or a day, so it stays under the 1000 cap. */
async function listInbox(prefix) {
  const route = `/sections/${INBOX}/files?prefix=${encodeURIComponent(prefix)}`;
  const response = await send('GET', route, { headers: {} });
  if (!response.ok) throw await failure('GET', route, response);
  const { files, truncated } = await response.json();
  if (truncated) console.error(`(listing of ${prefix} was cut at ${files.length}; narrow it)`);
  return files.map(file => file.path);
}

// --- the spool: events that could not be sent, shared with the hub-hooks mod ---

const spoolFile = () => process.env.BUW_SPOOL || path.join(os.homedir(), '.buw', 'spool.jsonl');

async function spool(entry) {
  const file = spoolFile();
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ v: 1, at: isoNow(), kind: 'put', section: INBOX, contentType: 'application/json', createOnly: true, ...entry })}\n`);
}

/**
 * Send up to 20 spooled `put` entries, oldest first. Sent (200) or already there (412) or older
 * than a day (or with no readable time): dropped. Any other answer, 4xx included (this command's
 * token may just be unable to write the inbox), or no answer: kept. Other kinds of line belong to the hooks and stay.
 */
async function replaySpool() {
  const file = spoolFile();
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const keep = [];
  let tried = 0;
  let down = false;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;                                       // a torn line: drop it
    }
    if (entry?.v !== 1 || entry.kind !== 'put' || !INBOX_RE.test(String(entry.section)) || typeof entry.path !== 'string') {
      keep.push(line);
      continue;
    }
    if (!(Date.now() - Date.parse(entry.at) <= DAY)) continue;     // older than a day, or no readable time: expired
    if (down || tried >= 20) {
      keep.push(line);
      continue;
    }
    tried += 1;
    try {
      const result = await putInbox(inboxPath(entry.path), entry.body, { section: entry.section, createOnly: entry.createOnly !== false, contentType: entry.contentType, retry: false });
      if (result.state === 'transient') {
        down = true;
        keep.push(line);
      }
    } catch {
      // A refusal (401, 403, another 4xx) may be only this command's token: keep the line; the 24 h rule clears a truly bad one.
      keep.push(line);
    }
  }
  if (keep.length === lines.length && tried === 0) return;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, keep.length ? `${keep.join('\n')}\n` : '');
  await rename(temp, file);
}

// --- events ---

function buildEvent(flags) {
  const kind = flags.kind;
  if (!EVENT_KINDS.includes(kind)) throw new Error(`Event kind is one of: ${EVENT_KINDS.join(', ')}.`);
  if (!flags.title) throw new Error('An event needs --title.');
  const now = new Date();
  const host = hostName();
  const event = {
    ts: now.toISOString(), kind,
    ...(flags.project ? { project: flags.project } : {}),
    ...(flags.bead ? { bead: flags.bead } : {}),
    ...(flags.ask ? { ask: flags.ask } : {}),
    ...(flags.checklist ? { checklist: String(flags.checklist) } : {}),
    ...(flags.review ? { review: String(flags.review) } : {}),
    ...(process.env.CLAUDE_SESSION_ID ? { session: process.env.CLAUDE_SESSION_ID } : {}),
    host, source: flags.source || 'cli', title: String(flags.title),
    ...(flags.url ? { url: flags.url } : {}),
    ...(flags.summary ? { summary: String(flags.summary) } : {}),
  };
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  return { event, file: inboxPath('events', now.toISOString().slice(0, 10), `${time}-${host}-${rand(3)}.json`) };
}

/** Post an event; when the API cannot be reached, keep it in the spool and say so. Never throws for that. */
async function postEvent(flags, { out = console.log } = {}) {
  const { event, file } = buildEvent(flags);
  const body = `${JSON.stringify(event, null, 2)}\n`;
  const result = await putInbox(file, body, { createOnly: true });
  if (result.state === 'transient') {
    await spool({ path: file, body });
    out(`spooled ${file} (${result.reason}); it is sent with the next inbox command`);
    return file;
  }
  out(file);
  return file;
}

// --- Asks ---

const askState = (names, ask, snooze) => {
  if (names.has('cancel.json')) return 'cancelled';
  if (names.has('pickup.json')) return 'picked up';
  if (names.has('answer.json')) return 'answered';
  if (names.has('snooze.json') && Date.parse(snooze?.until) > Date.now()) return `snoozed until ${new Date(snooze.until).toISOString().slice(11, 16)}`;
  if (ask?.expiresAt && Date.now() > Date.parse(ask.expiresAt)) return 'expired';
  return 'open';
};

/** Folders of files, by the folder name under a listing's prefix: { id → Set of file names }. */
function groupFolders(paths, root) {
  const folders = new Map();
  for (const file of paths) {
    const [, id, ...rest] = file.split('/');
    if (file.split('/')[0] !== root || !id || !rest.length) continue;
    if (!folders.has(id)) folders.set(id, new Set());
    folders.get(id).add(rest.join('/'));
  }
  return folders;
}

/** This month's and last month's prefixes, or the whole folder with --all. */
function monthPrefixes(root, all) {
  if (all) return [`${root}/`];
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [stamp(last).slice(0, 6), stamp(now).slice(0, 6)].map(month => `${root}/${month}`);
}

async function listFolders(root, all) {
  const paths = (await Promise.all(monthPrefixes(root, all).map(listInbox))).flat();
  return groupFolders(paths, root);
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await work(items[at]);
    }
  }));
  return results;
}

function askFromFile(raw, flags, id) {
  const now = new Date();
  const from = { host: hostName(), tool: flags.tool || 'claude-code', ...(process.env.CLAUDE_SESSION_ID ? { session: process.env.CLAUDE_SESSION_ID } : {}), ...(raw.from ?? {}) };
  const ask = {
    id, project: flags.project,
    ...(flags.bead || raw.bead ? { bead: flags.bead || raw.bead } : {}),
    createdAt: now.toISOString(),
    expiresAt: raw.expiresAt ?? new Date(now.getTime() + 7 * DAY).toISOString(),
    from,
    question: raw.question,
    ...(raw.context ? { context: raw.context } : {}),
    ...(raw.options ? { options: raw.options } : {}),
    ...(raw.decisions ? { decisions: raw.decisions } : {}),
    ...(raw.image ? { image: raw.image } : {}),
    allowNote: raw.allowNote ?? true,
    allowDrawing: raw.allowDrawing ?? false,
    ...(flags['require-passkey'] ? { requirePasskey: true } : raw.requirePasskey !== undefined ? { requirePasskey: raw.requirePasskey } : {}),
  };
  return ask;
}

/** An Ask picture's file name: the server's rule. */
const ASK_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const DECISION_LIMITS = { count: 10, text: 200, detail: 500 };

/** `--decision "text|detail"` → { id: 'd<n>', text, detail? }. The detail starts at the first "|". */
function decisionsFromFlags(values) {
  return values.map((value, index) => {
    const bar = value.indexOf('|');
    const text = (bar < 0 ? value : value.slice(0, bar)).trim();
    const detail = bar < 0 ? '' : value.slice(bar + 1).trim();
    return { id: `d${index + 1}`, text, ...(detail ? { detail } : {}) };
  });
}

/** `--option <id>=<label>[@<image file name>]` → { id, label, image? }. */
function optionFromFlag(value) {
  const equals = value.indexOf('=');
  if (equals < 1) throw new Error(`--option ${value}: write it as <id>=<label>, or <id>=<label>@<image file>.`);
  let label = value.slice(equals + 1).trim();
  // Text after the last "@" with no white space is a picture reference: a bare image file name, or an error.
  const tail = /@(\S*)$/.exec(label);
  let image;
  if (tail) {
    if (!ASK_IMAGE_RE.test(tail[1]) || !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(tail[1])) {
      throw new Error(`--option ${value}: the picture after @ is a file name like x.png (pass the path with --image).`);
    }
    image = tail[1];
    label = label.slice(0, tail.index).trim();
  }
  return { id: value.slice(0, equals).trim(), label, ...(image ? { image } : {}) };
}

/** The ask input to build from: the file, or --question, with the flags' options, decisions and picture added. */
async function askInput(flags) {
  const usage = 'Usage: ask create --project <p> [--bead <b>] (--file ask.json | --question <text>) [--option <id>=<label>[@<image>]]... [--decision <text[|detail]>]... [--image <file>]... [--require-passkey]';
  if (!flags.project || (!flags.file && !flags.question)) throw new Error(usage);
  if (flags.file && flags.question) throw new Error(`Give --file, or --question, not both. ${usage}`);
  const raw = flags.file ? JSON.parse(await readFile(flags.file, 'utf8')) : { question: flags.question };
  const images = flags.image ?? [];
  if (flags.option) {
    if (raw.options !== undefined) throw new Error('The file has options already: give options in the file or with --option, not both.');
    raw.options = flags.option.map(optionFromFlag);
  }
  if (flags.decision) {
    if (raw.decisions !== undefined) throw new Error('The file has decisions already: give decisions in the file or with --decision, not both.');
    raw.decisions = decisionsFromFlags(flags.decision);
    if (raw.allowDrawing === undefined) raw.allowDrawing = true;
  }
  if (raw.decisions !== undefined && raw.image === undefined && images.length === 1 && !(Array.isArray(raw.options) && raw.options.length)) raw.image = path.basename(images[0]);
  return raw;
}

/** The decisions' one-line summary of an answer: "d1 approve", "d2 change: Bottom-left". */
function decisionLines(answer) {
  const verdicts = answer?.decisions;
  if (!verdicts || typeof verdicts !== 'object') return [];
  return Object.keys(verdicts).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(id => `${id} ${verdicts[id]?.verdict ?? '?'}${verdicts[id]?.note ? `: ${String(verdicts[id].note).replace(/\s+/g, ' ')}` : ''}`);
}

function validateAsk(ask, imageNames) {
  const problems = [];
  if (typeof ask.question !== 'string' || !ask.question.trim()) problems.push('question is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ask.project ?? '')) problems.push('--project is lower-case letters, digits and dashes');
  if (Number.isNaN(Date.parse(ask.expiresAt))) problems.push('expiresAt is not a date');
  if (ask.options !== undefined) {
    if (!Array.isArray(ask.options)) problems.push('options is a list');
    else {
      const ids = new Set();
      for (const option of ask.options) {
        if (typeof option?.id !== 'string' || !option.id || typeof option.label !== 'string' || !option.label) problems.push('each option needs an id and a label');
        else if (ids.has(option.id)) problems.push(`option id ${option.id} is used twice`);
        else ids.add(option.id);
        if (option?.image !== undefined && !imageNames.includes(option.image)) problems.push(`option ${option?.id} names image ${option.image}, which is not among the --image files`);
      }
    }
  }
  if (ask.decisions !== undefined) {
    const L = DECISION_LIMITS;
    if (!Array.isArray(ask.decisions) || ask.decisions.length < 1 || ask.decisions.length > L.count) problems.push(`decisions is a list of 1 to ${L.count}`);
    else {
      ask.decisions.forEach((decision, index) => {
        const at = `decision ${index + 1}`;
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) { problems.push(`${at} is not an object`); return; }
        if (decision.id !== `d${index + 1}`) problems.push(`${at}: id is d${index + 1}`);
        if (typeof decision.text !== 'string' || !decision.text.trim() || decision.text.length > L.text) problems.push(`${at}: text is 1 to ${L.text} characters`);
        if (decision.detail !== undefined && (typeof decision.detail !== 'string' || decision.detail.length > L.detail)) problems.push(`${at}: detail is at most ${L.detail} characters`);
      });
    }
  }
  if (ask.image !== undefined) {
    if (typeof ask.image !== 'string' || !ASK_IMAGE_RE.test(ask.image)) problems.push('image is a file name of letters, digits, . _ - (up to 120, starting with a letter or digit)');
    else if (!imageNames.includes(ask.image)) problems.push(`image names ${ask.image}, which is not among the --image files`);
  }
  if (ask.requirePasskey !== undefined && typeof ask.requirePasskey !== 'boolean') problems.push('requirePasskey is true or false');
  if (typeof ask.allowNote !== 'boolean' || typeof ask.allowDrawing !== 'boolean') problems.push('allowNote and allowDrawing are true or false');
  if (problems.length) throw new Error(`ask.json is not valid: ${problems.join('; ')}.`);
}

// --- the Discord ping for a new Ask ---

async function hubConfig() {
  try { return JSON.parse(await readFile(process.env.BUW_HUB_CONFIG || path.join(os.homedir(), '.buw', 'hub.json'), 'utf8')); } catch { return null; }
}

/** The #needs-you webhook: BUW_DISCORD_NEEDS_YOU, then hub.json, then a secrets file. None: no ping. */
async function needsYouWebhook(hub) {
  if (process.env.BUW_DISCORD_NEEDS_YOU?.trim()) return process.env.BUW_DISCORD_NEEDS_YOU.trim();
  if (typeof hub?.discord?.needsYou === 'string' && hub.discord.needsYou.trim()) return hub.discord.needsYou.trim();
  try { return (await readFile(path.join(os.homedir(), '.buw', 'secrets', 'discord-webhook-needs-you'), 'utf8')).trim() || null; } catch { return null; }
}

const titleOf = id => String(id).split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

/**
 * Tell the owner an Ask or a checklist is waiting: `path` is the Hub link after the site's address. Silent without a
 * webhook; on a failed post the message is kept in the shared spool for hub-hooks to replay (no address in it), and
 * the exit code is never touched.
 */
async function pingNeedsYou({ project, text, path: link }) {
  const hub = await hubConfig();
  // A dev inbox must not ping the owner's phone with links to the real site: only an explicit webhook does.
  if (INBOX !== 'inbox' && !process.env.BUW_DISCORD_NEEDS_YOU?.trim()) return;
  const webhook = await needsYouWebhook(hub);
  if (!webhook) return;
  const site = String(hub?.siteUrl || process.env.BUW_SITE_URL || '').replace(/\/+$/, '');
  const content = [`**Agent needs you · ${titleOf(project)}**`, clip(text, 200), ...(site ? [`${site}${link}`] : [])].join('\n');
  const body = JSON.stringify({ content, allowed_mentions: { parse: [] } });
  try {
    const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Discord answered ${response.status}`);
  } catch (error) {
    const file = spoolFile();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ v: 1, at: isoNow(), kind: 'discord', target: 'needsYou', body })}\n`);
    console.error(`(Discord ping kept in the spool: ${error.name === 'TimeoutError' ? 'timed out' : error.message.replace(/https?:[^\s)]+/g, '')})`);
  }
}

/** Whether `body` starts with the bytes of the picture type its file extension names; null when the extension is not one of the known types. */
function pictureProblem(name, body) {
  const ext = path.extname(name).toLowerCase();
  const starts = (...bytes) => bytes.every((byte, index) => body[index] === byte);
  let ok;
  let type;
  if (ext === '.png') { type = 'PNG'; ok = starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a); }
  else if (ext === '.jpg' || ext === '.jpeg') { type = 'JPEG'; ok = starts(0xff, 0xd8, 0xff); }
  else if (ext === '.gif') { type = 'GIF'; ok = body.subarray(0, 4).toString('latin1') === 'GIF8'; }
  else if (ext === '.webp') { type = 'WebP'; ok = body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP'; }
  else if (ext === '.svg') { type = 'SVG'; ok = /^(?:\uFEFF)?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<(?:svg|\?xml)/i.test(body.subarray(0, 2048).toString('utf8')); }
  else return null;
  return ok ? null : `${name} is not a ${type} picture.`;
}

async function askCreate(flags) {
  const raw = await askInput(flags);
  const id = newId(flags.project, raw.question);
  const ask = askFromFile(raw, flags, id);
  const images = flags.image ?? [];
  validateAsk(ask, images.map(file => path.basename(file)));
  const uploads = [];
  for (const file of images) {
    const name = path.basename(file);
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error(`Image name ${name}: letters, digits, . _ - only.`);
    const body = await readFile(file);
    if (body.length > MAX_INLINE) throw new Error(`${name} is over 4 MB.`);
    const wrong = pictureProblem(name, body);
    if (wrong) throw new Error(wrong);
    uploads.push({ file: inboxPath('asks', id, name), body, contentType: IMAGE_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream' });
  }
  const askFile = inboxPath('asks', id, 'ask.json');
  // Pictures first and the ask last, so an ask is never listed before what it shows.
  for (const upload of uploads) await mustPut(upload.file, upload.body, { createOnly: true, contentType: upload.contentType });
  if (await mustPut(askFile, `${JSON.stringify(ask, null, 2)}\n`, { createOnly: true }) === 'exists') throw new Error(`${askFile} already exists; run it again.`);
  await postEvent({ kind: 'ask-created', title: clip(ask.question, 80), project: ask.project, bead: ask.bead, ask: id, source: 'cards', summary: 'A question is waiting for an answer.' }).catch(error => console.error(`(ask-created event skipped: ${error.message})`));
  await pingNeedsYou({ project: ask.project, text: ask.question, path: `/#/~hub/ask/${id}` }).catch(() => {});
  console.log(id);
}

async function askList(flags) {
  const folders = await listFolders('asks', flags.all);
  const wanted = flags.project ? new RegExp(`^\\d{8}-${flags.project.toLowerCase().replace(/[^a-z0-9-]/g, '')}-`) : null;
  const ids = [...folders.keys()].filter(id => !wanted || wanted.test(id)).sort();
  const rows = await mapLimit(ids, 8, async id => {
    const names = folders.get(id);
    const ask = names.has('ask.json') ? await readJson(inboxPath('asks', id, 'ask.json')) : null;
    const snooze = names.has('snooze.json') && !['cancel.json', 'pickup.json', 'answer.json'].some(name => names.has(name)) ? await readJson(inboxPath('asks', id, 'snooze.json')) : null;
    return { id, ask, state: askState(names, ask, snooze) };
  });
  for (const row of rows) {
    if (flags.project && row.ask?.project !== flags.project) continue;
    if (flags.answered && row.state !== 'answered') continue;
    if (flags.open && row.state !== 'open') continue;
    console.log(`${row.id}\t${row.state}\t${row.ask?.project ?? ''}\t${clip(row.ask?.question, 80)}`);
  }
}

async function askGet(id) {
  id = idSafe(id);
  const names = (await listInbox(`asks/${id}/`)).map(file => file.split('/').slice(2).join('/'));
  if (!names.length) throw new Error(`No ask ${id}.`);
  const shown = ['ask.json', 'answer.json', 'pickup.json', 'cancel.json'];
  for (const name of shown) {
    if (!names.includes(name)) continue;
    const text = (await readInbox(inboxPath('asks', id, name))).trim();
    console.log(`== ${name}\n${text}`);
    if (name === 'answer.json') {
      let answer = null;
      try { answer = JSON.parse(text); } catch { /* shown as it is */ }
      const lines = decisionLines(answer);
      if (lines.length) console.log(`== decisions\n${lines.join('\n')}`);
    }
  }
  const others = names.filter(name => !shown.includes(name));
  if (others.length) console.log(`== other files\n${others.join('\n')}`);
}

/** pickup.json and cancel.json, and taken.json for a request: create-only, and the second one in learns who was first. */
async function claim(folder, id, file, body) {
  const target = inboxPath(folder, id, file);
  if (await mustPut(target, `${JSON.stringify(body, null, 2)}\n`, { createOnly: true }) === 'exists') {
    const first = await readJson(target);
    console.error(`${folder}/${id}/${file} was written already${first ? ` by ${first.host ?? first.by ?? 'someone'} at ${first.at ?? '?'}` : ''}.`);
    throw new Exit(3);
  }
  console.log(`${folder}/${id}/${file}`);
}

const pickupBody = flags => ({ at: isoNow(), ...(process.env.CLAUDE_SESSION_ID ? { session: process.env.CLAUDE_SESSION_ID } : {}), host: hostName(), ...(flags.bead ? { bead: flags.bead } : {}) });

// --- Checklists: a list of steps for the owner, ticked one at a time in the Hub ---
// checklists/<id>/: checklist.json (this command), tick-/untick-<item>-<stamp>-<rand4>.json and submit.json (the Hub only),
// pickup.json and cancel.json (this command). The state is read from the file names alone.

const CHECKLIST_MARK_RE = /^(tick|untick)-(\d{2})-(\d{8}T\d{9}Z)-([a-z0-9]{4})\.json$/;
const CHECKLIST_LIMITS = { title: 200, items: 50, text: 200, group: 80, guide: 4000, context: 4000, link: 2000, file: 256 * 1024, build: 2000, lookFor: 2000 };
const PLAYTEST_PLATFORMS = ['web', 'windows', 'mac', 'linux', 'android', 'ios'];

/** cancel.json → cancelled, pickup.json → picked-up, submit.json → submitted, else open. */
const checklistState = names => (names.has('cancel.json') ? 'cancelled' : names.has('pickup.json') ? 'picked-up' : names.has('submit.json') ? 'submitted' : 'open');

/** The winning mark per item: the greatest stamp in the file name, the greater rand4 on a tie. → Map<item, { done, at }> */
function checklistMarks(names) {
  const best = new Map();
  for (const name of names) {
    const match = CHECKLIST_MARK_RE.exec(name);
    if (!match) continue;
    const [, action, item, time, tail] = match;
    const key = `${time}-${tail}`;
    if (!best.has(item) || key > best.get(item).key) {
      best.set(item, { key, done: action === 'tick', at: `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}.${time.slice(15, 18)}Z` });
    }
  }
  return new Map([...best].map(([item, { done, at }]) => [item, { done, at }]));
}

const isHttps = value => { try { return new URL(value).protocol === 'https:' && /^https:\/\//i.test(value); } catch { return false; } };

/** The problems with a checklist input (the shape of checklist.json without id, project, createdAt, from and item ids). */
function validateChecklist(raw) {
  const L = CHECKLIST_LIMITS;
  const problems = [];
  const text = (value, max) => typeof value === 'string' && value.trim().length >= 1 && value.length <= max;
  const optional = (value, max) => value === undefined || (typeof value === 'string' && value.length <= max);
  const link = value => typeof value === 'string' && value.length <= L.link && /^https?:\/\//i.test(value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['the file is not an object'];
  if (!text(raw.title, L.title)) problems.push(`title is 1 to ${L.title} characters`);
  if (!optional(raw.context, L.context)) problems.push(`context is at most ${L.context} characters`);
  if (raw.card !== undefined && !link(raw.card)) problems.push('card is an http:// or https:// link of at most 2000 characters');
  if (raw.kind !== undefined && raw.kind !== 'playtest') problems.push('kind is "playtest", or left out for steps');
  if (raw.kind === 'playtest') {
    if (typeof raw.build !== 'string' || !raw.build) problems.push('a playtest needs --build, the https link of the build');
    else if (raw.build.length > L.build || !isHttps(raw.build)) problems.push(`--build is an https:// link of at most ${L.build} characters`);
    if (raw.platform !== undefined && !PLAYTEST_PLATFORMS.includes(raw.platform)) problems.push(`--platform is one of: ${PLAYTEST_PLATFORMS.join(', ')}`);
    if (!optional(raw.lookFor, L.lookFor)) problems.push(`--look-for is at most ${L.lookFor} characters`);
  } else if (raw.build !== undefined || raw.platform !== undefined || raw.lookFor !== undefined) {
    problems.push('build, platform and lookFor belong to a playtest: add --playtest');
  }
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > L.items) problems.push(`items is a list of 1 to ${L.items}`);
  else {
    raw.items.forEach((item, index) => {
      const at = `item ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { problems.push(`${at} is not an object`); return; }
      if (!text(item.text, L.text)) problems.push(`${at}: text is 1 to ${L.text} characters`);
      if (!optional(item.group, L.group)) problems.push(`${at}: group is at most ${L.group} characters`);
      if (!optional(item.guide, L.guide)) problems.push(`${at}: guide is at most ${L.guide} characters`);
      if (item.link !== undefined && !link(item.link)) problems.push(`${at}: link is an http:// or https:// link of at most 2000 characters`);
    });
  }
  return problems;
}

/** The checklist.json to write: the input plus id, project, createdAt and from, with positional item ids. */
function checklistFromInput(raw, flags, id) {
  const card = flags.card || raw.card;
  const bead = flags.bead || raw.bead;
  return {
    id, project: flags.project, createdAt: isoNow(),
    from: { host: hostName(), tool: flags.tool || 'claude-code', ...(process.env.CLAUDE_SESSION_ID ? { session: process.env.CLAUDE_SESSION_ID } : {}) },
    ...(bead ? { bead } : {}),
    title: raw.title.trim(),
    ...(raw.context ? { context: raw.context } : {}),
    ...(card ? { card } : {}),
    ...(raw.kind === 'playtest' ? { kind: 'playtest', build: raw.build, platform: raw.platform ?? 'web', ...(raw.lookFor ? { lookFor: raw.lookFor } : {}) } : {}),
    items: raw.items.map((item, index) => ({
      id: String(index + 1).padStart(2, '0'), text: item.text.trim(),
      ...(item.group ? { group: item.group } : {}), ...(item.guide ? { guide: item.guide } : {}), ...(item.link ? { link: item.link } : {}),
    })),
  };
}

/** The names of the files in one checklist's folder; throws when there are none. */
async function checklistNames(id) {
  const names = (await listInbox(`checklists/${id}/`)).map(file => file.split('/').slice(2).join('/'));
  if (!names.includes('checklist.json')) throw new Error(`No checklist ${id}.`);
  return new Set(names);
}

/** Everything `get` shows: the list, its state, progress and the Hub's and the agent's files. */
const CHECKLIST_PICTURE_RE = /^(?:evidence-\d{2}|shot)-(?:\d{8}T\d{9}Z)-[a-z0-9]{4}\.(?:png|jpg)$/;

/** The bytes of an inbox file, or null when it is not there. */
async function readInboxBytes(file) {
  const route = fileRoute(file);
  const response = await send('GET', route, { headers: {} });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure('GET', route, response);
  return Buffer.from(await response.arrayBuffer());
}

async function checklistRead(id) {
  const names = await checklistNames(id);
  const checklist = await readJson(inboxPath('checklists', id, 'checklist.json'));
  if (!checklist || !Array.isArray(checklist.items)) throw new Error(`checklists/${id}/checklist.json is not a checklist.`);
  const marks = checklistMarks(names);
  const items = checklist.items.map(item => ({ id: item.id, text: item.text, done: !!marks.get(item.id)?.done, ...(marks.get(item.id) ? { at: marks.get(item.id).at } : {}) }));
  const read = async name => (names.has(name) ? readJson(inboxPath('checklists', id, name)) : undefined);
  const [submit, pickup, cancel] = await Promise.all([read('submit.json'), read('pickup.json'), read('cancel.json')]);
  // The newest picture per step, and the playtest screenshots, from the file names alone.
  const evidence = {};
  const shots = [];
  for (const name of [...names].sort()) {
    if (!CHECKLIST_PICTURE_RE.test(name)) continue;
    if (name.startsWith('shot-')) shots.push(name);
    else evidence[name.slice(9, 11)] = name;
  }
  for (const item of items) if (evidence[item.id]) item.evidence = evidence[item.id];
  const view = {
    checklist, state: checklistState(names), done: items.filter(item => item.done).length, total: items.length, items, ...(shots.length ? { shots } : {}),
    ...(submit ? { submit } : {}), ...(pickup ? { pickup } : {}), ...(cancel ? { cancel } : {}),
  };
  // Not part of the printed or JSON view: what `--into` downloads.
  Object.defineProperty(view, 'pictures', { value: [...names].filter(name => CHECKLIST_PICTURE_RE.test(name)).sort() });
  return view;
}

const minute = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

function printChecklist(view, asJson) {
  if (asJson) { console.log(JSON.stringify(view, null, 2)); return; }
  const { checklist, state, done, total, items } = view;
  console.log([checklist.id, state, `${done} of ${total} done`, checklist.project].join('\t'));
  console.log(checklist.title);
  for (const item of items) {
    console.log(`${item.done ? '[x]' : '[ ]'} ${item.id} ${item.text}${item.done && item.at ? `  (${minute(item.at)})` : ''}`);
    if (item.evidence) console.log(`     evidence: ${item.evidence}`);
  }
  for (const shot of view.shots ?? []) console.log(`screenshot: ${shot}`);
  if (checklist.kind === 'playtest') {
    console.log(`playtest: ${checklist.build} (${checklist.platform ?? 'web'})${checklist.lookFor ? `; look for: ${String(checklist.lookFor).replace(/\s+/g, ' ')}` : ''}`);
    const report = view.submit;
    if (report) {
      const issues = Array.isArray(report.issues) ? report.issues : [];
      console.log(`rating: ${report.rating ?? '?'}/5, verdict: ${report.verdict ?? '?'}, ${issues.length} issue(s)`);
      issues.forEach((issue, index) => console.log(`  ${index + 1}. ${String(issue?.text ?? '').replace(/\s+/g, ' ')}${issue?.shot ? ` [${issue.shot}]` : ''}`));
    }
  }
  for (const name of ['submit', 'pickup', 'cancel']) if (view[name]) console.log(`== ${name}.json\n${JSON.stringify(view[name], null, 2)}`);
}

async function checklistCreate(flags) {
  const usage = 'Usage: checklist create --project <p> (--file checklist.json | --title <t> --item <text>...) [--bead <b>] [--card <url>] [--playtest --build <https url> [--platform <p>] [--look-for <t>]]';
  if (!flags.project || (!flags.file && !flags.title)) throw new Error(usage);
  if (flags.file && (flags.title || flags.item)) throw new Error(`Give --file, or --title with --item, not both. ${usage}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(flags.project)) throw new Error('--project is lower-case letters, digits and dashes');
  const raw = flags.file ? JSON.parse(await readFile(flags.file, 'utf8')) : { title: flags.title, items: (flags.item ?? []).map(text => ({ text })) };
  for (const name of ['build', 'platform', 'look-for']) if (flags[name] !== undefined && !flags.playtest) throw new Error(`--${name} belongs to a playtest: add --playtest. ${usage}`);
  if (flags.playtest) {
    if (raw.kind !== undefined && raw.kind !== 'playtest') throw new Error(`The file is not a playtest (kind ${JSON.stringify(raw.kind)}), so --playtest does not fit. ${usage}`);
    raw.kind = 'playtest';
    if (flags.build !== undefined) raw.build = flags.build;
    if (flags.platform !== undefined) raw.platform = flags.platform;
    if (flags['look-for'] !== undefined) raw.lookFor = flags['look-for'];
  }
  const problems = validateChecklist(raw);
  if (flags.card !== undefined && !/^https?:\/\//i.test(flags.card)) problems.push('--card is an http:// or https:// link');
  if (problems.length) throw new Error(`checklist.json is not valid: ${problems.join('; ')}.`);
  const id = newId(flags.project, raw.title);
  const checklist = checklistFromInput(raw, flags, id);
  const body = `${JSON.stringify(checklist, null, 2)}\n`;
  if (Buffer.byteLength(body) > CHECKLIST_LIMITS.file) throw new Error('checklist.json is not valid: the file is over 256 KB.');
  const file = inboxPath('checklists', id, 'checklist.json');
  if (await mustPut(file, body, { createOnly: true }) === 'exists') throw new Error(`${file} already exists; run it again.`);
  const steps = checklist.items.length;
  await postEvent({ kind: 'checklist-created', title: clip(checklist.title, 80), project: checklist.project, bead: checklist.bead, checklist: id, source: 'cards', summary: checklist.kind === 'playtest' ? `A build to try: ${steps} things to look at.` : `${steps} steps for you.` }, { out: console.error }).catch(error => console.error(`(checklist-created event skipped: ${error.message})`));
  await pingNeedsYou({ project: checklist.project, text: checklist.kind === 'playtest' ? `Playtest: ${checklist.title}` : `${checklist.title} (${steps} steps)`, path: `/#/~hub/checklist/${id}` }).catch(() => {});
  console.log(id);
}

async function checklistList(flags) {
  const folders = await listFolders('checklists', flags.all);
  const wanted = flags.project ? new RegExp(`^\\d{8}-${flags.project.toLowerCase().replace(/[^a-z0-9-]/g, '')}-`) : null;
  const ids = [...folders.keys()].filter(id => folders.get(id).has('checklist.json') && (!wanted || wanted.test(id))).sort();
  const rows = await mapLimit(ids, 8, async id => {
    const names = folders.get(id);
    const state = checklistState(names);
    if ((flags.open && state !== 'open') || (flags.submitted && state !== 'submitted')) return null;
    const checklist = await readJson(inboxPath('checklists', id, 'checklist.json'));
    if (!checklist || !Array.isArray(checklist.items)) return null;
    const marks = checklistMarks(names);
    const done = checklist.items.filter(item => marks.get(item.id)?.done).length;
    return { id, state, done, total: checklist.items.length, project: checklist.project ?? '', title: clip(checklist.title, 80) };
  });
  for (const row of rows) if (row && (!flags.project || row.project === flags.project)) console.log([row.id, row.state, `${row.done}/${row.total}`, row.project, row.title].join('\t'));
}

async function checklistGet(id, flags) {
  id = idSafe(id);
  const view = await checklistRead(id);
  if (flags.into !== undefined) {
    if (typeof flags.into !== 'string' || !flags.into) throw new Error('--into is a folder to put the pictures in.');
    await mkdir(flags.into, { recursive: true });
    const saved = [];
    for (const name of view.pictures) {
      const bytes = await readInboxBytes(inboxPath('checklists', id, name));
      if (!bytes) continue;
      const target = path.join(flags.into, name);
      await writeFile(target, bytes);
      saved.push(target);
    }
    if (flags.json) view.saved = saved;
    printChecklist(view, flags.json);
    if (!flags.json) for (const target of saved) console.log(`saved: ${target}`);
    else if (!saved.length) console.error('(no pictures on this list)');
    return;
  }
  printChecklist(view, flags.json);
}

/** Wait for the owner to submit. Exit 0 on submit (prints what `get` prints), 3 on cancel, 4 on timeout (prints the progress). */
async function checklistWait(id, flags) {
  id = idSafe(id);
  const minutes = flags.timeout === undefined ? 30 : Number(flags.timeout);
  const seconds = flags.every === undefined ? 20 : Number(flags.every);
  if (!(minutes > 0) || minutes > 240) throw new Error('--timeout is a number of minutes above 0 and at most 240.');
  if (!(seconds >= 5)) throw new Error('--every is a number of seconds, at least 5.');
  const deadline = Date.now() + minutes * 60_000;
  for (let first = true; ; first = false) {
    let view;
    try {
      view = await checklistRead(id);
    } catch (error) {
      if (first || /^No checklist/.test(error.message)) throw error;
      console.error(`(poll failed, trying again: ${error.message})`);
    }
    if (view) {
      if (view.state === 'cancelled') { printChecklist(view, flags.json); throw new Exit(3); }
      if (view.state === 'submitted' || view.state === 'picked-up') { printChecklist(view, flags.json); return; }
      if (Date.now() >= deadline) {
        console.log(`${view.checklist.id}\t${view.state}\t${view.done} of ${view.total} done\t${view.checklist.project}\t(timed out after ${minutes} min)`);
        throw new Exit(4);
      }
    } else if (Date.now() >= deadline) {
      throw new Exit(4);
    }
    await delay(Math.max(0, Math.min(seconds * 1000, deadline - Date.now())));
  }
}

/** The agent has read the submission and acted on it: exit 2 when it was not submitted, 3 when already picked up. */
async function checklistPickup(id) {
  id = idSafe(id);
  const names = await checklistNames(id);
  const state = checklistState(names);
  if (state === 'picked-up') { console.error(`checklists/${id} was picked up already.`); throw new Exit(3); }
  if (state !== 'submitted') { console.error(`checklists/${id} is ${state}, not submitted: nothing to pick up.`); throw new Exit(2); }
  return claim('checklists', id, 'pickup.json', { at: isoNow(), host: hostName(), ...(process.env.CLAUDE_SESSION_ID ? { session: process.env.CLAUDE_SESSION_ID } : {}) });
}

/** Withdraw a list that is still open: exit 3 when it was cancelled or submitted already. */
async function checklistCancel(id) {
  id = idSafe(id);
  const state = checklistState(await checklistNames(id));
  if (state !== 'open') { console.error(`checklists/${id} is ${state}, so it cannot be cancelled.`); throw new Exit(3); }
  return claim('checklists', id, 'cancel.json', { at: isoNow(), by: hostName() });
}

// --- requests ---

async function requestList(flags) {
  const folders = await listFolders('requests', flags.all);
  const ids = [...folders.keys()].filter(id => folders.get(id).has('request.json')).sort();
  const rows = await mapLimit(ids, 8, async id => {
    const names = folders.get(id);
    let state = names.has('taken.json') ? 'taken' : names.has('declined.json') ? 'declined' : 'open';
    if (flags.approved || flags.target) {
      // Only an approval the runner could still start: signed, not taken, not stopped, not declined, not finished, not expired.
      if (!names.has('approved.json') || ['taken.json', 'declined.json', 'stop.json', 'result.json'].some(name => names.has(name))) return null;
      const approved = await readJson(inboxPath('requests', id, 'approved.json'));
      if (!approved || !(Date.parse(approved.expires) > Date.now()) || (flags.target && approved.target !== flags.target)) return null;
      state = 'approved';
    }
    if (flags.open && state !== 'open') return null;
    const request = await readJson(inboxPath('requests', id, 'request.json'));
    return { id, state, request };
  });
  for (const row of rows) {
    if (!row || (flags.project && row.request?.project !== flags.project)) continue;
    console.log(`${row.id}\t${row.state}\t${row.request?.project ?? ''}\t${clip(row.request?.text, 80)}`);
  }
}

/** The preset ids a request may name. A copy of Object.keys(PRESETS) in site/api/presets.mjs; a test keeps them equal. */
const PRESET_IDS = ['code-task', 'research', 'market-research', 'game-teardown', 'playtest-build', 'sprite-set', 'agent-avatar', 'docs'];
const REQUEST_NEEDS = ['unity', 'gpu', 'comfyui', 'sprite-studio', 'lan', 'local-files'];
const REQUEST_TARGETS = ['pc', 'cloud', 'hermes', 'at-pc'];
const REQUEST_USAGE = 'Usage: request create --project <p> --text <t> [--title <t>] [--preset <id>] [--repo owner/name] [--needs a,b] [--target pc|cloud|hermes|at-pc] [--done-when <t>] [--origin-run <id>] [--when next-sprint|nightly|record] [--by <name>]';

async function requestCreate(flags) {
  if (!flags.project || !flags.text) throw new Error(REQUEST_USAGE);
  const preset = flags.preset;
  if (preset !== undefined && !PRESET_IDS.includes(preset)) throw new Error(`--preset is one of: ${PRESET_IDS.join(', ')}.`);
  if (preset === undefined && (flags.title || flags.repo || flags.needs || flags.target || flags['done-when'])) {
    throw new Error('--title, --repo, --needs, --target and --done-when need --preset.');
  }
  if (flags.text.length > 4000) throw new Error('--text is at most 4000 characters.');
  if (flags.title !== undefined && (!flags.title.trim() || flags.title.length > 120)) throw new Error('--title is 1 to 120 characters.');
  if (flags.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flags.repo)) throw new Error('--repo is owner/name.');
  if (flags['done-when'] !== undefined && flags['done-when'].length > 400) throw new Error('--done-when is at most 400 characters.');
  if (flags.target !== undefined && !REQUEST_TARGETS.includes(flags.target)) throw new Error(`--target is one of: ${REQUEST_TARGETS.join(', ')}.`);
  const needs = flags.needs === undefined ? undefined : [...new Set(flags.needs.split(',').map(item => item.trim()).filter(Boolean))];
  if (needs?.some(item => !REQUEST_NEEDS.includes(item))) throw new Error(`--needs is a comma list of: ${REQUEST_NEEDS.join(', ')}.`);
  const when = flags.when ?? 'next-sprint';
  if (!WHEN.includes(when)) throw new Error(`--when is one of: ${WHEN.join(', ')}.`);
  const by = flags.by || hostName();
  const originRun = flags['origin-run'] ?? process.env.BUW_REQUEST_ID?.trim();
  if (originRun && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(originRun)) throw new Error('--origin-run is a request id.');
  const id = newId(flags.project, flags.text);
  const request = {
    id, project: flags.project, createdAt: isoNow(), by, text: flags.text,
    ...(preset === undefined ? { when } : {
      ...(flags.title ? { title: flags.title } : {}),
      preset,
      ...(flags.repo ? { repo: flags.repo } : {}),
      needs: needs ?? [],
      ...(flags.target ? { target: flags.target } : {}),
      ...(flags['done-when'] ? { doneWhen: flags['done-when'] } : {}),
      origin: originRun ? { kind: 'run', name: originRun } : { kind: 'agent', name: by },
    }),
  };
  const file = inboxPath('requests', id, 'request.json');
  if (await mustPut(file, `${JSON.stringify(request, null, 2)}
`, { createOnly: true }) === 'exists') throw new Error(`${file} already exists; run it again.`);
  console.log(id);
  if (preset !== undefined) {
    await pingNeedsYou({ project: flags.project, text: request.title ?? flags.text, path: `/#/~hub/request/${id}` }).catch(() => {});
  }
}

// --- Runner commands: verify an approval, read its brief, claim it, report progress, finish ---
// What a runner trusts is the owner's Ed25519 signature on approved.json and nothing else: it checks that the signature,
// the request bytes, the target, the expiry, the limits and the nonce all hold, and refuses on the first that does not.

// --- signature check: a copy of canonical, parsePublicKey and verify in site/api/signing.mjs (a test keeps them equal) ---
function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).filter(name => value[name] !== undefined).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function parsePublicKey(text) {
  const body = String(text ?? '').split(/\r?\n/).filter(line => !line.startsWith('-----')).join('').replace(/\s+/g, '');
  return createPublicKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'spki' });
}
function verifySigned(doc, publicKey) {
  try {
    if (!doc || typeof doc !== 'object' || typeof doc.signature !== 'string') return false;
    const signature = Buffer.from(doc.signature, 'base64');
    if (signature.length !== 64) return false;
    const rest = Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'signature'));
    return edVerify(null, Buffer.from(canonical(rest), 'utf8'), publicKey, signature);
  } catch {
    return false;
  }
}
// --- end of the signature check ---

const MAX_RUN_MINUTES = 120;   // MAX_RUN_MINUTES in site/api/presets.mjs
const RUN_STATES = ['started', 'working', 'turn-ended', 'usage-limit'];
const FINISH_OUTCOMES = ['pr', 'card', 'failed'];

/** The public key a runner trusts: HUB_SIGNING_PUBKEY (base64 SPKI or PEM text), else the file BUW_APPROVAL_PUBKEY names, else ~/.buw/secrets/approval-signing-key.pub. Exit 5 without one. */
async function approvalPublicKey() {
  let text = process.env.HUB_SIGNING_PUBKEY?.trim();
  if (!text) {
    const file = process.env.BUW_APPROVAL_PUBKEY?.trim() || path.join(os.homedir(), '.buw', 'secrets', 'approval-signing-key.pub');
    text = await readFile(file, 'utf8').catch(() => '');
  }
  if (!text.trim()) { console.error('no public key: set HUB_SIGNING_PUBKEY or BUW_APPROVAL_PUBKEY, or put approval-signing-key.pub in ~/.buw/secrets.'); throw new Exit(5); }
  try {
    return parsePublicKey(text);
  } catch {
    console.error('no public key: the one given is not an Ed25519 SPKI key.');
    throw new Exit(5);
  }
}

const refuse = reason => { console.error(reason); throw new Exit(5); };

/** The approval for a request if every check holds; else exit 5 naming the first check that failed. */
async function verifyApproval(rawId, { target, repo } = {}) {
  const id = idSafe(rawId);
  if (!id) throw new Error('A request id is needed.');
  const publicKey = await approvalPublicKey();
  const [requestBytes, approvedText, takenBytes, stopText, declinedText, resultText] = await Promise.all([
    readInboxBytes(inboxPath('requests', id, 'request.json')),
    readInbox(inboxPath('requests', id, 'approved.json')),
    readInboxBytes(inboxPath('requests', id, 'taken.json')),
    readInbox(inboxPath('requests', id, 'stop.json')),
    readInbox(inboxPath('requests', id, 'declined.json')),
    readInbox(inboxPath('requests', id, 'result.json')),
  ]);
  // A taken.json that is there but cannot be read counts as taken by someone else.
  let takenDoc = null;
  let takenUnreadable = false;
  if (takenBytes !== null) {
    try { takenDoc = JSON.parse(takenBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { takenUnreadable = true; }
    if (!takenDoc || typeof takenDoc !== 'object') takenUnreadable = true;
  }
  let approved = null;
  try { approved = approvedText === null ? null : JSON.parse(approvedText); } catch { /* unsigned */ }
  if (!approved || typeof approved !== 'object' || Array.isArray(approved) || typeof approved.signature !== 'string') refuse('unsigned: there is no signed approval for this request.');
  if (!verifySigned(approved, publicKey)) refuse('bad-signature: the approval is not signed by the configured key.');
  if (approved.v !== 1 || approved.request !== id) refuse('wrong-request: the approval is for another request.');
  if (requestBytes === null || createHash('sha256').update(requestBytes).digest('hex') !== approved.requestSha256) refuse('hash-mismatch: request.json changed after it was approved.');
  let request = null;
  try { request = JSON.parse(requestBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { /* checked next */ }
  if (!request || request.id !== id || request.project !== approved.project) refuse('wrong-request: request.json does not match the approval.');
  const expires = typeof approved.expires === 'string' ? Date.parse(approved.expires) : NaN;
  if (!(expires > Date.now())) refuse('expired: the approval is past its expiry.');
  const minutes = approved.limits?.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_RUN_MINUTES) refuse(`bad-limits: limits.minutes must be 1 to ${MAX_RUN_MINUTES}.`);
  const run = approved.run;
  if (!run || typeof run !== 'object' || typeof run.brief !== 'string' || !run.brief || typeof run.preset !== 'string') refuse('no-run-block: the approval has no run block.');
  if (stopText !== null) refuse('stopped: the owner stopped this request.');
  if (declinedText !== null) refuse('declined: the owner declined this request.');
  if (resultText !== null) refuse('finished: this request already has a result.');
  if (typeof approved.nonce !== 'string' || !approved.nonce || takenUnreadable || (takenDoc && takenDoc.nonce !== approved.nonce)) refuse('nonce-used: another run took this approval.');
  // This CLI runs pc and cloud approvals only: a hermes one is started by the site API, never by a runner.
  if (!['pc', 'cloud'].includes(approved.target) || (target && approved.target !== target)) refuse(`wrong-target: the approval is for ${approved.target}.`);
  if (repo && approved.repo !== repo) refuse(`wrong-repo: the approval is for ${approved.repo ?? 'no repo'}.`);
  return { id, approved, request };
}

async function requestVerify(rawId, flags) {
  if (flags.target && !['pc', 'cloud'].includes(flags.target)) throw new Error('--target is pc or cloud.');
  const { id, approved } = await verifyApproval(rawId, flags);
  console.log(JSON.stringify({ id, project: approved.project, repo: approved.repo ?? null, target: approved.target, limits: approved.limits, nonce: approved.nonce, preset: approved.run.preset }));
}

async function requestBrief(rawId, flags) {
  if (flags.target && !['pc', 'cloud'].includes(flags.target)) throw new Error('--target is pc or cloud.');
  const { approved } = await verifyApproval(rawId, flags);
  process.stdout.write(approved.run.brief.endsWith('\n') ? approved.run.brief : `${approved.run.brief}\n`);
}

/** Secret-looking runs hidden before text goes to the Hub: sk-…, ghp_…, AKIA…, JWTs, and 32+ character hex or base64 runs. */
function maskSecrets(text) {
  return String(text ?? '')
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[masked]')
    .replace(/\bsk-[\w-]{10,}/g, '[masked]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[masked]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[masked]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[masked]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[masked]');
}

const runId = flags => idSafe(flags._[1] ?? process.env.BUW_REQUEST_ID);
const markStampNow = () => `${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}-${rand(2)}`;   // 20261029T100000123Z-ab12

async function requestTakeRunner(rawId, flags) {
  if (!['pc', 'cloud'].includes(flags.runner)) throw new Error('--runner is pc or cloud.');
  if (!flags.nonce) throw new Error('Usage: request take <id> --runner pc|cloud --nonce <n> [--session <id or link>]');
  const id = idSafe(rawId);
  const approved = await readJson(inboxPath('requests', id, 'approved.json'));
  if (!approved?.nonce) refuse('unsigned: there is no approval to take.');
  if (approved.nonce !== flags.nonce) refuse('nonce-used: that nonce is not this approval\'s.');
  const session = flags.session || process.env.CLAUDE_SESSION_ID;
  return claim('requests', id, 'taken.json', { runner: flags.runner, host: hostName(), nonce: approved.nonce, ...(session ? { session } : {}), at: isoNow() });
}

async function requestRun(flags) {
  const id = runId(flags);
  if (!id) throw new Error('Usage: request run <id> --state started|working|turn-ended|usage-limit [--last <text>] [--link <url>]');
  if (!RUN_STATES.includes(flags.state)) throw new Error(`--state is one of: ${RUN_STATES.join(', ')}.`);
  if (flags.link && !/^https:\/\/\S+$/.test(flags.link)) throw new Error('--link is an https address.');
  const session = process.env.CLAUDE_SESSION_ID;
  const doc = {
    v: 1, request: id, state: flags.state,
    ...(flags.last ? { lastAction: clip(maskSecrets(flags.last), 200) } : {}),
    ...(session ? { session } : {}),
    ...(flags.link ? { sessionLink: flags.link } : {}),
    at: isoNow(),
  };
  const file = inboxPath('requests', id, `run-${markStampNow()}.json`);
  if (await mustPut(file, `${JSON.stringify(doc, null, 2)}\n`, { createOnly: true }) === 'exists') throw new Error(`${file} already exists; run it again.`);
  console.log(file);
}

async function requestFinish(rawId, flags) {
  const id = runId({ _: ['finish', rawId] });
  if (!id) throw new Error('Usage: request finish <id> --outcome pr|card|failed --summary <s> [--pr <url>] [--card <link>] [--reason <r>] [--report <file.md>]');
  if (!FINISH_OUTCOMES.includes(flags.outcome)) throw new Error(`--outcome is one of: ${FINISH_OUTCOMES.join(', ')}.`);
  if (!flags.summary?.trim()) throw new Error('--summary is needed.');
  if (flags.pr && !/^https:\/\/\S+$/.test(flags.pr)) throw new Error('--pr is an https address.');
  let report = null;
  if (flags.report) {
    report = await readFile(flags.report);
    if (report.length > 256 * 1024) throw new Error('--report is over 256 KB.');
  }
  const resultFile = inboxPath('requests', id, 'result.json');
  if (await readInbox(resultFile) !== null) { console.error(`requests/${id}/result.json was written already.`); throw new Exit(3); }
  if (report) await mustPut(inboxPath('requests', id, 'report.md'), report, { createOnly: true, contentType: 'text/markdown' });   // already there: a retry
  const result = {
    v: 1, outcome: flags.outcome,
    ...(flags.pr ? { pr: flags.pr } : {}),
    ...(flags.card ? { card: String(flags.card) } : {}),
    summary: clip(maskSecrets(flags.summary), 500),
    ...(flags.reason ? { reason: clip(maskSecrets(flags.reason), 80) } : {}),
    by: 'run', at: isoNow(),
  };
  if (await mustPut(resultFile, `${JSON.stringify(result, null, 2)}\n`, { createOnly: true }) === 'exists') { console.error(`requests/${id}/result.json was written already.`); throw new Exit(3); }
  console.log(`requests/${id}/result.json`);
  const project = (await readJson(inboxPath('requests', id, 'request.json')).catch(() => null))?.project;
  const quiet = () => {};
  if (flags.pr) await postEvent({ kind: 'pr-opened', title: `PR opened for ${id}`, url: flags.pr, summary: result.summary, source: 'cards-finish', ...(project ? { project } : {}) }, { out: quiet }).catch(() => {});
  if (flags.outcome === 'failed') await postEvent({ kind: 'alert', title: `Run failed: ${id}`, summary: result.summary, source: 'cards-finish', ...(project ? { project } : {}) }, { out: quiet }).catch(() => {});
}

const stampTime = name => {
  const match = /^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +match[7]) : 0;
};

/** The state of one request from its files (no PC report here): the table's rows, without `hermesLive`. */
async function requestStateOf(id, names) {
  const read = name => (names.has(name) ? readJson(inboxPath('requests', id, name)) : Promise.resolve(null));
  const [request, approved, taken, result] = await Promise.all([read('request.json'), read('approved.json'), read('taken.json'), read('result.json')]);
  const now = Date.now();
  if (names.has('declined.json')) return 'declined';
  if (names.has('stop.json')) return result || !taken ? 'stopped' : 'stopping';
  if (result) return result.outcome === 'failed' ? 'failed' : 'done';
  if (!request?.preset) return taken ? 'taken' : 'open';
  if (taken) {
    const newest = Math.max(0, ...[...names].map(stampTime));
    if (now - newest < 20 * 60000) return 'running';
    return now - Date.parse(taken.at) < 20 * 60000 ? 'taken' : 'lost';
  }
  if (approved) return Date.parse(approved.expires) <= now ? 'expired' : 'approved';
  return 'proposed';
}

async function requestState(rawId) {
  const id = idSafe(rawId);
  const names = new Set((await listInbox(`requests/${id}/`)).map(file => file.split('/').slice(2).join('/')));
  if (!names.has('request.json')) { console.error(`No request ${id}.`); throw new Exit(2); }
  console.log(await requestStateOf(id, names));
}

// --- Beads ---

/** A worktree root as it is hashed and stored: forward slashes, no trailing slash. */
const normalRoot = root => String(root ?? '').replace(/[\\]/g, '/').replace(/\/+$/, '');

/** `<host>-<first 10 hex of sha256(root, lower case)>`. The same rule as `copyIdOf` in site/api/hub-beads.mjs. */
const copyIdOf = (host, root) => `${host}-${sha256(normalRoot(root).toLowerCase()).slice(0, 10)}`;

const gitOut = (...args) => {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : '';
};

async function beadsPush(flags) {
  const project = flags.project;
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('Usage: beads push --project <p> [--from <file.jsonl>] [--copy <id>]');
  if (flags.copy !== undefined && (!/^[a-z0-9][a-z0-9-]*$/.test(flags.copy) || flags.copy === 'legacy' || /token|secret|password|credential/.test(flags.copy))) {
    throw new Error('--copy must be lower-case letters, digits and hyphens, not "legacy", and must not contain token, secret, password or credential.');
  }
  let content;
  if (flags.from) {
    content = await readFile(flags.from, 'utf8');
  } else {
    const run = spawnSync('bd export', { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const missing = run.error?.code === 'ENOENT' || run.status === 127 || /not recognized|not found/i.test(run.stderr ?? '');
    if (missing) throw new Error('bd is not installed.');
    if (run.status !== 0) throw new Error(`bd export failed (${run.status}): ${clip(run.stderr, 200)}`);
    content = run.stdout;
  }
  if (Buffer.byteLength(content) > MAX_INLINE) throw new Error('The Beads export is over 4 MB.');
  const root = normalRoot(gitOut('rev-parse', '--show-toplevel') || process.cwd());
  const gitDir = gitOut('rev-parse', '--path-format=absolute', '--git-dir');
  const copy = flags.copy ?? copyIdOf(hostName(), root);
  const meta = {
    v: 2, pushedAt: isoNow(), host: hostName(),
    count: content.split(/\r?\n/).filter(line => line.trim()).length,
    repo: gitOut('remote', 'get-url', 'origin'),
    worktree: root.split('/').pop() || '',
    main: !!gitDir && normalRoot(gitDir) === normalRoot(gitOut('rev-parse', '--path-format=absolute', '--git-common-dir')),
    root,
    branch: gitOut('rev-parse', '--abbrev-ref', 'HEAD'),
  };
  // The data first, then the meta that announces it.
  await mustPut(inboxPath('beads', project, `${copy}.jsonl`), content, { contentType: 'application/x-ndjson' });
  await mustPut(inboxPath('beads', project, `${copy}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`beads/${project}/${copy}.jsonl (${meta.count} issue(s))`);
}

// --- argument parsing for the inbox commands ---

const BOOLEAN_FLAGS = new Set(['answered', 'open', 'submitted', 'all', 'json', 'require-passkey', 'playtest', 'approved']);
function parseFlags(args) {
  const flags = { _: [] };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (!arg.startsWith('--')) { flags._.push(arg); continue; }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
    at += 1;
    if (name === 'image') (flags.image ??= []).push(value);
    else if (name === 'item') (flags.item ??= []).push(value);
    else if (name === 'option') (flags.option ??= []).push(value);
    else if (name === 'decision') (flags.decision ??= []).push(value);
    else flags[name] = value;
  }
  return flags;
}

async function inbox(command, args) {
  const flags = parseFlags(args);
  const [sub, id] = flags._;
  await replaySpool().catch(() => {});
  if (command === 'event') return postEvent({ ...flags, kind: sub });
  if (command === 'ask' && sub === 'create') return askCreate(flags);
  if (command === 'ask' && sub === 'list') return askList(flags);
  if (command === 'ask' && sub === 'get' && id) return askGet(id);
  if (command === 'ask' && sub === 'pickup' && id) return claim('asks', idSafe(id), 'pickup.json', pickupBody(flags));
  if (command === 'ask' && sub === 'cancel' && id) return claim('asks', idSafe(id), 'cancel.json', { at: isoNow(), by: hostName() });
  if (command === 'checklist' && sub === 'create') return checklistCreate(flags);
  if (command === 'checklist' && sub === 'list') return checklistList(flags);
  if (command === 'checklist' && sub === 'get' && id) return checklistGet(id, flags);
  if (command === 'checklist' && sub === 'wait' && id) return checklistWait(id, flags);
  if (command === 'checklist' && sub === 'pickup' && id) return checklistPickup(id);
  if (command === 'checklist' && sub === 'cancel' && id) return checklistCancel(id);
  if (command === 'request' && sub === 'list') return requestList(flags);
  if (command === 'request' && sub === 'create') return requestCreate(flags);
  if (command === 'request' && sub === 'verify' && id) return requestVerify(id, flags);
  if (command === 'request' && sub === 'brief' && id) return requestBrief(id, flags);
  if (command === 'request' && sub === 'run') return requestRun(flags);
  if (command === 'request' && sub === 'finish') return requestFinish(id ?? process.env.BUW_REQUEST_ID, flags);
  if (command === 'request' && sub === 'state' && id) return requestState(id);
  if (command === 'request' && sub === 'take' && id && flags.runner !== undefined) return requestTakeRunner(id, flags);
  if (command === 'request' && sub === 'take' && id) {
    const wanted = await readJson(inboxPath('requests', idSafe(id), 'request.json'));
    if (wanted?.preset) {
      console.error('This request is for a dispatched run; it starts only from its approval.');
      throw new Exit(4);
    }
    if (!flags.bead) throw new Error('Usage: request take <id> --bead <bead id>');
    return claim('requests', idSafe(id), 'taken.json', pickupBody(flags));
  }
  if (command === 'beads' && sub === 'push') return beadsPush(flags);
  console.error(USAGE);
  throw new Exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const [first] = args;
  if (['event', 'ask', 'checklist', 'request', 'beads'].includes(first)) {
    const rest = args.slice(1);
    const at = rest.indexOf('--via');
    const via = (at >= 0 ? rest.splice(at, 2)[1] : undefined) ?? process.env.BUW_CARDS_VIA;
    transport = await pickTransport(via);
    console.error(`(via ${transport.label})`);
    return inbox(first, rest);
  }
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : undefined; };
  const flag = name => { const at = args.indexOf(name); return at >= 0 ? Boolean(args.splice(at, 1)) : false; };
  const into = option('--into') ?? '.';
  const section = option('--section');
  const card = option('--card');
  const dryRun = flag('--dry-run');
  const via = option('--via') ?? process.env.BUW_CARDS_VIA;
  const [command, target] = args;
  if (!['login', 'sections', 'list', 'get', 'put'].includes(command)) {
    console.error(USAGE);
    process.exit(1);
  }
  if (command === 'login') return login();
  transport = await pickTransport(via);
  console.error(`(via ${transport.label})`);

  if (command === 'sections') {
    for (const item of (await call('GET', '/sections')).sections) console.log(`${item.id}\t${item.cards} card(s)\t${item.name}`);
  } else if (command === 'list' && target) {
    for (const item of (await call('GET', `/sections/${target}`)).cards) console.log(`${item.id}\t${item.updated ?? ''}\t${item.title}`);
  } else if (command === 'get' && target) {
    await get(target, into);
  } else if (command === 'put' && target && section && card) {
    await put(target, section, card, dryRun);
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

main().catch(error => {
  if (error instanceof Exit) process.exit(error.code);
  // fetch says only "fetch failed"; the network error behind it is in its cause.
  console.error(error.cause ? `${error.message}: ${error.cause.code ?? ''} ${error.cause.message ?? error.cause}`.trim() : error.message);
  process.exit(1);
});
