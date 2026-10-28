// The app's side of the card bridge: a card page is framed from another origin and holds no
// credential, so it asks the signed-in app to save for it, by postMessage. The app answers only
// the frame it is showing, from the origin that frame was loaded from, and only for that frame's
// own card: the workspace and card id are fixed here, never read from a message.
//
//   request  { type: 'buw:bridge', v: 1, id, op, ...fields }
//   reply    { type: 'buw:bridge', v: 1, id, ok: true, result }
//            { type: 'buw:bridge', v: 1, id, ok: false, status, error, current? }
//
// Operations: hello, responses.get, responses.set, markdown.get, markdown.save (docs/workspaces.md).

export const BRIDGE_TYPE = 'buw:bridge';
export const BRIDGE_OPS = ['responses.get', 'responses.set', 'markdown.get', 'markdown.save'];
const WRITES = new Set(['responses.set', 'markdown.save']);
const MAX_WRITES = 10;
const WINDOW_MS = 1000;
const SIGNED_OUT = 'Sign in to the Workspace to save this card.';

const reply = (id, body) => ({ type: BRIDGE_TYPE, v: 1, id, ...body });
const fail = (id, status, error, extra = {}) => reply(id, { ok: false, status, error, ...extra });

/** A message that has the shape of a bridge request. Anything else is not for the bridge and is ignored. */
export function isBridgeRequest(data) {
  return !!data && typeof data === 'object' && data.type === BRIDGE_TYPE && data.v === 1
    && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 32 && typeof data.op === 'string';
}

const query = fields => new URLSearchParams(fields).toString();

/**
 * @param card     { workspace, id }: the card the frame shows, the only one a request can reach
 * @param enabled  true when the app can save (or a function that says so now)
 * @param call     call(path, body?) → the answer of an /api route, or throws with .status and .answer
 * @param now      the clock, for tests
 * @returns handle(data) → the reply to send, or null for a message that is not a bridge request
 */
export function createBridgeHandler({ card, enabled, call, now = Date.now }) {
  const writes = [];
  const can = () => (typeof enabled === 'function' ? enabled() : enabled);

  const run = async (id, op, data) => {
    const text = key => (typeof data[key] === 'string' ? data[key] : null);
    const { workspace, id: cardId } = card;
    if (op === 'responses.get') {
      const doc = text('doc');
      if (!doc) return fail(id, 400, 'Say which doc to read.');
      return reply(id, { ok: true, result: await call(`/cards/responses?${query({ workspace, id: cardId, doc })}`) });
    }
    if (op === 'responses.set') {
      const doc = text('doc');
      if (!doc) return fail(id, 400, 'Say which doc to save.');
      if (!data.set || typeof data.set !== 'object' || Array.isArray(data.set)) return fail(id, 400, 'Say which items to set.');
      return reply(id, { ok: true, result: await call('/cards/responses', { workspace, id: cardId, doc, set: data.set }) });
    }
    const path = text('path');
    if (!path) return fail(id, 400, 'Say which section to use.');
    if (op === 'markdown.get') {
      return reply(id, { ok: true, result: await call(`/cards/markdown?${query({ workspace, id: cardId, path })}`) });
    }
    const body = text('text');
    if (body === null) return fail(id, 400, 'Say what the section should hold.');
    const base = data.base === undefined ? null : data.base;
    if (base !== null && typeof base !== 'string') return fail(id, 400, 'The base must be the etag you read, or null.');
    return reply(id, { ok: true, result: await call('/cards/markdown', { workspace, id: cardId, path, text: body, base }) });
  };

  async function handle(data) {
    if (!isBridgeRequest(data)) return null;
    const { id, op } = data;
    if (!can()) return fail(id, 401, SIGNED_OUT);
    if (op === 'hello') return reply(id, { ok: true, result: { section: card.workspace, card: card.id, ops: [...BRIDGE_OPS] } });
    if (!BRIDGE_OPS.includes(op)) return fail(id, 400, 'Unknown operation.');
    if (WRITES.has(op)) {
      const at = now();
      while (writes.length && at - writes[0] >= WINDOW_MS) writes.shift();
      if (writes.length >= MAX_WRITES) return fail(id, 429, 'Too many saves; wait a moment.');
      writes.push(at);
    }
    try {
      return await run(id, op, data);
    } catch (error) {
      const current = error?.answer?.current;
      return fail(id, Number.isInteger(error?.status) ? error.status : 0, String(error?.message || 'Could not save.'), current === undefined ? {} : { current });
    }
  }
  return { handle };
}

/**
 * Answer the bridge messages of one frame. A message counts only when it comes from that frame's own
 * window and from `origin`, the origin the frame was loaded from; the reply goes back to that window
 * with that origin as its target, never '*'. Returns the function that stops listening.
 */
export function attachCardBridge(frame, card, { origin, enabled, call, win = window, now }) {
  const handler = createBridgeHandler({ card, enabled, call, now });
  const onMessage = event => {
    const target = frame.contentWindow;
    if (!target || event.source !== target || event.origin !== origin) return;
    if (!isBridgeRequest(event.data)) return;
    void handler.handle(event.data).then(answer => {
      // The frame may have gone somewhere else while the call was out: the target origin then drops it.
      if (answer && frame.contentWindow === target) target.postMessage(answer, origin);
    });
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}
