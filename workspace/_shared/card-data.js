/* Shared card data: lets a card page save what the viewer enters (ratings, sentences) and read it back.
   No dependencies. Load it from a card page and call BuwCardData.open({ doc: 'name' }).

     const store = await BuwCardData.open({ doc: 'listen-v2' });
     store.get(id) / store.all() / store.set(id, data | null) / store.on('status', fn)
     store.mode          'server' | 'local'
     store.exportJson()  download the whole doc
     store.signIn()      try the Workspace again (no passphrase, no prompt)
     BuwCardData.bridge.call(op, fields)   the same channel for a card's Markdown answer (see below)

   A card page holds no credential and never calls /api. The Workspace app shows the card in a frame and
   saves for it: this script sends the app a message, the app checks it came from that frame and answers
   for that one card only. Messages are { type: 'buw:bridge', v: 1, id, op, ...fields } and are answered with
   { type: 'buw:bridge', v: 1, id, ok: true, result } or { ..., ok: false, status, error, current? }.
     hello                                  -> { section, card, ops }
     responses.get   { doc }                -> { doc, etag }           (doc is null before the first save)
     responses.set   { doc, set }           -> { doc, etag }           (set: item id -> { updated, data } | null)
     markdown.get    { path }               -> { text, etag }
     markdown.save   { path, text, base }   -> { text, etag }          (a stale base rejects with status 409 and `current`)
   `path` must be one of the card's Markdown steps in workspace.json.
   The hello goes to window.parent with target '*' and carries no data; it is resent every 250 ms for 1.5 s,
   as the app may attach a moment after this script runs. The first parent window that answers it pins
   appOrigin; every later request goes to that origin only, and every later reply must come from that
   window and origin.

   Without a parent that answers (the card opened in its own tab, or the app signed out) the store is local:
   items are kept in this browser's localStorage, mode is 'local', store.message says why, and exportJson
   still works. Items that never reached the server are pushed on the next connect.
   The server merges a save item by item, so this page sends only the items that changed.
   The card and section come from the hello answer; nothing the page says can pick another card.
   Status values: 'saved' | 'saving' | 'offline' | 'error' (store.message says why). */
