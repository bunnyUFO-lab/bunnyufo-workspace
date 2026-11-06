import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import type { ChatApproval, ChatDelegate, ChatHeld, ChatJob, ChatLine, ChatListAnswer, ChatMarks, ChatModel, ChatPersona, ChatQueued, ChatQueueView, ChatTool, HelpPreview, Item } from '../lib/hub'
import { HubError, clock, hubGet, hubPost, remember } from '../lib/hub'
import { host } from '../lib/host'
import { hasFiles, pictureFiles } from '../lib/pastePictures.mjs'
import { hubHash, parseChatId, parseHelpId, reviewHash } from '../lib/route'
import { ROUTE_EVENT, afterPop, back, direction, entrySerial, skipGone, swap } from '../lib/entries'
import { useIsDesktop } from '../lib/chrome'
import type { HelpKind } from '../lib/route'
import { Icon } from '../local/Icons'
import { holdReload } from '../lib/reloadGate'
import { elapsedLabel } from './runLines'
import { StreamCut, plainText, streamChat, streamLive } from './chatStream'
import type { ChatHandlers } from './chatStream'
import { MAX_IMAGES, PICTURE_TYPES, prepareImage, toBase64 } from './chatImages'
import type { Prepared } from './chatImages'
import HubImage from './HubImage'
import JobsCard from './ChatJobs'
import { LIVE_JOB } from './jobStates'
import Md, { CodeBlock } from './Md'
import { splitFences } from './chatText'
import { useHubData } from './useHub'
import { onAsk, peekAsk, takeAsk } from './askHermes'
import './chatRuns.css'
import './chatChoice.css'
import { openSpawn } from './spawnStore'
import { takeHelpDraft } from './flash'
import { onChatStart, peekChatStart, takeChatStart } from './chatStart'
import { setFocus } from './needsFocus'
import Who from './ChatWho'
import ChatList, { ChatSetAside, RenameSheet } from './ChatList'
import { chatMenu, onChatMarks, restoreChat, setChatMarks, wasDeletedHere } from './chatActions'
import { Sheet } from '../ui/Sheet'
import RowMenu from '../ui/RowMenu'
import { IconButton } from '../ui/Controls'
import type { HubData } from './useHub'
import { chooseModel, pauseNote } from './chatModel'
import { MAX_MISSES, hasRunningDelegate, nextLookMs, replySaved, sameLines, type ChatAnswer } from './chatWatch'
import type { TeamAgent, TeamView } from '../lib/hubTeam'

const READ_KEY = 'buw.hub.readAloud'
const JOB = '__job'
const AUTO = 'auto'
const HERMES = 'hermes'   // persona: no persona, Hermes itself

/** What the tags call a model: its label, or the bare id when the server no longer lists it. */
/** A time in a pause note: the time today, with the weekday when it falls on another day. */
const pauseWhen = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : `${new Date(iso).toLocaleDateString([], { weekday: 'short' })} ${clock(iso)}`)
const nameOf = (models: ChatModel[], id: string) => models.find(entry => entry.id === id)?.label ?? id
/** The menu text: Auto says what it tries first, the paid ones say API, Codex (the ChatGPT plan) says neither. */
const menuLabel = (entry: ChatModel, autoFirst: string) => (entry.id === AUTO ? `${entry.label} · ${autoFirst} first` : /no API cost/.test(entry.note) ? entry.label : `${entry.label} · API`)

const openSameOrigin = (url: URL) => { window.location.assign(url.href) }

/** A line on screen. While a turn streams, a user line shows the tray's object URLs instead of saved files. */
type Shown = ChatLine & { previews?: string[] }

function Created({ items }: { items: Item[] }) {
  return (
    <div className="hub-created">
      {items.map(item => (
        <div className="hub-created-card" key={`${item.kind}-${item.id}`} data-created={item.kind}>
          <span className="hub-pill">{item.kind}</span>
          <span className="hub-created-title">{item.title}</span>
          <a className="hub-btn" href={item.kind === 'ask' ? hubHash('ask', item.id) : hubHash('request', item.id)}>Open</a>
        </div>
      ))}
    </div>
  )
}

/** Tools Hermes used or is using: one faint mono line each. */
function ToolLines({ tools }: { tools: ChatTool[] }) {
  if (!tools.length) return null
  return (
    <div className="hub-tools" data-tools>
      {tools.map(tool => <span className="hub-tool" key={tool.id || tool.name} data-state={tool.state} data-tool={tool.name}>{tool.name}{tool.summary ? ` ${tool.summary}` : ''}</span>)}
    </div>
  )
}

const DELEGATE_TOOL = 'delegate_task'
const DELEGATE_LABEL: Record<ChatDelegate['state'], string> = { running: 'Running', done: 'Finished', failed: 'Failed', unknown: 'No result' }
const DELEGATE_NOTE: Partial<Record<ChatDelegate['state'], string>> = {
  running: 'The result shows here when it finishes.',
  failed: 'Hermes gave no reason.',
  unknown: 'No result reached the Hub in two hours. Hermes may have restarted, so ask it here.',
}

function DelegateCard({ delegate }: { delegate: ChatDelegate }) {
  const [open, setOpen] = useState(false)
  const note = DELEGATE_NOTE[delegate.state]
  return (
    <div className="hub-delegate" data-delegate={delegate.id} data-state={delegate.state}>
      <button type="button" className={`hub-delegate-goal${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(value => !value)} data-delegate-goal>{delegate.goal || 'Hermes did not send the goal.'}</button>
      <span className="hub-delegate-state" data-delegate-state>{DELEGATE_LABEL[delegate.state]}{delegate.seconds !== undefined ? ` · ${elapsedLabel(delegate.seconds * 1000)}` : ''}</span>
      {delegate.summary
        ? <details className="hub-delegate-result" data-delegate-result><summary>Result</summary><Md text={delegate.summary} onSameOrigin={openSameOrigin} copy breaks /></details>
        : note && <span className="hub-muted hub-delegate-note">{note}</span>}
    </div>
  )
}

/** What `delegate_task` started: each delegate's goal, how far it is, and its result. */
function Delegates({ items }: { items: ChatDelegate[] }) {
  if (!items.length) return null
  return (
    <div className="hub-delegates" data-delegates role="group" aria-label="Helpers Hermes started">
      <span className="hub-muted hub-delegates-head">Hermes started {items.length === 1 ? 'a helper' : `${items.length} helpers`}</span>
      <span className="hub-muted hub-delegates-sub" data-delegates-sub>Inside this chat. Not tracked as a job.</span>
      {items.map(delegate => <DelegateCard key={delegate.id} delegate={delegate} />)}
    </div>
  )
}

/** Hermes asks before writing a protected file. It denies on its own after five minutes. */
function ApprovalCard({ approval, onAnswered }: { approval: ChatApproval; onAnswered: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const left = Math.max(0, Math.ceil((new Date(approval.expiresAt).getTime() - now) / 1000))
  const answer = async (choice: 'once' | 'deny') => {
    if (!host.write) { setError('Sign in to answer.'); return }
    setBusy(true)
    setError('')
    try {
      await hubPost(`/hermes-approvals/${encodeURIComponent(approval.id)}/answer`, { choice })
      onAnswered()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send the answer.')
      setBusy(false)
    }
  }
  return (
    <div className="hub-chat-approval" data-chat-approval role="group" aria-label="Hermes asks for approval">
      <strong>{approval.title || 'Hermes asks to write a protected file'}</strong>
      {approval.command && <pre data-approval-command>{approval.command}</pre>}
      {approval.description && approval.description !== approval.title && <pre>{approval.description}</pre>}
      <div className="hub-chat-approval-a">
        {approval.choices.includes('once') && <button type="button" className="hub-btn pri" disabled={busy || left === 0} onClick={() => void answer('once')} data-answer="once">Approve once</button>}
        {approval.choices.includes('deny') && <button type="button" className="hub-btn" disabled={busy || left === 0} onClick={() => void answer('deny')} data-answer="deny">Deny</button>}
        <span className="hub-muted">{left > 0 ? `Hermes denies it in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'Hermes denied it after 5 minutes.'}</span>
      </div>
      {error && <span className="hub-error" role="alert">{error}</span>}
    </div>
  )
}

