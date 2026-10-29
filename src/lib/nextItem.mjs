// Which item the owner meets after settling one, and where it lives. Plain JavaScript with no imports,
// so a node test can load it; nextItem.d.mts types it for the app. The hash shapes mirror src/lib/route.ts.

/** What the note says after each action that removes an item from the queue. */
export const NOTE_VERB = {
  answered: 'Answered',
  snoozed: 'Snoozed',
  submitted: 'Submitted',
  done: 'Marked done',
  cancelled: 'Cancelled',
  reviewed: 'Review sent',
  reported: 'Report sent',
};

/** The key of an item in the queue: the kind and the id. */
export const itemKey = item => `${item.kind}-${item.id}`;

/**
 * The next item after `settledKey`: the one that came after it in `previousKeys` (the order the owner was
 * looking at, before the action) and is still in `items`; when it was the last, the first item left. Never the
 * settled item itself, even if `items` still holds it. Null when nothing else is left.
 */
export function pickNext(items, settledKey, previousKeys = []) {
  const remaining = items.filter(item => item && itemKey(item) !== settledKey);
  if (!remaining.length) return null;
  const at = previousKeys.indexOf(settledKey);
  if (at >= 0) {
    for (const key of previousKeys.slice(at + 1)) {
      const found = remaining.find(item => itemKey(item) === key);
      if (found) return found;
    }
  }
  return remaining[0];
}

/** Where an item opens: its own page, or for a session that has none the Unstick chip with the card in focus. */
export function itemLink(item) {
  const id = encodeURIComponent(item.id);
  if (item.kind === 'ask') return { hash: `#/~hub/ask/${id}` };
  if (item.kind === 'checklist') return { hash: `#/~hub/checklist/${id}` };
  if (item.kind === 'review') return { hash: `#/~hub/review/${id}` };
  return { hash: '#/~hub/needs/unstick', focus: itemKey(item) };
}
