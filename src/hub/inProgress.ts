// Chats whose reply is still coming, and the jobs they started, kept on this device so nothing in progress disappears from view
// because one read of the Hub came back without it. No React here: the list screen, the thread and the Jobs view read it through
// useInProgress.ts. Stored in localStorage; when storage is blocked or full the list lives in memory and the app carries on.
import type { ChatJob, ChatLine, ChatSummary, JobListRow } from '../lib/hub'
import { LIVE_JOB } from './jobStates.ts'

export const STORE_KEY = 'buw.hub.inProgress.v1'
/** A reply that was not confirmed after this long is shown as unconfirmed, not dropped (the same two hours as a delegate with no result). */
export const LIMIT_MS = 2 * 60 * 60 * 1000
/** A job entry no read ever settled is dropped after this. */
export const JOB_LIMIT_MS = 24 * 60 * 60 * 1000
export const MAX_CHATS = 20
export const MAX_JOBS = 50
export const MAX_BYTES = 64 * 1024
export const WRITE_EVERY_MS = 1000
const TERMINAL = new Set(['done', 'failed', 'stopped', 'declined', 'expired'])
const PICTURE_NOTE = '[Picture not kept on this device]'

/** One chat whose turn has not been seen saved. `id` is null until the Hub names the chat. */
export interface ChatEntry {
  key: string
  id: string | null
  title: string
  persona: string | null
  model: string | null
  startedAt: string
  /** The lines shown when the turn started, then the owner's message of this turn. */
  lines: ChatLine[]
  /** How many lines (not counting the context line) the chat had before this turn. */
  base: number
  ask: { text: string; at: string }
  /** The reply so far. */
  reply: string
  /** The ids of the jobs the turn started. */
  jobs: string[]
}
export interface JobEntry { chat: string; addedAt: string; job: ChatJob }
export interface Store { chats: ChatEntry[]; jobs: JobEntry[] }

/** A chat row as the list draws it: the Hub's row, or one made from an entry. */
export type ListRow = ChatSummary & {
  /** `replying`: a turn is in progress here. `unconfirmed`: the Hub never confirmed it. `sending`: it has no id yet. */
  local?: 'replying' | 'unconfirmed' | 'sending'
  /** What the search matches besides the title: the entry's lines and reply, lower case. */
  haystack?: string
  jobsRunning?: number
  key?: string
}

const EMPTY: Store = { chats: [], jobs: [] }
const countOf = (lines: ChatLine[]) => lines.filter(line => line.role !== 'context').length
const time = (iso: string | null | undefined) => { const value = iso ? new Date(iso).getTime() : NaN; return Number.isNaN(value) ? 0 : value }
const clip = (text: string, length: number) => text.trim().slice(0, length)

export const expired = (entry: { startedAt: string }, now = Date.now()) => now - time(entry.startedAt) > LIMIT_MS
export const jobExpired = (entry: JobEntry, now = Date.now()) => now - time(entry.addedAt) > JOB_LIMIT_MS
export const isTerminal = (state: string) => TERMINAL.has(state)

/** A line as it is kept: no pictures (a plain note in their place). */
export function plainLine(line: ChatLine & { previews?: string[] }): ChatLine {
  const { images, previews, ...rest } = line
  const pictures = (images?.length ?? 0) + (previews?.length ?? 0)
  return pictures ? { ...rest, text: rest.text ? `${rest.text}\n${PICTURE_NOTE}` : PICTURE_NOTE } : rest
}

/** The lines the thread shows for an entry: what was shown, the owner's message, and the reply so far. */
export function cachedLines(entry: ChatEntry): ChatLine[] {
  return entry.reply ? [...entry.lines, { role: 'assistant', text: entry.reply, at: entry.ask.at, ...(entry.jobs.length ? { jobs: entry.jobs } : {}) }] : entry.lines
}

