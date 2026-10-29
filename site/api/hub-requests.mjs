// Requests in the Hub: the schema of `request.json`, the files that sit beside it, the state they add up
// to, the detail of one request, and Decline and Mark done. hub.mjs creates this module and delegates the
// `/hub/requests*` routes to it; the pure parts (the state table, the list row) live in hub-model.mjs so
// that Work and the tests can use them without a bucket.
//
// A request is a folder `requests/<id>/` of create-only files. Its state is never stored: it is derived
// from which files exist (docs/workspaces.md, "Requests"). Every file the server writes for itself is
// written with `ifNoneMatch: '*'`; a 412 means someone wrote it first and is answered with a 409.
import { checkDrawing } from './card-writes.mjs';
import { RULES, presetOf, presetsForClient, renderBrief, route } from './presets.mjs';
import { WHEN, newRequestId, requestItem, requestState, runFileTime, validId, validProject } from './hub-model.mjs';

/** The needs a request may name. */
export const NEEDS = ['unity', 'gpu', 'comfyui', 'sprite-studio', 'lan', 'local-files'];
/** Where a request may run: the proposal in `request.json`, and the final target in `approved.json` (never `at-pc`). */
export const TARGETS = ['pc', 'cloud', 'hermes', 'at-pc'];
export const ORIGIN_KINDS = ['owner', 'agent', 'run'];
export const REQUEST_LIMITS = { text: 4000, title: 120, doneWhen: 400, reason: 400, summary: 500, question: 600, answer: 2000, followSummary: 500, name: 80 };
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const PRESET_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** How many run and fire files the detail lists. */
const LIST_CAP = 20;

const text = (value, max, what, { required = false } = {}) => {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean) {
    if (required) throw Object.assign(new Error(`${what} is 1 to ${max} characters.`), { status: 400 });
    return undefined;
  }
  if (clean.length > max) throw Object.assign(new Error(`${what} is 1 to ${max} characters.`), { status: 400 });
  return clean;
};

/**
 * Check what a request is made from and return the clean fields. Throws a 400 in plain English. `raw` holds
 * `project`, `text` and either `when` (a legacy request) or `preset`; the optional fields are `title`, `repo`,
 * `needs`, `target`, `doneWhen`, `replaces`, `origin` and `followUp`. Unknown fields are dropped. The id, the
 * time and the author are the server's to add.
 *
 * `fromOwner` is true only for the site API acting for a signed-in person: it alone may set `origin.kind`
 * `owner` or a `followUp`. A request an agent makes (the card API, `cards request create`) never is.
 */
export function checkRequest(raw, { fromOwner = false } = {}) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const data = raw && typeof raw === 'object' ? raw : {};
  if (!validProject(data.project)) throw fail('Name the project (lower-case letters, digits and dashes).');
  const body = text(data.text, REQUEST_LIMITS.text, 'A request', { required: true });
  const out = { project: data.project, text: body };
  if (data.preset !== undefined && data.preset !== null) {
    if (typeof data.preset !== 'string' || !PRESET_RE.test(data.preset)) throw fail('That preset is not a name.');
    out.preset = data.preset;
  } else {
    if (!WHEN.includes(data.when)) throw fail('Say when: next-sprint, nightly or record.');
    out.when = data.when;
  }
  const title = text(data.title, REQUEST_LIMITS.title, 'A title');
  if (title) out.title = title;
  if (data.repo !== undefined && data.repo !== null && data.repo !== '') {
    if (typeof data.repo !== 'string' || !REPO_RE.test(data.repo)) throw fail('The repo is owner/name.');
    out.repo = data.repo;
  }
  if (data.needs !== undefined && data.needs !== null) {
    if (!Array.isArray(data.needs) || data.needs.some(need => !NEEDS.includes(need))) throw fail(`Needs are any of: ${NEEDS.join(', ')}.`);
    out.needs = [...new Set(data.needs)];
  }
  if (data.target !== undefined && data.target !== null && data.target !== '') {
    if (!TARGETS.includes(data.target)) throw fail('The target is pc, cloud, hermes or at-pc.');
    out.target = data.target;
  }
  const doneWhen = text(data.doneWhen, REQUEST_LIMITS.doneWhen, '"Done when"');
  if (doneWhen) out.doneWhen = doneWhen;
  if (data.replaces !== undefined && data.replaces !== null && data.replaces !== '') {
    if (!validId(data.replaces)) throw fail('"Replaces" is a request id.');
    out.replaces = data.replaces;
  }
  if (data.origin !== undefined && data.origin !== null) {
    const origin = data.origin;
    if (typeof origin !== 'object' || Array.isArray(origin) || !ORIGIN_KINDS.includes(origin.kind)) throw fail('The origin is { kind: owner, agent or run, name }.');
    if (origin.kind === 'owner' && !fromOwner) throw fail('Only the site can mark a request as the owner\'s.');
    const name = text(origin.name, REQUEST_LIMITS.name, 'The origin name');
    out.origin = { kind: origin.kind, ...(name ? { name } : {}) };
  }
  if (data.followUp !== undefined && data.followUp !== null) {
    if (!fromOwner) throw fail('Only the site can add a follow-up.');
    const follow = data.followUp;
    if (typeof follow !== 'object' || Array.isArray(follow) || !validId(follow.from)) throw fail('A follow-up names the request it follows.');
    out.followUp = {
      from: follow.from,
      question: text(follow.question, REQUEST_LIMITS.question, 'The follow-up question', { required: true }),
      answer: text(follow.answer, REQUEST_LIMITS.answer, 'The follow-up answer', { required: true }),
      summary: text(follow.summary, REQUEST_LIMITS.followSummary, 'The follow-up summary') ?? '',
    };
  }
  return out;
}

