import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import type { ChatApproval, ChatLine, ChatModel, ChatPersona, ChatSummary, ChatTool, HelpPreview, Item } from '../lib/hub'
import { HubError, hubGet, hubPost, remember } from '../lib/hub'
import { host } from '../lib/host'
import { hasFiles, pictureFiles } from '../lib/pastePictures.mjs'
import { hubHash, parseHelpId, reviewHash } from '../lib/route'
import type { HelpKind } from '../lib/route'
import { Icon } from '../local/Icons'
import { holdReload } from '../lib/reloadGate'
import { StreamCut, plainText, streamChat } from './chatStream'
import { MAX_IMAGES, prepareImage, toBase64 } from './chatImages'
import type { Prepared } from './chatImages'
import HubImage from './HubImage'
import Md from './Md'
import { useHubData } from './useHub'
import { onAsk, takeAsk } from './askHermes'
import './chatRuns.css'
import './chatChoice.css'
import { openSpawn } from './spawnStore'
import { takeHelpDraft } from './flash'
import { setFocus } from './needsFocus'
import { AgentSprite } from './team/AgentSprite'
import type { TeamAgent, TeamView } from '../lib/hubTeam'

const READ_KEY = 'buw.hub.readAloud'
const JOB = '__job'
const AUTO = 'auto'
const HERMES = 'hermes'   // persona: no persona, Hermes itself

/** What the tags call a model: its label, or the bare id when the server no longer lists it. */
const nameOf = (models: ChatModel[], id: string) => models.find(entry => entry.id === id)?.label ?? id
/** The menu text: the paid ones say API. */
const menuLabel = (entry: ChatModel) => (entry.id === AUTO ? entry.label : `${entry.label} · API`)

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
          <a className="hub-btn" href={item.kind === 'ask' ? hubHash('ask', item.id) : hubHash('needs', 'requests')}>Open</a>
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

/** The page of the item a help chat is about (Unstick has none: it opens Needs you on its card). */
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

/** persona: the agent's own sprite from the Team, else a name-seeded one while the Team loads or when it is off. */
function Who({ id, name, agents, size, bare }: { id: string; name: string; agents: TeamAgent[]; size: number; bare?: boolean }) {
  const sprite = agents.find(agent => agent.id === id)?.sprite ?? { kind: 'random' as const, salt: 0, name }
  return <span className="hub-who" data-who={id}><AgentSprite sprite={sprite} size={size} title={name} />{!bare && <span className="hub-who-name">{name}</span>}</span>
}

function Bubble({ line, conversation, models, who, agents }: { line: Shown; conversation?: string; models: ChatModel[]; who?: ChatPersona | null; agents: TeamAgent[] }) {
  const urls = line.previews ?? (conversation ? (line.images ?? []).map(image => `/api/hub/chat/${encodeURIComponent(conversation)}/images/${encodeURIComponent(image.file)}`) : [])
  return (
    <div className={`hub-bubble ${line.role}`}>
      {line.role === 'assistant' && who && <Who id={who.id} name={who.name} agents={agents} size={22} />}
      {line.role === 'assistant' ? <Md text={line.text} onSameOrigin={openSameOrigin} /> : line.text && <p className="hub-note-text">{line.text}</p>}
      {urls.length > 0 && (
        <div className="hub-bubble-images" data-bubble-images>
          {urls.map((url, index) => <HubImage key={url} url={url} open className="hub-bubble-image" alt={`Picture ${index + 1}`} />)}
        </div>
      )}
      {line.tools && line.tools.length > 0 && <ToolLines tools={line.tools.map(name => ({ id: name, name, state: 'done' as const }))} />}
      {line.created && line.created.length > 0 && <Created items={line.created} />}
      {line.role === 'assistant' && line.model && line.model !== AUTO && <span className="hub-muted hub-bubble-model" data-bubble-model>{nameOf(models, line.model)}</span>}
    </div>
  )
}