/** Whether the saved lines hold this turn: the owner's message where it was added, answered (or stopped before any reply). */
export function turnSaved(messages: ChatLine[], entry: Pick<ChatEntry, 'base' | 'ask'>): boolean {
  const lines = messages.filter(line => line.role !== 'context')
  const mine = lines[entry.base]
  return !!mine && mine.role === 'user' && (!entry.ask.text || mine.text === entry.ask.text) && (lines[entry.base + 1]?.role === 'assistant' || !!mine.stopped)
}

/** What a read of the thread means for an entry. `live`: it is running, follow the stream. `saved`: the entry is done. `keep`: show the device's lines. */
export type Verdict = { kind: 'live' } | { kind: 'saved' } | { kind: 'keep'; lines: ChatLine[] } | { kind: 'server' }
export function judge(entry: ChatEntry, answer: { messages: ChatLine[]; running?: boolean }): Verdict {
  if (answer.running) return { kind: 'live' }
  if (turnSaved(answer.messages, entry)) return { kind: 'saved' }
  const device = cachedLines(entry)
  return countOf(answer.messages) < countOf(device) ? { kind: 'keep', lines: device } : { kind: 'server' }
}

// ---- the store

let store: Store = EMPTY
let loaded = false
const listeners = new Set<() => void>()
const warned = new Set<string>()

const storage = (): Storage | null => { try { return globalThis.localStorage ?? null } catch { return null } }

function parse(raw: string | null): Store {
  try {
    const value = JSON.parse(raw ?? '') as Partial<Store>
    const chats = Array.isArray(value.chats) ? value.chats.filter(entry => entry && typeof entry.key === 'string' && Array.isArray(entry.lines) && entry.ask) : []
    const jobs = Array.isArray(value.jobs) ? value.jobs.filter(entry => entry && entry.job && typeof entry.job.id === 'string' && typeof entry.chat === 'string') : []
    return { chats, jobs }
  } catch { return EMPTY }
}

function load() {
  if (loaded) return
  loaded = true
  const disk = storage()
  if (!disk) return
  try { store = parse(disk.getItem(STORE_KEY)) } catch { /* blocked: memory only */ }
}

const emit = () => listeners.forEach(listener => listener())

/** Keeps an entry inside the text limit: the oldest earlier lines go first, then the start of the reply. The owner's message always stays. */
export function fit(entry: ChatEntry): ChatEntry {
  const size = (value: ChatEntry) => JSON.stringify([value.lines, value.reply]).length
  let next = entry
  while (size(next) > MAX_BYTES && next.lines.length > 1) next = { ...next, lines: next.lines.slice(1), base: Math.max(0, next.base - 1) }
  if (size(next) > MAX_BYTES) next = { ...next, reply: next.reply.slice(-Math.max(0, MAX_BYTES - size({ ...next, reply: '' }) - 64)) }
  return next
}

export function cap(next: Store, now = Date.now()): Store {
  let chats = next.chats
  if (chats.length > MAX_CHATS) {
    // Oldest first, an unconfirmed one before a fresh one.
    const order = [...chats].sort((a, b) => Number(expired(b, now)) - Number(expired(a, now)) || time(a.startedAt) - time(b.startedAt))
    const drop = new Set(order.slice(0, chats.length - MAX_CHATS).map(entry => entry.key))
    chats = chats.filter(entry => !drop.has(entry.key))
  }
  let jobs = next.jobs.filter(entry => !jobExpired(entry, now))
  if (jobs.length > MAX_JOBS) {
    const drop = new Set([...jobs].sort((a, b) => time(a.addedAt) - time(b.addedAt)).slice(0, jobs.length - MAX_JOBS).map(entry => entry.job.id))
    jobs = jobs.filter(entry => !drop.has(entry.job.id))
  }
  return { chats, jobs }
}

function write() {
  const disk = storage()
  if (!disk) return
  try { disk.setItem(STORE_KEY, JSON.stringify(store)) } catch {
    // Full: keep the newest half and try once more. Blocked: memory only.
    try {
      store = { chats: store.chats.slice(-Math.ceil(store.chats.length / 2)), jobs: store.jobs.slice(-Math.ceil(store.jobs.length / 2)) }
      disk.setItem(STORE_KEY, JSON.stringify(store))
    } catch { /* memory only */ }
  }
}