(() => {
  if (window.BuwCardData) return;
  const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
  const TYPE = 'buw:bridge';
  const DEBOUNCE = 800;
  const BATCH = 200;
  const RETRY = 15000;
  const RATE_RETRY = 2000;
  const HELLO_EVERY = 250;
  const HELLO_WAIT = 1500;
  const CALL_WAIT = 15000;
  const NO_BRIDGE = 'Open this card inside the Workspace, signed in, to save it.';

  // An old page may still hold a passphrase from the card API days. A card never uses one now.
  try { localStorage.removeItem('buw.cardApiPassphrase'); } catch { /* blocked storage */ }

  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const fail = (message, status, extra) => Object.assign(new Error(message), { status }, extra);

  async function resolveCard(section, folder) {
    const response = await fetch(`/w/${encodeURIComponent(section)}/workspace.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = await response.json();
    const entity = (list.entities || []).find(item => item.folder === folder || item.id === folder);
    if (!entity) throw new Error(`No card with folder "${folder}" in section "${section}".`);
    return entity.id;
  }

  // ---- the bridge to the app ----
  let appOrigin = null;
  let helloing = null;
  const pending = new Map();   // request id -> { resolve, reject, timer, hello }
  const makeId = () => { let id = ''; while (id.length < 12) id += Math.floor(Math.random() * 36).toString(36); return id; };

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== TYPE || data.v !== 1 || typeof data.id !== 'string') return;
    const wait = pending.get(data.id);
    if (!wait || event.source !== window.parent) return;
    if (!wait.hello && event.origin !== appOrigin) return;
    pending.delete(data.id);
    clearTimeout(wait.timer);
    if (wait.hello) {
      if (data.ok === true && data.result) { appOrigin = event.origin; wait.resolve({ result: data.result }); }
      else wait.resolve({ result: null, error: typeof data.error === 'string' ? data.error : NO_BRIDGE, status: data.status });
    } else if (data.ok === true) wait.resolve(data.result);
    else wait.reject(fail(typeof data.error === 'string' ? data.error : 'The Workspace could not save.', Number.isInteger(data.status) ? data.status : 0, data.current === undefined ? {} : { current: data.current }));
  });

  /** Ask the parent window once: { result } when the app answered ok, else { result: null, error? }. */
  function hello(again) {
    if (helloing && !again) return helloing;
    helloing = new Promise(resolve => {
      if (window.parent === window) return resolve({ result: null });
      const id = makeId();
      const started = Date.now();
      const send = () => {
        if (!pending.has(id)) return;
        if (Date.now() - started >= HELLO_WAIT) { pending.delete(id); return resolve({ result: null }); }
        try { window.parent.postMessage({ type: TYPE, v: 1, id, op: 'hello' }, '*'); } catch { /* no parent to ask */ }
        const wait = pending.get(id);   // a parent that answers at once has already settled it
        if (wait) wait.timer = setTimeout(send, HELLO_EVERY);
      };
      pending.set(id, { resolve, hello: true, timer: null });
      send();
    });
    return helloing;
  }

  async function call(op, fields) {
    const greeting = await hello();
    if (!greeting.result) throw fail(greeting.error || NO_BRIDGE, greeting.status || 0);
    return new Promise((resolve, reject) => {
      const id = makeId();
      const timer = setTimeout(() => { pending.delete(id); reject(fail('The Workspace did not answer.', 0)); }, CALL_WAIT);
      pending.set(id, { resolve, reject, timer });
      try { window.parent.postMessage({ ...fields, type: TYPE, v: 1, id, op }, appOrigin); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(fail(error.message || 'Could not reach the Workspace.', 0)); }
    });
  }

  async function open({ doc, section, card } = {}) {
    if (!ID.test(doc || '')) throw new Error('BuwCardData.open needs a doc id such as "listen-v2".');
    const greeting = await hello();
    let bridged = Boolean(greeting.result);
    let localNote = greeting.error || NO_BRIDGE;

    const root = document.documentElement;
    const place = /^\/w\/([^/]+)\/([^/]+)\//.exec(location.pathname);
    const folder = place ? decodeURIComponent(place[2]) : '';
    let cardId;
    if (bridged) {
      // The app says which card this is. The page's own attributes and options cannot pick another.
      section = greeting.result.section;
      cardId = greeting.result.card;
    } else {
      // Only to name the localStorage key.
      section = section || root.getAttribute('data-buw-section') || (place && decodeURIComponent(place[1])) || '';
      cardId = card || root.getAttribute('data-buw-card') || '';
      if (!cardId && section && folder) { try { cardId = await resolveCard(section, folder); } catch { /* the folder names it below */ } }
      cardId = cardId || folder || 'card';
    }
    const storageSection = section || 'local';

    const storageKey = `buw-card-data:${storageSection}/${cardId}/${doc}`;
    const items = new Map();        // id -> { updated, data }
    const dirty = new Set();        // ids whose latest value has not reached the server
    const listeners = new Set();
    let mode = 'local';
    let status = 'saved';
    let message = '';
    let timer = null;
    let retryTimer = null;
    let saving = null;

    const emit = (next, text = '') => {
      status = next;
      message = text;
      for (const fn of listeners) { try { fn(status, message); } catch { /* A listener's mistake is its own. */ } }
    };
    const mirror = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ items: Object.fromEntries(items), dirty: [...dirty] }));
      } catch { /* Storage blocked or full: the server copy still counts. */ }
    };

    try {
      const saved = JSON.parse(read(storageKey) || 'null');
      for (const [id, entry] of Object.entries(saved?.items || {})) items.set(id, entry);
      for (const id of saved?.dirty || []) dirty.add(id);
    } catch { /* Nothing stored, or not readable. */ }

    /** Take the server's copy of every item that is not waiting to be saved. */
    const adopt = theirs => {
      for (const [id, entry] of Object.entries(theirs)) if (!dirty.has(id)) items.set(id, entry);
      // Held locally, gone from the server (deleted elsewhere), and not waiting to be saved.
      for (const id of [...items.keys()]) if (!dirty.has(id) && !(id in theirs)) items.delete(id);
    };

    const retryLater = ms => { clearTimeout(retryTimer); retryTimer = setTimeout(() => (mode === 'server' ? flush() : connect()), ms); };
    const failure = error => {
      const code = error?.status ?? 0;
      if (code === 401 || code === 403) return emit('error', error.message || 'Sign in to the Workspace to save this card.');
      if (code === 429) { retryLater(RATE_RETRY); return emit('saving'); }
      retryLater(RETRY);
      if (code === 0) return emit('offline', 'Offline: saved in this browser.');
      return emit('error', error.message || 'Could not save.');
    };

    async function flush() {
      clearTimeout(timer);
      timer = null;
      if (saving) return saving;
      if (mode !== 'server' || !dirty.size) return;
      saving = (async () => {
        try {
          while (dirty.size) {
            emit('saving');
            const ids = [...dirty].slice(0, BATCH);
            const sent = Object.fromEntries(ids.map(id => [id, items.has(id) ? items.get(id) : null]));
            const answer = await call('responses.set', { doc, set: sent });
            for (const id of ids) {
              // Changed again while the request was out: it stays dirty for the next round.
              const now = items.has(id) ? items.get(id) : null;
              if (JSON.stringify(now) === JSON.stringify(sent[id])) dirty.delete(id);
            }
            adopt(answer?.doc?.items || {});
            mirror();
          }
          emit('saved');
        } catch (error) {
          failure(error);
        } finally {
          saving = null;
        }
      })();
      return saving;
    }

    /** Ask the app for the saved copy: on success mode becomes 'server', it is merged in and pending items are pushed. */
    async function connect() {
      if (!bridged) return emit('saved', localNote);
      try {
        const answer = await call('responses.get', { doc });
        adopt(answer?.doc?.items || {});
        mode = 'server';
        mirror();
        if (dirty.size) await flush(); else emit('saved');
      } catch (error) {
        mode = 'local';
        failure(error);
      }
    }

    await connect();

    const store = {
      get mode() { return mode; },
      get status() { return status; },
      get message() { return message; },
      get needsSignIn() { return false; },   // kept for old pages: there is no passphrase to ask for
      section: storageSection, card: cardId, doc,
      get: id => items.get(id)?.data,
      all: () => Object.fromEntries([...items].map(([id, entry]) => [id, entry.data])),
      set(id, data) {
        if (!ID.test(id || '')) throw new Error(`"${id}" is not a valid item id.`);
        if (data === null || data === undefined) items.delete(id);
        else items.set(id, { updated: new Date().toISOString(), data });
        dirty.add(id);                        // local mode keeps the list too: connect() pushes it later
        mirror();
        if (mode !== 'server') return emit(status === 'error' ? 'error' : 'saved', message);
        emit('saving');
        clearTimeout(timer);
        timer = setTimeout(flush, DEBOUNCE);
      },
      on(event, fn) {
        if (event === 'status') { listeners.add(fn); fn(status, message); }
        return () => listeners.delete(fn);
      },
      /** Try the Workspace again. There is no passphrase and no prompt. Returns the mode. */
      async signIn() {
        if (window.parent === window) { emit(status, NO_BRIDGE); return mode; }
        const again = await hello(!bridged);
        if (again.result) bridged = true;
        localNote = again.error || NO_BRIDGE;
        await connect();
        return mode;
      },
      flush,
      document() {
        return { version: 1, section: storageSection, card: cardId, doc, updated: new Date().toISOString(), items: Object.fromEntries(items) };
      },
      exportJson() {
        const blob = new Blob([`${JSON.stringify(store.document(), null, 2)}\n`], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${cardId}-${doc}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      },
    };

    window.addEventListener('online', () => { if (dirty.size) { if (mode === 'server') flush(); else connect(); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && mode === 'server' && dirty.size) flush(); });
    return store;
  }

  window.BuwCardData = {
    open,
    bridge: {
      get ready() { return hello().then(greeting => greeting.result); },
      call,
    },
  };
})();