/**
 * @param bucket        the s3.mjs bucket
 * @param key           `inboxKey` bound to this hub's prefix and inbox
 * @param cached        reads a create-only JSON file through the cache (null when missing)
 * @param putCreateOnly writes a file with `ifNoneMatch: '*'`, throwing the given error on a 412
 * @param listFolders   `(root, at) → Map<id, Set<file name>>` for this month and the one before
 * @param pool          bounded parallel map
 * @param projectRepo  `(project) → 'owner/name' | undefined`: the repo the project's section tracks
 * @param cloudRepos   `() → string[]`: repos with a cloud routine (none until cloud runs exist)
 * @param hooks         `{ hermesLive(id) → boolean, pcBusy(session) → boolean }`; the Hermes follower and the PC report
 *                      plug in here (both default to false)
 */
export function createRequests({ bucket, key, cached, putCreateOnly, listFolders, pool, fail, hooks = {}, projectRepo = async () => undefined, cloudRepos = () => [] }) {
  const live = { hermesLive: () => false, pcBusy: () => false, ...hooks };
  const clash = message => fail(message, 409);

  const newestRun = names => {
    let newest = null;
    for (const name of names) {
      const time = runFileTime(name);
      if (time !== null && (newest === null || time > newest)) newest = time;
    }
    return newest;
  };

  /** The state-bearing files of one request, read only when they exist. */
  async function readParts(id, names, request) {
    const read = file => (names.has(file) ? cached(`requests/${id}/${file}`) : null);
    const legacy = !request.preset;
    const [taken, approved, result] = await Promise.all([read('taken.json'), legacy ? null : read('approved.json'), legacy ? null : read('result.json')]);
    return { taken, approved, result };
  }

  const stateOf = (id, names, request, parts, at) => requestState({
    names, request, ...parts, newestRunAt: newestRun(names), hermesLive: live.hermesLive(id) === true, pcBusy: live.pcBusy, now: at,
  });

  /** Every request of this month and the one before, as list rows. */
  async function loadRequests(at) {
    const folders = await listFolders('requests', at);
    const rows = await pool(16, [...folders], async ([id, names]) => {
      if (!names.has('request.json') || !validId(id)) return null;
      const request = await cached(`requests/${id}/request.json`);
      if (!request || typeof request.text !== 'string') return null;
      const full = { ...request, id };
      const parts = await readParts(id, names, full);
      return requestItem(full, stateOf(id, names, full, parts, at), parts.taken, parts);
    });
    return rows.filter(Boolean);
  }

  /** The names directly inside `requests/<id>/`, or null when the folder has no request.json. */
  async function folderNames(id) {
    if (!validId(id)) throw fail('No such request.', 404);
    const base = key(`requests/${id}/request.json`).slice(0, -'request.json'.length);
    const { objects } = await bucket.list(base);
    const names = new Set(objects.map(object => object.key.slice(base.length)).filter(name => name && !name.includes('/')));
    if (!names.has('request.json')) throw fail('No such request.', 404);
    return names;
  }

  /** One request, its file names and the state-bearing files. 404 when it does not exist. */
  async function loadOne(id, at) {
    const names = await folderNames(id);
    const stored = await cached(`requests/${id}/request.json`);
    if (!stored || typeof stored.text !== 'string') throw fail('No such request.', 404);
    const request = { ...stored, id };
    const parts = await readParts(id, names, request);
    return { names, request, parts, state: stateOf(id, names, request, parts, at) };
  }

  /** The newest `limit` files of a family (`run-*`, `fire-*`), parsed, newest first; the stamp in the name sorts by time. */
  async function newestFiles(id, names, prefix, limit = LIST_CAP) {
    const picked = [...names].filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort().reverse().slice(0, limit);
    const bodies = await pool(8, picked, name => cached(`requests/${id}/${name}`));
    return bodies.filter(Boolean);
  }

  /** `GET /hub/requests/:id`. `approved` comes without its signed brief (`run.brief`): it is long and the run view does not show it. */
  async function requestDetail(id, at) {
    const { names, request, parts, state } = await loadOne(id, at);
    const read = file => (names.has(file) ? cached(`requests/${id}/${file}`) : null);
    const [stop, declined, hermesRun, retry, runs, fires] = await Promise.all([
      read('stop.json'), read('declined.json'), read('hermes-run.json'), read('hermes-retry.json'),
      newestFiles(id, names, 'run-'), newestFiles(id, names, 'fire-'),
    ]);
    const { approved } = parts;
    const shown = approved && approved.run ? { ...approved, run: Object.fromEntries(Object.entries(approved.run).filter(([name]) => name !== 'brief')) } : approved;
    return {
      request,
      state,
      ...(shown ? { approved: shown } : {}),
      ...(parts.taken ? { taken: parts.taken } : {}),
      runs,
      ...(parts.result ? { result: parts.result } : {}),
      ...(hermesRun ? { hermesRun } : {}),
      ...(retry ? { retry } : {}),
      fires,
      ...(stop ? { stop } : {}),
      ...(declined ? { declined } : {}),
      files: [...names].sort(),
      report: names.has('report.md'),
    };
  }

  /**
   * `POST /hub/requests`. The legacy body is `{ project, text, when, drawing? }`. With a `preset` it is
   * `{ project, text, title?, preset, repo?, needs?, target?, doneWhen?, replaces?, drawing? }`: the request is
   * the owner's (`origin.kind: owner`, set here and never taken from the body) and carries the proposed target.
   */
  async function createRequest(data, user, at) {
    const { origin: _origin, followUp: _followUp, ...body } = data ?? {};
    const clean = checkRequest(body, { fromOwner: true });
    const preset = clean.preset ? presetOf(clean.preset) : null;
    if (clean.preset && !preset) throw fail('There is no such preset.', 400);
    if (preset && !user) throw fail('Sign in to send a job.', 401);
    let proposal = {};
    if (preset) {
      const repo = clean.repo ?? (preset.fields.includes('repo') ? await projectRepo(clean.project) : undefined);
      const needs = clean.needs ?? (preset.needs.length ? preset.needs : undefined);
      if (clean.target && clean.target !== 'at-pc' && !preset.targets.includes(clean.target)) throw fail(`${preset.label} runs on ${preset.targets.join(' or ')}.`, 400);
      const routed = route({ preset, project: clean.project, needs: needs ?? [], repo, cloudRepos: cloudRepos() });
      proposal = {
        ...(clean.title ? { title: clean.title } : {}), preset: preset.id, ...(repo ? { repo } : {}), ...(needs ? { needs } : {}),
        target: clean.target ?? routed.target, ...(clean.doneWhen ? { doneWhen: clean.doneWhen } : {}),
        origin: { kind: 'owner', name: user }, ...(clean.replaces ? { replaces: clean.replaces } : {}),
      };
      proposal.why = clean.target ? 'you chose it' : routed.why;
    }
    const checked = data.drawing ? checkDrawing({ scene: data.drawing.scene, png: data.drawing.png }) : null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = newRequestId(clean.project, clean.text, at);
      const conflict = fail('Could not find a free id; try again.', 409);
      try {
        const { why, ...stored } = proposal;
        const request = { id, project: clean.project, createdAt: at.toISOString(), by: user || 'local', text: clean.text, ...(preset ? stored : { when: clean.when }) };
        if (checked) {
          await putCreateOnly(`requests/${id}/request.excalidraw`, checked.sceneText, 'application/json', conflict);
          await putCreateOnly(`requests/${id}/request.png`, checked.pngBuffer, 'image/png', conflict);
          request.drawing = { excalidraw: 'request.excalidraw', png: 'request.png' };
        }
        await putCreateOnly(`requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}
`, 'application/json', conflict);
        return { status: 201, body: { id, ...(preset ? { target: request.target, why } : {}) } };
      } catch (error) {
        if (error !== conflict || attempt === 2) throw error;
      }
    }
    throw fail('Could not find a free id; try again.', 409);
  }

  /** `GET /hub/presets`, `/hub/presets/route?preset=&project=&repo=` and `/hub/presets/brief?request=<id>`. */
  async function presetRoutes(path, query, at) {
    if (path === '/hub/presets') return { presets: presetsForClient(), rules: RULES };
    if (path === '/hub/presets/route') {
      const preset = presetOf(query.get('preset'));
      if (!preset) throw fail('There is no such preset.', 400);
      const project = query.get('project') ?? '';
      if (!validProject(project)) throw fail('Name the project.', 400);
      const repo = query.get('repo') || (preset.fields.includes('repo') ? await projectRepo(project) : undefined);
      return route({ preset, project, repo: repo || undefined, cloudRepos: cloudRepos() });
    }
    if (path === '/hub/presets/brief') {
      const { request } = await loadOne(query.get('request') ?? '', at);
      const preset = presetOf(request.preset);
      if (!preset || request.target !== 'at-pc') throw fail('Only a request you start at the PC has a brief to copy.', 400);
      return { brief: renderBrief({ preset, request }) };
    }
    throw fail('Not found', 404);
  }

  /** `POST /hub/requests/:id/decline { reason? }`: only a request nobody has acted on (open, proposed or expired). */
  async function declineRequest(id, raw, user, at) {
    const { state } = await loadOne(id, at);
    if (state === 'declined') throw fail('That request is already declined.', 409);
    if (!['open', 'proposed', 'expired'].includes(state)) {
      throw fail(state === 'approved' ? 'That request is approved: stop it instead.' : `That request is ${state}; it can no longer be declined.`, 409);
    }
    const reason = text(raw?.reason, REQUEST_LIMITS.reason, 'A reason');
    const body = { at: at.toISOString(), by: user, ...(reason ? { reason } : {}) };
    await putCreateOnly(`requests/${id}/declined.json`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', clash('That request is already declined.'));
    return { status: 201, body: { state: 'declined' } };
  }

  /** `POST /hub/requests/:id/done { summary? }`: Mark done on a request the owner runs at the PC. Not signed. */
  async function doneRequest(id, raw, user, at) {
    const { request, state } = await loadOne(id, at);
    if (request.preset === undefined || request.target !== 'at-pc') throw fail('Only a request for the PC (at-pc) is marked done by hand.', 400);
    if (state !== 'proposed') throw fail(`That request is ${state}.`, 409);
    const summary = text(raw?.summary, REQUEST_LIMITS.summary, 'The summary');
    const body = { v: 1, outcome: 'manual', ...(summary ? { summary } : {}), by: 'hub', at: at.toISOString() };
    await putCreateOnly(`requests/${id}/result.json`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', clash('That request already has a result.'));
    return { status: 201, body: { state: 'done' } };
  }

  /** The POST routes under `/hub/requests/:id/`. Each needs a signed-in user, even where REQUIRE_REMOTE_USER is off. */
  const actions = { decline: declineRequest, done: doneRequest };

  async function post(id, action, raw, user, at) {
    if (!Object.hasOwn(actions, action)) throw fail('Not found', 404);
    if (!user) throw fail('Sign in to do that.', 401);
    return actions[action](id, raw, user, at);
  }

  return { loadRequests, detail: requestDetail, create: createRequest, presets: presetRoutes, post, loadOne, stateOf, hooks: live };
}
