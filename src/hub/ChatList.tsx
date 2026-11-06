// The Chat tab's list: Pinned, Today and Earlier, an Archived row and a Trash row, a search field, and a "..." menu on every chat.
// Nothing here deletes a chat: Delete moves it to the Trash and Restore brings it back (chatActions.ts).
import { Fragment, useEffect, useRef, useState } from 'react'
import type { TouchEvent } from 'react'
import type { ChatListAnswer, ChatPersona, ChatSummary } from '../lib/hub'
import { HUB_WROTE, clock, hubGet } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { back, go, useEntryMemo } from '../lib/entries'
import { segments } from '../search/searchIndex'
import Icon from '../ui/Icon'
import { Button } from '../ui/Controls'
import { Section } from '../ui/Layout'
import RowMenu from '../ui/RowMenu'
import { Sheet } from '../ui/Sheet'
import TopBar from '../ui/TopBar'
import type { HubData } from './useHub'
import { useHubData } from './useHub'
import SearchField from './SearchField'
import Who from './ChatWho'
import { archiveChat, chatMenu, renameChat, restoreChat } from './chatActions'
import type { ChatRef } from './chatActions'
import type { TeamAgent } from '../lib/hubTeam'
import './chatList.css'

const AUTO = 'auto'
const HERMES = 'hermes'
const DEBOUNCE_MS = 300
const MIN_TEXT = 2
const SWIPE = 96

/** The time a row shows: the clock today, the day before. */
function whenOf(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toDateString() === new Date().toDateString() ? clock(iso) : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const isToday = (iso: string | null | undefined) => !!iso && new Date(iso).toDateString() === new Date().toDateString()

interface Names { personas: ChatPersona[]; agents: TeamAgent[]; modelName: (id: string) => string }

function useNames(personas: ChatPersona[], agents: TeamAgent[], models: { id: string; label: string }[]): Names {
  return { personas, agents, modelName: id => models.find(entry => entry.id === id)?.label ?? id }
}

/** One chat's row: a link (avatar, title, a quiet line, the time, an unread dot) and its "..." menu. A left swipe on a phone archives it. */
function ChatRow({ chat, names, activeId, swipe, onRename }: { chat: ChatSummary; names: Names; activeId?: string; swipe: boolean; onRename: (chat: ChatSummary) => void }) {
  const persona = chat.persona ? names.personas.find(entry => entry.id === chat.persona) : undefined
  const personaName = persona ? persona.name : chat.persona ? chat.persona : 'Hermes'
  const touch = useRef<{ x: number; y: number; lock: 'x' | 'y' | null; dx: number } | null>(null)
  const row = useRef<HTMLDivElement>(null)
  const swipedAt = useRef(0)
  const open = chat.id === activeId
  const onStart = (event: TouchEvent) => {
    if (!swipe || (event.target as Element).closest('button')) return
    const point = event.touches[0]
    touch.current = { x: point.clientX, y: point.clientY, lock: null, dx: 0 }
  }
  const onMove = (event: TouchEvent) => {
    const state = touch.current
    if (!state) return
    const point = event.touches[0]
    const dx = point.clientX - state.x
    const dy = point.clientY - state.y
    // The first 10 px decide: a mostly vertical move is a scroll, and it wins for the rest of the touch.
    if (state.lock === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) state.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    if (state.lock !== 'x') return
    state.dx = Math.min(0, dx)
    if (row.current) { row.current.style.transition = 'none'; row.current.style.transform = `translateX(${state.dx}px)` }
  }
  const onEnd = () => {
    const state = touch.current
    touch.current = null
    if (!state || state.lock !== 'x') return
    swipedAt.current = Date.now()
    const node = row.current
    if (!node) return
    node.style.transition = 'transform 0.2s var(--ease)'
    if (state.dx > -SWIPE) { node.style.transform = ''; return }
    node.style.transform = 'translateX(-100%)'
    window.setTimeout(() => {
      void archiveChat(chat).then(ok => {
        if (!ok) node.style.transform = ''
        else if (open) back(hubHash('chat'))
      })
    }, 180)
  }
  return (
    <div className="cl-swipe" data-swipe={chat.id} onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}>
      <div className="cl-swipe-bg" aria-hidden="true">Archive</div>
      <div className={`cl-row${chat.unread ? ' unread' : ''}${open ? ' on' : ''}`} ref={row}>
        <a className="cl-link" href={hubHash('chat', chat.id)} data-conversation={chat.id} data-pinned={chat.pinned ? '' : undefined} data-unread={chat.unread ? '' : undefined}
          aria-current={open ? 'page' : undefined} onClick={event => { if (Date.now() - swipedAt.current < 400) event.preventDefault() }}>
          <Who id={persona ? chat.persona! : HERMES} name={personaName} agents={names.agents} size={32} bare />
          <span className="cl-body">
            <b className="cl-title">{chat.pinned && <span className="cl-pin" data-pin-mark title="Pinned"><Icon name="pin" size={14} /></span>}{chat.title}</b>
            <small className="cl-snip">
              {chat.running ? <span data-conversation-running>Replying… · </span> : <>{chat.count} messages · </>}<span data-conversation-persona>{personaName}</span>{chat.model && chat.model !== AUTO && <> · <span data-conversation-model>{names.modelName(chat.model)}</span></>}
            </small>
          </span>
          <span className="cl-end"><span className="cl-when" data-conversation-time>{whenOf(chat.updated)}</span>{chat.unread && <span className="cl-dot" role="img" aria-label="Unread" data-unread-dot />}</span>
        </a>
        <RowMenu label={`More for ${chat.title}`} title={chat.title} items={chatMenu(chat, () => onRename(chat), open ? { leave: () => back(hubHash('chat')) } : undefined)} />
      </div>
    </div>
  )
}