function commit(next: Store) {
  store = cap(next)
  write()
  emit()
}

export function getStore(): Store { load(); return store }
export function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Drops what a test or a sign-out left behind, in memory and on disk. */
export function clearInProgress() {
  load()
  pending.clear()
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  commit(EMPTY)
}

/** Another tab wrote the list: read it again. */
export function reloadFromStorage() {
  const disk = storage()
  if (!disk) return
  try { store = parse(disk.getItem(STORE_KEY)); loaded = true; emit() } catch { /* blocked */ }
}

// ---- the reply, written at most about once a second

const pending = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | undefined

/** Writes the replies waiting to be written. Called by the timer, when the page hides, and when a turn ends. */
export function flushReplies() {
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  if (!pending.size) return
  const waiting = new Map(pending)
  pending.clear()
  commit({ ...store, chats: store.chats.map(entry => (waiting.has(entry.key) ? fit({ ...entry, reply: waiting.get(entry.key)! }) : entry)) })
}

/** The reply so far for an entry. Ignored when the entry is gone (dismissed, deleted or settled). */
export function setReply(key: string, reply: string, now = false) {
  load()
  if (!store.chats.some(entry => entry.key === key)) return
  pending.set(key, reply)
  if (now) { flushReplies(); return }
  if (timer === undefined) timer = setTimeout(flushReplies, WRITE_EVERY_MS)
}

// ---- changes

export interface Begin { id: string | null; title: string; persona: string | null; model: string | null; before: ChatLine[]; owner: ChatLine & { previews?: string[] }; now?: number }

/** A turn begins (sent here, or seen running in a chat that was opened). The same turn begun twice keeps its entry. Returns the entry's key. */
export function beginChat(input: Begin): string {
  load()
  const same = store.chats.find(entry => !!input.id && entry.id === input.id && !!input.owner.text && entry.ask.text === input.owner.text)
  if (same) return same.key
  const key = `c${Math.random().toString(36).slice(2, 10)}`
  const lines = [...input.before.map(line => plainLine(line)), plainLine(input.owner)]
  const entry = fit({
    key, id: input.id, title: input.title, persona: input.persona, model: input.model, startedAt: new Date(input.now ?? Date.now()).toISOString(),
    lines, base: countOf(input.before), ask: { text: input.owner.text, at: input.owner.at }, reply: '', jobs: [],
  })
  commit({ ...store, chats: [...store.chats.filter(other => !(input.id && other.id === input.id)), entry] })
  return key
}

/** The Hub named the chat. */
export function setChatId(key: string, id: string) {
  load()
  if (!store.chats.some(entry => entry.key === key && entry.id !== id)) return
  commit({ ...store, chats: store.chats.map(entry => (entry.key === key ? { ...entry, id } : entry)) })
}

/** A turn named jobs: each is kept at once, as a plain row until a read gives its details. */
export function addJobIds(key: string, ids: string[], now = Date.now()) {
  load()
  const entry = store.chats.find(item => item.key === key)
  if (!entry || !ids.length) return
  const chat = entry.id ?? entry.key
  const fresh = ids.filter(id => !store.jobs.some(job => job.job.id === id))
  commit({
    chats: store.chats.map(item => (item.key === key ? { ...item, jobs: [...new Set([...item.jobs, ...ids])] } : item)),
    jobs: [...store.jobs, ...fresh.map(id => ({ chat, addedAt: new Date(now).toISOString(), job: placeholderJob(id) }))],
  })
}

/** What a job row says before any read gave its details: a job Hermes proposed in the reply. */
export const placeholderJob = (id: string): ChatJob => ({ id, title: 'A job this chat started', text: '', project: '', writer: '', verified: false, state: 'proposed', approvable: false, why: 'Open it to approve.', by: '' })