export default function Chat({ id }: { id?: string }) {
  if (!host.chat) return <p className="hub-empty">Chat is not set up on this host.</p>
  return <ChatView key={id ?? 'new'} id={id} />
}

// A new conversation gets its address when its first reply is done; what is on screen travels to the new view.
let carried: { id: string; lines: Shown[]; model: string; persona: string } | null = null

const carry = (id: string, lines: Shown[], model: string, persona: string) => { carried = { id, lines, model, persona } }

const isPicture = (file: File) => file.type.startsWith('image/')

function ChatView({ id }: { id?: string }) {
  const help = parseHelpId(id)
  const preview = useHubData<HelpPreview>(help ? `/chat/about/${help.kind}/${help.step ?? '-'}/${encodeURIComponent(help.id)}` : null)
  const list = useHubData<{ conversations: ChatSummary[]; models?: ChatModel[]; personas?: ChatPersona[] }>('/chat')
  const team = useHubData<TeamView>('/team')   // persona: the sprites of the picker and the header
  const [[initial, initialModel, initialPersona]] = useState<[Shown[] | null, string, string]>(() => { const hit = carried && carried.id === id ? carried : null; carried = null; return [hit ? hit.lines : null, hit ? hit.model : AUTO, hit ? hit.persona : HERMES] })
  const [persona, setPersona] = useState(initialPersona)   // persona: who the chat talks to; fixed once the chat has a line
  const [model, setModel] = useState(initialModel)   // model:
  const [messages, setMessages] = useState<Shown[]>(initial ?? [])
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState(() => (help ? takeHelpDraft() : ''))
  const [images, setImages] = useState<Prepared[]>([])
  const [preparing, setPreparing] = useState(0)
  const [trayNote, setTrayNote] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [tools, setTools] = useState<ChatTool[]>([])
  const [approval, setApproval] = useState<ChatApproval | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [readAloud, setReadAloud] = useState(() => remember(READ_KEY) === '1')
  const abort = useRef<AbortController | null>(null)
  const run = useRef<string | null>(null)
  const stopWanted = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const conversation = useRef<string | undefined>(help ? undefined : id)
  const [shownId, setShownId] = useState<string | undefined>(help ? undefined : id)
  const urls = useRef(new Set<string>())
  const slots = useRef(MAX_IMAGES)
  const speaks = typeof window !== 'undefined' && 'speechSynthesis' in window

  // The conversation in the address is the one on screen.
  useEffect(() => {
    if (!id || initial || help) return undefined
    let stopped = false
    hubGet<{ messages: ChatLine[] }>(`/chat/${encodeURIComponent(id)}`)
      .then(answer => { if (!stopped) { setMessages(answer.messages); setModel([...answer.messages].reverse().find(line => line.role === 'user')?.model ?? AUTO); setPersona(answer.messages.find(line => line.persona)?.persona ?? HERMES) } })   // model: an old chat opens on its last choice
      .catch(failure => { if (!stopped) setError(failure instanceof Error ? failure.message : 'The conversation could not be read.') })
    return () => { stopped = true }
  }, [id, initial, help])

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [messages, pending])
  useEffect(() => {
    const made = urls.current
    return () => { abort.current?.abort(); if (speaks) window.speechSynthesis.cancel(); made.forEach(url => URL.revokeObjectURL(url)); made.clear() }
  }, [speaks])

  // Stop ends the run on the server; leaving the screen or losing the connection does not, so the reply is still saved.
  const stop = () => {
    const id = run.current
    if (id) { void hubPost('/chat/stop', { run: id }).catch(() => {}); abort.current?.abort(); return }
    // Before `started` there is no run to name, and aborting now would leave it running on the server:
    // hold the stop until onStarted, which sends it (or aborts, when the turn has no run).
    stopWanted.current = true
  }

  const release = (list: string[]) => list.forEach(url => { URL.revokeObjectURL(url); urls.current.delete(url) })


  const addFiles = async (files: File[]) => {
    if (streaming) { setTrayNote('Wait for the reply before adding pictures.'); return }
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

  const send = async (asked?: string) => {
    const text = (asked ?? draft).trim()
    const sending = asked === undefined ? images : []
    if ((!text && !sending.length) || streaming || preparing) return
    if (speaks) window.speechSynthesis.cancel()
    setError(null)
    setTrayNote(null)
    setStreaming(true)
    if (asked === undefined) { setDraft(''); setImages([]); slots.current = MAX_IMAGES }
    setTools([])
    setApproval(null)
    setPending('')
    const before = messages
    const askedModel = model   // model: what this turn asks for
    const askedPersona = persona   // persona: only a new chat names one; the server keeps it after that
    const previews = sending.map(item => item.url)
    const optimistic: Shown = { role: 'user', text, at: new Date().toISOString(), ...(previews.length ? { previews } : {}) }
    setMessages([...before, optimistic])
    const controller = new AbortController()
    abort.current = controller
    run.current = null
    stopWanted.current = false
    let reply = ''
    let created: Item[] = []
    let finished: string | null = null
    let saved: ChatLine | undefined
    let savedContext: ChatLine | undefined
    let problem: string | null = null
    let cut = false
    const unhold = holdReload()   // an update reload waits until the reply has ended
    const used: string[] = []
    try {
      const encoded = await Promise.all(sending.map(async item => ({ type: item.type, data: await toBase64(item.blob) })))
      const gone = !!help && !!preview.error && preview.data === null
      await streamChat({ ...(conversation.current ? { conversation: conversation.current } : {}), ...(askedModel !== AUTO ? { model: askedModel } : {}), ...(askedPersona !== HERMES && !conversation.current && !help ? { persona: askedPersona } : {}), ...(help && !conversation.current && !gone ? { about: { kind: help.kind, id: help.id, ...(help.step ? { step: help.step } : {}) } } : {}), text, ...(encoded.length ? { images: encoded } : {}) }, {
        onDelta: piece => { reply += piece; setPending(reply) },
        onCreated: items => { created = items },
        onTool: tool => {
          if (!used.includes(tool.name)) used.push(tool.name)
          setTools(current => (current.some(item => item.id === tool.id) ? current.map(item => (item.id === tool.id ? { ...item, ...tool, summary: tool.summary ?? item.summary } : item)) : [...current, tool]))
        },
        onStarted: (id, name) => {
          run.current = id
          if (name) conversation.current = name   // a resend joins this conversation, not a second one
          if (stopWanted.current) { stopWanted.current = false; if (id) stop(); else abort.current?.abort() }
        },
        onApproval: setApproval,
        onApprovalSettled: () => setApproval(null),
        onDone: (name, user, context) => { finished = name; saved = user; savedContext = context },
        onError: message => { problem = message },
      }, controller.signal)
    } catch (failure) {
      if (failure instanceof StreamCut) {
        // The server took the message and the stream broke: the line is saved there, so it stays here.
        cut = true
        problem = failure.message
      } else if (!controller.signal.aborted) {
        unhold()
        // Refused before anything streamed: nothing was saved, so the text and the pictures go back.
        setMessages(before)
        if (asked === undefined) { setDraft(text); setImages(sending); slots.current = MAX_IMAGES - sending.length }
        setPending(null)
        setStreaming(false)
        setError(failure instanceof HubError || failure instanceof Error ? failure.message : 'The message was not sent.')
        return
      }
    }
    unhold()
    const stopped = controller.signal.aborted
    const swapped = !!saved && !!finished
    const userLine: Shown = swapped ? saved as ChatLine : { ...optimistic, ...(askedModel !== AUTO ? { model: askedModel } : {}), ...(askedPersona !== HERMES ? { persona: askedPersona } : {}) }
    const lines: Shown[] = [...(savedContext && !before.length ? [savedContext as ChatLine] : []), ...before, userLine, { role: 'assistant', text: cut ? `${reply} [interrupted]`.trim() : stopped ? `${reply} [stopped]`.trim() : reply, at: new Date().toISOString(), ...(used.length ? { tools: used } : {}), ...(created.length ? { created } : {}), ...(askedModel !== AUTO ? { model: askedModel } : {}), ...(askedPersona !== HERMES ? { persona: askedPersona } : {}) }]
    if (finished) { conversation.current = finished; setShownId(finished) }
    setMessages(lines)
    setPending(null)
    setTools([])
    setApproval(null)
    setStreaming(false)
    if (swapped) release(previews)
    if (problem) setError(problem)
    if (cut) list.reload()
    if (finished) {
      list.reload()
      if (finished !== id) { carry(finished, lines, askedModel, askedPersona); window.location.assign(hubHash('chat', finished)) }
    }
    if (!stopped && !problem && readAloud && speaks && reply.trim()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(plainText(reply)))
  }

  // "Ask Hermes: <text>" from the palette: a new conversation that sends the text at once.
  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send })
  const takeQueued = useCallback(() => {
    if (id) return
    const text = takeAsk()
    if (text) void sendRef.current(text)
  }, [id])
  useEffect(() => { takeQueued(); return onAsk(takeQueued) }, [takeQueued])

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
  }

  const conversations = list.data?.conversations ?? []
  const models = list.data?.models ?? []   // model: an older server sends none, and then there is no menu
  const personas = list.data?.personas ?? []   // persona: an older server sends none, and then there is no picker
  const agents = team.data?.agents ?? []
  const who = personas.find(entry => entry.id === persona) ?? null   // null is Hermes
  const pickable = personas.length > 0 && !id && !help && !messages.length && pending === null
  const pick = (value: string) => {
    if (value === JOB) { openSpawn({ text: draft.trim() || undefined, ...(who ? { preset: who.preset } : {}) }); return }   // the select keeps its value; Spawn picks the agent, the machine and the project
    setModel(value)
  }
  // The banner: from the preview of a new help chat, or from the context line a stored one starts with.
  const stored = messages[0]?.role === 'context' && messages[0].about ? messages[0] : null
  const gone = !!help && !stored && !!preview.error && preview.data === null
  const banner = stored
    ? <HelpBanner about={stored.about ?? null} text={stored.text} pictures={(stored.images ?? []).map(image => ({ url: `/api/hub/chat/${encodeURIComponent(shownId ?? '')}/images/${encodeURIComponent(image.file)}` }))} />
    : help && (gone ? <HelpBanner about={null} pictures={[]} /> : preview.data ? <HelpBanner about={preview.data.about} text={preview.data.text} pictures={preview.data.pictures.map(picture => ({ path: picture.path }))} /> : null)
  const canSend = (!!draft.trim() || images.length > 0) && preparing === 0
  return (
    <div className={`hub-chat${drawer ? ' drawer' : ''}`}>
      <aside className="hub-chat-list" aria-label="Conversations">
        <a className="hub-btn pri" href={hubHash('chat')} onClick={() => setDrawer(false)}>New chat</a>
        {conversations.map(item => (
          <a key={item.id} className={`hub-chat-item${item.id === id ? ' on' : ''}`} href={hubHash('chat', item.id)} onClick={() => setDrawer(false)} data-conversation={item.id}>
            <span>{item.title}</span>
            <span className="hub-muted">{item.count} messages{item.persona && <> · <span className="hub-chat-tag" data-conversation-persona>{personas.find(entry => entry.id === item.persona)?.name ?? item.persona}</span></>}{item.model && item.model !== AUTO && <> · <span className="hub-chat-tag" data-conversation-model>{nameOf(models, item.model)}</span></>}</span>
          </a>
        ))}
        {!conversations.length && <p className="hub-empty">No conversations yet.</p>}
      </aside>
      <section className={`hub-chat-main${dragging ? ' hub-drop' : ''}`} onDragEnter={onDrag} onDragOver={onDrag} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="hub-top">
          <h2>Chat</h2>
          <span className="hub-chat-with hub-muted" data-chat-with={persona}>with {pickable
            ? (
              <>
                <Who id={who ? persona : HERMES} name={who?.name ?? 'Hermes'} agents={agents} size={24} bare />
                <select className="hub-persona" aria-label="Talk to" data-chat-persona value={personas.some(entry => entry.id === persona) ? persona : HERMES} onChange={event => setPersona(event.target.value)}>
                  <option value={HERMES}>Hermes</option>
                  {personas.map(entry => <option key={entry.id} value={entry.id} title={entry.role}>{entry.name}</option>)}
                </select>
              </>
            )
            : <Who id={who ? persona : HERMES} name={who?.name ?? 'Hermes'} agents={agents} size={24} />}</span>
          <button type="button" className="hub-btn hub-chat-toggle" aria-expanded={drawer} onClick={() => setDrawer(value => !value)}>Chats</button>
        </div>
        {banner}
        <div className="hub-messages" ref={scroller} aria-live="polite">
          {!messages.length && pending === null && <p className="hub-empty">{who ? `Ask ${who.name} anything: ${who.role}. It writes a card when you ask for one.` : 'Ask the assistant anything, or tell it what to do.'}</p>}
          {messages.map((line, index) => (line.role === 'context' ? null : <Bubble key={index} line={line} conversation={shownId} models={models} who={who} agents={agents} />))}
          {pending !== null && (
            <div className="hub-bubble assistant pending" data-pending>
              {pending ? <Md text={pending} onSameOrigin={openSameOrigin} /> : <span className="hub-muted">…</span>}
              <ToolLines tools={tools} />
              {approval && <ApprovalCard approval={approval} onAnswered={() => setApproval(null)} />}
            </div>
          )}
        </div>
        {error && <p className="hub-error" role="alert">{error}</p>}
        {(images.length > 0 || preparing > 0 || trayNote) && (
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
        <div className="hub-compose">
          <input ref={picker} type="file" accept="image/*" multiple hidden data-attach-input onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <button type="button" className="hub-attach" aria-label="Attach pictures" title="Attach pictures" disabled={streaming} onClick={() => picker.current?.click()}><Icon name="attach" size={20} /></button>
          <textarea
            ref={input} value={draft} rows={2} maxLength={8000} placeholder="Message" aria-label="Message"
            onChange={event => setDraft(event.target.value)} onKeyDown={onKey} onPaste={onPaste}
          />
          {streaming
            ? <button type="button" className="hub-btn" onClick={stop}>Stop</button>
            : <button type="button" className="hub-btn pri" disabled={!canSend} onClick={() => void send()}>Send</button>}
        </div>
        {(speaks || models.length > 0) && (
          <div className="hub-chat-extras">
            {models.length > 0 && (
              <>
                <select className="hub-model" aria-label="Model" data-chat-model value={models.some(entry => entry.id === model) ? model : AUTO} disabled={streaming} onChange={event => pick(event.target.value)}>
                  {models.map(entry => <option key={entry.id} value={entry.id} title={entry.note}>{menuLabel(entry)}</option>)}
                  <option disabled>──────────</option>
                  <option value={JOB}>Start a job instead…</option>
                </select>
                <span className="hub-muted hub-model-note" data-chat-model-note>{models.find(entry => entry.id === model)?.note}</span>
              </>
            )}
            {speaks && (
              <label className="hub-muted hub-aloud">
                <input type="checkbox" checked={readAloud} onChange={event => { setReadAloud(event.target.checked); remember(READ_KEY, event.target.checked ? '1' : '0'); if (!event.target.checked) window.speechSynthesis.cancel() }} /> Read replies aloud
              </label>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
