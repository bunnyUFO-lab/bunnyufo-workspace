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
//   cards event <kind> --title <t> [--project <p> --bead <b> --ask <id> --url <u> --summary <s> --source <s>]
//        post an event to events/<date>/. A failed send is kept in ~/.buw/spool.jsonl (BUW_SPOOL) and
//        retried by the next inbox command.
//   cards ask create --project <p> [--bead <b>] --file ask.json [--image <file>]...
//        put an Ask (its pictures first, ask.json last) and post an ask-created event; prints its id
//        then, when a #needs-you webhook is configured (BUW_DISCORD_NEEDS_YOU, `discord.needsYou` in
//        ~/.buw/hub.json, or ~/.buw/secrets/discord-webhook-needs-you), post a short note there with a
//        link to the Ask (`siteUrl` in hub.json or BUW_SITE_URL). A failed post is spooled for hub-hooks to
//        replay and never changes the exit code; the webhook address is never printed or stored.
//   cards ask list [--project <p>] [--answered | --open] [--all]     id, state, project, question
//   cards ask get <id>                                                ask.json, answer.json, pickup.json, cancel.json
//   cards ask pickup <id> | cards ask cancel <id>                     exit 3 when someone else already did
//   cards request list [--project <p>] [--open]
//   cards request take <id> --bead <b>                                exit 3 when already taken
//   cards request create --project <p> --text <t> [--when next-sprint|nightly|record] [--by <name>]
//   cards beads push --project <p> [--from <file.jsonl>]              Beads copy (`bd export` by default)
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
  + '       npm run cards -- event <kind> --title <t> | ask create|list|get|pickup|cancel | request list|take|create | beads push --project <p>';
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

const EVENT_KINDS = ['session-started', 'session-ended', 'blocked', 'ready-for-review', 'pr-opened', 'pr-merged', 'ci-failed', 'ci-passed', 'deployed', 'ask-created', 'alert'];
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

const fileRoute = file => `/sections/inbox/files/${enc(file)}`;
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
async function putInbox(file, body, { createOnly = false, contentType = 'application/json', retry = true } = {}) {
  const route = fileRoute(file);
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
  const route = `/sections/inbox/files?prefix=${encodeURIComponent(prefix)}`;
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
  await appendFile(file, `${JSON.stringify({ v: 1, at: isoNow(), kind: 'put', section: 'inbox', contentType: 'application/json', createOnly: true, ...entry })}\n`);
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
    if (entry?.v !== 1 || entry.kind !== 'put' || entry.section !== 'inbox' || typeof entry.path !== 'string') {
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
      const result = await putInbox(inboxPath(entry.path), entry.body, { createOnly: entry.createOnly !== false, contentType: entry.contentType, retry: false });
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
    ...(process.env.CLAUDE_SESSION_ID ? { session: process.env.CLAUDE_SESSION_ID } : {}),
    host, source: flags.source || 'cli', title: String(flags.title),
    ...(flags.url ? { url: flags.url } : {}),
    ...(flags.summary ? { summary: String(flags.summary) } : {}),
  };
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  return { event, file: inboxPath('events', now.toISOString().slice(0, 10), `${time}-${host}-${rand(3)}.json`) };
}

/** Post an event; when the API cannot be reached, keep it in the spool and say so. Never throws for that. */
async function postEvent(flags) {
  const { event, file } = buildEvent(flags);
  const body = `${JSON.stringify(event, null, 2)}\n`;
  const result = await putInbox(file, body, { createOnly: true });
  if (result.state === 'transient') {
    await spool({ path: file, body });
    console.log(`spooled ${file} (${result.reason}); it is sent with the next inbox command`);
    return file;
  }
  console.log(file);
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
    allowNote: raw.allowNote ?? true,
    allowDrawing: raw.allowDrawing ?? false,
  };
  return ask;
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
 * Tell the owner an Ask is waiting. Silent without a webhook; on a failed post the message is kept in
 * the shared spool for hub-hooks to replay (no address in it), and the exit code is never touched.
 */
