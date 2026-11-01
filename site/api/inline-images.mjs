// Pictures Hermes makes come back inside a reply: as a markdown image holding a base64 data URL (a few MB of text), or as a raw
// `MEDIA:<path>` tag on a file in Hermes's own cache. Neither belongs in a stored chat line, a request report or the history sent
// back to Hermes, so each becomes a short note. Both patterns are linear: the base64 class has no nested quantifier.
export const IMAGE_NOTE = '[image made by Hermes, not kept here]';

const DATA_IMAGE = /!\[[^\]]*\]\(data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=\s]+\)/gi;
const MEDIA_TAG = /MEDIA:\S+\.(?:png|jpe?g|gif|webp|bmp)/gi;

export function stripInlineImages(text) {
  if (typeof text !== 'string' || !(text.includes('data:image') || text.includes('MEDIA:'))) return text;
  return text.replace(DATA_IMAGE, IMAGE_NOTE).replace(MEDIA_TAG, IMAGE_NOTE);
}