/** A read of a chat's jobs: a job that finished leaves; one still going (or named by this chat's turn) is kept with its newest details. */
export function noteJobs(chat: string, read: ChatJob[]) {
  load()
  const mine = store.chats.find(entry => entry.id === chat)
  let jobs = store.jobs
  let changed = false
  for (const job of read) {
    const held = jobs.find(entry => entry.job.id === job.id)
    if (isTerminal(job.state)) {
      if (held) { jobs = jobs.filter(entry => entry.job.id !== job.id); changed = true }
    } else if (held || LIVE_JOB.has(job.state) || mine?.jobs.includes(job.id)) {
      const next = { chat, addedAt: held?.addedAt ?? new Date().toISOString(), job }
      jobs = held ? jobs.map(entry => (entry.job.id === job.id ? next : entry)) : [...jobs, next]
      changed = true
    }
  }
  if (changed) commit({ ...store, jobs })
}

/** A read of the Jobs view: finished jobs leave. */
export function noteJobRows(rows: Pick<JobListRow, 'id' | 'state'>[]) {
  load()
  const done = new Set(rows.filter(row => isTerminal(row.state)).map(row => row.id))
  if (store.jobs.some(entry => done.has(entry.job.id))) commit({ ...store, jobs: store.jobs.filter(entry => !done.has(entry.job.id)) })
}

/** The Hub's answer for a chat's thread shows the turn saved: the entry leaves. Returns the verdict. */
export function settleChat(id: string, answer: { messages: ChatLine[]; running?: boolean }): Verdict | null {
  load()
  const entry = store.chats.find(item => item.id === id)
  if (!entry) return null
  const verdict = judge(entry, answer)
  if (verdict.kind === 'saved') { pending.delete(entry.key); commit({ ...store, chats: store.chats.filter(item => item.key !== entry.key) }) }
  return verdict
}

/** The Hub's list: entries whose chat shows the turn saved leave, and one that had no id yet takes the id of the row it became. */
export function settleList(rows: ChatSummary[]) {
  load()
  const taken = new Set(store.chats.map(entry => entry.id).filter(Boolean))
  let changed = false
  const chats: ChatEntry[] = []
  for (const entry of store.chats) {
    let current = entry
    if (!current.id) {
      const match = rows.find(row => !taken.has(row.id) && row.title === clip(current.ask.text, 60) && time(row.updated) >= time(current.startedAt) - 5 * 60 * 1000)
      if (match) { taken.add(match.id); current = { ...current, id: match.id }; changed = true }
    }
    const row = current.id ? rows.find(item => item.id === current.id) : undefined
    if (row && listSaved(row, current)) { changed = true; pending.delete(current.key); continue }
    chats.push(current)
  }
  if (changed) commit({ ...store, chats })
}

/** The Hub's row shows the turn saved: it is not running and holds the owner's message and a reply. */
export const listSaved = (row: ChatSummary, entry: ChatEntry) => !row.running && row.count >= entry.base + 2

export function dismissKey(key: string) {
  load()
  pending.delete(key)
  if (store.chats.some(entry => entry.key === key)) commit({ ...store, chats: store.chats.filter(entry => entry.key !== key) })
}

/** The owner deleted or archived the chat: it must not come back. */
export function dismissChat(id: string) {
  load()
  const gone = store.chats.filter(entry => entry.id === id)
  if (!gone.length) return
  gone.forEach(entry => pending.delete(entry.key))
  commit({ ...store, chats: store.chats.filter(entry => entry.id !== id) })
}

export const entryFor = (id: string | undefined | null, from: Store = getStore()) => (id ? from.chats.find(entry => entry.id === id) : undefined)

// ---- merging

/**
 * The Hub's chat rows with the entries: the Hub's row wins, but keeps a running mark while the entry says a turn is in progress and the
 * Hub has not shown it saved. An entry the Hub does not list gets a row of its own, at the top with the other running chats.
 */
