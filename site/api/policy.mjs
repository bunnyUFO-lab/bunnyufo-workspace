// Policy approval: the site API signs proposed requests of some kinds by itself, so research starts without a tap.
// Off by default. `HUB_POLICY_APPROVE` is a comma list of preset kinds, `research` and/or `docs`; nothing else is
// accepted (the owner kept the tap for code, build and art). `HUB_POLICY_PER_DAY` caps the signatures per UTC day
// (default 10). Only a request the owner or an agent session made is signed: a request that a run made is never
// signed here, so no run spawns runs unattended. A signature goes through the one path that signs
// (`approveRequest`, `by: 'policy'`), so a full Hermes or cloud target makes the request wait, as with a tap.
import { presetOf } from './presets.mjs';
import { day8, validId } from './hub-model.mjs';

export const POLICY_KINDS = ['research', 'docs'];
const SWEEP_MS = 60_000;
const NOTE = 'Policy limit reached today';

/** The kinds a `HUB_POLICY_APPROVE` value turns on: known kinds only, in the order given, without repeats. */
export function parsePolicyKinds(value) {
  const kinds = String(value ?? '').split(',').map(part => part.trim().toLowerCase()).filter(part => POLICY_KINDS.includes(part));
  return [...new Set(kinds)];
}

/**
 * @param requests  `createRequests()`: `approveRequest`
 * @param canSign   whether the host has a signing key
 */
export function createPolicy({ env = {}, requests, listFolders, cached, canSign = false, now = () => new Date(), log = () => {}, sweepMs = SWEEP_MS }) {
  const kinds = canSign ? parsePolicyKinds(env.HUB_POLICY_APPROVE) : [];
  const cap = Number.isInteger(Number(env.HUB_POLICY_PER_DAY)) && Number(env.HUB_POLICY_PER_DAY) > 0 ? Number(env.HUB_POLICY_PER_DAY) : 10;
  const state = { signedToday: 0, day: '' };
  let lastCheck = 0;

  /** Whether the request's preset kind is on policy and its origin is one policy trusts. */
  const eligible = request => {
    const preset = presetOf(request?.preset);
    const origin = request?.origin?.kind ?? 'agent'; // a missing origin reads as an agent's
    return !!preset && kinds.includes(preset.kind) && (origin === 'owner' || origin === 'agent');
  };

  /** Policy signatures made on this UTC day, counted from the approvals themselves. */
  async function signedOn(at) {
    const today = day8(at);
    let count = 0;
    for (const [id, names] of await listFolders('requests', at)) {
      if (!names.has('approved.json')) continue;
      const approved = await cached(`requests/${id}/approved.json`);
      if (approved?.by === 'policy' && typeof approved.at === 'string' && day8(new Date(approved.at)) === today) count += 1;
    }
    return count;
  }

  /** Sign what is eligible, oldest first, until the day's limit. Returns the ids it signed. */
  async function sweepNow(at) {
    if (!kinds.length) return [];
    const signed = [];
    try {
      let count = await signedOn(at);
      const waiting = [];
      for (const [id, names] of await listFolders('requests', at)) {
        if (!names.has('request.json') || !validId(id)) continue;
        if (['approved.json', 'declined.json', 'stop.json', 'result.json', 'taken.json'].some(file => names.has(file))) continue;
        const request = await cached(`requests/${id}/request.json`);
        if (!request?.preset || !eligible(request)) continue;
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
      state.day = day8(at);
    } finally {
    }
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
      if (!kinds.length || state.day !== day8(now()) || state.signedToday < cap) return items;
      return items.map(item => (item.state === 'proposed' && eligible({ preset: item.preset, origin: item.origin }) ? { ...item, note: NOTE } : item));
    },
    close() { clearInterval(timer); },
  };
}
