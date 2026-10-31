// What an answer to an avatar Ask does (the sprite flow, m5). Two kinds of Ask carry an `avatar` field:
//
//   { agent, request, subject }  the pick of one of four variants. The pick starts the sprite sheet run:
//                                one signed request, `agent-avatar-sheet`, made here and approved by the same
//                                function the Approve route calls.
//   { agent, sheet }             the check of a finished sheet. "Use it" makes the sheet the agent's sprite through
//                                the same code as the Team screen's Use this; "Not this one" does nothing.
//
// The Ask is an agent's file, so the field is only a pointer: every claim in it is checked here before anything
// is written. The answer itself is already stored when `afterAnswer` runs; nothing here can undo or fail it.
import { createHash } from 'node:crypto';
import { SHEET_ID_RE } from './hub-sheets.mjs';
import { validId } from './hub-model.mjs';
import { SUBJECT_RE } from './presets.mjs';

const SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const START_NOTE = 'The sprite sheet starts on the Gaming PC within a few minutes.';


/**
 * The id of the sheet request an avatar request starts: one per avatar request (one approval, one sheet run), so a second Ask,
 * a second answer or a retry can never make another. The id can be worked out by anyone, so a request found at it is trusted
 * only when the site wrote it (see `ownSheetRequest`).
 */
export function sheetRequestId(requestId) {
  const tail = createHash('sha256').update(`avatar-sheet:${requestId}`).digest('hex').slice(0, 4);
  return `${String(requestId).slice(0, 115)}-${tail}`;
}

/** A clean `avatar` field, or null. Unknown fields are dropped. */
export function checkAvatarField(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.agent !== 'string' || !SLUG_RE.test(raw.agent)) return null;
  if (raw.sheet !== undefined) return typeof raw.sheet === 'string' && SHEET_ID_RE.test(raw.sheet) ? { agent: raw.agent, sheet: raw.sheet } : null;
  if (!validId(raw.request)) return null;
  if (raw.subject !== undefined && (typeof raw.subject !== 'string' || !SUBJECT_RE.test(raw.subject))) return null;
  return { agent: raw.agent, request: raw.request, ...(raw.subject ? { subject: raw.subject } : {}) };
}

/**
 * @param requests      `createRequests(...)`: `verifiedRun`, `createFixed`, `approveRequest`
 * @param chooseAvatar  `(agentId, { kind: 'custom', sheet }, user, at)`: the Team screen's avatar write
 * @param agents        the agent ids that may have an avatar
 */
export function createAvatar({ requests, chooseAvatar, agents, log = () => {} }) {
  const no = why => ({ started: false, why });

  /** The sheet request at `id` and its state, when the Hub itself made it for this agent; null for anything else. */
  async function ownSheetRequest(id, agent, at) {
    let loaded;
    try { loaded = await requests.loadOne(id, at); } catch { return null; }
    const { request } = loaded;
    const own = request.preset === 'agent-avatar-sheet' && request.agent === agent && request.origin?.kind === 'owner' && validId(request.fromAsk) && await requests.siteWrote(id);
    return own ? loaded : null;
  }

  async function startSheet({ ask, avatar, answer, user, at }) {
    if (ask.requirePasskey !== true) return no('This Ask does not require a passkey, so it cannot start a run.');
    if (!/^[a-d]$/.test(answer.choice ?? '')) return no('That is not one of the four variants.');
    if (!avatar.subject) return no('The Ask names no Sprite Studio subject.');
    let verified;
    try {
      verified = await requests.verifiedRun(avatar.request, { preset: 'agent-avatar', at });
    } catch (error) {
      return no(error.message);
    }
    if (verified.request.agent !== avatar.agent) return no('That request was made for another agent.');
    const id = sheetRequestId(avatar.request);
    let found = false;
    try {
      await requests.createFixed({
        project: verified.request.project, preset: 'agent-avatar-sheet', agent: avatar.agent, fromAsk: ask.id, choice: answer.choice, subject: avatar.subject,
        text: `Sprite sheet for ${avatar.agent}, from variant ${answer.choice} of ${ask.id}`,
      }, { id, user, at });
    } catch (error) {
      if (error.status !== 409) return no(error.message);
      found = true;
    }
    if (found) {
      // Something is at that id. It counts only when the Hub made it for this agent; then a failed approve can be finished here.
      const mine = await ownSheetRequest(id, avatar.agent, at);
      if (!mine) return no('That request id is taken; nothing started.');
      // Still only proposed: an earlier approve failed, so this pick finishes it. Approved already: the same Ask is told so, another Ask is refused.
      if (mine.state !== 'proposed') return mine.request.fromAsk === ask.id ? { started: true, request: id, message: START_NOTE } : no('A sprite sheet run was already started for this avatar request.');
    }
    try {
      await requests.approveRequest(id, { target: 'pc', by: user, at });
    } catch (error) {
      log(`[hub] the sheet request ${id} was made but not approved: ${error.message}`);
      return no(`The sheet request was saved but not approved: ${error.message}. Picking again on an Ask for the same avatar request finishes it.`);
    }
    return { started: true, request: id, message: START_NOTE };
  }

  async function useSheet({ avatar, user, at }) {
    try {
      await chooseAvatar(avatar.agent, { kind: 'custom', sheet: avatar.sheet }, user, at);
    } catch (error) {
      return { chosen: false, why: error.message };
    }
    return { chosen: true, sheet: avatar.sheet };
  }

  /**
   * Called right after the create-only `answer.json` is written on the web path. Returns what to add to the response as
   * `avatar`, or null when the Ask is no avatar Ask or the answer starts nothing. Never throws.
   */
  async function afterAnswer({ ask, answer, user, at }) {
    if (!ask || ask.avatar === undefined || !answer?.choice) return null;
    const avatar = checkAvatarField(ask.avatar);
    if (!avatar || !agents.includes(avatar.agent)) return no('The Ask names no known agent.');
    try {
      if (avatar.sheet) return answer.choice === 'use' ? await useSheet({ avatar, user, at }) : null;
      return await startSheet({ ask, avatar, answer, user, at });
    } catch (error) {
      log(`[hub] avatar answer for ${ask.id} failed: ${error.message}`);
      return no('That did not work.');
    }
  }

  return { afterAnswer };
}