export function mergeChats(rows: ChatSummary[], from: Store, now = Date.now()): ListRow[] {
  const byId = new Map(from.chats.filter(entry => entry.id).map(entry => [entry.id!, entry]))
  const jobsOf = (id: string) => from.jobs.filter(entry => entry.chat === id && !jobExpired(entry, now) && LIVE_JOB.has(entry.job.state)).length
  const text = (entry: ChatEntry) => `${entry.title}\n${cachedLines(entry).map(line => line.text).join('\n')}`.toLowerCase()
  const status = (entry: ChatEntry) => (expired(entry, now) ? 'unconfirmed' as const : 'replying' as const)
  const listed = new Set(rows.map(row => row.id))
  const merged: ListRow[] = rows.map(row => {
    const entry = byId.get(row.id)
    const running = jobsOf(row.id)
    if (!entry || listSaved(row, entry)) return running ? { ...row, jobsRunning: running } : row
    return { ...row, running: true, local: status(entry), haystack: text(entry), key: entry.key, ...(running ? { jobsRunning: running } : {}) }
  })
  const own: ListRow[] = from.chats.filter(entry => !(entry.id && listed.has(entry.id))).map(entry => ({
    id: entry.id ?? '', key: entry.key, title: entry.title || 'New chat', updated: entry.startedAt, count: countOf(cachedLines(entry)), running: true,
    ...(entry.persona ? { persona: entry.persona } : {}), ...(entry.model ? { model: entry.model } : {}),
    local: entry.id ? status(entry) : expired(entry, now) ? 'unconfirmed' as const : 'sending' as const, haystack: text(entry), ...(entry.id && jobsOf(entry.id) ? { jobsRunning: jobsOf(entry.id) } : {}),
  })).sort((a, b) => time(b.updated) - time(a.updated))
  return [...own, ...merged]
}

/** Entries the Hub's list does not hold, for the console note: only ones that have been waiting a while. */
export function missingFromList(rows: ChatSummary[], from: Store, now = Date.now(), after = 30_000) {
  return from.chats.filter(entry => entry.id && !rows.some(row => row.id === entry.id) && now - time(entry.startedAt) > after)
}

/** A chat's job rows: the Hub's rows win by id; a job the Hub's read lacks is drawn from the entry. In the order of `ids`. */
export function mergeChatJobs(server: ChatJob[], from: Store, chat: string | undefined, now = Date.now()): ChatJob[] {
  if (!chat) return server
  const held = from.jobs.filter(entry => entry.chat === chat && !jobExpired(entry, now) && !server.some(job => job.id === entry.job.id)).map(entry => entry.job)
  return held.length ? [...server, ...held] : server
}

/** The Jobs view's rows: the Hub's rows win by id; a job the Hub's read lacks is added, for the project in view. */
export function mergeJobRows(server: JobListRow[], from: Store, project = '', now = Date.now()): { rows: JobListRow[]; local: Set<string> } {
  const local = new Set<string>()
  const rows = [...server]
  for (const entry of from.jobs) {
    if (jobExpired(entry, now) || isTerminal(entry.job.state) || server.some(row => row.id === entry.job.id)) continue
    if (project && entry.job.project !== project) continue
    local.add(entry.job.id)
    rows.push({ id: entry.job.id, title: entry.job.title, project: entry.job.project, preset: entry.job.preset ?? '', state: entry.job.state, ...(entry.job.agent ? { agent: entry.job.agent } : {}), at: entry.addedAt, deliverables: [], pills: [] })
  }
  return { rows, local }
}

/** Says once, in the console, that the Hub lacks what this device holds. No message text. */
export function warnMissing(chat: string, device: number, server: number | null, startedAt: string, status: number | null, now = Date.now()) {
  const mark = `${chat}/${device}/${server}/${status}`
  if (warned.has(mark)) return
  warned.add(mark)
  console.warn('Hub is missing a chat this device holds', { chat, deviceLines: device, hubLines: server, status, secondsSinceStart: Math.round((now - time(startedAt)) / 1000) })
}

export const lineCount = (lines: ChatLine[]) => countOf(lines)

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('storage', event => { if (event.key === STORE_KEY || event.key === null) reloadFromStorage() })
  globalThis.addEventListener('pagehide', flushReplies)
  globalThis.addEventListener('visibilitychange', () => { if (globalThis.document?.visibilityState === 'hidden') flushReplies() })
}
