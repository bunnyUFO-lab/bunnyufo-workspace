// Pictures Hermes makes come back inside a reply: as a markdown image holding a base64 data URL (a few MB of text), or as a raw
// `MEDIA:<path>` line naming a file in Hermes's own cache. Neither belongs in a stored chat line, a request report or the history
// sent back to Hermes, so each becomes a short note. Both are found by a single forward scan (no backtracking regex), so a hostile
// reply with thousands of openers still costs time proportional to its length.
export const IMAGE_NOTE = '[image made by Hermes, not kept here]';

const OPENER = '(data:image/';
const ALT_MAX = 200;
const isBase64 = code => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 47 || code === 61 || code === 32 || code === 9 || code === 10 || code === 13;
const isSubtype = code => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 46 || code === 45;
const MEDIA_LINE = /^\s*MEDIA:\S+\.(?:png|jpe?g|gif|webp|bmp)\s*$/i;

/** Where the `![alt]` that ends right before `at` (the `(`) starts, or `at` when there is none. Looks back 200 characters at most, on one line. */
function altStart(text, at) {
  if (text.charCodeAt(at - 1) !== 93) return at;   // ]
  const floor = Math.max(0, at - 2 - ALT_MAX - 1);
  for (let i = at - 2; i >= floor; i -= 1) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 93) return at;   // newline, or another ]
    if (code === 91) return i > 0 && text.charCodeAt(i - 1) === 33 ? i - 1 : at;   // [ preceded by !
  }
  return at;
}

function stripDataImages(text) {
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(OPENER, from);
    if (at < 0) break;
    let i = at + OPENER.length;
    const subtype = i;
    while (i < text.length && isSubtype(text.charCodeAt(i))) i += 1;
    if (i === subtype || !text.startsWith(';base64,', i)) { from = at + 1; continue; }
    i += 8;
    const data = i;
    while (i < text.length && isBase64(text.charCodeAt(i))) i += 1;
    if (i === data) { from = at + 1; continue; }
    let end = i;
    if (text.charCodeAt(i) === 41) end = i + 1;   // the closing )
    else while (end > data && /\s/.test(text[end - 1])) end -= 1;   // unclosed: strip the run, keep the whitespace after it
    const start = altStart(text, at);
    out += text.slice(copied, start) + IMAGE_NOTE;
    copied = end;
    from = Math.max(end, at + 1);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

function stripMediaLines(text) {
  if (!text.includes('MEDIA:')) return text;
  const lines = text.split('\n');
  let fenced = false;
  let changed = false;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    if (/^\s{0,3}(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && line.includes('MEDIA:') && MEDIA_LINE.test(line)) { lines[n] = IMAGE_NOTE + (line.endsWith('\r') ? '\r' : ''); changed = true; }
  }
  return changed ? lines.join('\n') : text;
}

export function stripInlineImages(text) {
  if (typeof text !== 'string' || !(text.includes('data:image') || text.includes('MEDIA:'))) return text;
  return stripMediaLines(stripDataImages(text));
}
