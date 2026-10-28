import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { DrawingIo } from '../components/DrawingEditor'
import type { Ask, HubProject, Item } from '../lib/hub'
import { HubError, fileUrl, hubGet, hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { authHeaders } from '../local/client'
import { blankScene, setHandoff, type Drawn } from './drawing'
import HubImage from './HubImage'
import { useHubData } from './useHub'

const DrawingEditor = lazy(() => import('../components/DrawingEditor'))
const WHEN: [string, string][] = [['next-sprint', 'Next sprint'], ['nightly', 'Nightly'], ['record', 'Just record it']]

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
  reader.onerror = () => reject(new Error('The picture could not be read.'))
  reader.readAsDataURL(blob)
})

/** The saved scene and picture of a draft, as the answer and request routes take them. */
async function loadDrawn(id: string): Promise<Drawn> {
  const { text } = await hubGet<{ text: string }>(`/drawings/${encodeURIComponent(id)}`)
  const response = await fetch(fileUrl(`drawings/${id}/drawing.png`), { headers: authHeaders() })
  if (!response.ok) throw new Error('The sketch has no picture yet; save it again.')
  return { scene: text, png: await toBase64(await response.blob()) }
}

/**
 * Deletes a sketch after asking. The Hub keeps its files and only stops showing it; requests and
 * answers already sent keep their own copy. False when the owner said no.
 */
async function deleteSketch(id: string): Promise<boolean> {
  if (!window.confirm('Delete this sketch? Requests and answers you already sent with it keep their copy.')) return false
  await hubPost(`/drawings/${encodeURIComponent(id)}/delete`, {})
  return true
}

export default function Sketch({ id }: { id?: string }) {
  if (!host.write) return <p className="hub-empty">Sketch needs a signed-in user.</p>
  return id ? <SketchPage key={id} routeId={id} /> : <SketchList />
}

function SketchList() {
  const { data, error } = useHubData<{ drawings: { id: string; updated: string; hasPng: boolean }[] }>('/drawings')
  const [gone, setGone] = useState<Set<string>>(() => new Set())
  const [failed, setFailed] = useState<string | null>(null)
  const remove = async (id: string) => {
    try {
      if (await deleteSketch(id)) setGone(previous => new Set(previous).add(id))
    } catch (failure) {
      setFailed((failure as Error).message)
    }
  }
  const shown = data?.drawings.filter(draft => !gone.has(draft.id))
  return (
    <>
      <div className="hub-top"><h2>Sketch</h2><a className="hub-btn pri" href={hubHash('sketch', 'new')}>New sketch</a></div>
      {(error || failed) && <p className="hub-error" role="alert">{error ?? failed}</p>}
      {shown && !shown.length && <p className="hub-empty">No sketches yet. Draw something and send it to an agent.</p>}
      <div className="hub-sketches">
        {shown?.map(draft => (
          <div key={draft.id} className="hub-sketch-tile">
            <a className="hub-sketch" href={hubHash('sketch', draft.id)} data-sketch={draft.id}>
              <span className="hub-thumb">{draft.hasPng ? <HubImage path={`drawings/${draft.id}/drawing.png`} alt={`Sketch ${draft.id}`} /> : <span className="hub-image-missing">No picture</span>}</span>
              <span className="hub-muted">{new Date(draft.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </a>
            <button type="button" className="hub-sketch-delete" onClick={() => void remove(draft.id)} title="Delete this sketch" aria-label="Delete this sketch" data-sketch-delete={draft.id}>✕</button>
          </div>
        ))}
      </div>
    </>
  )
}

function SketchPage({ routeId }: { routeId: string }) {
  const [draft, setDraft] = useState<string | null>(routeId === 'new' ? null : routeId)
  const [editing, setEditing] = useState(routeId === 'new')
  const [version, setVersion] = useState(0)
  const draftRef = useRef(draft)
  const etag = useRef<string | null>(null)

  // Stable for the life of the page: the editor reloads when it changes.
  const io = useMemo<DrawingIo>(() => ({
    async load() {
      if (!draftRef.current) return { text: blankScene(), etag: null }
      const got = await hubGet<{ text: string; etag: string }>(`/drawings/${encodeURIComponent(draftRef.current)}`)
      etag.current = got.etag
      return got
    },
    async save(scene, png, base) {
      try {
        if (!draftRef.current) {
          const created = await hubPost<{ id: string; etag: string }>('/drawings', { scene, png })
          draftRef.current = created.id
          etag.current = created.etag
          setDraft(created.id)
          // The address now names the draft, so a reload comes back to it; no history entry is added.
          history.replaceState(null, '', hubHash('sketch', created.id))
          return { etag: created.etag }
        }
        const saved = await hubPost<{ etag: string }>(`/drawings/${encodeURIComponent(draftRef.current)}`, { scene, png, base: base ?? etag.current })
        etag.current = saved.etag
        return saved
      } catch (failure) {
        if (failure instanceof HubError && failure.status === 409) throw Object.assign(new Error(failure.message), { status: 409, answer: { current: failure.body?.current ?? null } })
        throw failure
      }
    },
    async background() { throw new Error('A sketch has no background picture.') },
  }), [])

  const close = () => {
    setEditing(false)
    setVersion(value => value + 1)
    if (!draftRef.current) window.location.assign(hubHash('sketch'))
  }

  const [deleteError, setDeleteError] = useState<string | null>(null)
  const remove = async () => {
    if (!draftRef.current) return
    try {
      if (await deleteSketch(draftRef.current)) window.location.assign(hubHash('sketch'))
    } catch (failure) {
      setDeleteError((failure as Error).message)
    }
  }

  return (
    <>
      <div className="hub-top"><h2>Sketch</h2><a className="hub-btn" href={hubHash('sketch')}>All sketches</a></div>
      {editing && (
        <Suspense fallback={null}><DrawingEditor url="" title="Sketch" io={io} onClose={close} /></Suspense>
      )}
      {draft && !editing && (
        <>
          <section className="hub-panel">
            <span className="hub-thumb hub-sketch-big"><HubImage key={version} path={`drawings/${draft}/drawing.png`} alt="Your sketch" /></span>
            <div className="hub-actions start">
              <button type="button" className="hub-btn" onClick={() => setEditing(true)}>Edit</button>
              <button type="button" className="hub-btn danger" onClick={() => void remove()} data-sketch-delete>Delete</button>
            </div>
            {deleteError && <p className="hub-error" role="alert">{deleteError}</p>}
          </section>
          <SendPanel draft={draft} />
        </>
      )}
    </>
  )
}

function SendPanel({ draft }: { draft: string }) {
  const [tab, setTab] = useState<'request' | 'ask'>('request')
  return (
    <section className="hub-panel" aria-label="Send to agent">
      <h3>Send to agent</h3>
      <div className="hub-seg" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'request'} className={tab === 'request' ? 'on' : ''} onClick={() => setTab('request')}>New request</button>
        <button type="button" role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'on' : ''} onClick={() => setTab('ask')}>Answer an Ask</button>
      </div>
      {tab === 'request' ? <NewRequest draft={draft} /> : <AnswerAsk draft={draft} />}
    </section>
  )
}

