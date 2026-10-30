// Emptying the Trash. THE ONLY PLACE THE APP DELETES ANYTHING FROM THE CARDS BUCKET.
//
// The owner chose "Trash, and empty it for good after 30 days". So a card deleted from the Library
// stays restorable for 30 days; a day after that its files go. The same holds for a tab removed from
// a card. Nothing else is ever deleted: not a card that was moved (its source files stay so old
// links keep working), not viewer data under card-responses/, not anything outside the one folder
// of the one card that was deleted.
//
// Two steps, in this order, so a restore can never lose its files:
//   1. claim: one conditional write of workspace.json drops the expired records from `retired` and
//      `removedTabs`. From then on Restore is impossible, and the answer names the folders and files
//      to remove.
//   2. delete: only the files under those folders (and the removed tabs' own files) are deleted.
// A crash between the two leaves files nobody can reach (a leak, not a loss) and the next run does
// not know about them; they are harmless.
//
// Not a scheduled job: it runs when the Trash is opened, or when someone posts to the route.

export const PURGE_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

/** The first day a record deleted on `at` is "more than 30 days ago": the day the Trash shows as "Deleted forever on". */
export const purgeOn = at => new Date(Date.parse(`${at}T00:00:00Z`) + (PURGE_DAYS + 1) * DAY).toISOString().slice(0, 10);

const expired = (at, today) => typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at) && purgeOn(at) <= today;

/** Names a workspace keeps for itself; a card's folder is never one of them. */
const RESERVED = new Set(['card-responses', '_shared', 'workspace.json', 'state.json', 'sections', 'inbox']);

/** A folder name that is safe to delete under: plain relative segments, nothing reserved, no way out. */
export function safeFolder(folder) {
  if (typeof folder !== 'string' || !folder || folder.length > 200) return null;
  if (folder.startsWith('/') || folder.includes('\\') || folder.includes('\0')) return null;
  const parts = folder.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  if (RESERVED.has(parts[0]) || parts[0].startsWith('_')) return null;
  return parts.join('/');
}

/** A tab's file path inside its card folder: plain relative segments. */
const safeFile = file => {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.includes('\0')) return null;
  const parts = file.split('/');
  return parts.some(part => !part || part === '.' || part === '..') ? null : file;
};

/**
 * Drop everything in `list` that is more than 30 days old in the Trash (changes `list` in place) and
 * say what to delete. Returns `{ cards: [{ id, folder }], tabs: [{ id, path, files }], keep: [...] }`:
 * `folders` are removed whole (every file under `<folder>/`), `files` one by one.
 */
export function claimExpired(list, today) {
  const out = { cards: [], tabs: [], skipped: [] };
  const live = new Set();
  for (const entity of list.entities ?? []) if (entity?.folder) live.add(entity.folder);
  for (const record of Object.values(list.retired ?? {})) {
    if (record?.kind === 'moved' && record.folder) live.add(record.folder);
  }
  const retired = list.retired && typeof list.retired === 'object' ? list.retired : {};
  // A deleted card whose folder another card, a moved record or a fresher Trash entry still uses keeps its files.
  const claimed = Object.entries(retired).filter(([, record]) => record?.kind === 'deleted' && expired(record.at, today));
  for (const record of Object.values(retired)) {
    if (record?.kind === 'deleted' && !expired(record.at, today) && record.entity?.folder) live.add(record.entity.folder);
  }
  for (const [id, record] of claimed) {
    delete retired[id];
    const folder = safeFolder(record.entity?.folder);
    if (!folder) out.skipped.push({ id, why: 'no safe folder' });
    else if (live.has(folder)) out.skipped.push({ id, why: 'folder still in use' });
    else out.cards.push({ id, folder });
  }
  if (list.retired && !Object.keys(retired).length) delete list.retired;

  for (const entity of list.entities ?? []) {
    if (!entity || !Array.isArray(entity.removedTabs)) continue;
    const folder = safeFolder(entity.folder);
    const keep = [];
    for (const tab of entity.removedTabs) {
      if (!expired(tab?.at, today)) { keep.push(tab); continue; }
      const file = safeFile(tab.path);
      const inUse = (entity.steps ?? []).some(step => step?.path === file)
        || entity.removedTabs.some(other => other !== tab && other?.path === tab.path && !expired(other?.at, today));
      if (!folder || !file || inUse) { out.skipped.push({ id: entity.id, path: tab?.path, why: !folder || !file ? 'no safe path' : 'tab is back in use' }); continue; }
      // A drawing's picture sits beside its scene.
      const files = [`${folder}/${file}`];
      if (/\.excalidraw$/i.test(file)) files.push(`${folder}/${file.replace(/\.excalidraw$/i, '.png')}`);
      out.tabs.push({ id: entity.id, path: file, files });
    }
    if (keep.length) entity.removedTabs = keep; else delete entity.removedTabs;
  }
  return out;
}