/** The page of the item a help chat is about (a session has none: it opens Needs you on its card). */
function itemLink(kind: HelpKind, id: string): { href: string; focus?: string } {
  if (kind === 'ask') return { href: hubHash('ask', id) }
  if (kind === 'checklist') return { href: hubHash('checklist', id) }
  if (kind === 'review') return { href: reviewHash(id) }
  return { href: hubHash('needs'), focus: `blocked-${id}` }
}

/**
 * Under the top bar of a help chat: what it is about, a way back to the item, and what Hermes was given. The text is
 * display only; the server builds it again from the stored item when the owner sends.
 */
function HelpBanner({ about, text, pictures }: { about: { kind: HelpKind; id: string; title: string } | null; text?: string; pictures: { path?: string; url?: string }[] }) {
  if (!about) return <p className="hub-help-banner hub-muted" data-help-banner data-gone>This item is no longer in the Hub.</p>
  const link = itemLink(about.kind, about.id)
  return (
    <div className="hub-help-banner" data-help-banner>
      <div className="hub-help-line">
        <span className="hub-help-title">Help with: {about.title}</span>
        <a className="hub-help-open" href={link.href} data-help-open onClick={() => { if (link.focus) setFocus(link.focus) }}>Open item</a>
      </div>
      {text && (
        <details className="hub-help-seen" data-help-seen>
          <summary>What Hermes sees</summary>
          <pre className="hub-help-text">{text}</pre>
          {pictures.length > 0 && <div className="hub-help-pics">{pictures.map(picture => <HubImage key={picture.path ?? picture.url} path={picture.path} url={picture.url} open className="hub-help-pic" alt="A picture Hermes sees" />)}</div>}
        </details>
      )}
    </div>
  )
}

/** The owner's own words as typed, with any fenced block shown as code (and its Copy button) instead of its backticks. */
function OwnerText({ text }: { text: string }) {
  return (
    <div className="hub-md">
      {splitFences(text).map((part, index) => part.kind === 'code'
        ? <CodeBlock key={index}><code className={part.lang ? `language-${part.lang}` : undefined}>{part.code}</code></CodeBlock>
        : <p key={index} className="hub-note-text">{part.text}</p>)}
    </div>
  )
}

function Bubble({ line, index, conversation, models, who, agents, jobs, onJobsChanged }: { line: Shown; index?: number; conversation?: string; models: ChatModel[]; who?: ChatPersona | null; agents: TeamAgent[]; jobs: ChatJob[]; onJobsChanged: () => void }) {
  const urls = line.previews ?? (conversation ? (line.images ?? []).map(image => `/api/hub/chat/${encodeURIComponent(conversation)}/images/${encodeURIComponent(image.file)}`) : [])
  return (
    <div className={`hub-bubble ${line.role}`} data-line={index}>
      {line.role === 'assistant' && who && <Who id={who.id} name={who.name} agents={agents} size={22} />}
      {line.role === 'assistant' ? <Md text={line.text} onSameOrigin={openSameOrigin} copy breaks /> : line.text && <OwnerText text={line.text} />}
      {urls.length > 0 && (
        <div className="hub-bubble-images" data-bubble-images>
          {urls.map((url, index) => <HubImage key={url} url={url} open className="hub-bubble-image" alt={`Picture ${index + 1}`} />)}
        </div>
      )}
      {line.tools && line.tools.length > 0 && <ToolLines tools={line.tools.filter(name => name !== DELEGATE_TOOL || !line.delegates?.length).map(name => ({ id: name, name, state: 'done' as const }))} />}
      {line.delegates && <Delegates items={line.delegates} />}
      {line.jobs && line.jobs.length > 0 && conversation && <JobsCard conversation={conversation} ids={line.jobs} jobs={jobs} onChanged={onJobsChanged} />}
      {line.created && line.created.length > 0 && <Created items={line.created} />}
      {line.role === 'assistant' && line.model && line.model !== AUTO && <span className="hub-muted hub-bubble-model" data-bubble-model>{nameOf(models, line.model)}</span>}
    </div>
  )
}

export default function Chat({ id }: { id?: string }) {
  if (!host.chat) return <p className="hub-empty">Chat is not set up on this host.</p>
  return <ChatScreen id={id} />
}

/**
 * The Chat screen. A phone shows one pane: the list at `chat`, a thread at `chat/<id>`, or the Archived and Trash lists. From 900 px
 * the list stays on the left and the thread (or one of those lists) fills the right. Only the panes that show are mounted.
 */
function ChatScreen({ id }: { id?: string }) {
  const desktop = useIsDesktop()
  const list = useHubData<ChatListAnswer>('/chat')
  const team = useHubData<TeamView>('/team')   // persona: the sprites of the picker, the header and the rows
  const agents = team.data?.agents ?? []
  const place = id === 'archived' || id === 'trash' ? id : null
  const blank = id === 'new'   // `chat/new`: the + button's address, a thread with nobody in it yet
  const target = parseChatId(place || blank ? undefined : id)
  // A start ("Chat with Researcher", Plan in Hermes) or a question from Search is waiting for a composer: on a phone the thread shows,
  // not the list, until the person leaves this address.
  const [wantedAt, setWantedAt] = useState(0)   // the history entry that has the start waiting
  const waiting = !target.id && !place && (!!peekChatStart() || !!peekAsk())
  if (waiting && wantedAt !== entrySerial()) setWantedAt(entrySerial())
  const wanted = wantedAt !== 0 && wantedAt === entrySerial()
  useEffect(() => {
    const want = () => { if (!target.id && !place) setWantedAt(entrySerial()) }
    const offStart = onChatStart(want)
    const offAsk = onAsk(want)
    return () => { offStart(); offAsk() }
  }, [target.id, place])
  const threadOnly = !!target.id || blank || wanted
  const thread = <ChatShell id={target.id} line={target.line} list={list} team={team} />
  const setAside = place ? <ChatSetAside view={place} agents={agents} personas={list.data?.personas ?? []} models={list.data?.models ?? []} /> : null
  const showList = desktop || (!place && !threadOnly)
  return (
    <div className="hub-chat" data-chat-screen={place ?? (threadOnly ? 'thread' : 'list')}>
      {showList && <aside className="hub-chat-pane list" aria-label="Conversations"><ChatList list={list} agents={agents} activeId={target.id} /></aside>}
      {setAside ? <section className="hub-chat-pane main">{setAside}</section> : (desktop || threadOnly) && thread}
    </div>
  )
}