function NewRequest({ draft }: { draft: string }) {
  const projects = useHubData<{ projects: HubProject[] }>('/projects')
  const [chosen, setChosen] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [when, setWhen] = useState('next-sprint')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = projects.data?.projects ?? []
  const project = chosen ?? list[0]?.id
  const send = async () => {
    if (!project) return
    setBusy(true); setError(null)
    try {
      const drawing = await loadDrawn(draft)
      const answer = await hubPost<{ id: string }>('/requests', { project, text: text.trim(), when, drawing })
      setSent(answer.id); setText('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request was not sent.')
    } finally { setBusy(false) }
  }
  return (
    <div>
      <div className="hub-chips" aria-label="Project">
        {list.map(item => <button key={item.id} type="button" className={`hub-chip${item.id === project ? ' on' : ''}`} onClick={() => setChosen(item.id)}>{item.name}</button>)}
      </div>
      <label className="hub-field">What should happen?
        <textarea value={text} onChange={event => setText(event.target.value)} rows={3} maxLength={4000} />
      </label>
      <div className="hub-seg" role="radiogroup" aria-label="When">
        {WHEN.map(([key, label]) => <button key={key} type="button" role="radio" aria-checked={when === key} className={when === key ? 'on' : ''} onClick={() => setWhen(key)}>{label}</button>)}
      </div>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {sent && <p className="hub-ok" role="status">Sent as <code>{sent}</code></p>}
      <div className="hub-actions"><button type="button" className="hub-btn pri" disabled={busy || !text.trim() || !project} onClick={() => void send()}>Send request</button></div>
    </div>
  )
}

function AnswerAsk({ draft }: { draft: string }) {
  const [asks, setAsks] = useState<Ask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The Ask list says nothing about drawings, so each open Ask is read once to see whether it takes one.
  useEffect(() => {
    let stopped = false
    hubGet<{ items: Item[] }>('/inbox?filter=asks')
      .then(async ({ items }) => {
        const open = items.filter(item => item.kind === 'ask' && (item.state === 'open' || item.state === 'snoozed')).slice(0, 20)
        const full = await Promise.all(open.map(item => hubGet<Ask>(`/asks/${encodeURIComponent(item.id)}`)))
        if (!stopped) setAsks(full.filter(ask => ask.allowDrawing))
      })
      .catch(failure => { if (!stopped) setError(failure instanceof Error ? failure.message : 'The Asks could not be read.') })
    return () => { stopped = true }
  }, [])
  const choose = async (ask: Ask) => {
    try {
      setHandoff(await loadDrawn(draft))
      window.location.assign(hubHash('ask', ask.id))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The sketch could not be read.')
    }
  }
  return (
    <div>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {asks && !asks.length && <p className="hub-empty">No open Ask takes a drawing.</p>}
      {asks?.map(ask => (
        <button key={ask.id} type="button" className="hub-row click hub-row-button" onClick={() => void choose(ask)}>
          <span className="hub-dot p" aria-hidden="true" />
          <span className="hub-row-text"><span className="hub-row-title">{ask.question}</span><span className="hub-row-meta">{ask.project}</span></span>
          <span className="hub-btn pri">Attach</span>
        </button>
      ))}
      {!asks && !error && <p className="hub-empty">Looking for Asks…</p>}
    </div>
  )
}
