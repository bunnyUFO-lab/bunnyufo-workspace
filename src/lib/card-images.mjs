// A card page can ask the app to show one of its own pictures in the app's viewer, and nothing else. The page
// is framed from another origin and holds no credential; the viewer, and everything it can start (Edit, Ask in
// chat, Copy), is the app's and needs a person's press there. The message names a file and never an action.
//
//   request  { type: 'buw:image', v: 1, id, src, all }   src: the picture's address; all: the page's pictures (at most 100)
//   reply    { type: 'buw:image', v: 1, id, ok: true | false }   ok: false: the page shows its own viewer
//
// Every other field is ignored. The app opens the address it builds itself (an app-origin address of a file in this
// card's folder), never the string in the message, and names the picture by its file name.

export const IMAGE_TYPE = 'buw:image';
const PICTURE = /\.(png|jpe?g|webp|gif|svg)$/i;
const MAX_ID = 32;
const MAX_SRC = 2048;
const MAX_ALL = 100;
const COOL_MS = 1000;
const MAX_OPENS = 10;
const WINDOW_MS = 60_000;

/** A message that has the shape of an image request. Anything else is not for this listener and is ignored without a reply. */
export function isImageRequest(data) {
  return !!data && typeof data === 'object' && data.type === IMAGE_TYPE && data.v === 1
    && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= MAX_ID
    && typeof data.src === 'string' && data.src.length <= MAX_SRC
    && Array.isArray(data.all) && data.all.length <= MAX_ALL && data.all.every(item => typeof item === 'string' && item.length <= MAX_SRC);
}

/**
 * The app-origin address of a picture the frame showed, or null when it is not a file of this card.
 * @param src         the address as the page gave it (absolute)
 * @param frameFolder the card folder as the frame loads it, with a trailing slash (the content host)
 * @param appFolder   the same folder on the app's own origin, with a trailing slash
 */
export function resolveFrameImage(src, frameFolder, appFolder) {
  let url;
  let folder;
  try { url = new URL(src); folder = new URL(frameFolder); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.origin !== folder.origin || !url.pathname.startsWith(folder.pathname)) return null;
  const parts = [];
  for (const raw of url.pathname.slice(folder.pathname.length).split('/')) {
    let part;
    try { part = decodeURIComponent(raw); } catch { return null; }
    if (part === '' || part === '.' || part === '..' || /[/\\\0]/.test(part)) return null;
    parts.push(part);
  }
  if (!parts.length || !PICTURE.test(parts[parts.length - 1])) return null;
  return appFolder + parts.map(encodeURIComponent).join('/');
}

const reply = (id, ok) => ({ type: IMAGE_TYPE, v: 1, id, ok });

/**
 * Answer the image requests of one frame. A message counts only when it comes from that frame's own window and from
 * `origin`, the origin the frame was loaded from; the reply goes back there, never to '*'. Returns the function that
 * stops listening.
 *
 * @param resolve    resolve(src) → the app address of a card file, or null
 * @param open       open({ url, urls }): show the viewer on `url`, with `urls` for Previous and Next (all built by `resolve`)
 * @param isOpen     true while a viewer is open
 * @param closedAt   the time the last viewer closed (ms), or 0
 * @param activated  true when the person pressed something just now (a script's click does not count)
 */
export function attachImageOpen(frame, { origin, resolve, open, isOpen, closedAt = () => 0, activated = () => globalThis.navigator?.userActivation?.isActive !== false, win = window, now = Date.now }) {
  const opens = [];
  const onMessage = event => {
    const target = frame.contentWindow;
    if (!target || event.source !== target || event.origin !== origin) return;
    if (!isImageRequest(event.data)) return;
    const { id, src, all } = event.data;
    const answer = ok => target.postMessage(reply(id, ok), origin);
    const at = now();
    while (opens.length && at - opens[0] >= WINDOW_MS) opens.shift();
    if (!activated() || isOpen() || at - closedAt() < COOL_MS || opens.length >= MAX_OPENS) return answer(false);
    const url = resolve(src);
    if (!url) return answer(false);
    const urls = [];
    for (const item of all) { const built = resolve(item); if (built && !urls.includes(built)) urls.push(built); }
    if (!urls.includes(url)) urls.push(url);
    opens.push(at);
    open({ url, urls });
    answer(true);
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}