/** The name sheet. An empty name clears the rename, so the title is the first message again. */
export function RenameSheet({ chat, onClose }: { chat: ChatRef; onClose: () => void }) {
  const [name, setName] = useState(chat.title)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const ok = await renameChat(chat, name)
    setBusy(false)
    if (ok) window.history.back()
  }
  return (
    <Sheet title="Rename chat" onClose={onClose}>
      <form className="cl-rename" onSubmit={event => { event.preventDefault(); void save() }}>
        <label className="cl-field"><span>Name</span><input value={name} maxLength={120} data-rename-input onChange={event => setName(event.target.value)} aria-label="Chat name" /></label>
        <p className="cl-hint">Leave it empty to use the first message again.</p>
        <Button tone="primary" wide type="submit" disabled={busy} data-rename-save>Save</Button>
      </form>
    </Sheet>
  )
}

/** Text with the words of the query marked. The marks are elements, never HTML from the text. */
function Marked({ text, q }: { text: string; q: string }) {
  return <>{segments(text, q).map((part, index) => (part.mark ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>))}</>
}

interface MessageHit { chat: string; title: string; persona?: string | null; line: number; snippet: string; archived?: boolean }

export default function ChatList({ list, agents, activeId }: { list: HubData<ChatListAnswer>; agents: TeamAgent[]; activeId?: string }) {
  const names = useNames(list.data?.personas ?? [], agents, list.data?.models ?? [])
  const [q, setQ] = useEntryMemo('chat-list-q', '')
  const [settled, setSettled] = useState(q)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(q), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [q])
  const [renaming, setRenaming] = useState<ChatSummary | null>(null)
  // More pages are read by offset and dropped when anything is written, so a row never shows a state that is gone.
  const [extra, setExtra] = useState<ChatSummary[]>([])
  const [paging, setPaging] = useState(false)
  useEffect(() => {
    const clear = () => setExtra([])
    window.addEventListener(HUB_WROTE, clear)
    return () => window.removeEventListener(HUB_WROTE, clear)
  }, [])
  const base = list.data?.conversations ?? []
  const shown = [...base, ...extra.filter(item => !base.some(row => row.id === item.id))]
  const total = list.data?.total ?? shown.length
  const more = shown.length < total
  const showMore = async () => {
    setPaging(true)
    try {
      const page = await hubGet<ChatListAnswer>(`/chat?offset=${shown.length}`)
      setExtra(current => [...current, ...page.conversations])
    } catch { /* the button stays: try again */ } finally { setPaging(false) }
  }

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const typed = words.length > 0
  const textTyped = settled.trim().length >= MIN_TEXT && q.trim().length >= MIN_TEXT && settled.length <= 200
  const found = useHubData<{ hits: MessageHit[]; warming?: boolean }>(host.chat && textTyped ? `/chat/search?q=${encodeURIComponent(settled.trim())}&limit=50` : null)
  const [lastHits, setLastHits] = useState<MessageHit[]>([])
  const answered = Array.isArray(found.data?.hits) ? found.data!.hits : null
  if (answered && answered !== lastHits) setLastHits(answered)
  const hits = !textTyped ? [] : answered ?? lastHits
  const warming = textTyped && !!found.data?.warming
  const retried = useRef('')
  const reloadHits = found.reload
  useEffect(() => {
    if (!warming || retried.current === settled) return undefined
    const timer = window.setTimeout(() => { retried.current = settled; reloadHits() }, 4000)
    return () => window.clearTimeout(timer)
  }, [warming, settled, reloadHits])

  const matching = typed ? shown.filter(chat => words.every(word => chat.title.toLowerCase().includes(word))) : shown
  const pinned = matching.filter(chat => chat.pinned)
  const today = matching.filter(chat => !chat.pinned && isToday(chat.updated))
  const earlier = matching.filter(chat => !chat.pinned && !isToday(chat.updated))
  const counts = list.data?.counts
  const group = (title: string, rows: ChatSummary[]) => rows.length > 0 && (
    <Section title={title} key={title}>
      <div className="ui-list cl-list" role="list" aria-label={title}>{rows.map(chat => <ChatRow key={chat.id} chat={chat} names={names} activeId={activeId} swipe={host.write} onRename={setRenaming} />)}</div>
    </Section>
  )
  const settledNow = !textTyped || !!found.data || !!found.error
  return (
    <div className="cl" data-chat-list>
      <TopBar title="Chat" actions={<a className="ui-icobtn pri" href={hubHash('chat', 'new')} role="button" aria-label="New chat" title="New chat" data-new-chat><Icon name="plus" /></a>} />
      <div className="cl-search">
        <SearchField value={q} onChange={setQ} label="Search chats" placeholder="Search chats and messages" data={{ 'data-chat-search': '' }} />
      </div>
      <div className="cl-scroll" data-chat-scroll>
        {list.error && !list.data && <p className="hub-error" role="alert">{list.error}</p>}
        {list.loading && <p className="cl-note" role="status">Loading chats…</p>}
        {list.data && !shown.length && !typed && <p className="cl-note" data-chat-none>No chats yet. Start one.</p>}
        {typed && !matching.length && !hits.length && settledNow && <p className="cl-note" role="status" data-chat-nomatch>No chat matches “{q.trim()}”.</p>}
        {group('Pinned', pinned)}
        {group('Today', today)}
        {group('Earlier', earlier)}
        {typed && hits.length > 0 && (
          <Section title="In messages">
            <div className="ui-list cl-list" role="list" aria-label="Messages that match">
              {hits.map(hit => (
                <a key={`${hit.chat}/${hit.line}`} className="ui-row cl-hit" role="listitem" href={`${hubHash('chat', hit.chat)}/m/${hit.line}`} data-chat-hit={`${hit.chat}/${hit.line}`}>
                  <span className="ui-row-body"><b>{hit.title}{hit.archived && <span className="cl-mark" data-conversation-mark> · Archived</span>}</b><small><Marked text={hit.snippet} q={q} /></small></span>
                </a>
              ))}
            </div>
          </Section>
        )}
        {warming && <p className="cl-note" role="status" data-chat-warming="">Still reading older chats. More may show in a moment.</p>}
        {!typed && more && <div className="cl-more"><Button wide disabled={paging} data-chat-more onClick={() => void showMore()}>Show more</Button></div>}
        {!typed && counts && (
          <Section>
            <div className="ui-list cl-list" role="list">
              <a className="ui-row cl-place" role="listitem" href={hubHash('chat', 'archived')} data-chat-place="archived" onClick={event => { event.preventDefault(); go(hubHash('chat', 'archived')) }}><span className="ui-row-body"><b>Archived</b></span><small className="cl-count">{counts.archived}</small><span className="cl-chev"><Icon name="chev" size={18} /></span></a>
              <a className="ui-row cl-place" role="listitem" href={hubHash('chat', 'trash')} data-chat-place="trash" onClick={event => { event.preventDefault(); go(hubHash('chat', 'trash')) }}><span className="ui-row-body"><b>Trash</b></span><small className="cl-count">{counts.trashed}</small><span className="cl-chev"><Icon name="chev" size={18} /></span></a>
            </div>
          </Section>
        )}
      </div>
      {renaming && <RenameSheet chat={renaming} onClose={() => setRenaming(null)} />}
    </div>
  )
}