// A start from Spawn always lands in a fresh conversation. On a new Chat that is already showing (it may be empty, or busy with a
// reply that is still streaming) the view is remounted, so it opens like New chat does: the agent's own model, no earlier pick,
// the text as a draft. On a stored conversation the address change to a new chat remounts it anyway.
function ChatShell({ id, line, list, team }: { id?: string; line?: number; list: HubData<ChatListAnswer>; team: HubData<TeamView> }) {
  const [fresh, setFresh] = useState(0)
  useEffect(() => onChatStart(() => { if (!id) setFresh(count => count + 1) }), [id])
  return <ChatView key={`${id ?? 'new'}-${fresh}`} id={id} line={line} list={list} team={team} />
}

// A new conversation gets its address when its first reply is done; what is on screen travels to the new view.
let carried: { id: string; lines: Shown[]; model: string; persona: string } | null = null

const carry = (id: string, lines: Shown[], model: string, persona: string) => { carried = { id, lines, model, persona } }

const isPicture = (file: File) => file.type.startsWith('image/')

/** A reply whose stream broke: what to show if it never gets saved. */
interface CutTurn { text: string; sentAt: string; fallback: Shown[]; previews: string[]; model: string; persona: string }

const CUT_NOTE = 'The connection dropped. Hermes is still working, and the reply shows here when it is saved.'
const REOPEN_NOTE = 'Hermes is still answering here. The reply shows when it is saved.'
/** What the rows of a held queue say: why nothing went out by itself. */
const HELD_WHY: Record<NonNullable<ChatQueued['why']>, string> = { stopped: 'the reply was stopped', failed: 'the reply failed', lost: 'Hermes lost the reply', long: 'this chat is too long', old: 'this waited too long', joined: 'it joined messages that were held' }
const LOST_NOTE = 'The reply did not arrive. Reopen the chat later, or send the message again.'

