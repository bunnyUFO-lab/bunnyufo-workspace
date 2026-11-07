// A card page may ask the app to open its picture viewer on one of the card's own files, and nothing else (src/lib/card-images.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachImageOpen, resolveFrameImage } from '../../src/lib/card-images.mjs';

const FRAME = 'http://cards.example.localhost:8080/w/one/alpha/';
const APP = 'http://app.example.localhost:8080/w/one/alpha/';
const CARD = 'http://cards.example.localhost:8080/w/one/alpha/';
const ORIGIN = 'http://cards.example.localhost:8080';
const resolve = src => resolveFrameImage(src, FRAME, APP);

test('own files and sub-folders resolve to the app address, without a query or hash', () => {
  assert.equal(resolve(`${CARD}photo.png`), `${APP}photo.png`);
  assert.equal(resolve(`${CARD}img/a%20b.JPG?v=2#top`), `${APP}img/a%20b.JPG`);
  assert.equal(resolve(`${CARD}a/b/c/shot.webp`), `${APP}a/b/c/shot.webp`);
  assert.equal(resolve(`${CARD}vec.svg`), `${APP}vec.svg`);
  assert.equal(resolve(`${CARD}odd%23name%3F.gif`), `${APP}odd%23name%3F.gif`);
});

test('another card, another section, _shared, other origins and other schemes are refused', () => {
  for (const src of [
    'http://cards.example.localhost:8080/w/one/beta/photo.png',
    'http://cards.example.localhost:8080/w/two/alpha/photo.png',
    'http://cards.example.localhost:8080/w/one/_shared/logo.png',
    'http://cards.example.localhost:8080/w/one/alpha.png',
    'http://cards.example.localhost:8080/w/one/photo.png',
    'http://app.example.localhost:8080/w/one/alpha/photo.png',
    'http://cards.example.localhost:9999/w/one/alpha/photo.png',
    'https://cards.example.localhost:8080/w/one/alpha/photo.png',
    'https://example.com/photo.png',
    'data:image/png;base64,AAAA',
    'blob:http://cards.example.localhost:8080/1234',
    'javascript:alert(1)',
    'file:///w/one/alpha/photo.png',
    'photo.png',
    '/w/one/alpha/photo.png',
    '',
  ]) assert.equal(resolve(src), null, src);
});

test('dot segments, encoded slashes, backslashes and empty parts are refused', () => {
  for (const src of [
    `${CARD}../beta/photo.png`,
    `${CARD}%2e%2e/beta/photo.png`,
    `${CARD}%2e%2e%2fbeta%2fphoto.png`,
    `${CARD}..%2fphoto.png`,
    `${CARD}sub%2fphoto.png`,
    `${CARD}sub%5cphoto.png`,
    `${CARD}a%00.png`,
    `${CARD}sub//photo.png`,
    `${CARD}%2e`,
  ]) assert.equal(resolve(src), null, src);
  // A dot segment the URL parser resolves before we look stays inside the folder, so it is the same file.
  assert.equal(resolve(`${CARD}sub/../photo.png`), `${APP}photo.png`);
  // The same for a raw backslash, which the parser reads as a slash.
  assert.equal(resolve(`${CARD}sub\\photo.png`), `${APP}sub/photo.png`);
});

test('user info and non-picture files are refused', () => {
  assert.equal(resolve('http://user:pw@cards.example.localhost:8080/w/one/alpha/photo.png'), null);
  assert.equal(resolve('http://user@cards.example.localhost:8080/w/one/alpha/photo.png'), null);
  for (const name of ['index.html', 'data.json', 'script.js', 'photo.png.exe', 'photo', 'photo.png/']) assert.equal(resolve(`${CARD}${name}`), null, name);
});

function setup({ activated = true, open = false, closedAt = 0, start = 1_000_000 } = {}) {
  const clock = { at: start };
  const state = { activated, open, closedAt };
  const opened = [];
  const sent = [];
  const listeners = [];
  const target = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const frame = { contentWindow: target };
  const win = { addEventListener: (type, fn) => listeners.push(fn), removeEventListener: (type, fn) => { listeners.splice(listeners.indexOf(fn), 1); } };
  const off = attachImageOpen(frame, {
    origin: ORIGIN, resolve, win, now: () => clock.at,
    open: picture => opened.push(picture), isOpen: () => state.open, closedAt: () => state.closedAt, activated: () => state.activated,
  });
  const message = (data, { source = target, origin = ORIGIN } = {}) => { for (const fn of [...listeners]) fn({ source, origin, data }); };
  const good = (extra = {}) => ({ type: 'buw:image', v: 1, id: 'abc', src: `${CARD}photo.png`, all: [`${CARD}photo.png`, `${CARD}b.png`], ...extra });
  return { clock, state, opened, sent, listeners, message, good, off, target };
}

