// The card API: read and write workspace cards in the cards bucket from anywhere, with a token.
//
// It runs in AWS Lambda behind an API Gateway HTTP API (template.yaml), so a session on any machine
// can fetch or publish a card without AWS credentials and without a way into the home server. The
// function's role reaches `sections/*` in the cards bucket and nothing else: not state.json, not
// another bucket. Callers send `Authorization: Bearer <passphrase>`: the one password the site's owner
// set at deploy (BUW_CARD_PASSPHRASE). Optional extra tokens, each limited to some sections or to some
// verbs on them, are held as SHA-256 hashes (BUW_CARD_TOKENS; see parseTokens for the grammar).
//
//   GET    /sections                                 the sections this token may use
//   GET    /sections/{section}                       its name and card list
//   GET    /sections/{section}/cards/{card}          the card's entry and files, each with a short-lived download URL
//   PUT    /sections/{section}/cards/{card}          add or update the card's entry in workspace.json (body: the entity)
//   GET    /sections/{section}/files?prefix=<p>      the files under a prefix (path, size, etag, lastModified), 1000 at most
//   GET    /sections/{section}/files/{folder}/{path} one file, up to 4 MB
//   PUT    /sections/{section}/files/{folder}/{path} upload one file, up to 4 MB (the body is the file);
//                                                    If-None-Match: * creates only, If-Match: "<etag>" replaces only that version
//   DELETE /sections/{section}/files/{folder}/{path} remove one file
//   POST   /sections/{section}/uploads               upload URLs for bigger files (body: { files: [{ path }] })
//   GET    /resolve?ref=<site link | section/card | name>   which card a link or a name means
//   GET    /cards.mjs                                the client (cards.mjs beside this file), with no token:
//                                                    it is code and holds nothing, and a session needs it first
//
// Files go up first and the entry last, so a card is never listed before its files are there. The
// entry is written with If-Match on the ETag it read, so two writers never drop each other's card.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { contentTypeOf, createBucket } from '../api/s3.mjs';

const CLIENT = new URL('./cards.mjs', import.meta.url);

export const MAX_INLINE = 4 * 1024 * 1024; // a Lambda payload is 6 MB, and base64 adds a third
export const MAX_FILE = 50 * 1024 * 1024; // the same limit `npm run publish` keeps
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;
/** The hidden inbox sections: the real one, and the development copy's. Same rules for both. */
const INBOXES = new Set(['inbox', 'inbox-dev']);
const SECTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const URL_TTL = 900;
const MAX_LISTED = 1000;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

const VERBS = ['read', 'write', 'delete'];

/**
 * A token's scope, the part after the colon:
 *   (none)                         every verb on every section
 *   `a|b`                          every verb, on those sections only
 *   `read=*;write=inbox|assistant` the listed verbs only, each on `*` (every section) or some sections
 * Returns { read, write, delete }, each `null` (every section) or a Set of section ids (empty: none).
 */
export function parseScope(scope) {
  const text = String(scope ?? '');
  if (!text) return { read: null, write: null, delete: null };
  if (!text.includes('=')) {
    if (!/^[\w-]+(\|[\w-]+)*$/.test(text)) throw new Error('not a section list');
    return Object.fromEntries(VERBS.map(verb => [verb, new Set(text.split('|'))]));
  }
  const rights = Object.fromEntries(VERBS.map(verb => [verb, new Set()]));
  const seen = new Set();
  for (const part of text.split(';')) {
    const match = /^(read|write|delete)=(\*|[a-z0-9-]+(?:\|[a-z0-9-]+)*)$/.exec(part);
    if (!match) throw new Error(`not a right: ${part}`);
    if (seen.has(match[1])) throw new Error(`${match[1]} is listed twice`);
    seen.add(match[1]);
    rights[match[1]] = match[2] === '*' ? null : new Set(match[2].split('|'));
  }
  return rights;
}

