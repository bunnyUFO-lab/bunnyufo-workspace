/* Shared card data: lets a card page save what the viewer enters (ratings, sentences) and read it back.
   No dependencies. Load it from a card page and call BuwCardData.open({ doc: 'name' }).

     const store = await BuwCardData.open({ doc: 'listen-v2' });
     store.get(id) / store.all() / store.set(id, data | null) / store.on('status', fn)
     store.mode          'server' | 'local'
     store.exportJson()  download the whole doc
     store.signIn()      ask for the card API passphrase (window.prompt), keep it in this browser, connect

   Saved through the card API's file routes, as one whole file per doc:
     GET/PUT  <api>/sections/<section>/files/card-responses/<card>/<doc>.json   (Authorization: Bearer <passphrase>)
   The key sits at the section root, outside every card folder, so `npm run publish` leaves it alone.
   <api> comes from open({ api }), else <html data-buw-card-api="...">, else the "cardApi" that the site's
   own GET /api/capabilities answers (same origin). With none of them the page stays in local mode, as it
   does without a passphrase. The passphrase is read from open({ passphrase }) or localStorage "buw.cardApiPassphrase".
   Without a passphrase, or when the API cannot be reached (offline, no CORS here, the local service's
   sandboxed origin), it falls back to localStorage and mode is 'local'. Every change is mirrored to
   localStorage as well; items that never reached the server are pushed on the next connect.
   A save is read-merge-write: GET the latest file, apply this page's pending items (null deletes), PUT.
   Two browsers saving at the same instant can drop one write; this is a single-user store.
   The card id comes from <html data-buw-card="...">, else from the folder in the section's workspace.json.
   Status values: 'saved' | 'saving' | 'offline' | 'error' (store.message says why). */
(() => {
  if (window.BuwCardData) return;
  const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
  const PASS_KEY = 'buw.cardApiPassphrase';
  const DEBOUNCE = 800;
  const BATCH = 200;
  const RETRY = 15000;
  const MAX_DOC = 4 * 1024 * 1024; // the card API's inline limit

  class AuthError extends Error {}

  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };

  async function resolveCard(section, folder) {
    const response = await fetch(`/w/${encodeURIComponent(section)}/workspace.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = await response.json();
    const entity = (list.entities || []).find(item => item.folder === folder || item.id === folder);
    if (!entity) throw new Error(`No card with folder "${folder}" in section "${section}".`);
    return entity.id;
  }

  /** The card API the hosting site names in /api/capabilities, or '' (no site API here, or none set). */
  async function siteCardApi() {
    try {
      const response = await fetch('/api/capabilities', { cache: 'no-store' });
      if (!response.ok) return '';
      const value = (await response.json()).cardApi;
      return typeof value === 'string' && /^https?:\/\//.test(value) ? value : '';
    } catch { return ''; }
  }

  async function open({ doc, section, card, api, passphrase } = {}) {
    if (!ID.test(doc || '')) throw new Error('BuwCardData.open needs a doc id such as "listen-v2".');
    const root = document.documentElement;
    const place = /^\/w\/([^/]+)\/([^/]+)\//.exec(location.pathname);
    section = section || root.getAttribute('data-buw-section') || (place && decodeURIComponent(place[1])) || '';
    const folder = place ? decodeURIComponent(place[2]) : '';
    let cardId = card || root.getAttribute('data-buw-card') || '';
    if (!cardId && section && folder) { try { cardId = await resolveCard(section, folder); } catch { /* local mode below */ } }
    const apiBase = String(api || root.getAttribute('data-buw-card-api') || await siteCardApi()).replace(/\/+$/, '');
    const canServe = Boolean(section && cardId && apiBase);
    const storageSection = section || 'local';
    cardId = cardId || folder || 'card';

    const fileUrl = `${apiBase}/sections/${encodeURIComponent(section)}/files/card-responses/${encodeURIComponent(cardId)}/${encodeURIComponent(doc)}.json`;
    const storageKey = `buw-card-data:${storageSection}/${cardId}/${doc}`;
    const items = new Map();        // id -> { updated, data }
    const dirty = new Set();        // ids whose latest value has not reached the server
    const listeners = new Set();
    let mode = 'local';
    let token = passphrase || read(PASS_KEY) || '';
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

    /** The doc on the server, or null when there is none yet. */
    async function fetchDoc() {
      const response = await fetch(fileUrl, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) throw new AuthError();
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      try { return await response.json(); } catch { throw new Error('The saved file is not valid JSON.'); }
    }

    async function putDoc(body) {
      const text = JSON.stringify(body);
      if (text.length > MAX_DOC) throw new Error('Too many ratings for one file (over 4 MB).');
      const response = await fetch(fileUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: text });
      if (response.status === 401 || response.status === 403) throw new AuthError();
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).error || ''; } catch { /* no body */ }
        throw new Error(detail || `HTTP ${response.status}`);
      }
    }

    const failure = error => {
      if (error instanceof AuthError) return emit('error', 'Sign in again: the card API did not accept the passphrase.');
      if (error instanceof TypeError) return emit('offline', 'Offline: saved in this browser.');
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
            const remote = await fetchDoc();
            const merged = { ...(remote?.items || {}) };
            for (const id of ids) { if (sent[id]) merged[id] = sent[id]; else delete merged[id]; }
            await putDoc({ version: 1, section, card: cardId, doc, updated: new Date().toISOString(), items: merged });
            for (const id of ids) {
              // Changed again while the request was out: it stays dirty for the next round.
              const now = items.has(id) ? items.get(id) : null;
              if (JSON.stringify(now) === JSON.stringify(sent[id])) dirty.delete(id);
            }
            mirror();
          }
          emit('saved');
        } catch (error) {
          failure(error);
          if (!(error instanceof AuthError)) { clearTimeout(retryTimer); retryTimer = setTimeout(flush, RETRY); }
        } finally {
          saving = null;
        }
      })();
      return saving;
    }

    /** Try the API: on success mode becomes 'server', the server copy is merged in and pending items are pushed. */
    async function connect() {
      if (!canServe) return emit('saved');
      if (!token) return emit('saved', 'Saved in this browser only. Sign in to save to the workspace.');
      try {
        const remote = await fetchDoc();
        const theirs = remote?.items || {};
        for (const [id, entry] of Object.entries(theirs)) if (!dirty.has(id)) items.set(id, entry);
        // Held locally, gone from the server (deleted elsewhere), and not waiting to be saved.
        for (const id of [...items.keys()]) if (!dirty.has(id) && !(id in theirs)) items.delete(id);
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
      get needsSignIn() { return canServe && !token; },
      section, card: cardId, doc,
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
      /** Ask for the passphrase, keep it in this browser, and connect. Returns the new mode. */
      async signIn(value) {
        const typed = value ?? window.prompt('Workspace card API passphrase');
        if (!typed) return mode;
        token = typed.trim();
        try { localStorage.setItem(PASS_KEY, token); } catch { /* not kept */ }
        await connect();
        if (mode !== 'server' && status === 'error') { token = ''; try { localStorage.removeItem(PASS_KEY); } catch { /* ignore */ } }
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

  window.BuwCardData = { open };
})();
