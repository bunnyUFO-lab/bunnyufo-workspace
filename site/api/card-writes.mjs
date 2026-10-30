// Making and editing cards by hand: a new card, a Markdown section added to one, a section's text
// saved back. The same rules on both hosts — the published site writes into the cards bucket, the
// local service into the workspace folder — so both hand this module a store with two calls:
//
//   read(file)                    → { text, etag } or null, for a path inside the workspace
//   write(file, text, { ifMatch }) → { etag }; ifMatch is the etag the caller read, or null for
//                                   "only if nothing is there", and a mismatch throws status 412;
//                                   the body is a string or a Buffer (a drawing's picture)
//   exists(file)                  → true or false, without reading the file
//
// An etag is the md5 of the bytes, which is what S3 answers for anything put in one piece, so the
// folder store computes the same thing and a client never has to know which host it is talking to.
//
// The card list is read, changed and written back conditionally, and read again when someone else
// wrote in between: two people adding cards from two devices both end up in it.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const md5 = text => createHash('md5').update(text).digest('hex');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** "Combat Notes!" → "combat-notes": a card id, a folder name, a section's file name. */
export const slug = value =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

const text = (value, limit, what) => {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length > limit) throw fail(`${what} is longer than ${limit} characters.`);
  return clean;
};

/** The first id not taken: `notes`, then `notes-2`, `notes-3`… */
const unique = (base, taken) => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EMPTY_DRAWING = '{"type":"excalidraw","version":2,"source":"bunnyufo-workspace","elements":[],"appState":{},"files":{}}\n';
const MAX_SCENE = 2 * 1024 * 1024;
const MAX_PICTURE = 6 * 1024 * 1024;
const MAX_SIDE = 2048;

/**
 * The checks every drawing save shares, on the card route and on the Hub's: a scene that is an
 * Excalidraw document of at most 2 MB, and a PNG of at most 6 MB and 2048 px a side. Throws the
 * same 400/413 errors; returns the scene text and the decoded picture.
 */
export function checkDrawing({ scene, png }) {
  if (typeof scene !== 'string') throw fail('Say what the drawing should hold.');
  if (Buffer.byteLength(scene) > MAX_SCENE) throw fail('A drawing is limited to 2 MB; remove pasted images.', 413);
  let parsed;
  try { parsed = JSON.parse(scene); } catch { throw fail('That drawing is not valid JSON.'); }
  if (parsed?.type !== 'excalidraw' || !Array.isArray(parsed.elements)) throw fail('That is not an Excalidraw drawing.');
  if (typeof png !== 'string') throw fail('Send the picture of the drawing too.');
  const pngBuffer = Buffer.from(png, 'base64');
  if (pngBuffer.length > MAX_PICTURE) throw fail('The picture is limited to 6 MB.', 413);
  if (pngBuffer.length < 24 || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw fail('The picture is not a PNG.');
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw fail('The picture is larger than 2048 px.');
  return { sceneText: scene, pngBuffer };
}

/** A path inside a card folder, as the card list writes it: no "..", no leading slash, no backslash. */
const inside = (value, pattern, what) => {
  const file = String(value ?? '');
  if (!pattern.test(file) || file.includes('..') || file.startsWith('/') || file.includes('\\')) throw fail(what);
  return file;
};

const dimension = value => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(16384, Math.max(1, n)) : null;
};

const RESPONSE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_SET = 200;
const MAX_RESPONSES = 4 * 1024 * 1024;
const responseId = (value, what) => {
  if (typeof value !== 'string' || !RESPONSE_ID.test(value)) throw fail(`${what} is lowercase letters, digits, dots, dashes and underscores, up to 80.`);
  return value;
};

const today = (now = new Date()) => now.toISOString().slice(0, 10);

const MAX_RETIRED = 500;
const MAX_REMOVED_TABS = 50;

/**
 * Keep `retired` (the card list's record of cards moved away or put in the Trash) to at most 500
 * entries. The oldest `moved` records go first; `deleted` ones are the Trash and never drop.
 */
