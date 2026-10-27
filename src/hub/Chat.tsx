import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ChatLine, ChatSummary, Item } from '../lib/hub'
import { HubError, hubGet, remember } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { plainText, streamChat } from './chatStream'
import Md from './Md'
import { canRecord, usePushToTalk } from './usePushToTalk'
import { useHubData } from './useHub'

const READ_KEY = 'buw.hub.readAloud'

const openSameOrigin = (url: URL) => { window.location.assign(url.href) }

function Created({ items }: { items: Item[] }) {
  return (
    <div className="hub-created">
      {items.map(item => (
        <div className="hub-created-card" key={`${item.kind}-${item.id}`} data-created={item.kind}>
          <span className="hub-pill">{item.kind}</span>
          <span className="hub-created-title">{item.title}</span>
          <a className="hub-btn" href={item.kind === 'ask' ? hubHash('ask', item.id) : hubHash('inbox', 'requests')}>Open</a>
        </div>
      ))}
    </div>
  )
}

function Bubble({ line }: { line: ChatLine }) {
  return (
    <div className={`hub-bubble ${line.role}`}>
      {line.role === 'assistant' ? <Md text={line.text} onSameOrigin={openSameOrigin} /> : <p className="hub-note-text">{line.text}</p>}
      {line.created && line.created.length > 0 && <Created items={line.created} />}
    </div>
  )
}

export default function Chat({ id }: { id?: string }) {
  if (!host.chat) return <p className="hub-empty">Chat is not set up on this host.</p>
  return <ChatView key={id ?? 'new'} id={id} />
}

// A new conversation gets its address when its first reply is done; what is on screen travels to the new view.
let carried: { id: string; lines: ChatLine[] } | null = null

