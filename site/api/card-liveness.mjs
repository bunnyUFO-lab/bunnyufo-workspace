// Which cards the Library counts as active. The same rule as the app's `isArchived` (src/App.tsx) and
// `overlay()` / `archiveCutoff()` (src/lib/workspace.ts), which are TypeScript and cannot be imported here;
// api.test.mjs checks that ARCHIVE_DAYS still matches. Keep the three in step.
export const ARCHIVE_DAYS = 7;

/** `YYYY-MM-DD` a week before `now`: a card last touched before this is put away by date. */
export function archiveCutoff(now = new Date()) {
  const day = new Date(now);
  day.setDate(day.getDate() - ARCHIVE_DAYS);
  return day.toISOString().slice(0, 10);
}

/** A card as the page shows it: the published entity with the state overlay (pin, status, restore date) laid over it. */
function overlaid(entity, state) {
  if (!state) return entity;
  const merged = { ...entity };
  if (state.pinned === true) merged.pinned = true;
  if (state.pinned === false) delete merged.pinned;
  if (state.status) merged.status = state.status;
  if (state.restoredAt && (!merged.updated || state.restoredAt > merged.updated)) merged.updated = state.restoredAt;
  return merged;
}

/** True when the Library shows this card among the active ones (not archived by hand, and not archived by age). */
export function isLiveCard(entity, state, now = new Date()) {
  const card = overlaid(entity, state);
  if (card.status === 'archived') return false;
  if (card.pinned || card.sample) return true;
  const touched = String(card.updated ?? card.created ?? '');
  if (!touched) return true;   // no date at all: the app keeps it among the active ones
  return !(touched < archiveCutoff(now));
}
