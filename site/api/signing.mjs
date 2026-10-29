// Signing for approvals and stops: Ed25519 over a canonical JSON form. The private key is
// `HUB_SIGNING_KEY` in the site API's environment (base64 of the PKCS8 DER, one line) and never leaves
// that host; runners hold only the public key. The verifier here is the one `cards.mjs` and the PC
// dispatcher copy. A fixed vector (test/fixtures/signing-vector.json, made once with a throwaway key)
// pins the byte format for all of them.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';

/**
 * The bytes that are signed: JSON with the keys of every object sorted, no whitespace, `undefined` dropped
 * (as an array item it is `null`), `null` kept, arrays in order. Returns a string; encode it as UTF-8.
 */
export function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).filter(name => value[name] !== undefined).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const without = (doc, name) => Object.fromEntries(Object.entries(doc).filter(([key]) => key !== name));

/** The private key from the environment, or null when `HUB_SIGNING_KEY` is unset. A malformed one throws a message that never holds the value. */
export function loadSigningKey(env = {}) {
  const value = String(env.HUB_SIGNING_KEY ?? '').trim();
  if (!value) return null;
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('HUB_SIGNING_KEY is not a base64 PKCS8 private key.');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('HUB_SIGNING_KEY is not an Ed25519 key.');
  return key;
}

/** `obj` plus its `signature` (base64 of the 64-byte Ed25519 signature over `canonical(obj)`). Any signature already on `obj` is replaced. */
export function sign(obj, privateKey) {
  const rest = without(obj, 'signature');
  return { ...rest, signature: edSign(null, Buffer.from(canonical(rest), 'utf8'), privateKey).toString('base64') };
}

/** True when `doc.signature` is a valid signature of the rest of `doc` by `publicKey`. Never throws. */
export function verify(doc, publicKey) {
  try {
    if (!doc || typeof doc !== 'object' || typeof doc.signature !== 'string') return false;
    const signature = Buffer.from(doc.signature, 'base64');
    if (signature.length !== 64) return false;
    return edVerify(null, Buffer.from(canonical(without(doc, 'signature')), 'utf8'), publicKey, signature);
  } catch {
    return false;
  }
}

/** A public key from SPKI as PEM or as one bare base64 line (what `HUB_SIGNING_PUBKEY` holds). */
export function parsePublicKey(text) {
  const body = String(text ?? '').split(/\r?\n/).filter(line => !line.startsWith('-----')).join('').replace(/\s+/g, '');
  return createPublicKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'spki' });
}

/** The PEM (SPKI) of a private key's public half: what a PC saves as `approval-signing-key.pub`. */
export const publicKeyPem = privateKey => createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

/** 16 random bytes as base64url: 22 characters. */
export const newNonce = () => randomBytes(16).toString('base64url');