export function capRetired(retired, limit = MAX_RETIRED) {
  let over = Object.keys(retired).length - limit;
  for (const key of Object.keys(retired)) {
    if (over <= 0) break;
    if (retired[key]?.kind === 'moved') { delete retired[key]; over -= 1; }
  }
  return retired;
}

/** A store over a folder on disk: the local service's workspace. */
export function folderStore(root) {
  const full = file => {
    const target = path.resolve(root, ...file.split('/'));
    if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) throw fail('That path is outside the workspace.');
    return target;
  };
  // One write at a time per folder: the etag check and the write are two steps on disk.
  let queue = Promise.resolve();
  return {
    async read(file) {
      try {
        const body = await readFile(full(file));
        return { text: body.toString('utf8'), etag: md5(body) };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async exists(file) {
      try {
        await stat(full(file));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    write(file, body, { ifMatch } = {}) {
      const done = queue.then(async () => {
        const target = full(file);
        const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (ifMatch === null && current) throw fail('Someone else made that file first.', 412);
        if (ifMatch && (!current || md5(current) !== ifMatch)) throw fail('That file changed since it was read.', 412);
        await mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, body);
        await rename(temp, target);
        return { etag: md5(Buffer.from(body)) };
      });
      queue = done.catch(() => {});
      return done;
    },
  };
}

/** A store over one section of the cards bucket: the published site's workspace. */
export function bucketStore(bucket, prefix) {
  const key = file => `${prefix}/${file}`;
  return {
    async read(file) {
      const got = await bucket.getText(key(file));
      return got ? { text: got.text, etag: got.etag } : null;
    },
    async exists(file) {
      try {
        await bucket.head(key(file));
        return true;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    },
    async write(file, body, { ifMatch } = {}) {
      const written = await bucket.put(key(file), body, ifMatch === null ? { ifNoneMatch: '*' } : ifMatch ? { ifMatch } : {});
      return { etag: written.etag };
    },
  };
}

/**
 * @param store  see the top of this file
 * @param now    the clock, for tests
 * @param section the workspace id, written into a card's responses doc
 */
export function cardWriter(store, { now = () => new Date(), retries = 4, section = '' } = {}) {
  /** Read the card list, let `change` edit it, and write it back only if nobody else did meanwhile. */
  async function editList(change) {
    for (let attempt = 1; ; attempt += 1) {
      const got = await store.read('workspace.json');
      if (!got) throw fail('This workspace has no card list (workspace.json).', 404);
      let list;
      try { list = JSON.parse(got.text); } catch { throw fail('This workspace\'s workspace.json is not valid JSON.', 409); }
      if (!Array.isArray(list.entities)) list.entities = [];
      const result = await change(list);
      try {
        await store.write('workspace.json', `${JSON.stringify(list, null, 2)}\n`, { ifMatch: got.etag });
        return result;
      } catch (error) {
        if (error.status !== 412 || attempt >= retries) throw error;
      }
    }
  }

  const cardIn = (list, id) => {
    const card = list.entities.find(item => item?.id === id);
    if (!card) throw fail('No card with that id in this workspace.', 404);
    if (!card.folder) throw fail('That card has no folder to write into.', 409);
    if (!Array.isArray(card.steps)) card.steps = [];
    return card;
  };

  /** The workspace id a card list belongs to, once the card is known to be in it. */
  async function knownCard(id) {
    const got = await store.read('workspace.json');
    if (!got) throw fail('This workspace has no card list (workspace.json).', 404);
    let list;
    try { list = JSON.parse(got.text); } catch { throw fail('The workspace card list (workspace.json) is not valid JSON.', 409); }
    cardIn({ entities: Array.isArray(list.entities) ? list.entities : [] }, id);
    return section;
  }

  /** A step of the card that is a Markdown file, by its path. */
  const markdownStep = (card, file) => {
    const step = card.steps.find(item => item?.path === file);
    if (!step) throw fail('That card has no section with that file.', 404);
    if (!/\.md$/i.test(file)) throw fail('Only Markdown sections can be edited here.');
    return step;
  };

  /** A step of the card that is an Excalidraw drawing, by its path. */
  const drawingStep = (card, file) => {
    const step = card.steps.find(item => item?.path === file);
    if (!step) throw fail('That card has no section with that file.', 404);
    inside(file, /\.excalidraw$/i, 'Only drawing sections can be edited here.');
    return step;
  };

  return {
    store,
    section,

    /**
     * A new card with one Markdown section. Its folder is `<date>_<id>` like the cards agents make,
     * so the two kinds sort and read the same.
     */
    async createCard({ title, description = '', category = '' }) {
      const name = text(title, 120, 'A title');
      if (!name) throw fail('A card needs a title.');
      const about = text(description, 400, 'A description');
      const base = slug(name);
      if (!base) throw fail('That title has no letters or digits in it.');
      const date = today(now());
      return editList(async list => {
        const id = unique(base, new Set(list.entities.map(item => item?.id)));
        const folder = `${date}_${id}`;
        const body = `# ${name}\n\n${about ? `${about}\n` : ''}`;
        // The page first, and only if the folder is new: a retried request makes one card, not two.
        await store.write(`${folder}/index.md`, body, { ifMatch: null }).catch(error => {
          if (error.status === 412) throw fail(`A card folder called "${folder}" is already here.`, 409);
          throw error;
        });
        const card = {
          id, title: name, ...(about ? { description: about } : {}), type: 'group',
          category: slug(category) || 'notes', created: date, updated: date, folder,
          steps: [{ name: 'Overview', path: 'index.md' }],
        };
        list.entities.push(card);
        return card;
      });
    },

    /** Change a card's title or description. The folder and id stay, so links keep working. */
    async updateCard({ id, title, description, category }) {
      return editList(async list => {
        const card = cardIn(list, id);
        if (title !== undefined) {
          const name = text(title, 120, 'A title');
          if (!name) throw fail('A card needs a title.');
          card.title = name;
        }
        if (description !== undefined) {
          const about = text(description, 400, 'A description');
          if (about) card.description = about; else delete card.description;
        }
        if (category !== undefined) card.category = slug(category) || 'notes';
        card.updated = today(now());
        return card;
      });
    },

    /**
     * Give every card of a category in this workspace another category. `from` is the category as the
     * Library shows it (`other` for a card with none). Renaming onto a category that already exists
     * is a merge; the answer says which it was.
     */
    async renameCategory({ from, to }) {
      const old = String(from ?? '').trim();
      const next = slug(to);
      if (!old) throw fail('Say which category to rename.');
      if (!next) throw fail('A category needs letters or digits in its name.');
      if (next === old) throw fail('That is already the name of the category.');
      return editList(async list => {
        const moving = list.entities.filter(item => item && (item.category || 'other') === old);
        if (!moving.length) throw fail('No card is in that category.', 404);
        const merged = list.entities.some(item => item && !moving.includes(item) && (item.category || 'other') === next);
        const date = today(now());
        for (const item of moving) { item.category = next; item.updated = date; }
        return { from: old, to: next, count: moving.length, merged };
      });
    },

    /** Move a tab to another place in the card's tab bar. `defaultStep` keeps pointing at the same tab. */
    async moveSection({ id, from, to }) {
      return editList(async list => {
        const card = cardIn(list, id);
        const last = card.steps.length - 1;
        if (![from, to].every(n => Number.isInteger(n) && n >= 0 && n <= last)) throw fail('That card has no such section.', 404);
        if (from === to) return card;
        const shown = Number.isInteger(card.defaultStep) ? card.steps[card.defaultStep] : null;
        const [step] = card.steps.splice(from, 1);
        card.steps.splice(to, 0, step);
        if (shown) card.defaultStep = card.steps.indexOf(shown);
        card.updated = today(now());
        return card;
      });
    },

    /**
     * Take a tab off the card. The file stays in the folder and the tab is kept in `removedTabs` (50 at
     * most, newest last) so it can be put back. `path` must match the tab at `index`: a card that changed
     * since the page was drawn is a 409, not the wrong tab gone. The last tab cannot go.
     */
    async deleteSection({ id, index, path: file }) {
      return editList(async list => {
        const card = cardIn(list, id);
        const step = Number.isInteger(index) ? card.steps[index] : undefined;
        if (!step) throw fail('That card has no such section.', 404);
        if (step.path !== file) throw fail('The card changed since you opened it; reload and try again.', 409);
        if (card.steps.length < 2) throw fail('A card needs at least one section. Delete the card instead.', 409);
        const wasDefault = card.defaultStep === index;
        card.steps.splice(index, 1);
        if (Number.isInteger(card.defaultStep)) {
          if (card.defaultStep > index) card.defaultStep -= 1;
          card.defaultStep = Math.min(card.defaultStep, card.steps.length - 1);
        }
        const removedTabs = Array.isArray(card.removedTabs) ? card.removedTabs : [];
        removedTabs.push({ ...step, at: today(now()), index, ...(wasDefault ? { wasDefault: true } : {}) });
        card.removedTabs = removedTabs.slice(-MAX_REMOVED_TABS);
        card.updated = today(now());
        return { card, removed: step };
      });
    },

    /** Put a removed tab back where it was (or at the end if the card is shorter now). */
    async restoreSection({ id, path: file }) {
      return editList(async list => {
        const card = cardIn(list, id);
        const removed = Array.isArray(card.removedTabs) ? card.removedTabs : [];
        const at = removed.map(item => item?.path).lastIndexOf(file);
        if (at < 0) throw fail('That card has no removed section with that file.', 404);
        if (card.steps.some(item => item?.path === file)) throw fail('A section with that file is already on the card.', 409);
        const { at: _when, index, wasDefault, ...step } = removed[at];
        const place = Math.min(Math.max(Number.isInteger(index) ? index : card.steps.length, 0), card.steps.length);
        card.steps.splice(place, 0, step);
        if (wasDefault) card.defaultStep = place;
        else if (Number.isInteger(card.defaultStep) && card.defaultStep >= place) card.defaultStep += 1;
        removed.splice(at, 1);
        if (removed.length) card.removedTabs = removed; else delete card.removedTabs;
        card.updated = today(now());
        return { card, step: place };
      });
    },

    /**
     * Put a card in this workspace's Trash: it leaves the list and `retired[id]` keeps the whole entity.
     * Its files, its viewers' data and its pins and tags stay where they are, so Restore is complete.
     */
    async deleteCard({ id }) {
      return editList(async list => {
        const at = list.entities.findIndex(item => item?.id === id);
        if (at < 0) throw fail('No card with that id in this workspace.', 404);
        const [entity] = list.entities.splice(at, 1);
        const retired = list.retired && typeof list.retired === 'object' && !Array.isArray(list.retired) ? list.retired : {};
        delete retired[id];
        retired[id] = { kind: 'deleted', at: today(now()), entity };
        list.retired = capRetired(retired);
        return { id, retired: retired[id] };
      });
    },

    /** Bring a card back from the Trash. Refused when a card with its id or folder is in the list again. */
    async restoreCard({ id }) {
      return editList(async list => {
        const record = list.retired?.[id];
        if (record?.kind !== 'deleted' || !record.entity) throw fail('That card is not in the Trash.', 404);
        const entity = record.entity;
        if (list.entities.some(item => item?.id === id || (entity.folder && item?.folder === entity.folder))) {
          throw fail('A card with that id or folder is already here; rename or delete it first.', 409);
        }
        delete list.retired[id];
        if (!Object.keys(list.retired).length) delete list.retired;
        entity.updated = today(now());
        list.entities.push(entity);
        return { card: entity };
      });
    },

    /**
     * Add a section to a card: a new file in its folder and a tab for it. `kind` is a Markdown page
     * (the default) or an empty drawing, which must not share its name with a picture already there.
     */
    async addSection({ id, name, kind = 'markdown' }) {
      if (kind !== 'markdown' && kind !== 'drawing') throw fail('A section is either Markdown or a drawing.');
      const drawing = kind === 'drawing';
      const extension = drawing ? '.excalidraw' : '.md';
      const label = text(name, 60, 'A section name');
      if (!label) throw fail('A section needs a name.');
      const base = slug(label) || 'section';
      return editList(async list => {
        const card = cardIn(list, id);
        const taken = new Set(card.steps.map(step => String(step?.path ?? '').replace(/\.[^.]+$/, '')));
        taken.add('index');
        let file;
        for (let n = 1; ; n += 1) {
          if (n > 21) throw fail('Too many sections of that name.', 409);
          const chosen = unique(base, taken);
          file = `${chosen}${extension}`;
          if (drawing && await store.exists(`${card.folder}/${chosen}.png`)) { taken.add(chosen); continue; }
          try {
            await store.write(`${card.folder}/${file}`, drawing ? EMPTY_DRAWING : `# ${label}\n\n`, { ifMatch: null });
            break;
          } catch (error) {
            // A file of that name already sits in the folder without a tab: take the next name.
            if (error.status !== 412) throw error;
            taken.add(chosen);
          }
        }
        card.steps.push({ name: label, path: file });
        card.updated = today(now());
        return { card, step: card.steps.length - 1, path: file };
      });
    },

    /** Rename a section's tab. The file keeps its name. */
    async renameSection({ id, index, name }) {
      const label = text(name, 60, 'A section name');
      if (!label) throw fail('A section needs a name.');
      return editList(async list => {
        const card = cardIn(list, id);
        const step = card.steps[index];
        if (!Number.isInteger(index) || !step) throw fail('That card has no such section.', 404);
        step.name = label;
        card.updated = today(now());
        return card;
      });
    },

    /** A Markdown section's text, with the etag a save has to name. */
    async readMarkdown({ id, path: file }) {
      const got = await store.read('workspace.json');
      if (!got) throw fail('This workspace has no card list (workspace.json).', 404);
      const card = cardIn(JSON.parse(got.text), id);
      markdownStep(card, file);
      const page = await store.read(`${card.folder}/${file}`);
      return { text: page?.text ?? '', etag: page?.etag ?? null };
    },

    /**
     * Save a Markdown section. `base` is the etag the editor started from; when the file changed
     * since, nothing is written and the answer (409) carries what is there now, so the editor can
     * show it instead of quietly overwriting someone else's edit.
     */
    async saveMarkdown({ id, path: file, text: body, base }) {
      if (typeof body !== 'string') throw fail('Say what the section should hold.');
      if (Buffer.byteLength(body) > 1024 * 1024) throw fail('A section is limited to 1 MB of text.', 413);
      const got = await store.read('workspace.json');
      if (!got) throw fail('This workspace has no card list (workspace.json).', 404);
      const card = cardIn(JSON.parse(got.text), id);
      markdownStep(card, file);
      const where = `${card.folder}/${file}`;
      const current = await store.read(where);
      if ((current?.etag ?? null) !== (base ?? null)) {
        throw Object.assign(fail('This section changed since you opened it.', 409), { current: current ? { text: current.text, etag: current.etag } : null });
      }
      let written;
      try {
        written = await store.write(where, body, { ifMatch: current ? current.etag : null });
      } catch (error) {
        if (error.status !== 412) throw error;
        const latest = await store.read(where);
        throw Object.assign(fail('This section changed since you opened it.', 409), { current: latest ? { text: latest.text, etag: latest.etag } : null });
      }
      // The card shows when it was last touched; a failed date bump is not worth failing the save for.
      await editList(async list => { cardIn(list, id).updated = today(now()); }).catch(() => {});
      return { text: body, etag: written.etag };
    },

    /** What a card's viewers saved under one doc name: `{ doc, etag }`, or `{ doc: null, etag: null }` before the first save. */
    async readResponses({ id, doc }) {
      const name = responseId(doc, 'A doc id');
      await knownCard(id);
      const got = await store.read(`card-responses/${id}/${name}.json`);
      if (!got) return { doc: null, etag: null };
      try { return { doc: JSON.parse(got.text), etag: got.etag }; } catch { throw fail('The saved responses are not valid JSON.'); }
    },

    /**
     * Apply `set` to a card's responses doc: an item id → `{ updated, data }` puts it, `null` deletes it. The
     * doc is read, changed and written back only if nobody wrote meanwhile, and read again when they did, so
     * two pages saving different items both land.
     */
    async saveResponses({ id, doc, set }) {
      const name = responseId(doc, 'A doc id');
      if (!set || typeof set !== 'object' || Array.isArray(set)) throw fail('Say which items to set.');
      const entries = Object.entries(set);
      if (entries.length < 1 || entries.length > MAX_SET) throw fail(`Set between 1 and ${MAX_SET} items at a time.`);
      for (const [item, value] of entries) {
        responseId(item, 'An item id');
        if (value === null) continue;
        if (!value || typeof value !== 'object' || Array.isArray(value) || !('data' in value)) throw fail('An item needs a data value.');
        if (typeof value.updated !== 'string' || value.updated.length > 40) throw fail('An item needs an updated time of at most 40 characters.');
      }
      const section = await knownCard(id);
      const where = `card-responses/${id}/${name}.json`;
      for (let attempt = 1; ; attempt += 1) {
        const got = await store.read(where);
        let current = null;
        if (got) { try { current = JSON.parse(got.text); } catch { throw fail('The saved responses are not valid JSON.', 409); } }
        const items = { ...(current?.items && typeof current.items === 'object' ? current.items : {}) };
        for (const [item, value] of entries) {
          if (value === null) delete items[item]; else items[item] = { updated: value.updated, data: value.data };
        }
        const merged = { version: 1, section, card: id, doc: name, updated: now().toISOString(), items };
        const text = `${JSON.stringify(merged)}
`;
        if (Buffer.byteLength(text) > MAX_RESPONSES) throw fail('Too many responses for one file (over 4 MB).', 413);
        try {
          const written = await store.write(where, text, { ifMatch: got ? got.etag : null });
          return { doc: merged, etag: written.etag };
        } catch (error) {
          if (error.status !== 412) throw error;
          if (attempt >= retries) throw fail('The responses kept changing; try again.', 409);
        }
      }
    },

    /** A drawing's scene (the .excalidraw JSON), with the etag a save has to name. */
    async readDrawing({ id, path: file }) {
      const got = await store.read('workspace.json');
      if (!got) throw fail('This workspace has no card list (workspace.json).', 404);
      const card = cardIn(JSON.parse(got.text), id);
      drawingStep(card, file);
      const scene = await store.read(`${card.folder}/${file}`);
      return { text: scene?.text ?? '', etag: scene?.etag ?? null };
    },

    /**
     * Save a drawing: the scene, then its picture beside it (`x.excalidraw` → `x.png`). The scene is
     * the one guarded by `base`, as in saveMarkdown, and goes first, so a lost race never leaves a
     * new picture beside an old scene.
     */
    async saveDrawing({ id, path: file, scene, png, base }) {
      const { sceneText, pngBuffer: picture } = checkDrawing({ scene, png });
      const got = await store.read('workspace.json');
      if (!got) throw fail('This workspace has no card list (workspace.json).', 404);
      const card = cardIn(JSON.parse(got.text), id);
      drawingStep(card, file);
      const where = `${card.folder}/${file}`;
      const current = await store.read(where);
      const conflict = latest => Object.assign(fail('This drawing changed since you opened it.', 409), { current: latest ? { text: latest.text, etag: latest.etag } : null });
      if ((current?.etag ?? null) !== (base ?? null)) throw conflict(current);
      let written;
      try {
        written = await store.write(where, sceneText, { ifMatch: current ? current.etag : null });
      } catch (error) {
        if (error.status !== 412) throw error;
        throw conflict(await store.read(where));
      }
      let pictured;
      try {
        pictured = await store.write(where.replace(/\.excalidraw$/i, '.png'), picture, {});
      } catch {
        throw fail('The drawing was saved but its picture was not; save again.', 502);
      }
      await editList(async list => { cardIn(list, id).updated = today(now()); }).catch(() => {});
      return { etag: written.etag, png: pictured.etag };
    },

    /**
     * Start a drawing over a picture of the card. The picture is referenced by name, not copied, so
     * the scene stays small and the original is never touched. The new tab sits after `after`.
     */
    async annotate({ id, image, after, width, height }) {
      const source = inside(image, /\.(png|jpe?g|webp|gif|svg)$/i, 'Only a picture of this card can be annotated.');
      const w = dimension(width) ?? 1024;
      const h = dimension(height) ?? 768;
      const stem = source.replace(/\.[^./]+$/, '');
      const name = source.split('/').pop();
      const label = stem.split('/').pop();
      const scene = `${JSON.stringify({
        type: 'excalidraw', version: 2, source: 'bunnyufo-workspace',
        elements: [{
          type: 'image', id: 'buw-bg', x: 0, y: 0, width: w, height: h, locked: true,
          status: 'saved', fileId: `buw:${name}`, scale: [1, 1], customData: { buwSrc: name },
        }],
        appState: { viewBackgroundColor: '#ffffff' }, files: {},
      })}\n`;
      // editList runs this again when the card list changed meanwhile: the scene written the first
      // time is kept and given its tab then, not left in the folder beside a second one.
      let file;
      return editList(async list => {
        const card = cardIn(list, id);
        if (!(await store.exists(`${card.folder}/${source}`))) throw fail('That picture is not in this card.', 404);
        for (let n = 1; !file; n += 1) {
          if (n > 50) throw fail('Too many annotations of that picture.', 409);
          const candidate = `${stem}.annotated${n > 1 ? `-${n}` : ''}`;
          if (await store.exists(`${card.folder}/${candidate}.excalidraw`) || await store.exists(`${card.folder}/${candidate}.png`)) continue;
          try {
            await store.write(`${card.folder}/${candidate}.excalidraw`, scene, { ifMatch: null });
            file = `${candidate}.excalidraw`;
            break;
          } catch (error) {
            if (error.status !== 412) throw error;
          }
        }
        const at = Number.isInteger(after) ? Math.min(Math.max(after + 1, 0), card.steps.length) : card.steps.length;
        card.steps.splice(at, 0, { name: `${label} (annotated)`, path: file });
        card.updated = today(now());
        return { card, step: at, path: file };
      });
    },
  };
}

/**
 * The routes both services answer, under /api/cards. `writerFor(workspace)` gives the cardWriter
 * for the workspace a request names, or throws 404. Returns the answer, or undefined for a path
 * that is not one of these.
 */
export async function cardRoute({ method, route, query, data, writerFor }) {
  if (!route.startsWith('/cards')) return undefined;
  if (method === 'GET' && route === '/cards/markdown') {
    const writer = await writerFor(query.get('workspace'));
    return { status: 200, body: await writer.readMarkdown({ id: query.get('id'), path: query.get('path') }) };
  }
  if (method === 'GET' && route === '/cards/responses') {
    const writer = await writerFor(query.get('workspace'));
    return { status: 200, body: await writer.readResponses({ id: query.get('id'), doc: query.get('doc') }) };
  }
  if (method === 'GET' && route === '/cards/drawing') {
    const writer = await writerFor(query.get('workspace'));
    return { status: 200, body: await writer.readDrawing({ id: query.get('id'), path: query.get('path') }) };
  }
  if (method !== 'POST') return undefined;
  const writer = await writerFor(data.workspace);
  if (route === '/cards') return { status: 201, body: { card: await writer.createCard(data) } };
  if (route === '/cards/update') return { status: 200, body: { card: await writer.updateCard(data) } };
  if (route === '/cards/section') return { status: 201, body: await writer.addSection(data) };
  if (route === '/cards/category') return { status: 200, body: await writer.renameCategory(data) };
  if (route === '/cards/section/move') return { status: 200, body: { card: await writer.moveSection(data) } };
  if (route === '/cards/section/delete') return { status: 200, body: await writer.deleteSection(data) };
  if (route === '/cards/section/restore') return { status: 200, body: await writer.restoreSection(data) };
  if (route === '/cards/delete') return { status: 200, body: await writer.deleteCard(data) };
  if (route === '/cards/restore') return { status: 200, body: await writer.restoreCard(data) };
  if (route === '/cards/section/rename') return { status: 200, body: { card: await writer.renameSection(data) } };
  if (route === '/cards/markdown') return { status: 200, body: await writer.saveMarkdown(data) };
  if (route === '/cards/drawing') return { status: 200, body: await writer.saveDrawing(data) };
  if (route === '/cards/responses') return { status: 200, body: await writer.saveResponses(data) };
  if (route === '/cards/annotate') return { status: 201, body: await writer.annotate(data) };
  return undefined;
}
