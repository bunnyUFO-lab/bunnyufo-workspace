// Who wrote what in a project section, the owner's Revert, and the setting that turns agent cards off.
//
// The card API (site/card-api/handler.mjs) leaves one create-only record per write an agent makes in a project section, in the
// inbox: `card-writes/<section>/<folder>/<stamp>-<rand>.json`, marked `writer: card-api` in the object's own metadata. This
// module reads them into rows, and Revert, which is the owner's act, undoes one group of them without removing any object:
//
//   an edited file      the earlier version is written again as a new current version, conditional on the current one
//   a new tab           the tab leaves the card's steps and goes into `removedTabs` (the "+" form brings it back)
//   a new card          the card goes to the Trash (restorable, purged after 30 days like any card)
//   a file with no tab  stays in the folder; the answer lists it under `skipped`
//
// Revert leaves its own record, `<stamp>-<rand>-revert.json`, with no mark: the Hub writes it. The card API refuses `card-writes/`
// to every token, so neither kind of file can be forged through it, and each is read only when it carries the right mark (or none).
//
// The setting is `library-writes.json` at the root of the inbox, `{ v: 1, off: [section], at, by }`. The Hub writes it with no mark.
// It always saves an explicit list: a missing file reads "everything on" here, but may fail closed for the card API's role.
import { S3Error } from './s3.mjs';
import { bucketStore, cardWriter } from './card-writes.mjs';
import { RESERVED, safeFile } from './card-purge.mjs';

export const SETTING_FILE = 'library-writes.json';
export const SECTION_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
/** `<YYYYMMDDTHHMMSSmmmZ>-<rand4>`, with `-revert` for a revert record. */
const FILE_RE = /^(\d{8}T\d{9}Z-[0-9a-f]{4})(-revert)?\.json$/;
const BATCH_RE = /^[a-z0-9]{8,32}$|^\d{8}T\d{9}Z-[0-9a-f]{4}$/;
const MARK = 'card-api';
const READ_RECORDS = 60;
const READ_REVERTS = 40;
const READ_RECORDS_OLDER = 300;
const READ_REVERTS_OLDER = 120;
export const MAX_OLDER_GROUPS = 150;
const REVERT_SCAN = 300;
export const MAX_GROUPS = 20;
/** The largest earlier version Revert writes back: the Hub holds the bytes in memory while it checks and puts them. */
export const MAX_RESTORE = 25 * 1024 * 1024;
const KINDS = new Set(['new-card', 'new-tab', 'edit']);

export const isInbox = id => /^inbox(-|$)/.test(String(id));
/** A section that can hold agent cards, as the card API judges it: a card list that is not hidden, not archived and not an inbox. */
export const isLibrarySection = (id, flags) => SECTION_RE.test(String(id)) && !isInbox(id) && !!flags && flags.hidden !== true && flags.archived !== true;

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

/** A record as the card API writes it, or null. Text fields are clipped; nothing here is ever drawn as HTML. */
export function checkRecord(row, { section, folder }) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.v !== 1) return null;
  if (typeof row.id !== 'string' || !/^\d{8}T\d{9}Z-[0-9a-f]{4}$/.test(row.id)) return null;
  if (row.section !== section || row.folder !== folder || !KINDS.has(row.kind) || typeof row.file !== 'string') return null;
  const entry = row.entry === true;
  if (entry && (typeof row.cardId !== 'string' || !Array.isArray(row.steps))) return null;
  return {
    id: row.id, folder, file: row.file.slice(0, 400), kind: row.kind, entry,
    cardId: entry ? row.cardId.slice(0, 200) : null,
    steps: entry ? row.steps.filter(item => typeof item === 'string').slice(0, 200) : [],
    // The step (a path inside the folder) whose agentTab mark this write set: Revert clears it again.
    markedAgentTab: typeof row.markedAgentTab === 'string' ? row.markedAgentTab.slice(0, 400) : null,
    agent: clip(row.agent, 40) || 'unknown', token: clip(row.token, 80),
    versionId: typeof row.versionId === 'string' ? row.versionId : null,
    previousVersionId: typeof row.previousVersionId === 'string' ? row.previousVersionId : null,
    etag: typeof row.etag === 'string' ? row.etag : null,
    // The etag the file had just before this write: a record whose previousEtag is not the etag of the one before it follows a change that is not in this batch.
    previousEtag: typeof row.previousEtag === 'string' ? row.previousEtag : null,
    context: /^(chat|job)(:[A-Za-z0-9._-]{1,120})?$/.test(row.context ?? '') ? row.context : null,
    why: clip(row.why, 300),
    batch: typeof row.batch === 'string' && /^[a-z0-9]{8,32}$/.test(row.batch) ? row.batch : null,
    at: typeof row.at === 'string' && !Number.isNaN(Date.parse(row.at)) ? row.at : null,
  };
}