async function pingNeedsYou(ask, id) {
  const hub = await hubConfig();
  const webhook = await needsYouWebhook(hub);
  if (!webhook) return;
  const site = String(hub?.siteUrl || process.env.BUW_SITE_URL || '').replace(/\/+$/, '');
  const content = [`**Agent needs you · ${titleOf(ask.project)}**`, clip(ask.question, 200), ...(site ? [`${site}/#/~hub/ask/${id}`] : [])].join('\n');
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

async function askCreate(flags) {
  if (!flags.project || !flags.file) throw new Error('Usage: ask create --project <p> [--bead <b>] --file ask.json [--image <file>]...');
  const raw = JSON.parse(await readFile(flags.file, 'utf8'));
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
    uploads.push({ file: inboxPath('asks', id, name), body, contentType: IMAGE_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream' });
  }
  const askFile = inboxPath('asks', id, 'ask.json');
  // Pictures first and the ask last, so an ask is never listed before what it shows.
  for (const upload of uploads) await mustPut(upload.file, upload.body, { createOnly: true, contentType: upload.contentType });
  if (await mustPut(askFile, `${JSON.stringify(ask, null, 2)}\n`, { createOnly: true }) === 'exists') throw new Error(`${askFile} already exists; run it again.`);
  await postEvent({ kind: 'ask-created', title: clip(ask.question, 80), project: ask.project, bead: ask.bead, ask: id, source: 'cards', summary: 'A question is waiting for an answer.' }).catch(error => console.error(`(ask-created event skipped: ${error.message})`));
  await pingNeedsYou(ask, id).catch(() => {});
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
    console.log(`== ${name}\n${(await readInbox(inboxPath('asks', id, name))).trim()}`);
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

// --- requests ---

async function requestList(flags) {
  const folders = await listFolders('requests', flags.all);
  const ids = [...folders.keys()].filter(id => folders.get(id).has('request.json')).sort();
  const rows = await mapLimit(ids, 8, async id => {
    const names = folders.get(id);
    const state = names.has('taken.json') ? 'taken' : names.has('declined.json') ? 'declined' : 'open';
    if (flags.open && state !== 'open') return null;
    const request = await readJson(inboxPath('requests', id, 'request.json'));
    return { id, state, request };
  });
  for (const row of rows) {
    if (!row || (flags.project && row.request?.project !== flags.project)) continue;
    console.log(`${row.id}\t${row.state}\t${row.request?.project ?? ''}\t${clip(row.request?.text, 80)}`);
  }
}

async function requestCreate(flags) {
  if (!flags.project || !flags.text) throw new Error('Usage: request create --project <p> --text <t> [--when next-sprint|nightly|record] [--by <name>]');
  const when = flags.when ?? 'next-sprint';
  if (!WHEN.includes(when)) throw new Error(`--when is one of: ${WHEN.join(', ')}.`);
  const id = newId(flags.project, flags.text);
  const request = { id, project: flags.project, createdAt: isoNow(), by: flags.by || hostName(), text: flags.text, when };
  const file = inboxPath('requests', id, 'request.json');
  if (await mustPut(file, `${JSON.stringify(request, null, 2)}\n`, { createOnly: true }) === 'exists') throw new Error(`${file} already exists; run it again.`);
  console.log(id);
}

// --- Beads ---

async function beadsPush(flags) {
  const project = flags.project;
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('Usage: beads push --project <p> [--from <file.jsonl>]');
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
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const meta = { pushedAt: isoNow(), host: hostName(), count: content.split(/\r?\n/).filter(line => line.trim()).length, repo: remote.status === 0 ? remote.stdout.trim() : '' };
  await mustPut(inboxPath('beads', `${project}.jsonl`), content, { contentType: 'application/x-ndjson' });
  await mustPut(inboxPath('beads', `${project}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`beads/${project}.jsonl (${meta.count} issue(s))`);
}

// --- argument parsing for the inbox commands ---

const BOOLEAN_FLAGS = new Set(['answered', 'open', 'all']);
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
  if (command === 'request' && sub === 'list') return requestList(flags);
  if (command === 'request' && sub === 'create') return requestCreate(flags);
  if (command === 'request' && sub === 'take' && id) {
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
  if (['event', 'ask', 'request', 'beads'].includes(first)) {
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
