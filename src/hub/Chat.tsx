import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import type { ChatLine, ChatSummary, Item } from '../lib/hub'
import { HubError, hubGet, remember } from '../lib/hub'
import { host } from '../lib/host'
import { hasFiles, pictureFiles } from '../lib/pastePictures.mjs'
import { hubHash } from '../lib/route'
import { Icon } from '../local/Icons'
import { plainText, streamChat } from './chatStream'
import { MAX_IMAGES, prepareImage, toBase64 } from './chatImages'
import type { Prepared } from './chatImages'
import HubImage from './HubImage'
import Md from './Md'
import { useHubData } from './useHub'

const READ_KEY = 'buw.hub.readAloud'

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

function Bubble({ line, conversation }: { line: Shown; conversation?: string }) {
  const urls = line.previews ?? (conversation ? (line.images ?? []).map(image => `/api/hub/chat/${encodeURIComponent(conversation)}/images/${encodeURIComponent(image.file)}`) : [])
  return (
    <div className={`hub-bubble ${line.role}`}>
      {line.role === 'assistant' ? <Md text={line.text} onSameOrigin={openSameOrigin} /> : line.text && <p className="hub-note-text">{line.text}</p>}
      {urls.length > 0 && (
        <div className="hub-bubble-images" data-bubble-images>
          {urls.map((url, index) => <HubImage key={url} url={url} open className="hub-bubble-image" alt={`Picture ${index + 1}`} />)}
        </div>
      )}
      {line.created && line.created.length > 0 && <Created items={line.created} />}
    </div>
  )
}

export default function Chat({ id }: { id?: string }) {
  if (!host.chat) return <p className="hub-empty">Chat is not set up on this host.</p>
  return <ChatView key={id ?? 'new'} id={id} />
}

// A new conversation gets its address when its first reply is done; what is on screen travels to the new view.
let carried: { id: string; lines: Shown[] } | null = null

const carry = (id: string, lines: Shown[]) => { carried = { id, lines } }

const isPicture = (file: File) => file.type.startsWith('image/')

function ChatView({ id }: { id?: string }) {
  const list = useHubData<{ conversations: ChatSummary[] }>('/chat')
  const [initial] = useState<Shown[] | null>(() => { const hit = carried && carried.id === id ? carried.lines : null; carried = null; return hit })
  const [messages, setMessages] = useState<Shown[]>(initial ?? [])
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<Prepared[]>([])
  const [preparing, setPreparing] = useState(0)
  const [trayNote, setTrayNote] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [readAloud, setReadAloud] = useState(() => remember(READ_KEY) === '1')
  const abort = useRef<AbortController | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const conversation = useRef<string | undefined>(id)
  const [shownId, setShownId] = useState<string | undefined>(id)
  const urls = useRef(new Set<string>())
  const slots = useRef(MAX_IMAGES)
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
  useEffect(() => {
    const made = urls.current
    return () => { abort.current?.abort(); if (speaks) window.speechSynthesis.cancel(); made.forEach(url => URL.revokeObjectURL(url)); made.clear() }
  }, [speaks])

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

  const send = async () => {
    const text = draft.trim()
    const sending = images
    if ((!text && !sending.length) || streaming || preparing) return
    if (speaks) window.speechSynthesis.cancel()
    setError(null)
    setTrayNote(null)
    setStreaming(true)
    setDraft('')
    setImages([])
    slots.current = MAX_IMAGES
    setPending('')
    const before = messages
    const previews = sending.map(item => item.url)
    const optimistic: Shown = { role: 'user', text, at: new Date().toISOString(), ...(previews.length ? { previews } : {}) }
    setMessages([...before, optimistic])
    const controller = new AbortController()
    abort.current = controller
    let reply = ''
    let created: Item[] = []
    let finished: string | null = null
    let saved: ChatLine | undefined
    let problem: string | null = null
    try {
      const encoded = await Promise.all(sending.map(async item => ({ type: item.type, data: await toBase64(item.blob) })))
      await streamChat({ ...(conversation.current ? { conversation: conversation.current } : {}), text, ...(encoded.length ? { images: encoded } : {}) }, {
        onDelta: piece => { reply += piece; setPending(reply) },
        onCreated: items => { created = items },
        onDone: (name, user) => { finished = name; saved = user },
        onError: message => { problem = message },
      }, controller.signal)
    } catch (failure) {
      if (!controller.signal.aborted) {
        // Refused before anything streamed: nothing was saved, so the text and the pictures go back.
        setMessages(before)
        setDraft(text)
        setImages(sending)
        slots.current = MAX_IMAGES - sending.length
        setPending(null)
        setStreaming(false)
        setError(failure instanceof HubError || failure instanceof Error ? failure.message : 'The message was not sent.')
        return
      }
    }
    const stopped = controller.signal.aborted
    const swapped = !!saved && !!finished
    const userLine: Shown = swapped ? saved as ChatLine : optimistic
    const lines: Shown[] = [...before, userLine, { role: 'assistant', text: stopped ? `${reply} [stopped]`.trim() : reply, at: new Date().toISOString(), ...(created.length ? { created } : {}) }]
    if (finished) { conversation.current = finished; setShownId(finished) }
    setMessages(lines)
    setPending(null)
    setStreaming(false)
    if (swapped) release(previews)
    if (problem) setError(problem)
    if (finished) {
      list.reload()
      if (finished !== id) { carry(finished, lines); window.location.assign(hubHash('chat', finished)) }
    }
    if (!stopped && !problem && readAloud && speaks && reply.trim()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(plainText(reply)))
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
  }

  const conversations = list.data?.conversations ?? []
  const canSend = (!!draft.trim() || images.length > 0) && preparing === 0
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
      <section className={`hub-chat-main${dragging ? ' hub-drop' : ''}`} onDragEnter={onDrag} onDragOver={onDrag} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="hub-top">
          <h2>Chat</h2>
          <button type="button" className="hub-btn hub-chat-toggle" aria-expanded={drawer} onClick={() => setDrawer(value => !value)}>Chats</button>
        </div>
        <div className="hub-messages" ref={scroller} aria-live="polite">
          {!messages.length && pending === null && <p className="hub-empty">Ask the assistant anything, or tell it what to do.</p>}
          {messages.map((line, index) => <Bubble key={index} line={line} conversation={shownId} />)}
          {pending !== null && <div className="hub-bubble assistant pending" data-pending>{pending ? <Md text={pending} onSameOrigin={openSameOrigin} /> : <span className="hub-muted">…</span>}</div>}
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
            ? <button type="button" className="hub-btn" onClick={() => abort.current?.abort()}>Stop</button>
            : <button type="button" className="hub-btn pri" disabled={!canSend} onClick={() => void send()}>Send</button>}
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