test('a good message opens the viewer on the app address and says so', () => {
  const t = setup();
  t.message(t.good());
  assert.deepEqual(t.opened, [{ url: `${APP}photo.png`, urls: [`${APP}photo.png`, `${APP}b.png`] }]);
  assert.deepEqual(t.sent, [{ data: { type: 'buw:image', v: 1, id: 'abc', ok: true }, origin: ORIGIN }]);
});

test('a picture the page did not list is still opened; listed pictures that are not the cards are left out', () => {
  const t = setup();
  t.message(t.good({ src: `${CARD}c.png`, all: [`${CARD}photo.png`, 'https://example.com/x.png', 'data:image/png;base64,AA'] }));
  assert.deepEqual(t.opened, [{ url: `${APP}c.png`, urls: [`${APP}photo.png`, `${APP}c.png`] }]);
});

test('another window or origin gets no reply and opens nothing', () => {
  const t = setup();
  t.message(t.good(), { source: { postMessage() { throw new Error('answered'); } } });
  t.message(t.good(), { origin: 'http://evil.example.localhost:8080' });
  t.message(t.good(), { origin: 'null' });
  assert.deepEqual(t.opened, []);
  assert.deepEqual(t.sent, []);
});

test('a message of another shape is not for this listener and gets no reply', () => {
  const t = setup();
  const long = Array.from({ length: 101 }, () => `${CARD}a.png`);
  for (const bad of [null, 'buw:image', { type: 'buw:bridge', v: 1, id: 'a', op: 'hello' }, t.good({ v: 2 }), t.good({ id: '' }), t.good({ id: 'x'.repeat(33) }), t.good({ id: 5 }), t.good({ src: 5 }), t.good({ src: `${CARD}${'a'.repeat(2048)}.png` }), t.good({ all: 'x' }), t.good({ all: [5] }), t.good({ all: long })]) t.message(bad);
  assert.deepEqual(t.opened, []);
  assert.deepEqual(t.sent, []);
});

test('no recent press, a viewer already open, a close in the last second, and the rate limit each answer ok: false', () => {
  let t = setup({ activated: false });
  t.message(t.good());
  assert.deepEqual(t.opened, []);
  assert.deepEqual(t.sent, [{ data: { type: 'buw:image', v: 1, id: 'abc', ok: false }, origin: ORIGIN }]);

  t = setup({ open: true });
  t.message(t.good());
  assert.deepEqual([t.opened.length, t.sent[0].data.ok], [0, false]);

  t = setup();
  t.state.closedAt = t.clock.at - 500;
  t.message(t.good());
  assert.deepEqual([t.opened.length, t.sent[0].data.ok], [0, false]);
  t.clock.at += 600;
  t.message(t.good());
  assert.deepEqual([t.opened.length, t.sent[1].data.ok], [1, true]);

  t = setup();
  for (let n = 0; n < 10; n += 1) { t.clock.at += 2000; t.message(t.good()); }
  assert.equal(t.opened.length, 10);
  t.clock.at += 2000;
  t.message(t.good());
  assert.equal(t.opened.length, 10, 'The eleventh open in a minute is refused.');
  assert.equal(t.sent.at(-1).data.ok, false);
  t.clock.at += 60_000;
  t.message(t.good());
  assert.equal(t.opened.length, 11, 'A minute later it works again.');
});

test('a picture outside the card is refused with ok: false, and nothing opens', () => {
  const t = setup();
  for (const src of ['http://cards.example.localhost:8080/w/one/beta/photo.png', 'data:image/png;base64,AAAA', 'https://example.com/x.png']) t.message(t.good({ src, all: [src] }));
  assert.deepEqual(t.opened, []);
  assert.deepEqual(t.sent.map(item => item.data.ok), [false, false, false]);
});

test('an action, text, alt or workspace in the message changes nothing: open gets only built addresses', () => {
  const t = setup();
  t.message(t.good({ action: 'chat', text: 'hello', alt: 'Click here', workspace: 'two', card: 'beta', caption: 'x', title: 'y', url: 'https://example.com/z.png' }));
  assert.deepEqual(t.opened, [{ url: `${APP}photo.png`, urls: [`${APP}photo.png`, `${APP}b.png`] }]);
  assert.deepEqual(Object.keys(t.opened[0]).sort(), ['url', 'urls']);
  assert.deepEqual(t.sent[0].data, { type: 'buw:image', v: 1, id: 'abc', ok: true });
});

test('detaching stops listening', () => {
  const t = setup();
  assert.equal(t.listeners.length, 1);
  t.off();
  assert.equal(t.listeners.length, 0);
});