/** A revert record, or null. */
export function checkRevert(row, { section, folder }) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.v !== 1 || row.kind !== 'revert') return null;
  if (typeof row.of !== 'string' || !BATCH_RE.test(row.of)) return null;
  if (row.section !== undefined && row.section !== section) return null;
  if (row.folder !== undefined && row.folder !== folder) return null;
  // `undone`: exactly the record ids this Revert undid. A record not listed is still live, whatever its batch label. A file with no list undoes nothing.
  const ids = Array.isArray(row.undone) ? row.undone.filter(id => typeof id === 'string' && /^\d{8}T\d{9}Z-[0-9a-f]{4}$/.test(id)).slice(0, 600) : null;
  // `left`: record ids the owner had changed the file after; the Revert left them alone and closed them, so they offer no button. They are not undone: agent text may still be there.
  const left = Array.isArray(row.left) ? row.left.filter(id => typeof id === 'string' && /^\d{8}T\d{9}Z-[0-9a-f]{4}$/.test(id)).slice(0, 600) : [];
  return { of: row.of, by: clip(row.by, 120), at: typeof row.at === 'string' ? row.at : null, partial: row.partial === true, undone: ids, left };
}

const LABEL = { 'new-card': 'Added a card', 'new-tab': 'Added a tab', edit: 'Changed a tab' };

/**
 * Group records (oldest first) into the rows the page shows: by `batch`, or by the record's own id when it has none.
 * `reverts` are the checked revert records. Newest group first, at most `limit`.
 */
/** The Revert that undid `record`: one for the same batch label and folder that lists the record's id. A revert file with no list undoes nothing. */
export function revertOf(record, reverts) {
  const label = record.batch ?? record.id;
  return reverts.find(item => item.of === label && item.folder === record.folder && item.undone?.includes(record.id)) ?? null;
}

/** The Revert that closed `record`: one that undid it, or one that left it alone because the owner had changed the file since. Either way the row offers no button for it. */
export function closedBy(record, reverts) {
  const label = record.batch ?? record.id;
  return reverts.find(item => item.of === label && item.folder === record.folder && (item.undone?.includes(record.id) || item.left?.includes(record.id))) ?? null;
}