const SET_ASIDE_PAGE = 100

/** `#/~hub/chat/archived` and `chat/trash`: the chats set aside, each with Restore. Opening one reads it. */
export function ChatSetAside({ view, agents, personas, models }: { view: 'archived' | 'trash'; agents: TeamAgent[]; personas: ChatPersona[]; models: { id: string; label: string }[] }) {
  const read = useHubData<ChatListAnswer>(`/chat?view=${view}&limit=${SET_ASIDE_PAGE}`)
  const names = useNames(personas, agents, models)
  // Later pages are read by offset, as the main list does, and dropped when anything is written (a Restore takes a row out of every offset).
  const [extra, setExtra] = useState<{ view: string; rows: ChatSummary[] }>({ view, rows: [] })
  const [paging, setPaging] = useState(false)
  useEffect(() => {
    const clear = () => setExtra(current => ({ ...current, rows: [] }))
    window.addEventListener(HUB_WROTE, clear)
    return () => window.removeEventListener(HUB_WROTE, clear)
  }, [])
  const base = read.data?.conversations ?? []
  const more = extra.view === view ? extra.rows : []
  const rows = [...base, ...more.filter(item => !base.some(row => row.id === item.id))]
  const total = read.data?.total ?? rows.length
  const showMore = async () => {
    setPaging(true)
    try {
      const page = await hubGet<ChatListAnswer>(`/chat?view=${view}&limit=${SET_ASIDE_PAGE}&offset=${rows.length}`)
      setExtra(current => ({ view, rows: [...(current.view === view ? current.rows : []), ...page.conversations] }))
    } catch { /* the button stays: try again */ } finally { setPaging(false) }
  }
  const title = view === 'trash' ? 'Trash' : 'Archived chats'
  return (
    <div className="cl" data-chat-set-aside={view}>
      <TopBar title={title} parent={hubHash('chat')} />
      {view === 'trash' && <p className="cl-note cl-left" data-trash-note>Deleted chats stay here. Restore one to use it again.</p>}
      <div className="cl-scroll">
        {read.error && !read.data && <p className="hub-error" role="alert">{read.error}</p>}
        {read.loading && <p className="cl-note" role="status">Loading chats…</p>}
        {read.data && !rows.length && <p className="cl-note" data-chat-none>{view === 'trash' ? 'The Trash is empty.' : 'No archived chats.'}</p>}
        {rows.length > 0 && (
          <div className="ui-list cl-list" role="list" aria-label={title}>
            {rows.map(chat => (
              <div className="cl-row cl-set" role="listitem" key={chat.id}>
                <a className="cl-link" href={hubHash('chat', chat.id)} data-conversation={chat.id}>
                  <Who id={chat.persona ?? HERMES} name={names.personas.find(entry => entry.id === chat.persona)?.name ?? 'Hermes'} agents={agents} size={32} bare />
                  <span className="cl-body"><b className="cl-title">{chat.title}</b><small className="cl-snip">{chat.count} messages · {whenOf(chat.trashed ?? chat.archived ?? chat.updated)}</small></span>
                </a>
                {host.write && <Button small data-chat-restore={chat.id} onClick={() => void restoreChat(chat)}>Restore</Button>}
              </div>
            ))}
          </div>
        )}
        {rows.length > 0 && rows.length < total && <div className="cl-more"><Button wide disabled={paging} data-chat-more onClick={() => void showMore()}>Show more ({total - rows.length} left)</Button></div>}
      </div>
    </div>
  )
}