function ChatView({ id, line: landLine, list, team }: { id?: string; line?: number; list: HubData<ChatListAnswer>; team: HubData<TeamView> }) {
  const help = parseHelpId(id)
  const preview = useHubData<HelpPreview>(help ? `/chat/about/${help.kind}/${help.step ?? '-'}/${encodeURIComponent(help.id)}` : null)
  // "Chat with <agent>" from Spawn: a fresh Chat reads the start once at mount (peeked, so a doubled initializer sees it too; the effect below drops it).
  const [start] = useState(() => (id || help ? null : peekChatStart()))
  const [[initial, initialModel, initialPersona]] = useState<[Shown[] | null, string | null, string]>(() => { const hit = carried && carried.id === id ? carried : null; carried = null; return [hit ? hit.lines : null, hit ? hit.model : null, hit ? hit.persona : start?.persona ?? HERMES] })
  const [persona, setPersona] = useState(initialPersona)   // persona: who the chat talks to; fixed once the chat has a line
  // model: what the owner picked in this conversation (or the chat's own last choice), or null: then the persona's preferred model, else Auto.
  const [picked, setPicked] = useState<string | null>(initialModel)
  const [messages, setMessages] = useState<Shown[]>(initial ?? [])
  const models = list.data?.models ?? []   // model: an older server sends none, and then there is no menu
  const personas = list.data?.personas ?? []   // persona: an older server sends none, and then there is no picker
  const who = personas.find(entry => entry.id === persona) ?? null   // null is Hermes
  const preferred = who?.model && models.some(entry => entry.id === who.model) ? who.model : AUTO   // model: the agent's own default, until the owner picks one
  // pauses: the plans the Hub saw hit a usage limit. The default falls to the next model in the chain; a hand pick stays, with the same note.
  const [clockNow, setClockNow] = useState(() => Date.now())   // a pause ends by itself: look again every half minute
  useEffect(() => { const timer = setInterval(() => setClockNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const choice = chooseModel({ picked, preferred, chain: list.data?.chain ?? [], pauses: list.data?.pauses ?? [], now: clockNow })
  const model = choice.model
  const pauseText = choice.pause ? pauseNote(nameOf(models, choice.pause.model), choice.pause, pauseWhen, choice.using ? nameOf(models, choice.using) : undefined) : null
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState(() => (help ? takeHelpDraft() : start?.draft ?? ''))
  const [images, setImages] = useState<Prepared[]>([])
  const [preparing, setPreparing] = useState(0)
  const [trayNote, setTrayNote] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [tools, setTools] = useState<ChatTool[]>([])
  const [delegates, setDelegates] = useState<ChatDelegate[]>([])
  const [thinking, setThinking] = useState('')   // what Hermes is thinking, shown until the reply has text
  const [recovering, setRecovering] = useState(false)   // the stream is gone or was never here: the reply is read from the saved chat
  const [queued, setQueued] = useState<ChatQueued[]>([])   // sent while a reply ran; the Hub delivers them when it ends
  // Every request about the queue is numbered when it starts; an answer older than one already shown is dropped, so a late answer never takes a row away.
  const stamps = useRef({ next: 0, shown: 0 })
  const stamp = useCallback(() => ++stamps.current.next, [])
  const [held, setHeld] = useState<ChatHeld | null>(null)   // why they are not going out by themselves
  const takeView = useCallback((number: number, answer: { queued?: ChatQueued[]; held?: ChatHeld | null }) => {
    if (number < stamps.current.shown) return
    stamps.current.shown = number
    setQueued(answer.queued ?? []); setHeld(answer.held ?? null)
  }, [])
  // Messages the owner sent that the Hub has not answered for yet: shown as rows at once, then replaced by the Hub's own rows. One that was sent
  // before the new chat had a name waits (`posting` false) and goes out as soon as it has one.
  const [local, setLocal] = useState<{ key: string; text: string; posting: boolean }[]>([])
  const [stopProblem, setStopProblem] = useState<string | null>(null)   // a Stop that did not reach Hermes: kept apart from `error`, which a followed turn clears
  const [stopping, setStopping] = useState(false)   // Stop was pressed: say so until the reply has ended
  const [known, setKnown] = useState(!!id && !parseHelpId(id))   // the conversation has a name, so a message can be queued in it
  const live = useRef(false)   // a turn is being read from a stream (sent here, or followed)
  const afterRef = useRef<(name: string) => Promise<void>>(async () => {})
  const followRef = useRef<(name: string, answer: ChatAnswer) => Promise<void>>(async () => {})
  const [note, setNote] = useState<string | null>(null)
  const [marks, setMarks] = useState<ChatMarks | null>(null)   // this chat's pin, rename, archive, Trash and unread marks, as the Hub holds them
  const [options, setOptions] = useState(false)   // the sheet that holds the persona and the model
  const [renaming, setRenaming] = useState(false)
  const cutTurn = useRef<CutTurn | null>(null)
  const [approval, setApproval] = useState<ChatApproval | null>(null)
  const [readAloud, setReadAloud] = useState(() => remember(READ_KEY) === '1')
  const abort = useRef<AbortController | null>(null)
  const run = useRef<string | null>(null)
  const stopWanted = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const conversation = useRef<string | undefined>(help ? undefined : id)
  const [shownId, setShownId] = useState<string | undefined>(help ? undefined : id)
  // The jobs the replies name: read only when a line has some. Looked at again when a line gains ids, and every 20 s while a job is going.
  const jobIds = messages.flatMap(line => line.jobs ?? [])
  const jobKey = jobIds.join(',')
  const jobRead = useHubData<{ jobs: ChatJob[] }>(jobIds.length && shownId && !help ? `/chat/${encodeURIComponent(shownId)}/jobs` : null)
  const jobs = jobRead.data?.jobs ?? []
  const jobsLive = jobs.some(job => LIVE_JOB.has(job.state))
  const reloadJobs = jobRead.reload
  useEffect(() => { if (jobKey) reloadJobs() }, [jobKey, reloadJobs])
  useEffect(() => {
    if (!jobsLive) return undefined
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') reloadJobs() }, nextLookMs(false, 0))
    return () => window.clearInterval(timer)
  }, [jobsLive, reloadJobs])
  const urls = useRef(new Set<string>())
  const slots = useRef(MAX_IMAGES)
  const speaks = typeof window !== 'undefined' && 'speechSynthesis' in window

  // The conversation in the address is the one on screen.
  useEffect(() => {
    if (!id || help) return undefined
    // A view that a finished turn handed its lines to has them already: it only looks at what the turn left behind (a queued message, a hold).
    if (initial) { const timer = window.setTimeout(() => void afterRef.current(id), 0); return () => window.clearTimeout(timer) }   // after the effects below have set the refs
    // A chat this tab just put in the Trash: Back onto its entry goes on past it. Going forward to it (its row in the Trash, a link) opens it, with its banner and Restore.
    if (wasDeletedHere(id) && direction() === 'back') { skipGone(hubHash('chat')); return undefined }
    let stopped = false
    const number = stamp()
    hubGet<ChatAnswer>(`/chat/${encodeURIComponent(id)}`)
      .then(answer => {
        if (stopped) return
        setMarks(answer.state ?? null)
        if (answer.state?.unread && host.write) void setChatMarks(id, { unread: false }).catch(() => { /* the dot stays until the next read */ })   // reading a chat clears its unread mark
        setMessages(answer.messages); setPicked([...answer.messages].reverse().find(line => line.role === 'user')?.model ?? AUTO); setPersona(answer.messages.find(line => line.persona)?.persona ?? HERMES)   // model: an old chat opens on its last choice
        takeView(number, answer)
        if (answer.running) void followRef.current(id, answer)   // opened while the reply is still coming: follow it live
      })
      .catch(failure => { if (!stopped) setError(failure instanceof Error ? failure.message : 'The conversation could not be read.') })
    return () => { stopped = true }
  }, [id, initial, help, stamp, takeView])

  // A search hit opens at its message and flashes it. A line that is gone opens at the bottom, as every chat does.
  const landed = useRef(false)
  useEffect(() => {
    const box = scroller.current
    const target = landLine !== undefined && !landed.current && messages.length ? box?.querySelector<HTMLElement>(`[data-line="${landLine}"]`) : null
    if (target) {
      landed.current = true
      target.scrollIntoView({ block: 'center' })
      target.classList.add('hub-flash')
      window.setTimeout(() => target.classList.remove('hub-flash'), 1800)
      return
    }
    box?.scrollTo({ top: box.scrollHeight })
  }, [messages, pending, landLine])
  useEffect(() => {
    const made = urls.current
    return () => { abort.current?.abort(); if (speaks) window.speechSynthesis.cancel(); made.forEach(url => URL.revokeObjectURL(url)); made.clear() }
  }, [speaks])

  // Read the saved chat while a reply is due after its stream broke, or while a delegate has no result yet. The look comes at once when the
  // page returns to the front, because a phone stops timers in the background.
  const waitingQueue = queued.length > 0 && !held   // the Hub is about to deliver them: look soon, so a phone that wakes sees the rows move
  const busy = streaming || recovering || queued.length > 0 || local.length > 0   // a message sent now waits its turn, behind a held row too: it joins the hold
  const watching = recovering || (!streaming && (hasRunningDelegate(messages) || queued.length > 0))
  const reloadList = list.reload
  useEffect(() => onChatMarks((name, state) => { if (name === conversation.current) setMarks(state) }), [])
  useEffect(() => {
    const name = conversation.current
    if (!watching || !name) return undefined
    let stopped = false
    let looking = false
    let misses = 0
    let timer: number | undefined
    const began = Date.now()
    const land = (lines: Shown[], problem: string | null) => {
      const turn = cutTurn.current
      cutTurn.current = null
      setMessages(lines)
      setPending(null)
      setDelegates([])
      setStreaming(false)
      setStopping(false)
      setRecovering(false)
      setNote(null)
      setError(problem)
      setShownId(name)
      reloadList()
      if (problem) return
      turn?.previews.forEach(url => { URL.revokeObjectURL(url); urls.current.delete(url) })
      if (name !== id) { carry(name, lines, turn?.model ?? AUTO, turn?.persona ?? HERMES); window.location.assign(hubHash('chat', name)) }
      else void afterRef.current(name)   // what the turn left behind: a queued message that started, a hold
    }
    const missed = () => {
      misses += 1
      if (misses < MAX_MISSES) return
      if (cutTurn.current) land(cutTurn.current.fallback, LOST_NOTE)
      else { setPending(null); setStreaming(false); setRecovering(false); setNote(null); setStopping(false) }
    }
    const look = async () => {
      if (stopped || looking) return
      looking = true
      window.clearTimeout(timer)
      try {
        const number = stamp()
        const answer = await hubGet<ChatAnswer>(`/chat/${encodeURIComponent(name)}`)
        if (stopped) return
        if (!recovering) {
          setMessages(current => (sameLines(current, answer.messages) ? current : answer.messages))
          takeView(number, answer)
          if (answer.running && !live.current) { void followRef.current(name, answer); return }   // a turn began that this page did not start: the queue's
        } else if (answer.running) { takeView(number, answer); if (answer.run) run.current = answer.run }   // the queue is shown while the reply is waited for too
        else if (!cutTurn.current || replySaved(answer.messages, cutTurn.current.text, cutTurn.current.sentAt)) { land(answer.messages, null); return }
        else missed()
      } catch (failure) {
        if (recovering && failure instanceof HubError && failure.status === 404) missed()   // anything else: offline for now, so look again
      } finally {
        looking = false
      }
      if (!stopped) timer = window.setTimeout(() => void look(), waitingQueue && !recovering ? 4000 : nextLookMs(recovering, Date.now() - began))
    }
    const onFront = () => { if (document.visibilityState === 'visible') void look() }
    document.addEventListener('visibilitychange', onFront)
    window.addEventListener('online', onFront)
    timer = window.setTimeout(() => void look(), recovering ? 1000 : waitingQueue ? 2000 : nextLookMs(false, 0))
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onFront); window.removeEventListener('online', onFront) }
  }, [watching, recovering, waitingQueue, id, reloadList, stamp, takeView])

  // Stop ends the run on the server; leaving the screen or losing the connection does not, so the reply is still saved.
  const stop = () => {
    setStopping(true)
    setStopProblem(null)
    const id = run.current
    if (id) { void hubPost('/chat/stop', { run: id }).catch(() => { setStopping(false); setStopProblem('Stop did not reach Hermes. The reply is still running; press Stop again.') }); abort.current?.abort(); return }
    // Before `started` there is no run to name, and aborting now would leave it running on the server:
    // hold the stop until onStarted, which sends it (or aborts, when the turn has no run).
    stopWanted.current = true
  }

  const release = (list: string[]) => list.forEach(url => { URL.revokeObjectURL(url); urls.current.delete(url) })


  const addFiles = async (files: File[]) => {
    if (busy) { setTrayNote('Wait for the reply before adding pictures.'); return }
    const pictures = files.filter(isPicture)
    const note: string[] = []
    if (pictures.length < files.length) note.push('Only pictures can be attached.')
    const room = slots.current
    if (pictures.length > room) note.push(`A message takes at most ${MAX_IMAGES} pictures.`)
    const take = pictures.slice(0, Math.max(0, room))
    slots.current -= take.length
    setTrayNote(note.join(' ') || null)
    if (!take.length) return
    setPreparing(count => count + take.length)
    for (const file of take) {
      try {
        const made = await prepareImage(file)
        urls.current.add(made.url)
        setImages(current => [...current, made])
      } catch (failure) {
        slots.current += 1
        setTrayNote(failure instanceof Error ? failure.message : "This picture can't be opened here. Try a JPEG or PNG.")
      }
      setPreparing(count => count - 1)
    }
  }

  const remove = (picture: Prepared) => {
    release([picture.url])
    slots.current += 1
    setImages(current => current.filter(item => item.id !== picture.id))
    setTrayNote(null)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pictureFiles(event.clipboardData)
    if (!files.length) return
    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
    void addFiles(files)
  }

  const onDrag = (event: DragEvent) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    setDragging(true)
  }
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
  }
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    setDragging(false)
    void addFiles(Array.from(event.dataTransfer.files))
  }

  /**
   * Puts a message in the queue of this conversation: it goes when the reply ends. The row shows at once and the Hub's answer replaces it.
   * The text goes back to the draft when that fails. `key` is the row already shown for it (a message that waited for the chat's name).
   */
  const queueMessage = async (text: string, waitingKey?: string) => {
    const key = waitingKey ?? `l${Math.random().toString(36).slice(2, 8)}`
    const name = conversation.current
    setError(null)
    setLocal(current => (current.some(item => item.key === key) ? current.map(item => (item.key === key ? { ...item, posting: !!name } : item)) : [...current, { key, text, posting: !!name }]))
    if (waitingKey === undefined) setDraft('')   // a row going out now that the chat has a name is not a new send: the box keeps what is being typed
    if (!name) return   // no name yet: the row waits, and goes out when the chat has one
    try {
      const number = stamp()
      const answer = await hubPost<ChatQueueView>(`/chat/${encodeURIComponent(name)}/queue`, { text, ...(model !== AUTO ? { model } : {}) }, undefined, true)
      takeView(number, answer)
      setLocal(current => current.filter(item => item.key !== key))
      void afterRef.current(name)   // nothing was running after all: the turn has started, so follow it
    } catch (failure) {
      setLocal(current => current.filter(item => item.key !== key))
      setDraft(current => (current ? `${text}\n\n${current}` : text))   // the message comes back in front of what is being typed: nothing is lost
      setError(failure instanceof Error ? failure.message : 'The message was not queued.')
      void afterRef.current(name)   // the answer may only have been lost: show what the Hub kept
    }
  }
  // A message sent before the new chat had a name goes out now that it has one.
  const queueRef = useRef(queueMessage)
  useEffect(() => { queueRef.current = queueMessage })
  useEffect(() => {
    if (!known || !conversation.current) return
    for (const item of local) if (!item.posting) void queueRef.current(item.text, item.key)
  }, [known, local])
  // The first post of a new chat failed: nothing will name the chat, so the rows waiting for it go back into the box (after `first`, the message
  // that failed, and before anything typed since). Nothing the owner wrote stays only in a row.
  const localRef = useRef(local)
  useEffect(() => { localRef.current = local })
  const giveBack = (first?: string) => {
    const waiting = localRef.current.filter(item => !item.posting).map(item => item.text)
    if (waiting.length) setLocal(current => current.filter(item => item.posting))
    const texts = [...(first ? [first] : []), ...waiting]
    if (texts.length) setDraft(current => [...texts, current].filter(Boolean).join('\n\n'))
  }

  /** Send now: the held messages go out as one turn. */
  const sendHeld = async () => {
    const name = conversation.current
    if (!name) return
    setError(null)
    try {
      const number = stamp()
      const answer = await hubPost<ChatQueueView>(`/chat/${encodeURIComponent(name)}/queue/send`, {}, undefined, true)
      takeView(number, answer)
      void afterRef.current(name)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The messages were not sent.') }
  }

  const cancelQueued = async (queuedId: string) => {
    const name = conversation.current
    if (!name) return
    setError(null)
    try {
      const number = stamp()
      const answer = await hubPost<ChatQueueView>(`/chat/${encodeURIComponent(name)}/queue/${encodeURIComponent(queuedId)}/cancel`, {}, undefined, true)
      takeView(number, answer)
    } catch (failure) {
      // 409: the reply ended first and the message went out. Say so plainly; the thread shows it next.
      setError(failure instanceof HubError && failure.status === 409 ? 'It had already gone out, so it could not be cancelled.' : failure instanceof Error ? failure.message : 'The message was not cancelled.')
      void afterRef.current(name)   // it may have been sent meanwhile: show what is true
    }
  }

  /**
   * What the Hub holds for this conversation after a turn: the saved lines, the queue and any hold; and a turn that has started on its own
   * (the queued messages went out) is followed. Looks again by itself when this fails.
   */
  const afterTurn = async (name: string) => {
    try {
      const number = stamp()
      const answer = await hubGet<ChatAnswer>(`/chat/${encodeURIComponent(name)}`)
      if (live.current) return
      setMessages(current => (sameLines(current, answer.messages) ? current : answer.messages))
      takeView(number, answer)
      if (answer.running) void followRef.current(name, answer)
      else setStopping(false)   // the reply has ended on the server: Stopping… is over
    } catch { setStopping(false) /* the watcher looks again while a message waits */ }
  }
  useEffect(() => { afterRef.current = afterTurn })

  /**
   * Reads one turn from a stream: the reply as it comes, its tools and delegates, and how it ends. For a turn this page sent (`streamChat`)
   * and for one it only follows (`streamLive`: the queue's, or one started elsewhere). A stream that breaks leaves the reply to the saved chat.
   */
  const readTurn = async (turn: { start: (handlers: ChatHandlers, signal: AbortSignal) => Promise<void>; before: Shown[]; optimistic: Shown; previews: string[]; model: string; persona: string; refused: (failure: unknown) => void }) => {
    const { start, before, optimistic, previews, model: askedModel, persona: askedPersona, refused } = turn
    const text = optimistic.text
    const controller = new AbortController()
    abort.current = controller
    live.current = true
    let reply = ''
    let created: Item[] = []
    let named: string[] = []
    let finished: string | null = null
    let saved: ChatLine | undefined
    let savedContext: ChatLine | undefined
    let problem: string | null = null
    let cut = false
    let idle = false
    const unhold = holdReload()   // an update reload waits until the reply has ended
    const used: string[] = []
    let started: ChatDelegate[] = []
    try {
      await start({
        onDelta: piece => { reply += piece; setPending(reply) },
        onCreated: items => { created = items },
        onJobs: ids => { named = ids },
        onTool: tool => {
          if (!used.includes(tool.name)) used.push(tool.name)
          setTools(current => (current.some(item => item.id === tool.id) ? current.map(item => (item.id === tool.id ? { ...item, ...tool, summary: tool.summary ?? item.summary } : item)) : [...current, tool]))
        },
        onThinking: setThinking,
        onDelegates: items => { started = items; setDelegates(items) },
        onStarted: (runId, name) => {
          run.current = runId
          if (name) {
            conversation.current = name; setKnown(true)   // a resend joins this conversation, not a second one
            // A new chat gets its address now, not when the reply ends: leaving at any moment finds the way back. `notify` off: the view
            // stays mounted and goes on reading this stream.
            if (!id && !help && window.location.hash !== hubHash('chat', name)) swap(hubHash('chat', name), undefined, false)
          }
          if (stopWanted.current) { stopWanted.current = false; if (runId) stop(); else abort.current?.abort() }
        },
        onApproval: setApproval,
        onApprovalSettled: () => setApproval(null),
        onDone: (name, user, context) => { finished = name; saved = user; savedContext = context },
        onError: message => { problem = message },
        onIdle: () => { idle = true },
      }, controller.signal)
    } catch (failure) {
      if (failure instanceof StreamCut) {
        // The server took the message and the stream broke: the line is saved there, so it stays here.
        cut = true
        problem = failure.message
      } else if (!controller.signal.aborted) {
        unhold()
        live.current = false
        refused(failure)
        return
      }
    }
    unhold()
    live.current = false
    stopWanted.current = false   // a Stop held for this turn's run id ends with the turn: it must never fire on a later message
    if (idle) {
      // /live found nothing running (the turn ended meanwhile): the saved chat has the rest.
      setTools([]); setThinking('')
      setNote(REOPEN_NOTE)
      setRecovering(true)
      return
    }
    const stopped = controller.signal.aborted
    const swapped = !!saved && !!finished
    const userLine: Shown = swapped ? saved as ChatLine : { ...optimistic, ...(askedModel !== AUTO ? { model: askedModel } : {}), ...(askedPersona !== HERMES ? { persona: askedPersona } : {}) }
    // A Stop before any text: the note sits on the owner's line, as the saved chat has it, and no reply line is made.
    const stoppedEmpty = stopped && !cut && !reply.trim() && !started.length
    const shownUser: Shown = stoppedEmpty ? { ...userLine, stopped: true } : userLine
    const lines: Shown[] = [...(savedContext && !before.length ? [savedContext as ChatLine] : []), ...before, shownUser, ...(stoppedEmpty ? [] : [{ role: 'assistant' as const, text: cut ? `${reply} [interrupted]`.trim() : stopped ? `${reply} [stopped]`.trim() : reply, at: new Date().toISOString(), ...(used.length ? { tools: used } : {}), ...(started.length ? { delegates: started } : {}), ...(created.length ? { created } : {}), ...(named.length ? { jobs: named } : {}), ...(askedModel !== AUTO ? { model: askedModel } : {}), ...(askedPersona !== HERMES ? { persona: askedPersona } : {}) }])]
    // Hermes goes on without the page, so the reply comes from the saved chat: the turn stays open until it is there.
    if (cut && conversation.current) {
      cutTurn.current = { text, sentAt: optimistic.at, fallback: lines, previews, model: askedModel, persona: askedPersona }
      setTools([]); setThinking('')
      setApproval(null)
      setNote(CUT_NOTE)
      setRecovering(true)
      return
    }
    if (finished) { conversation.current = finished; setShownId(finished) }
    setMessages(lines)
    setPending(null)
    setTools([]); setThinking('')
    setDelegates([])
    setApproval(null)
    setStreaming(false)
    if (swapped) release(previews)
    if (problem) setError(problem)
    if (!conversation.current) { setStopping(false); giveBack() }   // no name came: nothing will send the waiting rows
    if (cut) list.reload()
    const handedOver = !!finished && finished !== id
    if (finished) {
      list.reload()
      if (handedOver) {
        carry(finished, lines, askedModel, askedPersona)
        // The address may already name it (set when the id was known): then the route is only read again, so the view is made anew with these lines.
        if (window.location.hash === hubHash('chat', finished)) window.dispatchEvent(new Event(ROUTE_EVENT))
        else window.location.assign(hubHash('chat', finished))
      }
    }
    if (!handedOver && conversation.current) void afterRef.current(conversation.current)   // the queue may have moved on, or been held
    if (!stopped && !problem && readAloud && speaks && reply.trim()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(plainText(reply)))
  }

  /** A turn that is running here and that this page did not start (the queue's own, or one begun on another device): read it live. */
  const followLive = async (name: string, answer: ChatAnswer) => {
    if (live.current) return
    live.current = true   // before anything is awaited: two looks must not follow the same turn twice
    cutTurn.current?.previews.forEach(url => { URL.revokeObjectURL(url); urls.current.delete(url) })
    cutTurn.current = null
    setRecovering(false)
    const asking = answer.asking
    const before = answer.messages
    const optimistic: Shown = { role: 'user', text: asking?.text ?? '', at: asking?.at ?? new Date().toISOString() }
    conversation.current = name
    setKnown(true)
    run.current = answer.run ?? null
    stopWanted.current = false
    setError(null)
    setNote(null)
    setStreaming(true)
    setTools([]); setThinking('')
    setDelegates([])
    setApproval(null)
    setPending('')
    setQueued(answer.queued ?? []); setHeld(answer.held ?? null)
    setMessages(asking?.text ? [...before, optimistic] : before)
    await readTurn({
      start: (handlers, signal) => streamLive(name, handlers, signal),
      before, optimistic, previews: [], model, persona,
      refused: () => { setNote(REOPEN_NOTE); setRecovering(true) },   // the stream would not open: the saved chat has the reply when it ends
    })
  }
  useEffect(() => { followRef.current = followLive })

  const send = async (asked?: string) => {
    const text = (asked ?? draft).trim()
    const sending = asked === undefined ? images : []
    if ((!text && !sending.length) || preparing) return
    // A reply is running here, or messages are waiting for it: this one waits too. Pictures cannot wait, so they stay in the tray.
    if (busy) {
      if (sending.length) { setTrayNote('Pictures cannot wait in the queue. Send them when the reply is done, or remove them.'); return }
      if (!text) return
      await queueMessage(text)   // before the chat has a name the row waits for it
      return
    }
    if (speaks) window.speechSynthesis.cancel()
    setError(null)
    setTrayNote(null)
    setStopping(false)
    setStreaming(true)
    if (asked === undefined) { setDraft(''); setImages([]); slots.current = MAX_IMAGES }
    setTools([]); setThinking('')
    setDelegates([])
    setApproval(null)
    setPending('')
    const before = messages
    const askedModel = model   // model: what this turn asks for
    const askedPersona = persona   // persona: only a new chat names one; the server keeps it after that
    const previews = sending.map(item => item.url)
    const optimistic: Shown = { role: 'user', text, at: new Date().toISOString(), ...(previews.length ? { previews } : {}) }
    setMessages([...before, optimistic])
    run.current = null
    stopWanted.current = false
    const gone = !!help && !!preview.error && preview.data === null
    await readTurn({
      start: async (handlers, signal) => streamChat({ ...(conversation.current ? { conversation: conversation.current } : {}), ...(askedModel !== AUTO ? { model: askedModel } : {}), ...(askedPersona !== HERMES && !conversation.current && !help ? { persona: askedPersona } : {}), ...(help && !conversation.current && !gone ? { about: { kind: help.kind, id: help.id, ...(help.step ? { step: help.step } : {}) } } : {}), text, ...(sending.length ? { images: await Promise.all(sending.map(async item => ({ type: item.type, data: await toBase64(item.blob) }))) } : {}) }, handlers, signal),
      before, optimistic, previews, model: askedModel, persona: askedPersona,
      refused: failure => {
        // Refused before anything streamed: nothing was saved, so the text and the pictures go back.
        setMessages(before)
        setPending(null)
        setStreaming(false)
        // This page thought the chat was idle, but a reply is running (another device, or the queue's own turn): the message waits its turn.
        if (failure instanceof HubError && failure.status === 409 && conversation.current && !sending.length) { void queueMessage(text, `l${Math.random().toString(36).slice(2, 8)}`); return }   // a key: the sent text already left the box, so this must not clear what was typed since
        setStopping(false)
        if (asked === undefined) { giveBack(text); setImages(sending); slots.current = MAX_IMAGES - sending.length } else giveBack()
        setError(failure instanceof HubError || failure instanceof Error ? failure.message : 'The message was not sent.')
      },
    })
  }


  // "Ask Hermes: <text>" from Search: a new conversation that sends the text at once.
  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send })
  const takeQueued = useCallback(() => {
    if (id) return
    const text = takeAsk()
    if (text) void sendRef.current(text)
  }, [id])
  useEffect(() => { takeQueued(); return onAsk(takeQueued) }, [takeQueued])

  // The start is used once: drop it, and put the cursor in the composer when it came with a draft.
  useEffect(() => {
    takeChatStart()
    if (start) input.current?.focus()
  }, [start])

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
  }

  const agents = team.data?.agents ?? []
  const pickable = personas.length > 0 && !id && !help && !messages.length && pending === null
  const pick = (value: string) => {
    if (value === JOB) { afterPop(() => { setOptions(false); openSpawn({ text: draft.trim() || undefined, ...(who ? { preset: who.preset } : {}) }) }); return }   // the select keeps its value; Spawn picks the agent, the machine and the project; the sheet closes first
    setPicked(value)
  }
  // The banner: from the preview of a new help chat, or from the context line a stored one starts with.
  const stored = messages[0]?.role === 'context' && messages[0].about ? messages[0] : null
  const gone = !!help && !stored && !!preview.error && preview.data === null
  const banner = stored
    ? <HelpBanner about={stored.about ?? null} text={stored.text} pictures={(stored.images ?? []).map(image => ({ url: `/api/hub/chat/${encodeURIComponent(shownId ?? '')}/images/${encodeURIComponent(image.file)}` }))} />
    : help && (gone ? <HelpBanner about={null} pictures={[]} /> : preview.data ? <HelpBanner about={preview.data.about} text={preview.data.text} pictures={preview.data.pictures.map(picture => ({ path: picture.path }))} /> : null)
  const canSend = (!!draft.trim() || images.length > 0) && preparing === 0
  // The header: what this chat is called, who it talks to, and its own menu. A chat the Hub has no file for yet has no menu.
  const row = list.data?.conversations.find(entry => entry.id === shownId)
  const firstUser = messages.find(line => line.role === 'user')
  const derived = stored?.about ? `Help: ${stored.about.title}` : firstUser?.text.trim().slice(0, 60) || ''
  const title = marks?.title ?? row?.title ?? (derived || (shownId ? 'Chat' : 'New chat'))
  const trashed = !!marks?.trashed
  const archived = !!marks?.archived
  const chatRef = shownId && !help ? { id: shownId, title, pinned: marks?.pinned ?? row?.pinned ?? null, archived: marks?.archived ?? null, trashed: marks?.trashed ?? null, unread: marks?.unread ?? false } : null
  const leave = () => back(hubHash('chat'))
  return (
    <section className={`hub-chat-main hub-chat-pane main${dragging ? ' hub-drop' : ''}`} data-chat-thread={shownId ?? ''} onDragEnter={onDrag} onDragOver={onDrag} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="hub-chat-head">
          <IconButton icon="back" label="Back" className="hub-chat-back" data-back="" onClick={leave} />
          <button type="button" className="hub-chat-titlebtn" aria-haspopup="dialog" data-chat-options onClick={() => setOptions(true)}>
            <b data-chat-title>{title}</b>
            <small data-chat-with={persona}>{who?.name ?? 'Hermes'}{models.length > 0 && <> · {nameOf(models, model)}</>}{trashed ? ' · In the Trash' : archived ? ' · Archived' : ''}</small>
          </button>
          {chatRef && <RowMenu label="Chat options" title={title} items={chatMenu(chatRef, () => setRenaming(true), { leave })} />}
        </div>
        {options && (
          <Sheet title="Chat options" onClose={() => setOptions(false)}>
            <div className="hub-chat-sheet" data-chat-sheet>
              <label>
                <span>Talk to</span>
                {pickable
                  ? (
                    <span className="hub-chat-sheet-who" data-sheet-who={persona}>
                      <Who id={who ? persona : HERMES} name={who?.name ?? 'Hermes'} agents={agents} size={24} bare />
                      <select className="hub-persona" aria-label="Talk to" data-chat-persona value={personas.some(entry => entry.id === persona) ? persona : HERMES} onChange={event => setPersona(event.target.value)}>
                        <option value={HERMES}>Hermes</option>
                        {personas.map(entry => <option key={entry.id} value={entry.id} title={entry.role}>{entry.name}</option>)}
                      </select>
                    </span>
                  )
                  : <span className="hub-chat-sheet-who" data-sheet-who={persona}><Who id={who ? persona : HERMES} name={who?.name ?? 'Hermes'} agents={agents} size={24} /></span>}
              </label>
              {models.length > 0 && (
                <label>
                  <span>Model</span>
                  <select className="hub-model" aria-label="Model" data-chat-model value={models.some(entry => entry.id === model) ? model : AUTO} disabled={streaming} onChange={event => pick(event.target.value)}>
                    {models.map(entry => <option key={entry.id} value={entry.id} title={entry.note}>{menuLabel(entry, list.data?.autoFirst || 'Codex')}</option>)}
                    <option disabled>──────────</option>
                    <option value={JOB}>Start a job instead…</option>
                  </select>
                  <span className="hub-muted hub-model-note" data-chat-model-note>{models.find(entry => entry.id === model)?.note}</span>
                </label>
              )}
            </div>
          </Sheet>
        )}
        {renaming && chatRef && <RenameSheet chat={chatRef} onClose={() => setRenaming(false)} />}
        {banner}
        {trashed && (
          <div className="hub-chat-trashed" role="status" data-chat-trashed>
            <span>This chat is in the Trash. Its messages are still here. Restore it to send.</span>
            {host.write && chatRef && <button type="button" className="ui-btn" data-chat-restore={chatRef.id} onClick={() => void restoreChat(chatRef)}>Restore</button>}
          </div>
        )}
        <div className="hub-messages" ref={scroller} aria-live="polite">
          {!messages.length && pending === null && <p className="hub-empty">{who ? `Ask ${who.name} anything: ${who.role}. It writes a card when you ask for one.` : 'Ask the assistant anything, or tell it what to do.'}</p>}
          {messages.map((line, index) => (line.role === 'context' ? null : (
            <Fragment key={index}>
              <Bubble line={line} index={index} conversation={shownId} models={models} who={who} agents={agents} jobs={jobs} onJobsChanged={reloadJobs} />
              {line.role === 'user' && line.stopped && (
                <p className="hub-muted hub-chat-note" role="status" data-chat-stopped>
                  Stopped before it replied.
                  {index === messages.length - 1 && !streaming && !recovering && !!line.text.trim() && <> <button type="button" className="hub-btn" data-chat-resend onClick={() => void send(line.text)}>Send again</button></>}
                </p>
              )}
            </Fragment>
          )))}
          {pending !== null && (
            <div className="hub-bubble assistant pending" data-pending>
              {pending ? <Md text={pending} onSameOrigin={openSameOrigin} copy breaks /> : thinking ? <p className="hub-muted hub-thinking" data-thinking><span>Thinking: </span>{thinking}</p> : <span className="hub-muted" data-pending-wait>{who?.name ?? 'Hermes'} is working…</span>}
              <ToolLines tools={delegates.length ? tools.filter(tool => tool.name !== DELEGATE_TOOL) : tools} />
              <Delegates items={delegates} />
              {approval && <ApprovalCard approval={approval} onAnswered={() => setApproval(null)} />}
            </div>
          )}
        </div>
        {(queued.length > 0 || local.length > 0) && (
          <div className="hub-queue" data-chat-queued role="group" aria-label="Messages waiting to be sent">
            {queued.map(item => (
              <div className={`hub-queued${held ? ' held' : ''}`} key={item.id} data-queued={item.id} data-queued-state={held ? 'held' : 'queued'}>
                <span className="hub-queued-pill" data-queued-pill>{held ? `Not sent: ${HELD_WHY[item.why ?? held.reason]}` : 'Queued'}</span>
                <p className="hub-queued-text">{item.text}</p>
                <div className="hub-queued-a">
                  {held && <button type="button" className="hub-btn pri" data-queued-send onClick={() => void sendHeld()}>Send now</button>}
                  <button type="button" className="hub-btn" data-queued-cancel onClick={() => void cancelQueued(item.id)}>Cancel</button>
                </div>
              </div>
            ))}
            {local.map(item => (
              <div className="hub-queued" key={item.key} data-queued={item.key} data-queued-local data-queued-state="queued">
                <span className="hub-queued-pill" data-queued-pill>Queued</span>
                <p className="hub-queued-text">{item.text}</p>
                <div className="hub-queued-a">
                  <button type="button" className="hub-btn" data-queued-cancel disabled={item.posting} onClick={() => setLocal(current => current.filter(entry => entry.key !== item.key))}>Cancel</button>
                </div>
              </div>
            ))}
            {queued.length + local.length > 1 && <p className="hub-muted hub-queue-join" data-queued-join>{held ? 'These go together when you send them.' : 'These go together when the reply ends.'}</p>}
          </div>
        )}
        {stopProblem && <p className="hub-error" role="alert" data-chat-stop-error>{stopProblem}</p>}
        {stopping && <p className="hub-muted hub-chat-note" role="status" data-chat-stopping>Stopping…</p>}
        {note && <p className="hub-muted hub-chat-note" role="status" data-chat-note>{note}</p>}
        {error && <p className="hub-error" role="alert">{error}</p>}
        {!trashed && (images.length > 0 || preparing > 0 || trayNote) && (
          <div className="hub-tray" data-tray>
            {images.map((picture, index) => (
              <div className="hub-tray-item" key={picture.id}>
                <img src={picture.url} alt={`Picture ${index + 1}`} />
                <button type="button" className="hub-tray-remove" aria-label={`Remove picture ${index + 1}`} onClick={() => remove(picture)}><span aria-hidden="true">×</span></button>
              </div>
            ))}
            {preparing > 0 && <span className="hub-muted hub-tray-note" role="status">Preparing {preparing === 1 ? 'a picture' : `${preparing} pictures`}…</span>}
            {trayNote && <span className="hub-tray-note hub-tray-warn" role="status">{trayNote}</span>}
          </div>
        )}
        {!trashed && <div className="hub-compose">
          <input ref={picker} type="file" accept={PICTURE_TYPES} multiple hidden data-attach-input onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <button type="button" className="hub-attach" aria-label="Attach pictures" title="Attach pictures" disabled={busy} onClick={() => picker.current?.click()}><Icon name="attach" size={20} /></button>
          <textarea
            ref={input} value={draft} rows={2} maxLength={8000} placeholder="Message" aria-label="Message"
            onChange={event => setDraft(event.target.value)} onKeyDown={onKey} onPaste={onPaste}
          />
          {streaming && <button type="button" className="hub-btn" disabled={stopping} data-chat-stop onClick={stop}>Stop</button>}
          {/* A press on Send keeps the focus in the field: a tap that blurred it closed the phone's keyboard, the page moved, and the click missed. */}
          <button type="button" className="hub-btn pri" disabled={!canSend} onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={() => void send()}>Send</button>
        </div>}
        {/* The model and the persona are in the sheet from the title; what stays here is a pause note and the read-aloud switch. */}
        {!trashed && (speaks || !!pauseText) && (
          <div className="hub-chat-extras">
            {pauseText && <span className="hub-model-pause" role="status" data-chat-model-pause data-pause-model={choice.pause?.model}>{pauseText}</span>}
            {speaks && (
              <label className="hub-muted hub-aloud">
                <input type="checkbox" checked={readAloud} onChange={event => { setReadAloud(event.target.checked); remember(READ_KEY, event.target.checked ? '1' : '0'); if (!event.target.checked) window.speechSynthesis.cancel() }} /> Read replies aloud
              </label>
            )}
          </div>
        )}
    </section>
  )
}
