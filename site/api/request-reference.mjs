// The picture a job can carry as its reference (from a picture on a card). The owner attaches it in the Spawn sheet; the site checks the
// bytes, stores a snapshot beside request.json (`requests/<id>/reference.jpg|png`, written first and create-only) and records a block in
// request.json: { file, sha256, width, height, source }. `request.json` is signed whole (requestSha256), so the block binds the picture's hash.
// `checkRequest` drops a `reference`, so an agent's `cards request create` can never set one; only the site's own POST does.
import { createHash } from 'node:crypto';
import { checkOneImage } from './chat-images.mjs';
import { CARD_RE, REFERENCE_FILE_RE, SECTION_ID_RE, validCardFile } from './presets.mjs';

export const REFERENCE_TITLE_MAX = 120;

const oneLine = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** The card the picture came from, checked: ids and a path inside the card, and a title on one line (the title is for the page, never for the brief). */
function checkSource(source, fail) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw fail('Say which card the reference picture came from.');
  const { section, card, file } = source;
  if (typeof section !== 'string' || !SECTION_ID_RE.test(section)) throw fail('The reference picture names no valid section.');
  if (typeof card !== 'string' || !CARD_RE.test(card)) throw fail('The reference picture names no valid card.');
  if (!validCardFile(file)) throw fail('The reference picture names no valid file of the card.');
  const title = oneLine(source.title);
  if (!title || title.length > REFERENCE_TITLE_MAX) throw fail(`The reference title is 1 to ${REFERENCE_TITLE_MAX} characters.`);
  return { section, card, file, title };
}

/**
 * `reference: { type, data, source }` from the site's POST: the picture (JPEG or PNG, the rules of a chat picture, metadata stripped)
 * and its source. → `{ picture: { buffer, ext, type, width, height }, block }` with the block the server stores.
 */
export function checkReference(input, fail) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('The reference is { type, data, source }.');
  const source = checkSource(input.source, fail);
  const picture = checkOneImage({ type: input.type, data: input.data }, fail);
  const file = `reference.${picture.ext}`;
  return {
    picture,
    block: { file, sha256: createHash('sha256').update(picture.buffer).digest('hex'), width: picture.width, height: picture.height, source },
  };
}

/** The block of a stored request.json, when it has the shape the server writes; otherwise null (it is never trusted as it stands). */
export function storedReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { file, sha256, width, height, source } = value;
  if (typeof file !== 'string' || !REFERENCE_FILE_RE.test(file) || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  if (!source || typeof source !== 'object') return null;
  const ok = typeof source.section === 'string' && SECTION_ID_RE.test(source.section) && typeof source.card === 'string' && CARD_RE.test(source.card) && validCardFile(source.file);
  const title = oneLine(source.title);
  if (!ok || !title || title.length > REFERENCE_TITLE_MAX) return null;
  return { file, sha256, width, height, source: { section: source.section, card: source.card, file: source.file, title } };
}
