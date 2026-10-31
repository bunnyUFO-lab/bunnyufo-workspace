// What an answer to a rerun Ask does (the watcher's "run it again", m3b). An Ask that carries a `rerun` field points at a
// finished PC run:
//
//   { request, kind: 'denied' }            the run was denied a tool call. "I ran the allow lines; run it again" runs it again.
//   { request, kind: 'continue', ask }     the run ended before its own Ask (`ask`) was answered. Any option but "drop" starts a
//                                          new run with that answer signed into its brief as the follow-up.
//
// The Hub acts, the watcher never does: this makes one copy of the request under a fixed id and signs its approval through
// the same `approveRequest` the Approve button uses (the pattern of hub-avatar.mjs). The copy is a new request, so the PC
// verifies it like any approval: pinned key, nonce, hash, caps. Nothing here reuses or loosens an old approval.
//
// The Ask is an agent's file, so `rerun` is only a pointer: every claim in it is checked here before anything is written.
// The answer itself is already stored when `afterAnswer` runs; nothing here can undo or fail it. Only the web route calls
// it, behind the passkey; the Discord route never does, and an Ask without `requirePasskey: true` is refused.
import { rerunRequestId } from './hub-requests.mjs';
import { validId } from './hub-model.mjs';

const KINDS = ['denied', 'continue'];
const NO_NOTE = 'The owner asked to run it again without an answer.';
const LIMITS = { question: 600, answer: 2000 };

/** A clean `rerun` field, or null. Unknown fields are dropped. */
export function checkRerunField(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!validId(raw.request) || !KINDS.includes(raw.kind)) return null;
  if (raw.kind === 'continue') return validId(raw.ask) ? { request: raw.request, kind: 'continue', ask: raw.ask } : null;
  return raw.ask === undefined ? { request: raw.request, kind: 'denied' } : null;
}

/** Whether this answer is the one that starts the run: "allowed" on a denial Ask, any option but "drop" on a continue Ask. */
const startsRun = (field, choice) => (field.kind === 'denied' ? choice === 'allowed' : typeof choice === 'string' && choice !== 'drop');

/**
 * @param requests  `createRequests(...)`: `verifiedPcRun`, `copyFor`, `writeStop`, `loadOne`, `siteWrote`, `approveRequest`
 * @param readAsk   `(id) → ask.json` (throws when there is none)
 */
export function createRerun({ requests, readAsk, log = () => {} }) {
  const no = why => ({ started: false, why });

  /** The follow-up of a continue Ask, from the run's own Ask (never from the continue Ask's copies of it). */
  async function followUpFor({ field, ask, answer, project }) {
    let original;
    try { original = await readAsk(field.ask); } catch { return { why: 'The Ask the run left could not be read.' }; }
    if (!original || original.project !== project || original.project !== ask.project) return { why: 'That Ask belongs to another project.' };
    if (original.from?.request !== field.request) return { why: 'That Ask was not asked by this run.' };
    const note = typeof answer.note === 'string' ? answer.note.trim() : '';
    const option = (original.options ?? []).find(candidate => candidate?.id === answer.choice);
    let said;
    if (option) said = typeof option.label === 'string' ? option.label.trim() : '';
    else if (answer.choice === 'again') said = note ? '' : NO_NOTE;
    else return { why: "That is not one of the run's options." };
    const joined = said ? `${said}${note ? ` (${note})` : ''}` : note;
    const question = String(original.question ?? '').trim().slice(0, LIMITS.question);
    if (!question || !joined) return { why: 'There is no answer to carry.' };
    return { followUp: { from: field.request, question, answer: joined.slice(0, LIMITS.answer), summary: '' } };
  }

  /** The copy at `copyId`, when the Hub itself made it as the owner's rerun of `old`; null for anything else. */
  async function ownCopy(copyId, old, at) {
    let loaded;
    try { loaded = await requests.loadOne(copyId, at); } catch { return { missing: true }; }
    const { request } = loaded;
    const own = request.origin?.kind === 'owner' && request.replaces === old && await requests.siteWrote(copyId);
    return own ? loaded : null;
  }

  async function start({ ask, field, answer, user, at }) {
    if (ask.requirePasskey !== true) return no('This Ask does not require a passkey, so it cannot start a run.');
    let verified;
    try { verified = await requests.verifiedPcRun(field.request, at); } catch (error) { return no(error.message); }
    const project = verified.request.project;
    if (ask.project !== project) return no('That request belongs to another project.');
    let followUp;
    if (field.kind === 'continue') {
      const made = await followUpFor({ field, ask, answer, project });
      if (!made.followUp) return no(made.why);
      ({ followUp } = made);
    }
    const copyId = rerunRequestId(field.request);
    let state;
    if (!verified.ranAgain) {
      try {
        await requests.copyFor(field.request, { states: ['failed', 'lost', 'expired'], target: 'pc', user, at, followUp, fromAsk: ask.id, fixedId: copyId });
        state = 'proposed';
      } catch (error) {
        if (error.status !== 409) return no(error.message);
      }
    }
    if (!state) {
      // Something is at that id (an earlier answer made it). It counts only when the Hub made it as this request's rerun.
      const mine = await ownCopy(copyId, field.request, at);
      if (mine?.missing) return no('That request cannot run again now.');
      if (!mine) return no('That request id is taken; nothing started.');
      ({ state } = mine);
    }
    let already = state !== 'proposed';
    if (!already) {
      try {
        await requests.approveRequest(copyId, { target: 'pc', by: user, at });
      } catch (error) {
        // Another answer may have signed it between our read and our write. Otherwise the copy stays proposed for one tap.
        const now = await requests.loadOne(copyId, at).catch(() => null);
        if (now && now.state !== 'proposed') already = true;
        else {
          log(`[hub] the rerun ${copyId} of ${field.request} was made but not approved: ${error.message}`);
          return no(`Saved as ${copyId} but not approved: ${String(error.message).replace(/\.+$/, '')}. Approve it in Needs you.`);
        }
      }
    }
    try {
      await requests.writeStop(field.request, `run again as ${copyId}`, user, at, ['failed', 'lost', 'expired']);
    } catch (error) {
      if (error.status !== 409) log(`[hub] the original ${field.request} was not stopped after its rerun ${copyId}: ${error.message}`);
    }
    return { started: true, request: copyId, kind: field.kind, ...(already ? { already: true, message: `Already approved again as ${copyId}.` } : {}) };
  }

  /**
   * Called right after the create-only `answer.json` is written on the web path. Returns what to add to the response as
   * `rerun`, or null when the Ask is no rerun Ask or the answer starts nothing. Never throws.
   */
  async function afterAnswer({ ask, answer, user, at }) {
    if (!ask || ask.rerun === undefined || !answer?.choice) return null;
    const field = checkRerunField(ask.rerun);
    if (!field || !startsRun(field, answer.choice)) return null;
    try {
      return await start({ ask, field, answer, user, at });
    } catch (error) {
      log(`[hub] rerun answer for ${ask.id} failed: ${error.message}`);
      return no('That did not work.');
    }
  }

  return { afterAnswer };
}
