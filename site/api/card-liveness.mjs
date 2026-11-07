// The one rule for which cards the Library counts as active, and the state overlay it reads.
//
// Three places used to hold copies of this: the app's model, its workspace loader and the site's API.
// This file has no imports, so all of them read it: the services import it from here (site/api is
// rsynced to the server alone, so it cannot reach `src`), and the app imports it from `src/lib`,
// the way it imports server/report-theme.mjs. The Dockerfile's `ui` stage copies it for that reason.

export const ARCHIVE_DAYS = 7;

/** What a card can say it is for. No purpose is normal and means the card stays. */
export const PURPOSES = ['report', 'reference'];

/** `YYYY-MM-DD` a week before `now`: a card last touched before this is put away by date. */
export function archiveCutoff(now = new Date()) {
  const day = new Date(now);
  day.setDate(day.getDate() - ARCHIVE_DAYS);
  return day.toISOString().slice(0, 10);
}

/**
 * Overlay one card's stored state onto the entity the workspace published.
 *
 * The file is the default and the store is the override, so a card that an agent shipped
 * `pinned: true` stays pinned until someone says otherwise in the state, and so does a `purpose`.
 */
export function applyCardState(entity, state) {
  if (!state) return entity;
  const merged = { ...entity };
  if (state.pinned === true) merged.pinned = true;
  if (state.pinned === false) { delete merged.pinned; delete merged.pinOrder; }
  if (state.pinned !== false && typeof state.pinOrder === 'number') merged.pinOrder = state.pinOrder;
  if (state.status) merged.status = state.status;
  if (Array.isArray(state.tags)) merged.tags = state.tags.filter(tag => typeof tag === 'string');
  // A chosen icon wins over the card's own image and its category's emoji.
  if (typeof state.emoji === 'string' && state.emoji) merged.emoji = state.emoji;
  // The owner's choice from the row menu beats whatever a writer put in the entry.
  if (PURPOSES.includes(state.purpose)) merged.purpose = state.purpose;
  // Restoring a card counts as a touch: without a fresh date the 7-day rule would put it straight
  // back in the archive. It never moves the date backwards, so a later real edit still wins.
  if (state.restoredAt && (!merged.updated || state.restoredAt > merged.updated)) merged.updated = state.restoredAt;
  return merged;
}

/**
 * True when a card (already overlaid) is in the Archive. The first match decides:
 * archived by hand; kept (pinned, sample, reference); not a report or done; no date; then the date.
 */
export function isArchivedCard(card, now = new Date()) {
  if (card.status === 'archived') return true;
  if (card.pinned || card.sample || card.purpose === 'reference') return false;
  if (!(card.purpose === 'report' || card.status === 'done')) return false;
  const touched = String(card.updated ?? card.created ?? '');
  if (!touched) return false;   // no date at all: the app keeps it among the active ones
  return touched < archiveCutoff(now);
}

/** True when the Library shows this card among the active ones. */
export function isLiveCard(entity, state, now = new Date()) {
  return !isArchivedCard(applyCardState(entity, state), now);
}
