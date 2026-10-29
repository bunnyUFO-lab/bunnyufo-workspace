// Hermes asks before it writes to a protected instruction file. The follower (and, later, the Chat relay) copies
// each ask into `hermes-approvals/<id>/approval.json`; it is a Needs you row until a signed-in click answers it,
// the run ends, or Hermes gives up (it denies on its own after 300 seconds). The answer is forwarded to the run.
//
//   hermes-approvals/<id>/approval.json   the ask (site API, create-only)
//   hermes-approvals/<id>/answer.json     { choice, at, by, forwarded, error? } (site API, create-only)
//
// `<id>` is deterministic: `<yyyymmdd>-hermes-<4>-<4>` from the sha256 of run id and prompt id, so a second copy
// of the same approval hits a 412 and pings nothing.
import { createHash } from 'node:crypto';
import { day8, validId } from './hub-model.mjs';

export const APPROVAL_TTL_MS = 300_000;
/** The only answers the site forwards, whatever Hermes lists: a standing approval is never one click. */
export const ANSWERS = ['once', 'deny'];
const clip = (value, length) => String(value ?? '').slice(0, length);

export const approvalId = (runId, promptId, at) => {
  const digest = BigInt(`0x${createHash('sha256').update(`${runId}\n${promptId}`).digest('hex').slice(0, 14)}`).toString(36).padStart(8, '0').slice(0, 8);
  return `${day8(at)}-hermes-${digest.slice(0, 4)}-${digest.slice(4, 8)}`;
};

/**
 * @param runs         `() → createHermesRuns()` (a getter: the Hermes dispatch is built after this module)
 * @param notify       `createNotify()`
 * @param requestInfo  `(requestId) → Promise<{ project, hasResult }|null>`
 */