function ChatView({ id }: { id?: string }) {
  const list = useHubData<{ conversations: ChatSummary[] }>('/chat')
  const [initial] = useState<ChatLine[] | null>(() => { const hit = carried && carried.id === id ? carried.lines : null; carried = null; return hit })
  const [messages, setMessages] = useState<ChatLine[]>(initial ?? [])
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [readAloud, setReadAloud] = useState(() => remember(READ_KEY) === '1')
  const abort = useRef<AbortController | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const conversation = useRef<string | undefined>(id)
  const speaks = typeof window !== 'undefined' && 'speechSynthesis' in window

  // The conversation in the address is the one on screen.
  useEffect(() => {
    if (!id || initial) return undefined
    let stopped = false
    hubGet<{ messages: ChatLine[] }>(`/chat/${encodeURIComponent(id)}`)
      .then(answer => { if (!stopped) setMessages(answer.messages) })
      .catch(failure => { if (!stopped) setError(failure instanceof Error ? failure.message : 'The conversation could not be read.') })
    return () => { stopped = true }
  }, [id, initial])

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [messages, pending])
  useEffect(() => () => { abort.current?.abort(); if (speaks) window.speechSynthesis.cancel() }, [speaks])

  const append = useCallback((text: string) => {
    setDraft(current => (current ? `${current} ${text}` : text))
    input.current?.focus()
  }, [])
  const talk = usePushToTalk(append)

  const send = async () => {
    const text = draft.trim()
    if (!text || streaming) return
    if (speaks) window.speechSynthesis.cancel()
    setError(null)
    setStreaming(true)
    setDraft('')
    setPending('')
    const before = messages
    setMessages([...before, { role: 'user', text, at: new Date().toISOString() }])
    const controller = new AbortController()
    abort.current = controller
    let reply = ''
    let created: Item[] = []
    let finished: string | null = null
    let problem: string | null = null
    try {
      await streamChat({ ...(conversation.current ? { conversation: conversation.current } : {}), text }, {
        onDelta: piece => { reply += piece; setPending(reply) },
        onCreated: items => { created = items },
        onDone: name => { finished = name },
        onError: message => { problem = message },
      }, controller.signal)
    } catch (failure) {
      if (!controller.signal.aborted) {
        // Refused before anything streamed: nothing was saved, so the typed text goes back in the box.
        setMessages(before)
        setDraft(text)
        setPending(null)
        setStreaming(false)
        setError(failure instanceof HubError || failure instanceof Error ? failure.message : 'The message was not sent.')
        return
      }
    }
    const stopped = controller.signal.aborted
    const lines: ChatLine[] = [...before, { role: 'user', text, at: new Date().toISOString() }, { role: 'assistant', text: stopped ? `${reply} [stopped]`.trim() : reply, at: new Date().toISOString(), ...(created.length ? { created } : {}) }]
    setMessages(lines)
    setPending(null)
    setStreaming(false)
    if (problem) setError(problem)
    if (finished) {
      conversation.current = finished
      list.reload()
      if (finished !== id) { carried = { id: finished, lines }; window.location.assign(hubHash('chat', finished)) }
    }
    if (!stopped && !problem && readAloud && speaks && reply.trim()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(plainText(reply)))
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
  }

  const conversations = list.data?.conversations ?? []
  const showMic = canRecord()
  return (
    <div className={`hub-chat${drawer ? ' drawer' : ''}`}>
      <aside className="hub-chat-list" aria-label="Conversations">
        <a className="hub-btn pri" href={hubHash('chat')} onClick={() => setDrawer(false)}>New chat</a>
        {conversations.map(item => (
          <a key={item.id} className={`hub-chat-item${item.id === id ? ' on' : ''}`} href={hubHash('chat', item.id)} onClick={() => setDrawer(false)} data-conversation={item.id}>
            <span>{item.title}</span>
            <span className="hub-muted">{item.count} messages</span>
          </a>
        ))}
        {!conversations.length && <p className="hub-empty">No conversations yet.</p>}
      </aside>
      <section className="hub-chat-main">
        <div className="hub-top">
          <h2>Chat</h2>
          <button type="button" className="hub-btn hub-chat-toggle" aria-expanded={drawer} onClick={() => setDrawer(value => !value)}>Chats</button>
        </div>
        <div className="hub-messages" ref={scroller} aria-live="polite">
          {!messages.length && pending === null && <p className="hub-empty">Ask the assistant anything, or tell it what to do.</p>}
          {messages.map((line, index) => <Bubble key={index} line={line} />)}
          {pending !== null && <div className="hub-bubble assistant pending" data-pending>{pending ? <Md text={pending} onSameOrigin={openSameOrigin} /> : <span className="hub-muted">…</span>}</div>}
        </div>
        {error && <p className="hub-error" role="alert">{error}</p>}
        {talk.error && <p className="hub-error" role="alert">{talk.error}</p>}
        {talk.recording && <p className="hub-listening" role="status">Listening… release to transcribe (max 2 min) · {talk.seconds} s</p>}
        {talk.busy && <p className="hub-muted" role="status">Turning speech into text…</p>}
        <div className="hub-compose">
          <textarea
            ref={input} value={draft} rows={2} maxLength={8000} placeholder="Message" aria-label="Message"
            onChange={event => setDraft(event.target.value)} onKeyDown={onKey}
          />
          {showMic && (
            <button type="button" className={`hub-mic${talk.recording ? ' on' : ''}`} aria-label="Hold to talk" title="Hold to talk, or tap to start and stop" {...talk.handlers}>🎙</button>
          )}
          {streaming
            ? <button type="button" className="hub-btn" onClick={() => abort.current?.abort()}>Stop</button>
            : <button type="button" className="hub-btn pri" disabled={!draft.trim()} onClick={() => void send()}>Send</button>}
        </div>
        {speaks && (
          <label className="hub-muted hub-aloud">
            <input type="checkbox" checked={readAloud} onChange={event => { setReadAloud(event.target.checked); remember(READ_KEY, event.target.checked ? '1' : '0'); if (!event.target.checked) window.speechSynthesis.cancel() }} /> Read replies aloud
          </label>
        )}
      </section>
    </div>
  )
}
