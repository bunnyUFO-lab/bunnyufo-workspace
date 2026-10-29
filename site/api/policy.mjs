// Policy approval: the site API signs proposed requests of some kinds by itself, so research starts without a tap.
// Off by default. `HUB_POLICY_APPROVE` is a comma list of preset kinds, `research` and/or `docs`; nothing else is
// accepted (the owner kept the tap for code, build and art). `HUB_POLICY_PER_DAY` caps the signatures per Pacific day
// (default 10). A signature goes through the one path that signs (`approveRequest`, `by: 'policy'`), so a full Hermes or
// cloud target makes the request wait, as with a tap.
//
// Who may be signed is decided from a fact the writer cannot choose. A request's `origin` is a field the writer puts in
// the body, so it is not trusted on its own: a run holds a card-API token too and could claim to be an agent, or leave the
// field out. The token that wrote `request.json` leaves its kind as the object's user metadata, `writer`:
//   `site`   the site API wrote it (the owner's own request), and the body says `origin.kind: owner`
//   `agent`  the card API wrote it for an agent session's token, and the body says `origin.kind: agent`
// Anything else (no metadata, `runner`, `hermes`, or a body that disagrees) is not signed: it fails closed, and waits for a
// tap. So no run starts runs unattended.
import { presetOf } from './presets.mjs';
import { validId } from './hub-model.mjs';

export const POLICY_KINDS = ['research', 'docs'];
const SWEEP_MS = 60_000;
const NOTE = 'Policy limit reached today';
const WRITER_FOR_ORIGIN = { owner: 'site', agent: 'agent' };

/** The kinds a `HUB_POLICY_APPROVE` value turns on: known kinds only, in the order given, without repeats. */
export function parsePolicyKinds(value) {
  const kinds = String(value ?? '').split(',').map(part => part.trim().toLowerCase()).filter(part => POLICY_KINDS.includes(part));
  return [...new Set(kinds)];
}

const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The calendar day in Pacific time, `yyyy-mm-dd`: what "a day" means for the owner and for the limit. */
export const pacificDay = date => pacific.format(date);

/**
 * @param requests  `createRequests()`: `approveRequest`
 * @param canSign   whether the host has a signing key
 * @param writerOf  `(id) → Promise<string|null>`: the `writer` metadata of the request's request.json
 */
export function createPolicy({ env = {}, requests, listFolders, cached, canSign = false, now = () => new Date(), log = () => {}, sweepMs = SWEEP_MS, writerOf = async () => null }) {
  const kinds = canSign ? parsePolicyKinds(env.HUB_POLICY_APPROVE) : [];
  const cap = Number.isInteger(Number(env.HUB_POLICY_PER_DAY)) && Number(env.HUB_POLICY_PER_DAY) > 0 ? Number(env.HUB_POLICY_PER_DAY) : 10;
  const state = { signedToday: 0, day: '' };
  let lastCheck = 0;
  const writers = new Map(); // request.json never changes, and neither does its writer

  const writerFor = async id => {
    if (!writers.has(id)) writers.set(id, await writerOf(id));
    return writers.get(id);
  };

  /** Whether the preset kind is on policy and the origin is one policy may sign (the writer is checked separately). */
  const listed = request => {
    const preset = presetOf(request?.preset);
    return !!preset && kinds.includes(preset.kind) && Object.hasOwn(WRITER_FOR_ORIGIN, request?.origin?.kind);
  };

  /** Eligible: listed, an explicit origin, and the stored writer agrees with it. A missing origin or writer is not eligible. */
  const eligible = async (id, request) => listed(request) && (await writerFor(id)) === WRITER_FOR_ORIGIN[request.origin.kind];

  /** Policy signatures made on this Pacific day, counted from the approvals themselves. */
  async function signedOn(at) {
    const today = pacificDay(at);
    let count = 0;
    for (const [id, names] of await listFolders('requests', at)) {
      if (!names.has('approved.json')) continue;
      const approved = await cached(`requests/${id}/approved.json`);
      if (approved?.by === 'policy' && typeof approved.at === 'string' && pacificDay(new Date(approved.at)) === today) count += 1;
    }
    return count;
  }

  /** Sign what is eligible, oldest first, until the day's limit. Returns the ids it signed. */
  async function sweepNow(at) {
    if (!kinds.length) return [];
    const signed = [];
    let count = await signedOn(at);
    const waiting = [];
    for (const [id, names] of await listFolders('requests', at)) {
      if (!names.has('request.json') || !validId(id)) continue;
      if (['approved.json', 'declined.json', 'stop.json', 'result.json', 'taken.json'].some(file => names.has(file))) continue;
      const request = await cached(`requests/${id}/request.json`);
      if (!request?.preset || !listed(request) || !(await eligible(id, request))) continue;
      waiting.push({ id, request, createdAt: request.createdAt ?? '' });
    }
    waiting.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    for (const { id, request } of waiting) {
      if (count >= cap) break;
      try {
        await requests.approveRequest(id, { target: request.target, by: 'policy', at });
        count += 1;
        signed.push(id);
      } catch (error) {
        log(`[hub] policy could not sign ${id}: ${String(error.message).slice(0, 120)}`);
      }
    }
    state.signedToday = count;
    state.day = pacificDay(at);
    return signed;
  }

  // Sweeps run one after another, so a sweep asked for while one runs waits its turn and sees what the first left.
  let queue = Promise.resolve();
  const sweep = (at = now()) => { const turn = queue.then(() => sweepNow(at)); queue = turn.catch(() => {}); return turn; };

  let timer = null;
  let ready = Promise.resolve();
  if (kinds.length) {
    timer = setInterval(() => { sweep().catch(error => log(`[hub] policy sweep failed: ${error.message}`)); }, sweepMs);
    timer.unref?.();
    ready = sweep().catch(error => log(`[hub] policy sweep failed: ${error.message}`));
  }

  return {
    kinds, cap, sweep, ready,
    /** On a page load, at most once per 30 s. */
    pageLoad(at = now()) {
      if (!kinds.length || Date.now() - lastCheck < 30_000) return;
      lastCheck = Date.now();
      sweep(at).catch(error => log(`[hub] policy sweep failed: ${error.message}`));
    },
    /** Adds the note to a proposal that policy would sign, once today's limit is reached; the tap still signs it. */
    annotate(items) {
      if (!kinds.length || state.day !== pacificDay(now()) || state.signedToday < cap) return items;
      return items.map(item => (item.state === 'proposed' && listed({ preset: item.preset, origin: item.origin }) ? { ...item, note: NOTE } : item));
    },
    close() { clearInterval(timer); },
  };
}