export function groupRows(records, reverts, { limit = MAX_GROUPS, titles = {} } = {}) {
  const groups = new Map();
  for (const record of records) {
    const id = record.batch ?? record.id;
    const covered = closedBy(record, reverts);
    const at = `${record.folder}\0${id}\0${covered ? `${covered.at}|${covered.of}` : 'live'}`;
    if (!groups.has(at)) groups.set(at, { batch: id, folder: record.folder, agent: record.agent, token: record.token, why: record.why, context: record.context, at: record.at, newest: record.id, records: [], covered });
    const group = groups.get(at);
    group.records.push(record);
    if (record.id > group.newest) group.newest = record.id;
  }
  const rows = [];
  for (const group of groups.values()) {
    const kinds = new Set(group.records.map(record => record.kind));
    const files = group.records.filter(record => !record.entry).map(record => ({ file: record.file, kind: record.kind }));
    const undo = group.records.some(record => record.entry || record.kind === 'edit');
    const done = group.covered;
    rows.push({
      batch: group.batch, folder: group.folder, agent: group.agent, token: group.token, why: group.why, context: group.context, at: group.at,
      files,
      title: kinds.size === 1 ? LABEL[[...kinds][0]] : `${Math.max(files.length, 1)} files`,
      ...(titles[group.folder] ? { cardTitle: titles[group.folder] } : {}),
      canRevert: undo && !done,
      ...(done ? { reverted: { at: done.at, by: done.by, ...(done.partial ? { partial: true } : {}), ...(group.records.every(record => done.left?.includes(record.id)) ? { left: true } : {}) } } : {}),
      newest: group.newest,
    });
  }
  return rows.sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0)).slice(0, limit).map(({ newest: _newest, ...row }) => row);
}

/** `{ section, on }` or `{ save: true }`: a 400 for anything else. */
export function checkSettingRequest(raw, fail) {
  if (raw?.save === true) return { save: true };
  if (typeof raw?.section !== 'string' || !SECTION_RE.test(raw.section)) throw fail('Say which section.');
  if (typeof raw.on !== 'boolean') throw fail('Say on: true or false.');
  return { section: raw.section, on: raw.on };
}

/**
 * What the file says. `missing`: no file (everything is on). `bad`: a writer mark, not JSON or a wrong shape (the card API reads
 * every section as off). `ok`: `off` is the list.
 */
export function settingOf(got) {
  if (!got) return { state: 'missing', off: [] };
  if (got.metadata?.writer) return { state: 'bad', off: [], etag: got.etag };
  try {
    const file = JSON.parse(got.text);
    if (!file || file.v !== 1 || !Array.isArray(file.off) || !file.off.every(item => typeof item === 'string')) return { state: 'bad', off: [], etag: got.etag };
    return { state: 'ok', off: file.off, etag: got.etag, at: typeof file.at === 'string' ? file.at : null, by: typeof file.by === 'string' ? file.by : null };
  } catch {
    return { state: 'bad', off: [], etag: got.etag };
  }
}

