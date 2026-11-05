// Seeds and checks the development section for agent cards, for the QA run on the development copy (brief 2.5).
//
//   node scripts/qa/card-writes-fixture.mjs seed  --bucket <name>   section, an owner card, then an agent's new tab, an edit and a new card
//   node scripts/qa/card-writes-fixture.mjs check --bucket <name>   live S3 facts, then a Revert of one edit
//   node scripts/qa/card-writes-fixture.mjs reset --bucket <name>   one more batch of agent writes; it deletes nothing
//
// It builds the real card API handler in this process with made-up tokens, over a bucket client that uses this machine's AWS
// profile: the real handler against real S3, with no key stored and nothing deployed. Every bucket call goes through a guard that
// refuses any key outside `sections/dev-project-writes/` and `sections/inbox-dev/`, and any delete.
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createBucket } from '../../site/api/s3.mjs';
import { createCardApi, parseTokens } from '../../site/card-api/handler.mjs';
import { createCardWrites } from '../../site/api/hub-card-writes.mjs';
import { inboxKey } from '../../site/api/hub.mjs';

export const SECTION = 'dev-project-writes';
const ALLOWED = [`sections/${SECTION}/`, 'sections/inbox-dev/'];
const sha = text => createHash('sha256').update(text).digest('hex');
const md5 = text => createHash('md5').update(text).digest('hex');

/** The bucket client, but every call refuses a key outside the two prefixes this fixture may touch. Nothing here deletes. */
export function guarded(bucket) {
  const ok = key => ALLOWED.some(prefix => String(key).startsWith(prefix));
  const check = (what, key) => { if (!ok(key)) throw new Error(`card-writes-fixture refuses ${what} on ${key}: it may only touch ${ALLOWED.join(' and ')}.`); };
  const wrap = (name, keyOf = args => args[0]) => async (...args) => { check(name, keyOf(args)); return bucket[name](...args); };
  return {
    bucket: bucket.bucket,
    get: wrap('get'), head: wrap('head'), getText: wrap('getText'), getBytes: wrap('getBytes'), getJson: wrap('getJson'),
    getVersion: wrap('getVersion'), put: wrap('put'), putJson: wrap('putJson'), presign: wrap('presign'),
    list: wrap('list'), copy: wrap('copy', args => args[1]),
    async del(key) { throw new Error(`card-writes-fixture never deletes (${key}).`); },
  };
}

