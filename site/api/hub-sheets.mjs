// Custom pet sheets for the Team screen: read, check and list `team/<agent>/sheet-<stamp>.png` + `.json`.
//
// A sheet is data from the Gaming PC, so nothing is served or chosen until it passes `checkSheet`:
// the JSON has the fixed shape, the PNG is 1536 x 1872 and at most 4 MB, and its sha256 is the one
// the JSON names. A sheet becomes an agent's sprite only when the owner's avatar choice file names it
// with that hash (hub-team.mjs), so a sheet that merely exists changes nothing.
import { createHash } from 'node:crypto';

export const SHEET_ID_RE = /^sheet-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}$/;
export const SHEET_PNG_RE = /^(sheet-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4})\.png$/;
export const SHEET_JSON_RE = /^(sheet-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4})\.json$/;
export const SHEET_STATES = ['idle', 'run-right', 'run-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
export const SHEET_FRAME = { w: 192, h: 208 };
export const SHEET_COLS = 8;
export const SHEET_SIZE = { width: SHEET_COLS * SHEET_FRAME.w, height: SHEET_STATES.length * SHEET_FRAME.h };
export const SHEET_PNG_MAX = 4 * 1024 * 1024;
export const SHEET_JSON_MAX = 16 * 1024;
export const SHEETS_LISTED = 20;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The width and height a PNG's header says, or null when the bytes do not start like a PNG. */
export function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Check one sheet. `json` is the parsed sheet JSON, `png` the whole PNG as a Buffer, `agent` the folder's
 * agent. Returns `{ ok: true, sheet }` with the sheet as the Team screen needs it, or `{ ok: false, why }`.
 */
export function checkSheet({ agent, json, png }) {
  const no = why => ({ ok: false, why });
  if (!json || typeof json !== 'object' || Array.isArray(json)) return no('The sheet JSON is not an object.');
  if (json.v !== 1) return no('The sheet JSON is not version 1.');
  if (json.agent !== agent) return no('The sheet names another agent.');
  if (json.frame?.w !== SHEET_FRAME.w || json.frame?.h !== SHEET_FRAME.h) return no('The frame size is not 192 x 208.');
  if (json.cols !== SHEET_COLS) return no('The sheet does not have 8 columns.');
  if (!Array.isArray(json.rows) || json.rows.length !== SHEET_STATES.length) return no('The sheet does not have nine rows.');
  const rows = [];
  for (const [index, row] of json.rows.entries()) {
    if (row?.state !== SHEET_STATES[index]) return no(`Row ${index + 1} is not ${SHEET_STATES[index]}.`);
    if (!Number.isInteger(row.frames) || row.frames < 1 || row.frames > SHEET_COLS) return no(`Row ${row.state} needs 1 to 8 frames.`);
    if (!Number.isInteger(row.fps) || row.fps < 1 || row.fps > 24) return no(`Row ${row.state} needs 1 to 24 frames per second.`);
    rows.push({ state: row.state, frames: row.frames, fps: row.fps });
  }
  if (typeof json.sha256 !== 'string' || !HEX64.test(json.sha256)) return no('The sheet JSON has no sha256.');
  if (!Buffer.isBuffer(png) || png.length > SHEET_PNG_MAX) return no('The PNG is over 4 MB.');
  const size = pngSize(png);
  if (!size || size.width !== SHEET_SIZE.width || size.height !== SHEET_SIZE.height) return no('The PNG is not 1536 x 1872.');
  if (sha256(png) !== json.sha256) return no('The PNG does not match its sha256.');
  const at = typeof json.at === 'string' && Number.isFinite(new Date(json.at).getTime()) ? json.at : '';
  return { ok: true, sheet: { rows, at, sha256: json.sha256 } };
}

/** The sprite of a listed sheet, in the shape of the `custom` type in src/lib/hubTeam.ts. */
export function sheetSprite(agentId, sheet) {
  return {
    kind: 'custom', sheet: sheet.sheet, url: `/hub/file?path=team/${agentId}/${sheet.sheet}.png`,
    frame: { ...SHEET_FRAME }, cols: SHEET_COLS, rows: sheet.rows.map(row => ({ ...row })),
  };
}

/**
 * The sheet reader over a bucket. `folderKey(agentId)` is the agent's `team/<agent>/` key prefix with a
 * trailing slash (built by the Hub's `inboxKey`). Verdicts are cached by key and ETag: a sheet is
 * create-only, so an ETag never changes meaning, and the PNG is hashed once.
 */
export function createSheets({ bucket, folderKey, agents }) {
  const verdicts = new Map();
  const remember = (name, value) => {
    verdicts.set(name, value);
    while (verdicts.size > 200) verdicts.delete(verdicts.keys().next().value);
  };

  async function readBytes(name) {
    const got = await bucket.get(name);
    return { bytes: Buffer.from(await new Response(got.body).arrayBuffer()), etag: got.etag };
  }

  async function verdictOf(agentId, id, jsonObject, pngObject) {
    const name = `${folderKey(agentId)}${id}`;
    const stamp = `${name}|${jsonObject.etag}|${pngObject.etag}`;
    if (verdicts.has(stamp)) return verdicts.get(stamp);
    let verdict;
    try {
      if (jsonObject.size > SHEET_JSON_MAX) verdict = { ok: false, why: 'The sheet JSON is too big.' };
      else if (pngObject.size > SHEET_PNG_MAX) verdict = { ok: false, why: 'The PNG is over 4 MB.' };
      else {
        const [{ bytes: jsonBytes }, { bytes: png, etag }] = await Promise.all([readBytes(`${name}.json`), readBytes(`${name}.png`)]);
        let json = null;
        try { json = JSON.parse(jsonBytes.toString('utf8')); } catch { /* not JSON */ }
        const checked = checkSheet({ agent: agentId, json, png });
        verdict = checked.ok ? { ok: true, sheet: { sheet: id, ...checked.sheet, etag } } : checked;
      }
    } catch (error) {
      if (error.status === 404) verdict = { ok: false, why: 'The sheet is gone.' };
      else throw error;
    }
    remember(stamp, verdict);
    return verdict;
  }

  /** The agent's listed sheets, newest first, at most `SHEETS_LISTED`. Each is `{ sheet, at, rows, sha256, etag }`. */
  async function listSheets(agentId) {
    if (!agents.includes(agentId)) return [];
    const base = folderKey(agentId);
    const { objects } = await bucket.list(base);
    const byName = new Map(objects.map(object => [object.key.slice(base.length), object]));
    const ids = [...byName.keys()].map(name => SHEET_PNG_RE.exec(name)?.[1]).filter(id => id && byName.has(`${id}.json`)).sort().reverse();
    const found = [];
    for (const id of ids) {
      if (found.length >= SHEETS_LISTED) break;
      const verdict = await verdictOf(agentId, id, byName.get(`${id}.json`), byName.get(`${id}.png`));
      if (verdict.ok) found.push(verdict.sheet);
    }
    return found;
  }

  return {
    listSheets,
    /** One listed sheet by id, or null. */
    async find(agentId, id) {
      if (!SHEET_ID_RE.test(id ?? '')) return null;
      return (await listSheets(agentId)).find(sheet => sheet.sheet === id) ?? null;
    },
  };
}
