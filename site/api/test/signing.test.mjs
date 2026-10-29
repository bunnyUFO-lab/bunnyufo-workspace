// Signing: canonical bytes, sign and verify, key parsing, and the committed test vector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonical, loadSigningKey, newNonce, parsePublicKey, publicKeyPem, sha256Hex, sign, verify } from '../signing.mjs';

const vector = JSON.parse(readFileSync(new URL('./fixtures/signing-vector.json', import.meta.url), 'utf8'));
const makeKey = () => generateKeyPairSync('ed25519').privateKey;
const sample = () => ({
  v: 1, request: '20261029-example-x-a1b2', project: 'example', repo: null, target: 'hermes', requestSha256: sha256Hex(Buffer.from('{}')), limits: { minutes: 30 },
  expires: '2026-11-01T10:00:00.000Z', nonce: newNonce(), at: '2026-10-29T10:00:00.000Z', by: 'owner',
  run: { preset: 'research', model: null, permissionMode: null, opensWindows: false, allow: ['a', 'b'], brief: 'Do the job.\nSecond line.' },
});

test('canonical: sorted keys at every depth, no whitespace, undefined dropped, null and arrays kept', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { y: 1, x: undefined }, undefined], c: null }, e: 'é"\n' }), '{"a":{"c":null,"d":[3,{"y":1},null]},"b":1,"e":"é\\"\\n"}');
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});

test('sign then verify passes; changing any field, in run.brief too, fails', () => {
  const key = makeKey();
  const pub = parsePublicKey(publicKeyPem(key));
  const doc = sign(sample(), key);
  assert.equal(Buffer.from(doc.signature, 'base64').length, 64);
  assert.equal(verify(doc, pub), true);
  const tampered = [
    d => { d.target = 'pc'; }, d => { d.limits.minutes = 31; }, d => { d.run.brief += ' '; }, d => { d.run.allow.push('c'); }, d => { d.by = 'someone'; },
    d => { d.at = '2026-10-29T10:00:01.000Z'; }, d => { d.repo = 'a/b'; }, d => { d.request = '20261029-example-y-a1b2'; }, d => { d.nonce = 'B'.repeat(22); }, d => { d.extra = 1; }, d => { delete d.project; },
  ];
  for (const change of tampered) {
    const copy = structuredClone(doc);
    change(copy);
    assert.equal(verify(copy, pub), false, change.toString());
  }
  assert.equal(verify({ ...doc, signature: 'AAAA' }, pub), false);
  assert.equal(verify({ ...doc, signature: undefined }, pub), false);
  assert.equal(verify(null, pub), false);
  assert.equal(verify(doc, parsePublicKey(publicKeyPem(makeKey()))), false, 'another key does not verify it');
});

test('the order of keys in the file does not matter, and a signature on the input is replaced', () => {
  const key = makeKey();
  const pub = parsePublicKey(publicKeyPem(key));
  const doc = sign(sample(), key);
  const shuffled = Object.fromEntries(Object.entries(doc).reverse());
  shuffled.run = Object.fromEntries(Object.entries(shuffled.run).reverse());
  assert.equal(verify(shuffled, pub), true);
  const again = sign({ ...doc, signature: 'old' }, key);
  assert.equal(verify(again, pub), true);
});

test('a byte of request.json changes its hash', () => {
  const body = Buffer.from(vector.requestJson);
  assert.equal(vector.approved.requestSha256, sha256Hex(body));
  const changed = Buffer.from(body);
  changed[changed.length - 3] ^= 1;
  assert.notEqual(sha256Hex(changed), vector.approved.requestSha256);
});

test('the committed vector verifies with plain crypto.verify over canonical(rest)', () => {
  const { signature, ...rest } = vector.approved;
  assert.equal(canonical(rest), vector.canonical);
  const pub = parsePublicKey(vector.publicKeyPem);
  assert.equal(nodeVerify(null, Buffer.from(vector.canonical, 'utf8'), pub, Buffer.from(signature, 'base64')), true);
  assert.equal(verify(vector.approved, pub), true);
  assert.equal(verify({ ...vector.approved, by: 'x' }, pub), false);
  assert.doesNotMatch(readFileSync(new URL('./fixtures/signing-vector.json', import.meta.url), 'utf8'), /BEGIN [A-Z ]*PRIVATE KEY/, 'The vector holds no private key.');
});

test('PEM and bare base64 public keys both parse', () => {
  const pem = vector.publicKeyPem;
  const bare = pem.split('\n').filter(line => line && !line.startsWith('-----')).join('');
  const a = parsePublicKey(pem);
  assert.equal(verify(vector.approved, a), true);
  assert.equal(verify(vector.approved, parsePublicKey(bare)), true);
  assert.equal(verify(vector.approved, parsePublicKey(`${pem}\r\n`.replace(/\n/g, '\r\n'))), true, 'CRLF and a trailing newline are fine.');
  assert.throws(() => parsePublicKey('not a key'));
});

test('loadSigningKey: null without the variable, a key with it, and a message that never holds the value', () => {
  assert.equal(loadSigningKey({}), null);
  assert.equal(loadSigningKey({ HUB_SIGNING_KEY: '  ' }), null);
  const key = makeKey();
  const value = key.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const loaded = loadSigningKey({ HUB_SIGNING_KEY: `${value}\n` });
  assert.equal(verify(sign(sample(), loaded), parsePublicKey(publicKeyPem(key))), true);
  for (const bad of ['not-base64-at-all-!!', Buffer.from('short').toString('base64'), generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')]) {
    try {
      loadSigningKey({ HUB_SIGNING_KEY: bad });
      assert.fail('should throw');
    } catch (error) {
      assert.match(error.message, /HUB_SIGNING_KEY is not/);
      assert.equal(error.message.includes(bad.slice(0, 20)), false);
    }
  }
});

test('newNonce is 22 base64url characters and does not repeat', () => {
  const seen = new Set(Array.from({ length: 50 }, newNonce));
  assert.equal(seen.size, 50);
  for (const nonce of seen) assert.match(nonce, /^[A-Za-z0-9_-]{22}$/);
});
