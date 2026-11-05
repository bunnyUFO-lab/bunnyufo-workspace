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
  // `through`: the newest record id this Revert covered. A record newer than it is a later write, even under the same batch label. An older revert record has none and covers every record made before it.
  return { of: row.of, by: clip(row.by, 120), at: typeof row.at === 'string' ? row.at : null, partial: row.partial === true, through: typeof row.through === 'string' && /^\d{8}T\d{9}Z-[0-9a-f]{4}$/.test(row.through) ? row.through : null };
}

const LABEL = { 'new-card': 'Added a card', 'new-tab': 'Added a tab', edit: 'Changed a tab' };

/**
 * Group records (oldest first) into the rows the page shows: by `batch`, or by the record's own id when it has none.
 * `reverts` are the checked revert records. Newest group first, at most `limit`.
 */
/**
 * The Revert that covers `record`: one for the same batch label and folder whose `through` is at or after the record's id (a Revert with no
 * `through` covers everything made before it). A record no Revert covers is live, and a batch label an agent reuses starts a new group.
 */
export function revertOf(record, reverts) {
  const label = record.batch ?? record.id;
  return reverts.filter(item => item.of === label && item.folder === record.folder)
    .sort((a, b) => ((a.through ?? '￿') < (b.through ?? '￿') ? -1 : 1))
    .find(item => (item.through ? item.through >= record.id : !item.at || !record.at || item.at >= record.at)) ?? null;
}

export function groupRows(records, reverts, { limit = MAX_GROUPS, titles = {} } = {}) {
  const groups = new Map();
  for (const record of records) {
    const id = record.batch ?? record.id;
    const covered = revertOf(record, reverts);
    const at = `${record.folder}\0${id}\0${covered ? `${covered.through ?? ''}|${covered.at}` : 'live'}`;
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
      ...(done ? { reverted: { at: done.at, by: done.by, ...(done.partial ? { partial: true } : {}) } } : {}),
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

const stampOf = at => at.toISOString().replace(/[-:.]/g, '');

/**
 * @param bucket     the Hub's bucket client (versions: `getVersion`, `head`)
 * @param prefix     where the sections are in the bucket
 * @param key        `inboxKey` bound to this Hub's inbox
 * @param fail       `fail(message, status, extra?)`
 * @param sections   `async () => [{ id, name }]`: the Library sections this Hub may set (the card index, filtered)
 * @param titleOf    `async (section) => { [folder]: card title }`, from the card index; never fails the read
 */
export function createCardWrites({ bucket, prefix = 'sections', key, fail, sections, titleOf = async () => ({}), now = () => new Date(), log = () => {}, rand = () => Math.random().toString(16).slice(2, 6).padEnd(4, '0') }) {
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
      found.push({ key: object.key, folder: at, name, stamp: match[1], revert: !!match[2] });
    }
    return found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  }

  /** Read and check the files: a record only with the card API's mark, a revert record only without one. */
  async function readFiles(files, section) {
    const out = await Promise.all(files.map(async file => {
      const got = await bucket.getText(file.key).catch(error => { if (error?.status === 404) return null; throw error; });
      if (!got) return null;
      let value;
      try { value = JSON.parse(got.text); } catch { return null; }
      const marked = got.metadata?.writer === MARK;
      if (file.revert) {
        const row = got.metadata?.writer ? null : checkRevert(value, { section, folder: file.folder });
        return row ? { ...row, folder: file.folder } : null;
      }
      return marked ? checkRecord(value, { section, folder: file.folder }) : null;
    }));
    return out.filter(Boolean);
  }

  /** Up to 20 groups, newest first, for a section or one of its card folders. */
  async function rows({ section, folder, limit }) {
    checkSection(section);
    if (folder !== undefined && folder !== null && folder !== '') checkFolder(folder);
    else folder = null;
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_GROUPS) : MAX_GROUPS;
    const files = await listing(section, folder);
    const records = files.filter(file => !file.revert).slice(0, READ_RECORDS);
    const reverts = files.filter(file => file.revert).slice(0, READ_REVERTS);
    const [read, undone] = await Promise.all([readFiles(records, section), readFiles(reverts, section)]);
    // The card index is read only when there is something to title.
    const titles = read.length ? await titleOf(section).catch(() => ({})) : {};
    return { groups: groupRows(read.sort((a, b) => (a.id < b.id ? -1 : 1)), undone, { limit: cap, titles }) };
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
    const mine = labelled.filter(record => !revertOf(record, reverts));
    if (!mine.length) throw fail('Already reverted.', 409);

    // What the batch holds.
    const edits = new Map();
    for (const record of mine.filter(item => !item.entry && item.kind === 'edit')) {
      const file = inside(record.file, folder);
      if (!file) throw fail(`${record.file} is not a file of this card.`, 409);
      edits.set(file, { first: edits.get(file)?.first ?? record, last: record });
    }
    const entries = mine.filter(item => item.entry);
    const covered = new Set();
    for (const entry of entries) for (const path of entry.steps) covered.add(`${folder}/${path}`);
    const allCovered = entries.some(entry => entry.kind === 'new-card');
    const skipped = mine.filter(item => !item.entry && item.kind !== 'edit' && !allCovered && !covered.has(item.file)).map(item => item.file);
    if (!edits.size && !entries.length) throw fail('That write has nothing to undo.', 409);

    // 1. Check, and read every earlier version.
    const plan = [];
    for (const [file, { first, last }] of edits) {
      const target = sectionKey(section, file);
      let head;
      try { head = await bucket.head(target); } catch (error) { if (error?.status === 404) throw fail(`${file} is gone from the section.`, 409); throw error; }
      if (head.etag !== last.etag) throw fail(`${file} changed after this write. Revert the newer write first.`, 409);
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
    const writer = cardWriter(bucketStore(bucket, `${prefix}/${section}`), { section, now });
    const done = { restored: [], removedTabs: [], trashed: [], clearedMarks: [] };
    let current;
    if (entries.length) {
      try { current = (await writer.readList()).list; } catch (error) { if (error?.status === 404 || error?.status === 409) throw fail(error.message, 409); throw error; }
    }

    // 2. Do it. The first failure ends it; what went back is said.
    const stop = async (error, what) => {
      const any = done.restored.length || done.removedTabs.length || done.trashed.length || done.clearedMarks.length;
      const raced = error?.status === 412 || error?.status === 409;
      // A lost race is the owner's news about that file or card, not about the storage.
      if (!any) throw raced ? fail(`${what} changed while it was being put back. Reload and look at it.`, 409) : error;
      await writeRevertRecord(section, folder, { of: batch, through: mine[mine.length - 1].id, by: String(user).slice(0, 120), at: now().toISOString(), ...done, skipped, partial: true });
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
    for (const record of mine.filter(item => !item.entry && item.kind === 'edit' && item.markedAgentTab)) {
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
    const recorded = await writeRevertRecord(section, folder, { of: batch, through: mine[mine.length - 1].id, by: String(user).slice(0, 120), at, ...done, skipped });
    return { status: 200, body: { ...done, skipped, reverted: { at, by: String(user).slice(0, 120) }, recorded } };
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
