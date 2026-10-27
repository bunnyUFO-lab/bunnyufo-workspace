import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, onServiceEvent, useService } from '../local/client'
import { activeSite, allSites, siteHref } from '../lib/sites'
import { useCapabilities } from '../lib/writes'
import { host } from '../lib/host'
import type { ActiveWorkspace, WorkspaceEntry } from '../local/types'

type Workspaces = { active: ActiveWorkspace; workspaces: WorkspaceEntry[]; canSwitch: boolean }

/**
 * The active workspace under the logo, with a menu to switch.
 *
 * Local app: the user's registered workspaces, through the service; it can start a new one or add a folder.
 * Published site: the workspaces that site serves (lib/sites), as ordinary links, so the back button works.
 * A site serving only one workspace shows the label without a menu, as before.
 */
export default function WorkspaceSwitcher({ variant = 'brand' }: { variant?: 'brand' | 'crumb' }) {
  const { workspace } = useService()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Workspaces | null>(null)
  const [adding, setAdding] = useState<'' | 'new' | 'folder'>('')
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0 })
  const label = workspace && !workspace.builtin ? workspace.name : 'workspace'

  const refresh = () => api<Workspaces>('/workspaces').then(setList).catch(error => setError(String(error.message || error)))
  useEffect(() => {
    if (!host.workspaces) return
    return onServiceEvent(event => { if (event.type === 'workspace-switched') { setOpen(false); void refresh() } })
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])

  if (!host.workspaces) return <SiteSwitcher variant={variant} />

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await refresh() }
    catch (error) { setError(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  const toggle = () => {
    if (!open) {
      setError(''); setAdding(''); void refresh()
      // The menu is drawn on <body> (fixed), so headers and report layers cannot cover or clip it.
      const box = root.current?.getBoundingClientRect()
      if (box) setPlace({ left: Math.max(8, Math.min(box.left, window.innerWidth - 368)), top: box.bottom + 8 })
    }
    setOpen(!open)
  }
  const add = () => run(async () => {
    const result = await api<{ added: { id: string } }>('/workspaces/add', { path: folder.trim(), name: name.trim() || undefined })
    setFolder(''); setName(''); setAdding('')
    if (list?.canSwitch) await api('/workspaces/switch', { id: result.added.id })
  })
  // A new workspace is made beside the open one and publishes where it does (server/workspaces.mjs).
  const start = () => run(async () => {
    const result = await api<{ added: { id: string } }>('/workspaces/new', { name: name.trim() })
    setName(''); setAdding('')
    if (list?.canSwitch) await api('/workspaces/switch', { id: result.added.id })
  })

  return <div className={`workspace-switcher workspace-switcher-${variant}`} ref={root}>
    <button type="button" className={`${variant === 'brand' ? 'brand-sub ' : ''}workspace-switcher-button`} aria-label={`Workspace: ${label}. Switch or add a workspace`} onClick={toggle} aria-haspopup="menu" aria-expanded={open} title={workspace?.root}>
      {label}<span aria-hidden="true"> ▾</span>
    </button>
    {open && createPortal(<div className="workspace-menu" ref={menu} role="menu" aria-label="Workspaces" style={{ left: place.left, top: place.top }}>
      <p className="workspace-menu-title">Workspaces</p>
      {!list ? <p className="workspace-menu-note">Loading…</p> : <>
        {list.workspaces.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === list.active.id}
          disabled={busy || item.id === list.active.id || !list.canSwitch || !item.exists}
          onClick={() => void run(() => api('/workspaces/switch', { id: item.id }))} title={item.root}>
          <span className="workspace-menu-name">{item.name}</span>
          <small>{item.exists ? item.root : `${item.root} (missing)`}</small>
        </button>)}
        {!list.canSwitch && <p className="workspace-menu-note">This session's workspace is fixed (--content or BUW_CONTENT).</p>}
      </>}
      {adding === 'new' && <form className="workspace-menu-add" onSubmit={event => { event.preventDefault(); void start() }}>
        <input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Workspace name" aria-label="Workspace name" disabled={busy} />
        <span><button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create and open'}</button><button type="button" onClick={() => setAdding('')} disabled={busy}>Cancel</button></span>
        <small>Starts empty, beside {list?.active.name ?? 'the open workspace'}. Add cards with ＋ New card; npm run publish puts it on the site.</small>
      </form>}
      {adding === 'folder' && <form className="workspace-menu-add" onSubmit={event => { event.preventDefault(); void add() }}>
        <input autoFocus value={folder} onChange={event => setFolder(event.target.value)} placeholder="Folder with workspace.json" aria-label="Workspace folder" />
        <input value={name} onChange={event => setName(event.target.value)} placeholder="Name (optional)" aria-label="Workspace name" />
        <span><button type="submit" disabled={busy || !folder.trim()}>Add and open</button><button type="button" onClick={() => setAdding('')}>Cancel</button></span>
      </form>}
      {!adding && <div className="workspace-menu-actions">
        <button type="button" role="menuitem" className="workspace-menu-new" onClick={() => { setName(''); setAdding('new') }}>＋ New workspace…</button>
        <button type="button" role="menuitem" className="workspace-menu-new" onClick={() => { setName(''); setAdding('folder') }}>Add existing folder…</button>
      </div>}
      {error && <p className="workspace-menu-error" role="alert">{error}</p>}
    </div>, document.body)}
  </div>
}