/** Run `fn` over `items`, at most `size` at a time, keeping the order (the Hub passes its own `pool`; this is the same, for a caller that has none). */
async function defaultPool(size, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

const stampOf = at => at.toISOString().replace(/[-:.]/g, '');

/**
 * @param bucket     the Hub's bucket client (versions: `getVersion`, `head`)
 * @param prefix     where the sections are in the bucket
 * @param key        `inboxKey` bound to this Hub's inbox
 * @param fail       `fail(message, status, extra?)`
 * @param sections   `async () => [{ id, name }]`: the Library sections this Hub may set (the card index, filtered)
 * @param titleOf    `async (section) => { [folder]: card title }`, from the card index; never fails the read
 */
export function createCardWrites({ bucket, prefix = 'sections', key, fail, pool = defaultPool, readPool = 8, sections, titleOf = async () => ({}), now = () => new Date(), log = () => {}, rand = () => Math.random().toString(16).slice(2, 6).padEnd(4, '0') }) {
  const dirKey = (section, folder) => key(`card-writes/${section}/${folder ? `${folder}/` : ''}x`).slice(0, -1);
  const checkSection = section => { if (typeof section !== 'string' || !SECTION_RE.test(section) || isInbox(section)) throw fail('Say which section.', 400); };
  const checkFolder = folder => { if (typeof folder !== 'string' || !FOLDER_RE.test(folder) || RESERVED.has(folder)) throw fail('Say which card folder.', 400); };

  /** The record files of a section (or one folder), newest first: `{ key, folder, name, stamp, revert }`. */
  async function listing(section, folder) {
    const base = dirKey(section, folder);
    const { objects } = await bucket.list(base);
    const found = [];
    for (const object of objects) {
      const parts = object.key.slice(base.length).split('/');
      if (parts.length !== (folder ? 1 : 2)) continue;
      const name = parts[parts.length - 1];
      const match = FILE_RE.exec(name);
      const at = folder ?? parts[0];
      if (!match || !FOLDER_RE.test(at)) continue;
      found.push({ key: object.key, etag: object.etag, folder: at, name, stamp: match[1], revert: !!match[2] });
    }
    return found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  }

  // Records and revert records are create-only, so what a key held at one ETag never changes: it is read once and kept by key and ETag
  // (a file overwritten with other bytes has another ETag and is read again). A file that is no record is kept as null, so a forged one is not fetched again either.
  const seen = new Map();
  const SEEN_MAX = 3000;
  const remember = (name, value) => {
    seen.set(name, value);
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  };

  /** Read and check the files, at most `size` at a time: a record only with the card API's mark, a revert record only without one. */
  async function readFiles(files, section) {
    const out = await pool(readPool, files, async file => {
      const name = `${file.key}|${file.etag ?? ''}`;
      if (file.etag && seen.has(name)) return seen.get(name);
      const got = await bucket.getText(file.key).catch(error => { if (error?.status === 404) return null; throw error; });
      if (!got) return null;
      let value;
      try { value = JSON.parse(got.text); } catch { if (file.etag) remember(name, null); return null; }
      let row;
      if (file.revert) {
        const checked = got.metadata?.writer ? null : checkRevert(value, { section, folder: file.folder });
        row = checked ? { ...checked, folder: file.folder } : null;
      } else {
        row = got.metadata?.writer === MARK ? checkRecord(value, { section, folder: file.folder }) : null;
      }
      if (file.etag) remember(name, row);
      return row;
    });
    return out.filter(Boolean);
  }

  /** Up to 20 groups, newest first, for a section or one of its card folders. */
  async function rows({ section, folder, limit, older = false }) {
    checkSection(section);
    if (folder !== undefined && folder !== null && folder !== '') checkFolder(folder);
    else folder = null;
    const top = older ? MAX_OLDER_GROUPS : MAX_GROUPS;
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, top) : top;
    const files = await listing(section, folder);
    const allRecords = files.filter(file => !file.revert);
    const records = allRecords.slice(0, older ? READ_RECORDS_OLDER : READ_RECORDS);
    const reverts = files.filter(file => file.revert).slice(0, older ? READ_REVERTS_OLDER : READ_REVERTS);
    const [read, undone] = await Promise.all([readFiles(records, section), readFiles(reverts, section)]);
    // The card index is read only when there is something to title.
    const titles = read.length ? await titleOf(section).catch(() => ({})) : {};
    const all = groupRows(read.sort((a, b) => (a.id < b.id ? -1 : 1)), undone, { limit: Infinity, titles });
    // `more`: there is something older than what is shown (groups past the cap, or records not read).
    return { groups: all.slice(0, cap), more: all.length > cap || allRecords.length > records.length };
  }

  const sectionKey = (section, file) => `${prefix}/${section}/${file}`;
  const inside = (file, folder) => { const clean = safeFile(file); return clean && clean.startsWith(`${folder}/`) && !clean.startsWith('..') ? clean : null; };

  async function writeRevertRecord(section, folder, row) {
    const name = `card-writes/${section}/${folder}/${stampOf(now())}-${rand()}-revert.json`;
    try {
      await bucket.putJson(key(name), { v: 1, kind: 'revert', section, folder, ...row }, { ifNoneMatch: '*' });
      return true;
    } catch (error) {
      log(`[card-writes] revert not recorded: ${JSON.stringify({ section, folder, ...row })} (${error?.message})`);
      return false;
    }
  }

  /**
   * Revert one group. Everything that can be checked is checked before anything changes, so a batch that cannot go back changes
   * nothing. Then the files go back, then the card list. A failure midway stops there and records what went back, `partial: true`.
   */
  async function revert({ section, folder, batch }, user) {
    if (!user) throw fail('Sign in to revert this.', 401);
    checkSection(section);
    checkFolder(folder);
    if (typeof batch !== 'string' || !BATCH_RE.test(batch)) throw fail('Say which write.', 400);
    const files = (await listing(section, folder)).slice(0, REVERT_SCAN);
    const [records, reverts] = await Promise.all([readFiles(files.filter(file => !file.revert), section), readFiles(files.filter(file => file.revert), section)]);
    const labelled = records.filter(record => (record.batch ?? record.id) === batch).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!labelled.length) throw fail('No such write.', 404);
    // Only what no earlier Revert covered: a batch label the agent used again is a new write.
    const mine = labelled.filter(record => !closedBy(record, reverts));
    if (!mine.length) throw fail('Already reverted.', 409);

    // What the batch holds.
    const edits = new Map();
    const leftAlone = [];
    // The ids this Revert undoes: each file's unbroken tail, and every other record of the batch. An older record of an edited file stays live, as a row with its own Revert.
    const undoneIds = new Set(mine.filter(item => item.entry || item.kind !== 'edit').map(item => item.id));
    const tailIds = new Map();
    {
      const perFile = new Map();
      for (const record of mine.filter(item => !item.entry && item.kind === 'edit')) {
        const file = inside(record.file, folder);
        if (!file) throw fail(`${record.file} is not a file of this card.`, 409);
        perFile.set(file, [...(perFile.get(file) ?? []), record]);
      }
      // One rule: a Revert undoes only the newest live writes on a file. If a newer live record on the file is not this batch's, the file is left alone (Revert that one first). Going back from the
      // newest, a record joins the tail only while the record just before it on the file is this batch's too and its etag leads on from it (an owner's edit leaves no record, but it changes the etag).
      // Older records of the batch stay live, each its own row with its own Revert. The same bytes written again prove nothing: only the order of the records counts.
      const live = records.filter(item => !item.entry && !closedBy(item, reverts));
      for (const [file, list] of perFile) {
        const onFile = live.filter(item => inside(item.file, folder) === file).sort((x, y) => (x.id < y.id ? -1 : 1));
        const newest = onFile[onFile.length - 1];
        if (!newest || newest.id !== list[list.length - 1].id) { leftAlone.push({ file, why: 'Revert the newer write first' }); continue; }
        const ours = new Set(list.map(item => item.id));
        let from = onFile.length - 1;
        while (from > 0 && ours.has(onFile[from - 1].id) && onFile[from - 1].kind === 'edit' && onFile[from].previousEtag && onFile[from].previousEtag === onFile[from - 1].etag) from -= 1;
        const tail = onFile.slice(from);
        if (tail.length < list.length) leftAlone.push({ file, why: 'changed by someone else after the first write of this batch' });
        edits.set(file, { first: tail[0], last: tail[tail.length - 1], tail });
        tailIds.set(file, tail.map(item => item.id));
        for (const item of tail) undoneIds.add(item.id);
      }
    }
    const entries = mine.filter(item => item.entry);
    const covered = new Set();
    for (const entry of entries) for (const path of entry.steps) covered.add(`${folder}/${path}`);
    const allCovered = entries.some(entry => entry.kind === 'new-card');
    const skipped = mine.filter(item => !item.entry && item.kind !== 'edit' && !allCovered && !covered.has(item.file)).map(item => item.file);
    if (!edits.size && !entries.length) throw fail(leftAlone.some(item => item.why === 'Revert the newer write first') ? 'Revert the newer write first.' : 'That write has nothing to undo.', 409);

    // 1. Check, and read every earlier version.
    const plan = [];
    const ownerLeft = [];
    for (const [file, { first, last }] of [...edits]) {
      const target = sectionKey(section, file);
      let head;
      try { head = await bucket.head(target); } catch (error) { if (error?.status === 404) throw fail(`${file} is gone from the section.`, 409); throw error; }
      // No newer agent write is left on the file (that was settled above), so a different etag is the owner's own change: the file stays as it is, and the rest of the row goes on.
      if (head.etag !== last.etag) {
        leftAlone.push({ file, why: 'You changed this file after the agent, so it was left alone' });
        ownerLeft.push(...edits.get(file).tail.map(item => item.id));
        for (const item of edits.get(file).tail) undoneIds.delete(item.id);
        tailIds.delete(file);
        edits.delete(file);
        continue;
      }
      if (!first.previousVersionId) throw fail(`No earlier version of ${file} was seen, so it cannot be put back.`, 409);
      let old;
      try {
        old = await bucket.getVersion(target, first.previousVersionId);
      } catch (error) {
        if (error instanceof S3Error && error.status === 403) throw fail('The Hub cannot read older versions yet.', 503);
        throw error;
      }
      if (!old) throw fail(`The earlier version of ${file} is no longer in the bucket.`, 409);
      if (old.buffer.length > MAX_RESTORE) throw fail("Too big to restore here; restore it from the bucket's versions.", 413);
      plan.push({ file, target, etag: head.etag, old });
    }
    if (!edits.size && !entries.length) {
      // Nothing can be undone because the owner changed what is left: close those records, so no button stays for them, and say it plainly.
      await writeRevertRecord(section, folder, { of: batch, undone: [], left: ownerLeft, by: String(user).slice(0, 120), at: now().toISOString(), restored: [], removedTabs: [], trashed: [], clearedMarks: [], skipped, leftAlone });
      throw fail('You changed this file after the agent, so it was left alone.', 409);
    }
    const writer = cardWriter(bucketStore(bucket, `${prefix}/${section}`), { section, now });
    const done = { restored: [], removedTabs: [], trashed: [], clearedMarks: [] };
    let current;
    if (entries.length) {
      try { current = (await writer.readList()).list; } catch (error) { if (error?.status === 404 || error?.status === 409) throw fail(error.message, 409); throw error; }
    }

    // 2. Do it. The first failure ends it; what went back is said.
    const stop = async (error, what) => {
      const any = done.restored.length || done.removedTabs.length || done.trashed.length || done.clearedMarks.length;
      // Only the storage's own refusal is a lost race; a refusal of ours ("a card needs at least one section") is said as it is.
      const raced = error instanceof S3Error && (error.status === 412 || error.status === 409);
      // A lost race is the owner's news about that file or card, not about the storage.
      if (!any) throw raced ? fail(`${what} changed while it was being put back. Reload and look at it.`, 409) : error;
      // Only what went back is undone: the files restored so far. The rest stays live, so a second try can finish it.
      const partialIds = done.restored.flatMap(file => tailIds.get(file) ?? []);
      await writeRevertRecord(section, folder, { of: batch, undone: partialIds, by: String(user).slice(0, 120), at: now().toISOString(), left: ownerLeft, ...done, skipped, leftAlone, partial: true });
      const message = raced ? `${what} changed while it was being put back.` : error.message;
      throw fail(`Only part of this went back (${[...done.restored, ...done.removedTabs, ...done.trashed].join(', ')}). ${message}`, 409, { partial: true, ...done });
    };
    for (const step of plan) {
      try {
        await bucket.put(step.target, step.old.buffer, { contentType: step.old.contentType ?? undefined, ifMatch: step.etag });
        done.restored.push(step.file);
      } catch (error) { await stop(error, step.file); }
    }
    // An HTML page the owner owns is theirs again: it gets its card bridge back. A new tab is not touched here (it leaves the steps below).
    // It clears only when the write that set it is in a restored tail and no later write of any agent stays live on that file: while agent text is on the page, it has no bridge.
    const staysLive = record => records.some(other => !other.entry && other.file === record.file && other.id > record.id && !undoneIds.has(other.id) && !revertOf(other, reverts));
    for (const record of [...edits.values()].flatMap(item => item.tail).filter(item => item.markedAgentTab && !staysLive(item))) {
      try {
        if ((await writer.clearAgentTab({ folder, path: record.markedAgentTab })).cleared) done.clearedMarks.push(record.markedAgentTab);
      } catch (error) { await stop(error, 'The card list'); }
    }
    for (const entry of entries) {
      try {
        if (entry.kind === 'new-card') {
          if (current.entities.some(item => item?.id === entry.cardId)) {
            await writer.deleteCard({ id: entry.cardId });
            done.trashed.push(entry.cardId);
          }
        } else {
          for (const path of entry.steps) {
            // The index is read again each time: taking a tab off moves the ones after it.
            const { list } = await writer.readList();
            const card = list.entities.find(item => item?.id === entry.cardId);
            const index = card?.steps?.findIndex(step => step?.path === path) ?? -1;
            if (index < 0) continue;
            await writer.deleteSection({ id: entry.cardId, index, path });
            done.removedTabs.push(path);
          }
        }
      } catch (error) { await stop(error, 'The card list'); }
    }
    const at = now().toISOString();
    const recorded = await writeRevertRecord(section, folder, { of: batch, undone: [...undoneIds].sort(), left: ownerLeft, by: String(user).slice(0, 120), at, ...done, skipped, leftAlone });
    return { status: 200, body: { ...done, skipped, ...(leftAlone.length ? { leftAlone } : {}), reverted: { at, by: String(user).slice(0, 120) }, recorded } };
  }

  const settingKey = () => key(SETTING_FILE);
  async function readSetting() {
    const got = await bucket.getText(settingKey()).catch(error => { if (error?.status === 404) return null; throw error; });
    return settingOf(got);
  }

  /** The panel's list: each Library section this Hub may set and whether agents may write there. `assistant` is always on. */
  async function settingView() {
    const [list, setting] = await Promise.all([sections(), readSetting()]);
    const off = new Set(setting.off);
    return {
      sections: [
        { id: 'assistant', name: 'Assistant', on: true, locked: true },
        ...list.map(item => ({ id: item.id, name: item.name, on: setting.state === 'bad' ? false : !off.has(item.id) })),
      ],
      saved: setting.state !== 'missing',
      ...(setting.state === 'bad' ? { unreadable: true } : {}),
    };
  }

  /** Turn one section on or off, or save the list as it stands (`save`). Always writes an explicit list, conditionally, retrying twice. */
  async function setSection(raw, user) {
    if (!user) throw fail('Sign in to change this.', 401);
    const change = checkSettingRequest(raw, fail);
    const list = await sections();
    if (!change.save) {
      if (change.section === 'assistant') throw fail('assistant cannot be turned off: it is where agents fall back to.', 400);
      if (!list.some(item => item.id === change.section)) throw fail('That is not a section agents can be allowed to write in.', 400);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const setting = await readSetting();
      // A file the card API cannot read has every section off; saving over it keeps that, bar the one turned on.
      const off = new Set(setting.state === 'bad' ? list.map(item => item.id) : setting.off);
      if (!change.save) { if (change.on) off.delete(change.section); else off.add(change.section); }
      const file = { v: 1, off: [...off].sort(), at: now().toISOString(), by: String(user).slice(0, 120) };
      try {
        await bucket.putJson(settingKey(), file, { cacheControl: 'no-store', ...(setting.state === 'missing' ? { ifNoneMatch: '*' } : { ifMatch: setting.etag }) });
        return { status: 200, body: await settingView() };
      } catch (error) {
        if (!(error instanceof S3Error) || (error.status !== 412 && error.status !== 409)) throw error;
      }
    }
    throw fail('The setting changed while you saved it; try again.', 409);
  }

  return { rows, revert, settingView, setSection };
}