/**
 * "laptop=<sha256>, cloud=<sha256>:magic-loops|bunnylink, hermes=<sha256>:read=*;write=inbox"
 * → [{ name, hash, rights: { read, write, delete } }]. Without a scope a token may do everything.
 * A bad entry throws with its name only, never its hash.
 */
export function parseTokens(value) {
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^([\w.-]+)=([0-9a-f]{64})(?::([\w|*=;-]+))?$/i.exec(item);
    let rights;
    try {
      if (!match) throw new Error('form');
      rights = parseScope(match[3]);
    } catch {
      throw new Error(`BUW_CARD_TOKENS has an entry that is not name=<sha256>[:section|section | :read=*;write=a|b]: ${item.split('=')[0]}`);
    }
    return { name: match[1], hash: match[2].toLowerCase(), rights };
  });
}

const EVERYTHING = Object.freeze({ read: null, write: null, delete: null });

/** A path inside a section: forward slashes, a card folder and at least one file below it. */
export function cardPath(value) {
  const parts = String(value ?? '').split('/').filter(Boolean);
  if (parts.length < 2 || parts.some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts[0].startsWith('_')) return null; // _shared and the like belong to the whole section
  return parts.join('/');
}

/**
 * What a reference names: a site link (https://…/<section>#/<card>, or a /w/<section>/<folder>/
 * file link), "section/card", or a bare card id or title.
 */
export function parseRef(ref) {
  const text = String(ref ?? '').trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] === 'w' && segments[1]) return { section: segments[1], folder: segments[2] ?? null, card: null };
    const card = decodeURIComponent(url.hash.replace(/^#\/?/, '').split('/')[0] || '') || null;
    return { section: segments[0] ?? null, card, folder: null };
  }
  const slash = text.indexOf('/');
  if (slash > 0) return { section: text.slice(0, slash), card: text.slice(slash + 1), folder: null };
  return { section: null, card: text || null, folder: null };
}

const summary = entity => ({
  id: entity.id,
  title: entity.title,
  description: entity.description,
  category: entity.category,
  folder: entity.folder,
  status: entity.status,
  updated: entity.updated ?? entity.created,
});

/**
 * @param bucket an s3.mjs bucket
 * @param tokens parseTokens() output
 * @param prefix where the sections are in the bucket
 */
