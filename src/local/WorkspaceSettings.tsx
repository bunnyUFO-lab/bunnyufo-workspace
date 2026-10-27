import { useEffect, useState } from 'react'
import { api, onServiceEvent, useService } from './client'
import { Icon } from './Icons'
import ThemePicker from '../components/ThemePicker'
import { host } from '../lib/host'
import type { ActiveWorkspace, WorkspaceEntry } from './types'

type Workspaces = { active: ActiveWorkspace; workspaces: WorkspaceEntry[]; canSwitch: boolean }
/** Card folders the app can show: its own starter examples or registered workspace repos. */
function WorkspacesSection() {
  const [list, setList] = useState<Workspaces | null>(null)
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = () => api<Workspaces>('/workspaces').then(setList).catch(error => setError(String(error.message || error)))
  useEffect(() => {
    void refresh()
    return onServiceEvent(event => { if (event.type === 'workspace-switched') void refresh() })
  }, [])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await refresh() }
    catch (error) { setError(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  if (!list) return <section><h3>Workspaces</h3><p>Loading…</p></section>
  return <section className="settings-workspaces"><h3>Workspaces</h3>
    <ul>{list.workspaces.map(item => <li key={item.id} aria-current={item.id === list.active.id}>
      <span><strong>{item.name}</strong>{item.builtin && <small> (starter examples)</small>}{!item.exists && <small> (folder missing)</small>}<small className="settings-repo" title={item.root}>{item.root}</small>
        {item.site && <small><a href={item.site} target="_blank" rel="noreferrer">Published site ↗</a></small>}</span>
      {item.id === list.active.id ? <em>Active</em> : <span>
        <button disabled={busy || !list.canSwitch || !item.exists} onClick={() => void run(() => api('/workspaces/switch', { id: item.id }))}>Switch</button>
        {!item.builtin && <button disabled={busy} onClick={() => { if (window.confirm(`Remove "${item.name}" from the list? This only unregisters it; its files stay where they are.`)) void run(() => api('/workspaces/remove', { id: item.id })) }} title="Unregister only; files stay where they are">Remove</button>}
      </span>}
    </li>)}</ul>
    {!list.canSwitch && <p>{list.active.pinned ? 'This session was started with a fixed workspace (--content or BUW_CONTENT).' : 'Switching needs the local app.'}</p>}
    <form className="settings-add-workspace" onSubmit={event => { event.preventDefault(); void run(async () => { await api('/workspaces/add', { path: folder.trim(), name: name.trim() || undefined }); setFolder(''); setName('') }) }}>
      <input value={folder} onChange={event => setFolder(event.target.value)} placeholder="Folder with workspace.json, e.g. C:/Users/me/Workspace/buw-workspaces/my-workspace" aria-label="Workspace folder" />
      <input value={name} onChange={event => setName(event.target.value)} placeholder="Name (optional)" aria-label="Workspace name" />
      <button type="submit" disabled={busy || !folder.trim()}>Add workspace</button>
    </form>
    <p>Each workspace is its own git repo; publish its cards with <code>npm run publish</code>.</p>
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
  </section>
}

export default function WorkspaceSettings({ onClose }: { onClose: () => void }) {
  const { repo } = useService()
  return <div className="files-panel workspace-settings"><header><h2>Settings</h2><button className="desk-icon" onClick={onClose} aria-label="Close settings"><Icon name="close" size={17} /></button></header>
    <div className="settings-scroll"><section><h3>Appearance</h3><ThemePicker /></section>
      {host.workspaces && <WorkspacesSection />}
      {host.files && <section><h3>Project</h3><p className="settings-repo">{repo}</p><p>Skills, knowledge and processes belong to this repository.</p></section>}
    </div></div>
}