export function createHermesApprovals({ cached, putCreateOnly, listFolders, fail, now = () => new Date(), runs, notify, requestInfo, log = () => {}, scrub = text => String(text ?? '').replace(/https?:\/\/\S+/gi, '').slice(0, 120) }) {
  const EXISTS = Object.assign(new Error('exists'), { status: 409 });
  const busy = new Set();

  /**
   * Copy an `approval.request` into the inbox. Returns the id; pings only when this call wrote the file and the ask is
   * still open. The id depends on the run, the prompt and the day the run started, so a replay after a restart (even past
   * midnight) finds the same file. `createdAt` is when Hermes asked (the event's `timestamp`, in seconds); a control found
   * by polling has no such time and counts from now. Everything copied from Hermes is clipped.
   */
  async function copyApproval({ runId, request = null, chat = null, prompt, startedAt = null, polled = false, at = now() }) {
    const promptId = clip(prompt?.prompt_id ?? prompt?.request_id ?? '', 200);
    const run = clip(runId, 200);
    if (!run || !promptId) return null;
    const dayOf = startedAt && !Number.isNaN(new Date(startedAt).getTime()) ? new Date(startedAt) : at;
    const id = approvalId(run, promptId, dayOf);
    const asked = !polled && Number.isFinite(Number(prompt.timestamp)) ? Math.min(Number(prompt.timestamp) * 1000, at.getTime()) : at.getTime();
    const created = new Date(asked);
    const command = clip(prompt.command, 2000);
    const description = clip(prompt.description, 2000);
    const choices = (Array.isArray(prompt.choices) ? prompt.choices : []).filter(choice => typeof choice === 'string' && choice.length > 0 && choice.length <= 20).slice(0, 4);
    const body = {
      runId: run, requestId: promptId, promptId, executionGeneration: Number.isInteger(prompt.execution_generation) ? prompt.execution_generation : 1,
      request, chat, title: clip((description || command || 'Hermes asks to write a protected file').replace(/\s+/g, ' ').trim(), 200),
      detail: clip([command, description].filter(Boolean).join('\n\n'), 4000), command, description,
      choices: choices.length ? choices : [...ANSWERS],
      createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + APPROVAL_TTL_MS).toISOString(),
    };
    try {
      await putCreateOnly(`hermes-approvals/${id}/approval.json`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', EXISTS);
    } catch (error) {
      if (error === EXISTS) return id;
      throw error;
    }
    if (new Date(body.expiresAt).getTime() <= at.getTime()) return id; // Hermes has denied it by now: nothing to answer, nothing to ping
    const info = request ? await requestInfo(request).catch(() => null) : null;
    await notify.needsYou({ project: info?.project, text: `${body.title}\nAnswer within 5 minutes.`, link: '/#/~hub/needs/approval' });
    return id;
  }

  /** The open Hermes approvals, as Needs you rows, newest first. */
  async function loadOpen(at) {
    const folders = await listFolders('hermes-approvals', at);
    const rows = [];
    for (const [id, names] of folders) {
      if (!names.has('approval.json') || names.has('answer.json') || !validId(id)) continue;
      const approval = await cached(`hermes-approvals/${id}/approval.json`);
      if (!approval || new Date(approval.expiresAt).getTime() <= at.getTime()) continue;
      const info = approval.request ? await requestInfo(approval.request).catch(() => null) : null;
      if (info?.hasResult) continue;
      rows.push({
        kind: 'hermes-approval', id, title: approval.title, at: approval.createdAt, state: 'open', expiresAt: approval.expiresAt,
        project: info?.project ?? 'hermes', ...(approval.request ? { request: approval.request } : {}), ...(approval.chat ? { chat: approval.chat } : {}),
        command: approval.command, description: approval.description, choices: approval.choices,
      });
    }
    return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  /** `GET /hub/hermes-approvals/:id` */
  async function detail(id, at) {
    if (!validId(id)) throw fail('No such approval.', 404);
    const approval = await cached(`hermes-approvals/${id}/approval.json`);
    if (!approval) throw fail('No such approval.', 404);
    const answer = await cached(`hermes-approvals/${id}/answer.json`);
    const state = answer ? 'answered' : new Date(approval.expiresAt).getTime() <= at.getTime() ? 'expired' : 'open';
    return { approval, ...(answer ? { answer } : {}), state };
  }

  async function writeAnswer(id, body) {
    try {
      await putCreateOnly(`hermes-approvals/${id}/answer.json`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', EXISTS);
      return true;
    } catch (error) {
      if (error === EXISTS) return false;
      throw error;
    }
  }

  /**
   * `POST /hub/hermes-approvals/:id/answer { choice }`. Forwards to the run. When Hermes can no longer take it (it
   * denied after 300 seconds, or the run ended) the answer is still written, with `forwarded: false`, and the
   * route answers 409 with the reason.
   */
  async function answer(id, raw, user, at) {
    if (!validId(id)) throw fail('No such approval.', 404);
    const approval = await cached(`hermes-approvals/${id}/approval.json`);
    if (!approval) throw fail('No such approval.', 404);
    const choice = raw?.choice;
    if (!ANSWERS.includes(choice) || !approval.choices.includes(choice)) throw fail('The choice is once or deny.', 400);
    const first = await cached(`hermes-approvals/${id}/answer.json`);
    if (first) throw fail('That was already answered.', 409, { first });
    if (busy.has(id)) throw fail('That is being answered.', 409);
    busy.add(id);
    try {
      const base = { choice, at: at.toISOString(), by: user };
      const refuse = async error => {
        await writeAnswer(id, { ...base, forwarded: false, error });
        throw fail(error, 409);
      };
      if (new Date(approval.expiresAt).getTime() <= at.getTime()) await refuse('Hermes denied it after 5 minutes.');
      const info = approval.request ? await requestInfo(approval.request).catch(() => null) : null;
      if (info?.hasResult) await refuse('The run has already ended.');
      try {
        await runs().answer(approval.runId, { requestId: approval.requestId, executionGeneration: approval.executionGeneration, choice });
      } catch (error) {
        log(`[hub] Hermes did not take an approval answer: ${scrub(error.message, 120)}`);
        await refuse(error.status === 409 ? 'Hermes is no longer waiting for this answer.' : `Hermes did not take the answer: ${scrub(error.message, 120)}`);
      }
      if (!await writeAnswer(id, { ...base, forwarded: true })) throw fail('That was already answered.', 409);
      return { status: 201, body: { state: 'answered', choice } };
    } finally {
      busy.delete(id);
    }
  }

  return { copyApproval, loadOpen, detail, answer };
}