export function createCardApi({ bucket, tokens, prefix = 'sections', urlTtl = URL_TTL, today = () => new Date().toISOString().slice(0, 10) }) {
  const keyOf = (section, rest) => `${prefix}/${section}/${rest}`;

  function authenticate(headers) {
    const match = /^Bearer\s+(\S.*?)\s*$/i.exec(headers.authorization ?? ''); // a passphrase may have spaces
    if (!match) throw new HttpError(401, 'Send Authorization: Bearer <token>.');
    const hash = Buffer.from(sha256(match[1]), 'hex');
    const found = tokens.find(token => timingSafeEqual(Buffer.from(token.hash, 'hex'), hash));
    if (!found) throw new HttpError(401, 'That token is not known here.');
    return found;
  }

  const can = (caller, verb, section) => caller.rights[verb] === null || caller.rights[verb].has(section);

  async function section(caller, id, verb) {
    if (!SECTION_ID.test(id ?? '')) throw new HttpError(400, 'A section id is lower-case letters, digits and dashes.');
    if (!can(caller, verb, id)) throw new HttpError(403, `This token may not ${verb} section "${id}".`);
    const got = await bucket.getJson(keyOf(id, 'workspace.json'));
    if (!Array.isArray(got?.value?.entities)) throw new HttpError(404, `No section "${id}".`);
    return { id, registry: got.value, etag: got.etag };
  }

  async function sectionIds(caller) {
    const { prefixes } = await bucket.list(`${prefix}/`, { delimiter: '/' });
    return prefixes.map(item => item.slice(prefix.length + 1).replace(/\/$/, '')).filter(id => SECTION_ID.test(id) && can(caller, 'read', id));
  }

  /** In the inbox, anything nested below a checklist's folder (checklists/<id>/x/…), answers, snoozes, declines, checklist ticks, submissions and pictures, a sketch's deleted.json, an agent's avatar choice (team/<agent>/avatar-*.json), a request's approval, stop, Hermes run, retry, fire records and answers (requests/<id>/approved|stop|hermes-run|hermes-retry|allow-grant.json, fire-*.json, answer-*.json) everything under hermes-approvals/ and the owner's Roadmap marks (bead-marks/<project>/<bead>/<stamp>-done|not-needed|undo-<rand>.json) are the Hub's: only an unrestricted writer (the passphrase) may put them. */
  const OWNER_FILES = /^(asks\/[^/]+\/(answer\.[^/]+|snooze\.json)|requests\/[^/]+\/declined\.json|checklists\/[^/]+\/((tick|untick)-[^/]+\.json|submit\.json|(evidence|shot)-[^/]+)|checklists\/[^/]+\/[^/]+\/.*|drawings\/[^/]+\/deleted\.json|team\/[^/]+\/avatar-[^/]+\.json|requests\/[^/]+\/(approved|stop|hermes-run|hermes-retry|allow-grant)\.json|requests\/[^/]+\/(fire|answer)-[^/]+\.json|hermes-approvals\/.*|bead-marks\/[^/]+\/[^/]+\/[^/]+-(done|not-needed|undo)-[^/]+\.json)$/i;
  const ASK_FILE = /^(?:asks\/(?:[^/]+\/)*ask|asks\/[^/]+\/(?:delivered|watch-[^/]+)|checklists\/[^/]+\/checklist|requests\/[^/]+\/request)\.json$/i;
  /** The files a run writes: taken, progress, result and report. */
  const RUNNER_FILES = /^requests\/([^/]+)\/(taken\.json|run-[^/]+\.json|result\.json|report\.md)$/i;
  /** An agent's only file under bead-marks/: the note that it closed the issue the owner marked (create-only). */
  const APPLIED_FILE = /^bead-marks\/[^/]+\/[^/]+\/[^/]+-applied-[^/]+\.json$/i;
  const markFiles = (caller, sectionId, file, { ifNoneMatch, upload = false } = {}) => {
    if (INBOXES.has(sectionId) && caller.rights.write !== null && /^bead-marks\//i.test(file) && (!APPLIED_FILE.test(file) || upload || ifNoneMatch !== '*')) {
      throw new HttpError(403, 'Agents write only applied marks, once.');
    }
  };
  const ownerOnly = (caller, sectionId, file) => {
    if (INBOXES.has(sectionId) && caller.rights.write !== null && OWNER_FILES.test(file)) {
      throw new HttpError(403, 'Only the Hub writes answers.');
    }
  };
  /**
   * A limited writer may put a run's files (taken, run-*, result, report) in the inbox only as the token named
   * `pc-runner`, or as `cloud-<project>` for a request of that project (one GET of its request.json). Everyone else,
   * `hermes-main` and the old `cloud` token included, is refused. An unrestricted writer is not limited.
   */
  const runnerOnly = async (caller, sectionId, file) => {
    const match = INBOXES.has(sectionId) && caller.rights.write !== null ? RUNNER_FILES.exec(file) : null;
    if (!match) return;
    if (caller.name === 'pc-runner') return;
    const project = /^cloud-([a-z0-9][a-z0-9-]*)$/.exec(caller.name ?? '')?.[1];
    if (project) {
      const got = await bucket.getJson(keyOf(sectionId, `requests/${match[1]}/request.json`)).catch(() => null);
      if (typeof got?.value?.project === 'string' && got.value.project === project) return;
    }
    throw new HttpError(403, 'Only a run writes run files.');
  };
  /**
   * Who wrote a request.json, kept as object metadata (`x-amz-meta-writer`), never in the body: `agent` for a token that
   * is an agent session (named `agent` or `agent-<name>`), nothing for anyone else (pc-runner, cloud-<project>,
   * hermes-main, the old shared tokens, the passphrase). Only this function sets it; a caller's own `x-amz-meta-*`
   * headers are never forwarded. The site API's policy approval signs only when the stored `origin` and this agree.
   * An `asks/<id>/ask.json` put by a limited token is tagged too, with the token's kind: `pc-runner` for the PC watcher's token
   * (the only one whose Ask the Hub lets carry a `rerun` pointer, see site/api/hub-rerun.mjs; PC runs hold this token too, so it excludes other tokens, not a run), `agent` for `agent`/`agent-<name>`, `other` for any
   * other limited token. The passphrase's own ask.json carries nothing.
   */
  const writerMetadata = (caller, sectionId, file) => {
    if (!INBOXES.has(sectionId)) return undefined;
    // Whatever goes into bead-marks/ through this API is tagged, so the Hub reads an owner verdict only from a file it wrote itself.
    if (/^bead-marks\//i.test(file)) return { writer: 'card-api' };
    if (caller.rights.write !== null && /^asks\/[^/]+\/ask\.json$/i.test(file)) {
      return { writer: caller.name === 'pc-runner' ? 'pc-runner' : /^agent(-[\w.-]+)?$/.test(caller.name ?? '') ? 'agent' : 'other' };
    }
    return caller.rights.write !== null && /^requests\/[^/]+\/request\.json$/i.test(file) && /^agent(-[\w.-]+)?$/.test(caller.name ?? '')
      ? { writer: 'agent' } : undefined;
  };
  /** A limited writer cannot claim a request as the owner's. */
  const noOwnerOrigin = (caller, sectionId, file, body) => {
    if (!INBOXES.has(sectionId) || caller.rights.write === null || !/^requests\/[^/]+\/request\.json$/i.test(file)) return;
    let parsed;
    // TextDecoder drops a leading BOM, as the site API's reader does; a file that does not parse is refused.
    try { parsed = JSON.parse(new TextDecoder('utf-8').decode(body)); } catch { throw new HttpError(403, 'request.json must be valid JSON.'); }
    if (parsed?.origin?.kind === 'owner') throw new HttpError(403, 'A request from the owner is written by the Hub only.');
  };
  /**
   * An Ask is written once. A limited writer may create ask.json (If-None-Match: *) and never replace it, so what the
   * owner was shown, and what the Discord buttons were built from, cannot be rewritten by an agent. A presigned upload
   * URL cannot enforce create-only, so it is refused for ask.json too.
   */
  const askCreateOnly = (caller, sectionId, file, { ifNoneMatch, upload = false } = {}) => {
    if (INBOXES.has(sectionId) && caller.rights.write !== null && ASK_FILE.test(file) && (upload || ifNoneMatch !== '*')) {
      throw new HttpError(403, 'ask.json, checklist.json, request.json, delivered.json and watch-*.json are create-only.');
    }
  };
  /** A limited deleter keeps its hands off the Hub's files: asks, answers, snoozes and declines. */
  const hubFilesStay = (caller, sectionId, file) => {
    if (INBOXES.has(sectionId) && caller.rights.delete !== null && (ASK_FILE.test(file) || OWNER_FILES.test(file) || RUNNER_FILES.test(file) || /^bead-marks\//i.test(file))) {
      throw new HttpError(403, 'Only the Hub removes asks, answers, checklists, ticks, marks and request files.');
    }
  };

  const findEntity = (registry, ref) => registry.entities.find(item => item?.id === ref) ?? registry.entities.find(item => item?.folder === ref);

  /**
   * The site's record of a card that was moved to another workspace or put in the Trash, by id or
   * folder (`retired` in workspace.json, written only by the site). Null when the card is not retired.
   */
  const retiredBy = (registry, ref) => {
    const records = registry.retired && typeof registry.retired === 'object' ? registry.retired : {};
    const id = Object.keys(records).find(key => key === ref) ?? Object.keys(records).find(key => records[key]?.folder === ref || records[key]?.entity?.folder === ref);
    return id ? { id, ...records[id] } : null;
  };

  /**
   * The refusal for a retired card. The new workspace is named only to a token that may read it; any
   * other token is told the card moved, not where.
   */
  function retiredError(caller, sectionId, record, verb) {
    const status = verb === 'write' ? 409 : 404;
    if (record.kind === 'moved') {
      if (record.to && can(caller, 'read', record.to)) {
        return new HttpError(status, `Card "${record.id}" was moved to ${record.to}; ${verb === 'write' ? 'update it there' : 'read it there'}.`, { movedTo: { section: record.to, folder: record.folder ?? null } });
      }
      return new HttpError(status, `Card "${record.id}" was moved to another workspace.`);
    }
    return new HttpError(status, `Card "${record.id}" is in the Trash of ${sectionId}; ${verb === 'write' ? 'restore it first' : 'restore it to read it'}.`);
  }

  /** The retired card a write would collide with: one with this id, or one that owns this folder. Null when a live card has the id. */
  function retiredClaim(registry, id, folder) {
    if (registry.entities.some(item => item?.id === id)) return null;
    return registry.retired?.[id] ? { id, ...registry.retired[id] } : retiredBy(registry, folder);
  }

  async function cardFiles(sectionId, folder) {
    const base = keyOf(sectionId, `${folder}/`);
    const { objects } = await bucket.list(base);
    return objects.map(object => ({ path: object.key.slice(keyOf(sectionId, '').length), size: object.size, etag: object.etag, lastModified: object.lastModified }));
  }

  const routes = {
    async listSections(caller) {
      const ids = await sectionIds(caller);
      const sections = await Promise.all(ids.map(async id => {
        const got = await bucket.getJson(keyOf(id, 'workspace.json')).catch(() => null);
        if (!Array.isArray(got?.value?.entities)) return null;
        return { id, name: got.value.name || id, cards: got.value.entities.length };
      }));
      return { sections: sections.filter(Boolean) };
    },

    async getSection(caller, id) {
      const { registry } = await section(caller, id, 'read');
      return { id, name: registry.name || id, cards: registry.entities.map(summary) };
    },

    async getCard(caller, sectionId, ref) {
      const { registry } = await section(caller, sectionId, 'read');
      const entity = findEntity(registry, ref);
      if (!entity) {
        const record = retiredBy(registry, ref);
        if (record) throw retiredError(caller, sectionId, record, 'read');
        throw new HttpError(404, `No card "${ref}" in ${sectionId}.`);
      }
      const files = await cardFiles(sectionId, entity.folder);
      const withUrls = await Promise.all(files.map(async file => ({ ...file, url: await bucket.presign('GET', keyOf(sectionId, file.path), { expires: urlTtl }) })));
      return { section: sectionId, entity, files: withUrls, urlsExpireIn: urlTtl };
    },

    async putCard(caller, sectionId, id, entity) {
      if (!entity || typeof entity !== 'object' || Array.isArray(entity)) throw new HttpError(400, 'Send the card entry as a JSON object.');
      if (entity.id !== id) throw new HttpError(400, `The entry's id must be "${id}", the id in the path.`);
      if (typeof entity.title !== 'string' || !entity.title.trim()) throw new HttpError(400, 'The entry needs a title.');
      if (!Array.isArray(entity.steps)) throw new HttpError(400, 'The entry needs a steps array.');
      if (typeof entity.folder !== 'string' || !cardPath(`${entity.folder}/x`) || entity.folder.includes('/')) {
        throw new HttpError(400, 'The entry needs a folder: one name, not starting with "_" or ".".');
      }
      if (INBOXES.has(sectionId) && caller.rights.write !== null) throw new HttpError(403, 'The inbox holds files, not cards.');
      const first = await section(caller, sectionId, 'write');
      const claimed = retiredClaim(first.registry, id, entity.folder);
      if (claimed) throw retiredError(caller, sectionId, claimed, 'write');
      const files = await cardFiles(sectionId, entity.folder);
      if (!files.length) throw new HttpError(409, `${entity.folder}/ has no files yet: upload them first, then add the card.`);
      const refused = files.filter(file => SECRET.test(file.path) || file.size > MAX_FILE).map(file => file.path);
      if (refused.length) throw new HttpError(422, 'Some files look like secrets or are over 50 MB; delete them first.', { files: refused });

      const stored = { ...entity, updated: entity.updated ?? today() };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { registry, etag } = await section(caller, sectionId, 'write');
        const clash = registry.entities.find(item => item?.folder === entity.folder && item?.id !== id);
        if (clash) throw new HttpError(409, `Folder ${entity.folder} already belongs to card "${clash.id}".`);
        const index = registry.entities.findIndex(item => item?.id === id);
        const taken = retiredClaim(registry, id, entity.folder);
        if (taken) throw retiredError(caller, sectionId, taken, 'write');
        const entities = index >= 0 ? registry.entities.with(index, stored) : [...registry.entities, stored];
        try {
          await bucket.putJson(keyOf(sectionId, 'workspace.json'), { ...registry, entities }, { ifMatch: etag });
          return { section: sectionId, entity: stored, created: index < 0 };
        } catch (error) {
          if (error.status !== 412) throw error;
        }
      }
      throw new HttpError(409, 'The card list kept changing under this write; try again.');
    },

    async listFiles(caller, sectionId, prefixValue) {
      const wanted = String(prefixValue ?? '');
      if (/^[/_.]/.test(wanted) || wanted.split('/').some(part => part === '..' || part === '.') || /[\\\0]/.test(wanted)) {
        throw new HttpError(400, 'prefix is empty or a relative path: no "..", and not starting with "/", "_" or ".".');
      }
      await section(caller, sectionId, 'read');
      const base = keyOf(sectionId, '');
      const { objects } = await bucket.list(keyOf(sectionId, wanted));
      const files = objects
        .map(object => ({ path: object.key.slice(base.length), size: object.size, etag: object.etag, lastModified: object.lastModified }))
        .filter(file => cardPath(file.path) && !SECRET.test(file.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files: files.slice(0, MAX_LISTED), truncated: files.length > MAX_LISTED };
    },

    async getFile(caller, sectionId, file) {
      await section(caller, sectionId, 'read');
      const key = keyOf(sectionId, file);
      let head;
      try {
        head = await bucket.head(key);
      } catch (error) {
        if (error.status === 404) throw new HttpError(404, `No file ${file} in ${sectionId}.`);
        throw error;
      }
      if (head.size > MAX_INLINE) {
        throw new HttpError(413, 'Too big to send through the API; download it from url.', { url: await bucket.presign('GET', key, { expires: urlTtl }) });
      }
      const got = await bucket.get(key);
      const body = Buffer.from(await new Response(got.body).arrayBuffer());
      return { raw: body, contentType: got.contentType || contentTypeOf(file), etag: got.etag };
    },

    async putFile(caller, sectionId, file, body, contentType, { ifNoneMatch, ifMatch } = {}) {
      if (SECRET.test(file)) throw new HttpError(422, `${file} looks like a secret; it is not uploaded.`);
      if (body.length > MAX_INLINE) throw new HttpError(413, 'Over 4 MB: ask POST /sections/{section}/uploads for an upload URL.');
      await section(caller, sectionId, 'write');
      ownerOnly(caller, sectionId, file);
      markFiles(caller, sectionId, file, { ifNoneMatch });
      await runnerOnly(caller, sectionId, file);
      askCreateOnly(caller, sectionId, file, { ifNoneMatch });
      noOwnerOrigin(caller, sectionId, file, body);
      let put;
      try {
        put = await bucket.put(keyOf(sectionId, file), body, { contentType: contentType || contentTypeOf(file), ifNoneMatch, ifMatch, metadata: writerMetadata(caller, sectionId, file) });
      } catch (error) {
        if (error.status === 412) throw new HttpError(412, ifNoneMatch ? 'That file already exists.' : 'That file changed since you read it.');
        throw error;
      }
      return { path: file, size: body.length, etag: put.etag };
    },

    async deleteFile(caller, sectionId, file) {
      await section(caller, sectionId, 'delete');
      hubFilesStay(caller, sectionId, file);
      await bucket.del(keyOf(sectionId, file));
      return { path: file, deleted: true };
    },

    async uploads(caller, sectionId, request) {
      const files = Array.isArray(request?.files) ? request.files : null;
      if (!files?.length || files.length > 50) throw new HttpError(400, 'Send { files: [{ path }] }, 1 to 50 of them.');
      await section(caller, sectionId, 'write');
      const uploads = await Promise.all(files.map(async item => {
        const file = cardPath(item?.path);
        if (!file) throw new HttpError(400, `Not a card path: ${item?.path}`);
        if (SECRET.test(file)) throw new HttpError(422, `${file} looks like a secret; it is not uploaded.`);
        ownerOnly(caller, sectionId, file);
        markFiles(caller, sectionId, file, { upload: true });
        await runnerOnly(caller, sectionId, file);
        askCreateOnly(caller, sectionId, file, { upload: true });
        return { path: file, method: 'PUT', url: await bucket.presign('PUT', keyOf(sectionId, file), { expires: urlTtl }) };
      }));
      return { uploads, urlsExpireIn: urlTtl, maxBytes: MAX_FILE };
    },

    async resolve(caller, ref) {
      const wanted = parseRef(ref);
      if (!wanted.card && !wanted.folder) throw new HttpError(400, 'Send ?ref= a site link, section/card, or a card id or title.');
      const ids = wanted.section ? [wanted.section] : await sectionIds(caller);
      const needle = (wanted.card ?? '').toLowerCase();
      const matches = [];
      const moved = [];
      let trashed = null;
      for (const id of ids) {
        const { registry } = await section(caller, id, 'read').catch(error => {
          if (wanted.section) throw error;
          return { registry: { entities: [] } };
        });
        for (const entity of registry.entities) {
          if (!entity) continue;
          const hit = wanted.folder
            ? entity.folder === wanted.folder
            : entity.id === wanted.card || entity.folder === wanted.card || entity.title?.toLowerCase() === needle;
          if (hit) matches.push({ section: id, ...summary(entity) });
        }
        // A card the site moved: follow it into its new workspace. One in the Trash is only named.
        if (!matches.some(match => match.section === id)) {
          const record = retiredBy(registry, wanted.folder ?? wanted.card);
          if (record?.kind === 'moved' && record.to) moved.push({ from: id, id: record.id, to: record.to });
          else if (record) trashed ??= { section: id, id: record.id };
        }
      }
      for (const hop of moved) {
        const target = await section(caller, hop.to, 'read').catch(() => null);
        const entity = target?.registry.entities.find(item => item?.id === hop.id);
        if (!entity) continue;
        const known = matches.find(match => match.section === hop.to && match.id === hop.id);
        if (known) known.movedFrom ??= hop.from;
        else matches.push({ section: hop.to, ...summary(entity), movedFrom: hop.from });
      }
      if (!matches.length && trashed) throw new HttpError(404, `Card "${trashed.id}" is in the Trash of ${trashed.section}; restore it first.`);
      if (!matches.length) throw new HttpError(404, `Nothing matches "${ref}".`);
      return { matches };
    },
  };

  return async function handle(event) {
    const method = event.requestContext?.http?.method ?? 'GET';
    const segments = (event.rawPath ?? '/').split('/').filter(Boolean).map(decodeURIComponent);
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const raw = () => (event.body == null ? Buffer.alloc(0) : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    const json = () => {
      try {
        return JSON.parse(raw().toString('utf8') || '{}');
      } catch {
        throw new HttpError(400, 'Expected a JSON body.');
      }
    };
    try {
      // A browser's CORS preflight carries no credentials. The catch-all route sends it here, so answer
      // it before authenticating; API Gateway adds the CORS headers from the template.
      if (method === 'OPTIONS') return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
      if (event.rawPath === '/cards.mjs' && ['GET', 'HEAD'].includes(method)) {
        // The client learns its own address from the host that served it, so a session that fetches it
        // from the API needs no setup. With no host to go by, it is served unchanged.
        let body = await readFile(CLIENT, 'utf8');
        const domain = event.requestContext?.domainName || headers.host;
        if (domain && /^[a-z0-9.:-]+$/i.test(domain)) body = body.replace("const SERVED_API = '';", () => `const SERVED_API = ${JSON.stringify(`https://${domain}`)};`);
        return { statusCode: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }, body };
      }
      const caller = authenticate(headers);
      const [root, sectionId, kind, ...rest] = segments;
      let result;
      if (root === 'resolve' && segments.length === 1 && method === 'GET') {
        result = await routes.resolve(caller, event.queryStringParameters?.ref);
      } else if (root === 'sections' && !sectionId && method === 'GET') {
        result = await routes.listSections(caller);
      } else if (root === 'sections' && sectionId && !kind && method === 'GET') {
        result = await routes.getSection(caller, sectionId);
      } else if (root === 'sections' && kind === 'cards' && rest.length === 1 && method === 'GET') {
        result = await routes.getCard(caller, sectionId, rest[0]);
      } else if (root === 'sections' && kind === 'cards' && rest.length === 1 && method === 'PUT') {
        result = await routes.putCard(caller, sectionId, rest[0], json());
      } else if (root === 'sections' && kind === 'uploads' && !rest.length && method === 'POST') {
        result = await routes.uploads(caller, sectionId, json());
      } else if (root === 'sections' && kind === 'files' && !rest.length && method === 'GET') {
        result = await routes.listFiles(caller, sectionId, event.queryStringParameters?.prefix);
      } else if (root === 'sections' && kind === 'files' && ['GET', 'PUT', 'DELETE'].includes(method)) {
        const file = cardPath(rest.join('/'));
        if (!file) throw new HttpError(400, 'A file path is <card folder>/<file>, not starting with "_" or ".".');
        if (method === 'GET') result = await routes.getFile(caller, sectionId, file);
        if (method === 'PUT') result = await routes.putFile(caller, sectionId, file, raw(), headers['content-type'], {
          ifNoneMatch: headers['if-none-match'] === '*' ? '*' : undefined,
          ifMatch: headers['if-match']?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined,
        });
        if (method === 'DELETE') result = await routes.deleteFile(caller, sectionId, file);
      } else {
        throw new HttpError(404, `No route ${method} ${event.rawPath}.`);
      }
      if (result?.raw) {
        return {
          statusCode: 200,
          headers: { 'content-type': result.contentType, etag: `"${result.etag}"`, 'cache-control': 'no-store' },
          body: result.raw.toString('base64'),
          isBase64Encoded: true,
        };
      }
      return { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(result) };
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error.status === 404 ? 404 : 500;
      if (status === 500) console.error(error);
      const message = status === 500 ? 'Something went wrong; see the function log.' : error.message;
      return { statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: message, ...(error.extra ?? {}) }) };
    }
  };
}

let ready;
/** Lambda's entry point: configuration from the environment the template sets. */
export async function handler(event) {
  ready ??= createCardApi({
    bucket: createBucket({ bucket: process.env.BUW_S3_BUCKET, region: process.env.BUW_S3_REGION, endpoint: process.env.BUW_S3_ENDPOINT || undefined }),
    tokens: [
      ...(process.env.BUW_CARD_PASSPHRASE ? [{ name: 'passphrase', hash: sha256(process.env.BUW_CARD_PASSPHRASE), rights: EVERYTHING }] : []),
      ...parseTokens(process.env.BUW_CARD_TOKENS),
    ],
    prefix: process.env.BUW_S3_PREFIX || 'sections',
  });
  return ready(event);
}