/** The published site's version: the sections this site serves, as links — and a way to start one. */
function SiteSwitcher({ variant }: { variant: 'brand' | 'crumb' }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0 })
  const label = activeSite?.name ?? 'workspace'
  const { create } = useCapabilities()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // A new workspace is a few puts into the cards bucket and is on the site at once; the site list
  // is cached for a few seconds, so wait for it to appear there and then go to it.
  const start = async () => {
    const wanted = name.trim()
    if (!wanted) return
    setBusy('Creating…'); setError('')
    try {
      const response = await fetch('/api/sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: wanted }),
      })
      const answer = await response.json()
      if (!response.ok) throw new Error(answer.error || 'That workspace could not be made.')
      setBusy('Opening…')
      for (let tries = 0; tries < 60; tries++) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        try {
          const list = await (await fetch('/sites.json', { cache: 'no-store' })).json()
          if (Array.isArray(list) && list.some((site: { id?: string }) => site.id === answer.id)) {
            window.location.href = `/${answer.id}`
            return
          }
        } catch { /* the server is mid-publish; ask again */ }
      }
      setError('It was made, but the site has not listed it yet. It should appear shortly.')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])

  // One section and no way to add another: nothing to open a menu for.
  if (allSites.length < 2 && !create) return variant === 'brand' ? <span className="brand-sub">{label}</span> : null

  const toggle = () => {
    if (!open) {
      const box = root.current?.getBoundingClientRect()
      if (box) setPlace({ left: Math.max(8, Math.min(box.left, window.innerWidth - 368)), top: box.bottom + 8 })
    }
    setOpen(!open)
  }

  return <div className={`workspace-switcher workspace-switcher-${variant}`} ref={root}>
    <button type="button" className={`${variant === 'brand' ? 'brand-sub ' : ''}workspace-switcher-button`}
      aria-label={`Workspace: ${label}. Switch workspace`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
      {label}<span aria-hidden="true"> ▾</span>
    </button>
    {open && createPortal(<div className="workspace-menu" ref={menu} role="menu" aria-label="Workspaces" style={{ left: place.left, top: place.top }}>
      <p className="workspace-menu-title">Workspaces</p>
      {allSites.map(site => <a key={site.id} role="menuitemradio" aria-checked={site.id === activeSite?.id}
        className={site.id === activeSite?.id ? 'workspace-menu-current' : undefined} href={siteHref(site)}>
        <span className="workspace-menu-name">{site.name}</span>
      </a>)}
      {create && (naming
        ? <form className="workspace-menu-add" onSubmit={event => { event.preventDefault(); void start() }}>
          <input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Workspace name" aria-label="Workspace name" disabled={!!busy} />
          <span>
            <button type="submit" disabled={!!busy || !name.trim()}>{busy || 'Create'}</button>
            <button type="button" onClick={() => { setNaming(false); setError('') }} disabled={!!busy}>Cancel</button>
          </span>
          <small>Starts empty. Add cards to it with ＋ New card.</small>
        </form>
        : <div className="workspace-menu-actions"><button type="button" role="menuitem" className="workspace-menu-new" onClick={() => setNaming(true)}>＋ New workspace…</button></div>)}
      {error && <p className="workspace-menu-error" role="alert">{error}</p>}
    </div>, document.body)}
  </div>
}
