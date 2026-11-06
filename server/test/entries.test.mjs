// The history rules of src/lib/entries.ts against a stand-in browser: a list of entries, a position, hashchange on every move.
// The hooks (useEntryMemo, useOverlayEntry) need React and are covered in the browser test shell-back-ui.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const listeners = new Map();
const entries = [{ url: 'http://app.test/#/~hub/today', state: null }];
let at = 0;
const store = new Map();
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const fire = type => { for (const fn of [...(listeners.get(type) ?? [])]) fn(new Event(type)); };
const arrive = index => { at = index; queueMicrotask(() => fire('hashchange')); };

globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== fn)),
  dispatchEvent: event => fire(event.type),
  setTimeout, clearTimeout,
  location: {
    get hash() { return new URL(entries[at].url).hash; },
    set hash(value) {
      const url = new URL(entries[at].url);
      url.hash = value;
      if (url.href === entries[at].url) return;
      entries.splice(at + 1);
      entries.push({ url: url.href, state: null });
      arrive(entries.length - 1);
    },
    get pathname() { return new URL(entries[at].url).pathname; },
    get search() { return new URL(entries[at].url).search; },
  },
  history: {
    scrollRestoration: 'auto',
    get state() { return entries[at].state; },
    replaceState(state, _title, url) { entries[at] = { url: url ? new URL(url, entries[at].url).href : entries[at].url, state }; },
    back() { if (at > 0) arrive(at - 1); },
  },
};

const entry = await import('../../src/lib/entries.ts');
const here = () => window.location.hash;

test('install stamps the first entry and turns scroll restoration off', () => {
  entry.installEntries();
  assert.equal(window.history.scrollRestoration, 'manual');
  assert.ok(entries[0].state.hubEntry >= 1);
  assert.equal(entry.hasBehind(), false);
});

test('go adds one entry, and the same address adds none', async () => {
  entry.go('#/~hub/work');
  await tick();
  assert.equal(entries.length, 2);
  assert.equal(here(), '#/~hub/work');
  assert.ok(entries[1].state.hubEntry > entries[0].state.hubEntry, 'A new entry is stamped with a larger serial.');
  entry.go('#/~hub/work');
  await tick();
  assert.equal(entries.length, 2);
});

test('swap changes the address in place, keeps the serial and tells the route listeners', async () => {
  const seen = [];
  window.addEventListener(entry.ROUTE_EVENT, () => seen.push(here()));
  const serial = entries[at].state.hubEntry;
  entry.swap('#/~hub/jobs');
  assert.equal(entries.length, 2);
  assert.equal(here(), '#/~hub/jobs');
  assert.equal(entries[at].state.hubEntry, serial);
  assert.deepEqual(seen, ['#/~hub/jobs']);
  entry.swap('#/~hub/activity', undefined, false);
  assert.deepEqual(seen, ['#/~hub/jobs'], 'A quiet swap tells nobody.');
  entry.swap('#/~hub/activity', '/section');
  assert.equal(window.location.pathname, '/section');
});

test('in-app Back is one browser step when something of ours is behind, and the parent when not', async () => {
  assert.equal(entry.hasBehind(), true);
  entry.back('#/~hub/library');
  await tick();
  assert.equal(at, 0);
  assert.equal(here(), '#/~hub/today');
  assert.equal(entry.direction(), 'back');
  assert.equal(entry.hasBehind(), false);
  entry.back('#/~hub/library');
  await tick();
  assert.equal(here(), '#/~hub/library', 'Nothing behind: it goes to the parent screen.');
  assert.equal(entry.direction(), 'fwd');
  assert.equal(entries.length, 2, 'The parent replaced what was ahead: a new entry, never a way out of the app.');
});

test('a gone target is skipped: back keeps going back, otherwise it is replaced by the parent', async () => {
  entry.go('#/~hub/chat/gone');
  await tick();
  const length = entries.length;
  entry.skipGone('#/~hub/chat');
  assert.equal(here(), '#/~hub/chat');
  assert.equal(entries.length, length, 'Replaced in place, no new entry.');
  entry.go('#/~hub/chat/other');
  await tick();
  entry.back('#/~hub/chat');
  await tick();
  assert.equal(entry.direction(), 'back');
  entry.skipGone('#/~hub/chat');
  await tick();
  assert.equal(here(), '#/~hub/library', 'Going back, a gone entry is stepped over.');
});

test('a sheet is a /~o tail, and its action takes it off first', async () => {
  assert.equal(entry.overlayDepth('#/~hub/work'), 0);
  assert.equal(entry.overlayDepth('#/~hub/work/~o'), 1);
  assert.equal(entry.overlayDepth('#/~hub/work/~o/~o'), 2);
  assert.equal(entry.withoutOverlay('#/~hub/work/~o/~o'), '#/~hub/work');
  entry.go('#/~hub/work');
  await tick();
  entry.go('#/~hub/work/~o');
  await tick();
  const before = entries.length;
  let ran = 0;
  let during = '';
  entry.afterPop(() => { ran++; during = here(); });
  await tick();
  assert.equal(ran, 1);
  assert.equal(during, '#/~hub/work', 'The action ran once the sheet entry was gone.');
  assert.equal(entries.length, before, 'The sheet entry is behind us, not removed from the list; Back cannot reach it from here.');
  entry.afterPop(() => { ran++; });
  assert.equal(ran, 2, 'With no sheet open the action runs at once.');
});

test('no source file calls pushState outside lib/entries', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
  const bad = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) { walk(file); continue; }
      if (!/\.(ts|tsx)$/.test(name) || file.endsWith(`${path.sep}entries.ts`)) continue;
      const text = readFileSync(file, 'utf8');
      if (/history\.pushState\(/.test(text)) bad.push(`${path.relative(root, file)}: pushState`);
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
});
