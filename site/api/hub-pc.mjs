// The Gaming PC's status file, turned into what Today shows: a summary for the PC tile and the
// Working now list. Pure: no S3, no clock of its own. `hub.mjs` finds the newest file and calls in.
//
// The file is written by the PC's report script (`inbox/pc/status-<stamp>.json`, create-only, at
// most 64 KB). It is an agent's file, so `validStatus` cleans every field and refuses what it
// cannot trust.
import { blockedAppUrl, blockedSessionUrl, deriveEventItems, validProject } from './hub-model.mjs';

export const STATUS_MAX_BYTES = 64 * 1024;
/** A status older than this means the PC is asleep or off (the script reports every minute). */
export const STALE_SECONDS = 15 * 60;
const MAX_SESSIONS = 30;
const HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const BANDS = ['idle', 'busy', 'heavy'];

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const num = (value, low, high) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : null);
/** The last segment of a path, so a full path never reaches the page. */
const lastSegment = (value, max) => clip(String(value ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '', max);

/** An ISO string or a finite epoch number (milliseconds) as an ISO string; '' for anything else. */
function isoOf(value) {
  const date = typeof value === 'number' && Number.isFinite(value) ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

const bandOf = util => (util >= 50 ? 'heavy' : util >= 10 ? 'busy' : 'idle');

function cleanSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
  if (!id) return null;
  const project = typeof raw.project === 'string' && validProject(raw.project) ? raw.project : '';
  const url = blockedSessionUrl(typeof raw.url === 'string' ? raw.url.slice(0, 500) : undefined);
  const appUrl = blockedAppUrl(raw.appUrl);
  const startedAt = isoOf(raw.startedAt);
  const updatedAt = isoOf(raw.updatedAt);
  return {
    id,
    name: clip(raw.name, 120),
    status: ['busy', 'idle'].includes(raw.status) ? raw.status : 'unknown',
    kind: clip(raw.kind, 30),
    folder: lastSegment(raw.folder, 80),
    repo: lastSegment(raw.repo, 80),
    ...(project ? { project } : {}),
    branch: clip(raw.branch, 120),
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(url ? { url } : {}),
    ...(appUrl ? { appUrl } : {}),
  };
}

/**
 * A clean status, or null when the file is not one this version reads (wrong `v`, bad host or
 * time, more than 30 sessions). Unknown fields are dropped; `runs` is always `[]` until M3b.
 */
export function validStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
  if (typeof raw.host !== 'string' || !HOST_RE.test(raw.host)) return null;
  const at = isoOf(raw.at);
  if (!at) return null;
  let sessions = null;
  if (Array.isArray(raw.sessions)) {
    if (raw.sessions.length > MAX_SESSIONS) return null;
    sessions = raw.sessions.map(cleanSession).filter(Boolean);
  }
  const gpuUtil = raw.gpu && typeof raw.gpu === 'object' ? num(raw.gpu.util, 0, 100) : null;
  const comfy = raw.comfy && typeof raw.comfy === 'object' ? raw.comfy : null;
  const unity = raw.unity && typeof raw.unity === 'object' ? raw.unity : null;
  return {
    v: 1,
    host: raw.host,
    at,
    reason: raw.reason === 'heartbeat' ? 'heartbeat' : 'change',
    inUse: raw.inUse === true,
    keepAwake: raw.keepAwake === true,
    gpu: gpuUtil === null ? null : {
      util: gpuUtil,
      memMB: num(raw.gpu.memMB, 0, 1e7) ?? 0,
      memTotalMB: num(raw.gpu.memTotalMB, 0, 1e7) ?? 0,
      band: BANDS.includes(raw.gpu.band) ? raw.gpu.band : bandOf(gpuUtil),
    },
    comfy: comfy ? { up: comfy.up === true, running: num(comfy.running, 0, 1000) ?? 0, pending: num(comfy.pending, 0, 1000) ?? 0 } : null,
    unity: unity ? {
      open: unity.open === true,
      projects: (Array.isArray(unity.projects) ? unity.projects : []).slice(0, 10).map(name => lastSegment(name, 80)).filter(Boolean),
    } : null,
    sessions,
    runs: [],
  };
}

const ageOf = (status, at) => Math.max(0, Math.floor((at.getTime() - new Date(status.at).getTime()) / 1000));

/** The PC tile: how old the file is, whether the PC counts as on, and the headline numbers. */
export function pcSummary(status, at) {
  const ageSeconds = ageOf(status, at);
  const sessions = status.sessions ?? [];
  return {
    host: status.host,
    at: status.at,
    ageSeconds,
    state: ageSeconds > STALE_SECONDS ? 'asleep-or-off' : 'on',
    inUse: status.inUse,
    keepAwake: status.keepAwake,
    gpu: status.gpu,
    comfy: status.comfy,
    unity: status.unity,
    sessions: { busy: sessions.filter(row => row.status === 'busy').length, idle: sessions.filter(row => row.status === 'idle').length },
  };
}

/** The Beads id in a branch name, for one project prefix: `sprint/ws-b1z.11-map-feel` is `ws-b1z.11`. */
export function beadOfBranch(branch, prefix) {
  if (typeof branch !== 'string' || typeof prefix !== 'string' || !/^[a-z0-9]{1,8}$/.test(prefix)) return null;
  return new RegExp(`(?:^|/)(${prefix}-[a-z0-9]{3,8}(?:\\.\\d+)*)(?=-|$)`).exec(branch)?.[1] ?? null;
}

const RANK = { 'needs-you': 0, working: 1, idle: 2 };

/**
 * The sessions at work now. With a fresh status the PC's sessions come from it (the events from
 * the PC's own host are dropped: the status is the truth there) and sessions on other hosts
 * come from `session-started` events. Without one it is today's event-derived list.
 * `defaults` is `PROJECT_DEFAULTS`; `events` is the whole window.
 */
export function workingNow({ status = null, events, at, defaults = [] }) {
  const derived = deriveEventItems(events);
  const fromEvents = host => derived.running
    .filter(item => !host || item.host !== host)
    .map(item => ({
      id: item.id, source: 'events', host: item.host ?? '', agent: 'claude', title: item.title,
      ...(item.project ? { project: item.project } : {}), ...(item.bead ? { bead: item.bead } : {}),
      state: 'working', since: item.at, ...(item.url ? { url: item.url } : {}),
    }));
  const fresh = status && status.sessions && pcSummary(status, at).state === 'on';
  if (!fresh) return fromEvents(null);

  const blocked = new Map(derived.blocked.filter(item => item.session).map(item => [item.session, item]));
  const items = status.sessions.map(row => {
    const stop = blocked.get(row.id);
    const prefix = defaults.find(entry => entry.id === row.project)?.prefix;
    const bead = row.branch && prefix ? beadOfBranch(row.branch, prefix) : null;
    const url = row.url ?? stop?.url;
    const appUrl = row.appUrl ?? stop?.appUrl;
    return {
      id: row.id, source: 'pc', host: status.host, agent: 'claude',
      title: row.name || row.folder || 'Session',
      ...(row.project ? { project: row.project } : {}), ...(row.branch ? { branch: row.branch } : {}), ...(bead ? { bead } : {}),
      state: stop ? 'needs-you' : row.status === 'busy' ? 'working' : 'idle',
      since: row.startedAt ?? status.at,
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(url ? { url } : {}), ...(appUrl ? { appUrl } : {}),
    };
  });
  return [...items, ...fromEvents(status.host)]
    .sort((a, b) => RANK[a.state] - RANK[b.state] || (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
}