/** The handler in this process, with an owner token and an agent token that holds only the Library right. */
function handlerOver(bucket, clock) {
  const tokens = parseTokens([`owner=${sha('fixture-owner')}`, `fixture-agent=${sha('fixture-agent')}:read=*;write=@library`].join(', '));
  const api = createCardApi({ bucket, tokens, today: () => new Date(clock()).toISOString().slice(0, 10), now: clock });
  const call = async (token, method, rawPath, { body, headers = {} } = {}) => {
    const response = await api({ requestContext: { http: { method } }, rawPath, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
    const data = JSON.parse(response.body);
    if (response.statusCode >= 300) throw new Error(`${method} ${rawPath}: ${response.statusCode} ${data.error ?? response.body}`);
    return data;
  };
  return {
    owner: (method, rawPath, options) => call('fixture-owner', method, rawPath, options),
    agent: (method, rawPath, options) => call('fixture-agent', method, rawPath, options),
  };
}

const WHO = { 'x-card-agent': 'QA agent', 'x-card-why': encodeURIComponent('Fixture write for the development QA run') };
const today = clock => new Date(clock()).toISOString().slice(0, 10);

/** Everything the run needs, written as the owner, once: the section, the card `qa-owner` and a Beads copy so the project page exists. */
async function ensureBase(bucket, api, clock) {
  const listKey = `sections/${SECTION}/workspace.json`;
  const have = await bucket.getJson(listKey);
  if (!have) await bucket.putJson(listKey, { name: 'Dev project writes', entities: [] }, { ifNoneMatch: '*' }).catch(error => { if (error.status !== 412) throw error; });
  const list = (await bucket.getJson(listKey)).value;
  if (!list.entities.some(card => card.id === 'qa-owner')) {
    const folder = `${today(clock)}_qa-owner`;
    await api.owner('PUT', `/sections/${SECTION}/files/${folder}/index.md`, { body: '# QA owner card\n\nWritten by the owner.\n', headers: { 'content-type': 'text/markdown' } });
    await api.owner('PUT', `/sections/${SECTION}/cards/qa-owner`, { body: JSON.stringify({ id: 'qa-owner', title: 'QA owner card', description: 'A card the owner made.', type: 'standalone', category: 'qa', created: today(clock), folder, steps: [{ name: 'Notes', path: 'index.md' }], status: 'active' }) });
  }
  // The project page lists projects from the Beads copies in the inbox (`beads/<project>.jsonl` and `.meta.json`).
  const issue = { _type: 'issue', id: 'dpw-1', title: 'Check agent cards', status: 'open', priority: 2, issue_type: 'task', labels: [], created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', dependencies: [] };
  for (const [key, body] of [[`sections/inbox-dev/beads/${SECTION}.jsonl`, `${JSON.stringify(issue)}\n`], [`sections/inbox-dev/beads/${SECTION}.meta.json`, `${JSON.stringify({ pushedAt: new Date(clock()).toISOString(), host: 'fixture', count: 1, repo: 'example/dev-project-writes' })}\n`]]) {
    if (!(await bucket.head(key).catch(error => { if (error.status === 404) return null; throw error; }))) await bucket.put(key, body, { ifNoneMatch: '*', contentType: key.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json' });
  }
  return list;
}

/** One batch of agent writes: a new tab on the owner's card, an edit of its page (a chat asked for it), and a new card with an HTML tab. */
async function agentBatch(bucket, api, clock, tag) {
  const list = (await bucket.getJson(`sections/${SECTION}/workspace.json`)).value;
  const owner = list.entities.find(card => card.id === 'qa-owner');
  const batch = id => `${tag}${id}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24).padEnd(8, '0');
  const put = (file, text, headers, type) => api.agent('PUT', `/sections/${SECTION}/files/${file}`, { body: text, headers: { 'content-type': type, ...WHO, ...headers } });
  // A new tab.
  const note = `notes-${tag}.md`;
  await put(`${owner.folder}/${note}`, `# Agent notes ${tag}\n\nA tab an agent added.\n`, { 'if-none-match': '*', 'x-card-batch': batch('t') }, 'text/markdown');
  await api.agent('PUT', `/sections/${SECTION}/cards/qa-owner`, { body: JSON.stringify({ ...owner, steps: [...owner.steps, { name: `Agent notes ${tag}`, path: note }] }), headers: { ...WHO, 'x-card-batch': batch('t') } });
  // An edit: the etag comes from what the agent just read.
  const page = await bucket.head(`sections/${SECTION}/${owner.folder}/index.md`);
  const read = await bucket.getText(`sections/${SECTION}/${owner.folder}/index.md`);
  await put(`${owner.folder}/index.md`, `${read.text.trimEnd()}\n\nAn agent added a line (${tag}).\n`, { 'if-match': `"${page.etag}"`, 'x-card-context': 'chat', 'x-card-batch': batch('e') }, 'text/markdown');
  // A new card with an HTML tab.
  const id = tag === 'first' ? 'qa-agent' : `qa-agent-${tag}`;
  const folder = `${today(clock)}_${id}`;
  await put(`${folder}/index.html`, `<!doctype html><title>QA agent</title><p id="out">Loaded.</p><script>document.getElementById('out').textContent = 'Bridge: ' + (window.BuwCardData && window.BuwCardData.bridge ? 'present' : 'none');</script>\n`, { 'if-none-match': '*', 'x-card-batch': batch('c') }, 'text/html');
  await api.agent('PUT', `/sections/${SECTION}/cards/${id}`, { body: JSON.stringify({ id, title: `QA agent card ${tag}`, description: 'A card an agent made.', type: 'standalone', category: 'qa', created: today(clock), folder, steps: [{ name: 'Page', path: 'index.html' }], status: 'active' }), headers: { ...WHO, 'x-card-batch': batch('c') } });
  return { tab: batch('t'), edit: batch('e'), card: batch('c'), folder: owner.folder, cardFolder: folder };
}

const fail = (message, status) => Object.assign(new Error(message), { status });

/** Live S3 facts, then a Revert of one edit through the Hub's own code. Throws on the first one that does not hold. */
async function checkFacts(bucket, api, clock) {
  const assert = (condition, message) => { if (!condition) throw new Error(`check failed: ${message}`); };
  const key = `sections/${SECTION}/qa-check/probe-${randomBytes(3).toString('hex')}.txt`;
  const one = await bucket.put(key, 'one', { ifNoneMatch: '*', contentType: 'text/plain' });
  assert(one.etag === md5('one'), 'the etag of a one-piece put is the md5 of the body');
  assert(one.versionId, 'a PUT answers with a version id (is versioning on for this bucket?)');
  await bucket.put(key, 'other', { ifNoneMatch: '*' }).then(() => assert(false, 'If-None-Match on an existing key was accepted'), error => assert(error.status === 412, `If-None-Match on an existing key answered ${error.status}, not 412`));
  await bucket.put(key, 'x', { ifMatch: md5('stale') }).then(() => assert(false, 'a stale If-Match was accepted'), error => assert(error.status === 412, `a stale If-Match answered ${error.status}, not 412`));
  const head = await bucket.head(key);
  assert(head.versionId === one.versionId, 'a HEAD names the version the PUT made');
  const two = await bucket.put(key, 'two', { ifMatch: head.etag, contentType: 'text/plain' });
  assert(two.versionId && two.versionId !== one.versionId, 'a second put makes a new version');
  const old = await bucket.getVersion(key, one.versionId);
  assert(old?.buffer.toString() === 'one', 'GET ?versionId returns the old bytes');
  // The Hub's Revert, in this process, on one agent edit.
  const batch = await agentBatch(bucket, api, clock, `chk${randomBytes(2).toString('hex')}`);
  const writes = createCardWrites({ bucket, key: rel => inboxKey(rel, 'sections', 'inbox-dev'), fail, sections: async () => [], now: () => new Date(clock()) });
  const before = (await bucket.getText(`sections/${SECTION}/${batch.folder}/index.md`)).text;
  const answer = await writes.revert({ section: SECTION, folder: batch.folder, batch: batch.edit }, 'fixture');
  assert(answer.body.restored.length === 1, 'Revert put the edited page back');
  const after = (await bucket.getText(`sections/${SECTION}/${batch.folder}/index.md`)).text;
  assert(after !== before && !after.includes(`(${batch.edit.slice(0, 3)}`), 'the page has its earlier text');
  return { probe: key, restored: answer.body.restored };
}

/** Runs one command over `bucket` (a bucket client): the command line passes a real one, the test a stand-in. */
export async function run(command, bucket, { clock = Date.now, log = console.log } = {}) {
  const guard = guarded(bucket);
  const api = handlerOver(guard, clock);
  if (command === 'seed') {
    const list = await ensureBase(guard, api, clock);
    // A second seed is a reset: the first batch's names are taken.
    const made = await agentBatch(guard, api, clock, list.entities.some(card => card.id === 'qa-agent') ? `r${clock().toString(36)}` : 'first');
    log(`Seeded ${SECTION}: cards qa-owner and qa-agent, with a new tab, an edit and a new card written as an agent.`);
    return made;
  }
  if (command === 'reset') {
    await ensureBase(guard, api, clock);
    const made = await agentBatch(guard, api, clock, `r${clock().toString(36)}`);
    log(`Added a fresh batch to ${SECTION} (nothing deleted).`);
    return made;
  }
  if (command === 'check') {
    await ensureBase(guard, api, clock);
    const result = await checkFacts(guard, api, clock);
    log(`check passed on ${SECTION}: conditional writes, version ids, old bytes, and a Revert of one edit.`);
    return result;
  }
  throw new Error('Usage: card-writes-fixture.mjs seed|check|reset --bucket <name>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--bucket');
  const name = at > 0 ? process.argv[at + 1] : process.env.BUW_S3_BUCKET;
  const command = process.argv[2];
  if (!name || !['seed', 'check', 'reset'].includes(command)) {
    console.error('Usage: node scripts/qa/card-writes-fixture.mjs seed|check|reset --bucket <name>   (the bucket name may be BUW_S3_BUCKET instead)');
    process.exit(2);
  }
  run(command, createBucket({ bucket: name })).catch(error => { console.error(error.message); process.exit(1); });
}
