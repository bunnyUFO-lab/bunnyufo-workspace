import { useState } from 'react'
import { allSites, archivedSites, pathId } from '../lib/sites'
import type { Site } from '../lib/sites'
import { useCanWrite, useCapabilities } from '../lib/writes'

/**
 * The workspaces a published site serves, to rename, archive, restore and add. This is management, not a selector:
 * there are no links to a section and no "current" mark here. The Library's project filter is the one place that picks.
 */
export default function SiteWorkspaces() {
  const { create } = useCapabilities()
  const canWrite = useCanWrite()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')

  // Workspace edits go to /api/sections/...; the site list is read once per page, so a reload shows the result.
  const edit = async (route: string, data: Record<string, unknown>, label: string) => {
    setBusy(label); setError('')
    try {
      const response = await fetch(`/api/sections/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      const answer = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(answer.error || 'That change could not be saved.')
      return true
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
      return false
    } finally {
      setBusy('')
    }
  }
  const rename = async (site: Site) => {
    const wanted = draft.trim()
    if (!wanted) return
    if (await edit('rename', { workspace: site.id, name: wanted }, 'Renaming…')) window.location.reload()
  }
  const archive = async (site: Site, archived: boolean) => {
    if (!await edit('archive', { workspace: site.id, archived }, archived ? 'Archiving…' : 'Restoring…')) return
    // Archiving the section in the address leaves it: stay on Settings. The address, not the page-load value, says which one is open.
    if (archived && pathId() === site.id) window.location.assign('/#/~hub/settings')
    else window.location.reload()
  }

  // A new workspace is a few puts into the cards bucket and is on the site at once; the site list
  // is cached for a few seconds, so wait for it to appear there and then go to it.
  const start = async () => {
    const wanted = name.trim()
    if (!wanted) return
    setBusy('Creating…'); setError('')
    try {
      const response = await fetch('/api/sections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: wanted }) })
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

  const live = allSites.filter(site => !site.archived)
  return <section className="settings-workspaces" data-site-workspaces><h3>Workspaces</h3>
    <ul>{live.map(site => editing === site.id
      ? <li key={site.id}>
        <form className="settings-add-workspace settings-rename" onSubmit={event => { event.preventDefault(); void rename(site) }}>
          <input autoFocus value={draft} maxLength={60} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditing('') } }} aria-label={`New name for ${site.name}`} disabled={!!busy} />
          <span>
            <button type="submit" disabled={!!busy || !draft.trim()}>{busy || 'Rename'}</button>
            <button type="button" onClick={() => setEditing('')} disabled={!!busy}>Cancel</button>
          </span>
          <small>Only the name changes. The address and every link stay the same.</small>
        </form>
      </li>
      : <li key={site.id}>
        <span><strong>{site.name}</strong></span>
        {canWrite && <span>
          <button type="button" disabled={!!busy} aria-label={`Rename ${site.name}`} onClick={() => { setDraft(site.name); setEditing(site.id); setError('') }}>Rename…</button>
          <button type="button" disabled={!!busy} aria-label={`Archive ${site.name}`} onClick={() => void archive(site, true)}>Archive</button>
        </span>}
      </li>)}
    </ul>
    {canWrite && archivedSites.length > 0 && <>
      <h3>Archived</h3>
      <ul>{archivedSites.map(site => <li key={site.id}>
        <span><strong>{site.name}</strong><small> (archived)</small></span>
        <span><button type="button" disabled={!!busy} aria-label={`Restore ${site.name}`} onClick={() => void archive(site, false)}>Restore</button></span>
      </li>)}</ul>
    </>}
    {create && (naming
      ? <form className="settings-add-workspace" onSubmit={event => { event.preventDefault(); void start() }}>
        <input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Workspace name" aria-label="Workspace name" disabled={!!busy} />
        <span>
          <button type="submit" disabled={!!busy || !name.trim()}>{busy || 'Create'}</button>
          <button type="button" onClick={() => { setNaming(false); setError('') }} disabled={!!busy}>Cancel</button>
        </span>
        <small>Starts empty. Add cards to it with ＋ New card.</small>
      </form>
      : <p><button type="button" className="settings-new-workspace" onClick={() => setNaming(true)}>＋ New workspace…</button></p>)}
    <p>Each workspace is a project in the Library's filter.</p>
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
  </section>
}
