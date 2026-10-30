// Emptying the Trash. THE ONLY PLACE THE APP DELETES ANYTHING FROM THE CARDS BUCKET.
//
// The owner chose "Trash, and empty it for good after 30 days". So a card deleted from the Library
// stays restorable for 30 days; a day after that its files go. The same holds for a tab removed from
// a card. Nothing else is ever deleted: not a card that was moved (its source files stay so old
// links keep working), not viewer data under card-responses/ (pending the owner's word), not
// anything outside the one folder of the one card, nor a file a live tab still uses.
//
// Three steps, in this order, each a conditional write or a plain delete, so a crash anywhere is
// finished by the next run:
//   1. claim: one conditional write of workspace.json turns each expired Trash record into a
//      tombstone `{ kind: 'purged', at, folder, pending: true }` and marks each expired removed tab
//      `pending: true`. Restore refuses both from then on, and the card's id stays taken for good.
//   2. delete: only the files under the tombstone's folder, and the pending tabs' own files, that
//      no live tab uses.
//   3. finish: a second conditional write clears `pending`.
// Every run also finishes whatever is still `pending`. A run with nothing to do writes nothing.
//
// Not a scheduled job: it runs when the Trash or the removed tabs are opened, or on a post.
import { posix } from 'node:path';

export const PURGE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` as UTC midnight in ms, or null for anything that is not a real calendar day. */
export function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? ms : null;
}

/** The first day a record deleted on `at` is "more than 30 days ago": the day the Trash shows as "Deleted forever on". Null for a date that is not one. */
export function purgeOn(at) {
  const ms = parseDay(at);
  if (ms === null) return null;
  const day = new Date(ms + (PURGE_DAYS + 1) * DAY);
  return day.getUTCFullYear() > 9999 ? null : day.toISOString().slice(0, 10);
}

/** Old enough, by numbers: a real date, not in the future, and its purge day has come. Never throws. */
const expired = (at, todayMs) => {
  const ms = parseDay(at);
  return ms !== null && ms <= todayMs && ms + (PURGE_DAYS + 1) * DAY <= todayMs;
};

/** Names a workspace keeps for itself; a card's folder is never one of them. */
const RESERVED = new Set(['card-responses', '_shared', 'workspace.json', 'state.json', 'sections', 'inbox']);

/** A folder name that is safe to delete under: ONE plain segment, nothing reserved, no way out. */
export function safeFolder(folder) {
  if (typeof folder !== 'string' || !folder || folder.length > 200) return null;
  if (/[\\/\0]/.test(folder) || folder === '.' || folder === '..' || folder.startsWith('_') || RESERVED.has(folder)) return null;
  return folder;
}

/** A file path inside a card folder, normalized (`./a.md` is `a.md`); null when it leaves the folder. */
export function safeFile(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || /[\\\0]/.test(file)) return null;
  const clean = posix.normalize(file);
  return clean === '.' || clean === '..' || clean.startsWith('../') || clean.startsWith('/') ? null : clean;
}

const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Every file key a live (or still restorable) card uses: its steps, normalized, and the picture beside each drawing. */
function protectedKeys(entities) {
  const keys = new Set();
  for (const entity of entities) {
    if (!entity?.folder || !Array.isArray(entity.steps)) continue;
    for (const step of entity.steps) {
      const file = safeFile(step?.path);
      if (!file) continue;
      keys.add(posix.normalize(`${entity.folder}/${file}`));
      if (/\.excalidraw$/i.test(file)) keys.add(posix.normalize(`${entity.folder}/${file.replace(/\.excalidraw$/i, '.png')}`));
    }
  }
  return keys;
}

/**
 * Plan one run against the card list, changing `list` in place only for the claim (step 1).
 * Returns `{ cards: [{ id, folder }], tabs: [{ id, path, at, files }], claimed, skipped }`:
 * everything pending, new or left over, that step 2 has to delete.
 */
export function claimExpired(list, today) {
  const todayMs = parseDay(today);
  const out = { cards: [], tabs: [], claimed: false, skipped: [] };
  if (todayMs === null) return out;
  const entities = Array.isArray(list.entities) ? list.entities : [];
  const retired = list.retired && typeof list.retired === 'object' && !Array.isArray(list.retired) ? list.retired : {};

  // Folders that are not ours to delete: live cards, moved cards, and Trash entries that can still be restored.
  const keep = [];
  for (const entity of entities) if (typeof entity?.folder === 'string') keep.push(entity.folder);
  for (const record of Object.values(retired)) {
    if (record?.kind === 'moved' && typeof record.folder === 'string') keep.push(record.folder);
    if (record?.kind === 'deleted' && !expired(record.at, todayMs) && typeof record.entity?.folder === 'string') keep.push(record.entity.folder);
  }
  const freeToDelete = folder => !keep.some(other => overlaps(folder, other));

  const seenFolders = new Set();
  for (const [id, record] of Object.entries(retired)) {
    if (record?.kind === 'deleted' && expired(record.at, todayMs)) {
      const folder = safeFolder(record.entity?.folder);
      const ok = folder && freeToDelete(folder);
      if (!ok) out.skipped.push({ id, why: folder ? 'folder still in use' : 'no safe folder' });
      retired[id] = { kind: 'purged', at: today, ...(folder ? { folder } : {}), ...(ok ? { pending: true } : {}) };
      out.claimed = true;
    }
  }
  // Everything pending, including what an earlier run left behind. Re-checked now: a folder that is in use again is not touched.
  for (const [id, record] of Object.entries(retired)) {
    if (record?.kind !== 'purged' || record.pending !== true) continue;
    const folder = safeFolder(record.folder);
    if (!folder || !freeToDelete(folder)) { out.skipped.push({ id, why: 'folder not safe to delete' }); const { pending: _gone, ...rest } = record; retired[id] = rest; out.claimed = true; continue; }
    if (seenFolders.has(folder)) continue;
    seenFolders.add(folder);
    out.cards.push({ id, folder });
  }
  if (Object.keys(retired).length) list.retired = retired;

  // Removed tabs: whole workspace, deleted cards or not.
  const liveKeys = protectedKeys([...entities, ...Object.values(retired).filter(record => record?.kind === 'deleted').map(record => record.entity)]);
  for (const entity of entities) {
    if (!entity || !Array.isArray(entity.removedTabs)) continue;
    const folder = safeFolder(entity.folder);
    const kept = [];
    for (const tab of entity.removedTabs) {
      const file = safeFile(tab?.path);
      if (tab?.pending !== true && !expired(tab?.at, todayMs)) { kept.push(tab); continue; }
      if (!folder || !file) { out.skipped.push({ id: entity.id, path: tab?.path, why: 'no safe path' }); out.claimed = true; continue; }
      if (tab.pending !== true) { tab.pending = true; out.claimed = true; }
      kept.push(tab);
      const files = [file];
      if (/\.excalidraw$/i.test(file)) files.push(file.replace(/\.excalidraw$/i, '.png'));
      const deletable = files.map(name => posix.normalize(`${folder}/${name}`)).filter(key => !liveKeys.has(key));
      out.tabs.push({ id: entity.id, path: tab.path, at: tab.at, files: deletable });
    }
    if (kept.length) entity.removedTabs = kept; else delete entity.removedTabs;
  }
  return out;
}

/** Step 3: clear `pending` on what the plan has now deleted. Returns whether anything changed. */
export function finishPurge(list, plan) {
  let changed = false;
  for (const { id } of plan.cards) {
    const record = list.retired?.[id];
    if (record?.kind === 'purged' && record.pending) { delete record.pending; changed = true; }
  }
  for (const done of plan.tabs) {
    const entity = (list.entities ?? []).find(item => item?.id === done.id);
    if (!entity || !Array.isArray(entity.removedTabs)) continue;
    const left = entity.removedTabs.filter(tab => !(tab?.pending === true && tab.path === done.path && tab.at === done.at));
    if (left.length !== entity.removedTabs.length) {
      changed = true;
      if (left.length) entity.removedTabs = left; else delete entity.removedTabs;
    }
  }
  return changed;
}
