// Moving a card to another workspace. The ids and the folder never change, so every link keeps
// working; the card's files are copied (S3 CopyObject on the site, a file copy locally), checked,
// and only then does the card leave the old list. The old files are never deleted.
//
// Every step is safe to repeat, so a move that stopped half way is finished by asking again:
//   1 read both lists          2 list the card's files        3 copy what the target lacks
//   4 verify, re-list, re-copy 5 add the card to the target   6 retire it in the source
//   7 re-key the card's pins, tags and archive state
// `from` and `to` are cardWriters (see card-writes.mjs); their stores need list() and copyFrom().
import { slug } from './card-writes.mjs';
import { cardKey } from './card-state.mjs';

export const MAX_FILES = 300;
export const MAX_BYTES = 300 * 1024 * 1024;
const ROUNDS = 3;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const today = now => now().toISOString().slice(0, 10);
const multipart = etag => String(etag ?? '').includes('-');

/** True when a file in the target is the same as the one listed in the source. */
const same = (a, b) => a && b && a.size === b.size && (multipart(a.etag) || multipart(b.etag) || a.etag === b.etag);

export async function moveCard({ from, to, id, category, state, now = () => new Date() }) {
  if (!from || !to || from.section === to.section) throw fail('Say which other workspace to move the card to.');
  const [source, target] = await Promise.all([from.readList(), to.readList()]);
  if (target.list.archived === true || target.list.hidden === true) throw fail('That workspace does not take cards.', 409);
  const entity = source.list.entities.find(item => item?.id === id);
  const already = target.list.entities.find(item => item?.id === id);

  // An earlier move got as far as retiring the card: only the state may be left to do.
  if (!entity) {
    const record = source.list.retired?.[id];
    if (already && record?.kind === 'moved' && record.to === to.section) {
      const warning = await rekey(state, from, to, id);
      return { card: already, from: from.section, to: to.section, files: 0, ...(warning ? { warning } : {}) };
    }
    throw fail('No card with that id in this workspace.', 404);
  }
  if (!entity.folder) throw fail('That card has no folder to move.', 409);
  const chosen = typeof category === 'string' && category.trim() ? slug(category) || 'notes' : entity.category;

  const sameCard = already && already.folder === entity.folder;
  if (!sameCard) {
    const clash = target.list.entities.find(item => item?.id === id || item?.folder === entity.folder);
    if (clash) throw fail(`${target.list.name || to.section} already has a card called "${clash.title || clash.id}"; ids are not renamed to dodge it.`, 409);
  }

  let copied = 0;
  let card = already;
  if (!sameCard) {
    const prefixes = [`${entity.folder}/`, `card-responses/${id}/`];
    const listSource = async () => (await Promise.all(prefixes.map(prefix => from.store.list(prefix)))).flat();
    const listTarget = async () => (await Promise.all(prefixes.map(prefix => to.store.list(prefix)))).flat();

    let snapshot = await listSource();
    if (snapshot.length > MAX_FILES || snapshot.reduce((sum, item) => sum + item.size, 0) > MAX_BYTES) {
      throw fail(`This card is too big to move in one go (more than ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB).`, 413);
    }

    // The target may hold files already: a card that once lived here (moving back), or the part of
    // an earlier attempt. Anything else in those folders is someone else's.
    const there = await listTarget();
    const lived = target.list.retired?.[id]?.folder === entity.folder;
    if (there.length && !lived) {
      const bySource = new Map(snapshot.map(item => [item.file, item]));
      if (!there.every(item => same(item, bySource.get(item.file)))) {
        throw fail(`${target.list.name || to.section} already has files in that card's folder.`, 409);
      }
    }

    // Copy what the target lacks, check it, then look at the source again: a file written meanwhile
    // (an agent saving a page) is copied again, for up to three rounds.
    let settled = false;
    let dirty = null;
    for (let round = 1; round <= ROUNDS && !settled; round += 1) {
      const held = new Map((await listTarget()).map(item => [item.file, item]));
      for (const item of snapshot) {
        if (dirty ? !dirty.has(item.file) : same(held.get(item.file), item)) continue;
        await to.store.copyFrom(from.store, item.file);
        copied += 1;
      }
      const after = new Map((await listTarget()).map(item => [item.file, item]));
      const bad = snapshot.filter(item => !same(after.get(item.file), item)).map(item => item.file);
      const was = new Map(snapshot.map(item => [item.file, item]));
      const latest = await listSource();
      const moved = latest.filter(item => was.get(item.file)?.etag !== item.etag || was.get(item.file)?.size !== item.size).map(item => item.file);
      dirty = new Set([...bad, ...moved]);
      snapshot = latest;
      settled = dirty.size === 0;
    }
    if (!settled) throw fail('The card changed while it was moving; try again.', 409);

    const { id: _keep, ...rest } = entity;
    card = { id, ...rest, ...(chosen ? { category: chosen } : {}), updated: today(now) };
    try {
      await to.adoptCard({ entity: card });
    } catch (error) {
      throw Object.assign(error, { step: 5 });
    }
  } else if (chosen && chosen !== already.category) {
    // Retry of a move that also asked for a new category: the target copy gets it too.
    await to.updateCard({ id, category: chosen });
    card = { ...already, category: chosen };
  }

  try {
    await from.retireMoved({ id, to: to.section, folder: entity.folder });
  } catch (error) {
    throw Object.assign(new Error(`The card was copied to ${target.list.name || to.section} but not yet taken off ${source.list.name || from.section} (${error.message}); press Move again.`), { status: error.status && error.status !== 412 ? error.status : 409, step: 6 });
  }
  const warning = await rekey(state, from, to, id);
  return { card, from: from.section, to: to.section, files: copied, ...(warning ? { warning } : {}) };
}

/** Move the card's pins, tags and archive state to its new workspace. A failure is a warning: they can be redone. */
async function rekey(state, from, to, id) {
  if (!state?.rekey) return null;
  try {
    await state.rekey(cardKey(from.section, id), cardKey(to.section, id));
    return null;
  } catch (error) {
    return `The card moved, but its pins and tags were not carried over (${error.message}).`;
  }
}
