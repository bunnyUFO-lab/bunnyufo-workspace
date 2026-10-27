import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { api, reportError, setPreview, uploadFile, useService } from './client'
import type { FileEntry, Folder, Preview } from './types'
import { Icon } from './Icons'
import WorkspaceSettings from './WorkspaceSettings'
import SkillPacks from './SkillPacks'
import { completeFolder, matchSummary } from './pathComplete'
import { host } from '../lib/host'

// Only a host with an MCP tool pays for this panel.
const McpPanel = lazy(() => import('./McpPanel'))

const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
const fileName = (path: string) => path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || path
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
type TreeControls = {
  expanded: Set<string>; selected: string; dropTarget: string; query: string; revision: number
  toggle: (path: string) => void
  preview: (entry: FileEntry) => void
  drag: (event: DragEvent, path: string, directory: boolean) => void
  dragEnd: () => void
  dropProps: (path: string) => {
    onDragOver: (event: DragEvent) => void
    onDragLeave: (event: DragEvent) => void
    onDrop: (event: DragEvent) => void
  }
}

function FolderBranch({ path, mode = 'all', depth = 1, ancestors = [], tree, onLoad }: {
  path: string; mode?: 'main' | 'all'; depth?: number; ancestors?: string[]; tree: TreeControls; onLoad?: (folder: Folder) => void
}) {
  const [folder, setFolder] = useState<Folder | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    api<Folder>(`/files?path=${encodeURIComponent(path)}&mode=${mode}`).then(value => {
      if (!abort.signal.aborted) { setFolder(value); setError(''); onLoad?.(value) }
    }).catch(error => { if (!abort.signal.aborted) setError(message(error)) })
    return () => abort.abort()
  }, [path, mode, tree.revision, onLoad])
  if (error) return <p className="file-tree-note desk-error-inline">{error}</p>
  if (!folder) return <p className="file-tree-note">Loading folder…</p>
  if (ancestors.includes(pathKey(folder.path))) return <p className="file-tree-note">Linked folder already shown above.</p>
  if (depth > 20) return <p className="file-tree-note" title={path}>Nested too deep to show. Type its path above to open it here.</p>
  const entries = folder.entries.filter(entry => entry.directory || entry.name.toLowerCase().includes(tree.query.toLowerCase()))
  return <div role="group" {...tree.dropProps(folder.path)}>{entries.map(entry => {
    const expanded = tree.expanded.has(pathKey(entry.path))
    return <div role="none" key={entry.path}>
      <div role="none" className="file-entry" {...(entry.directory ? tree.dropProps(entry.path) : {})}>
      <button role="treeitem" data-path={entry.path} aria-level={depth + 1} aria-expanded={entry.directory ? expanded : undefined} aria-selected={pathKey(tree.selected) === pathKey(entry.path)}
        className={`file-row ${entry.directory ? 'directory' : ''} ${pathKey(tree.selected) === pathKey(entry.path) ? 'selected' : ''} ${tree.dropTarget === pathKey(entry.path) ? 'drop-target' : ''}`}
        style={{ paddingLeft: 8 + Math.min(depth, 10) * 14 }} title={entry.path}
        onClick={() => entry.directory ? tree.toggle(entry.path) : tree.preview(entry)}
        draggable onDragStart={event => tree.drag(event, entry.path, entry.directory)} onDragEnd={tree.dragEnd}
        {...tree.dropProps(entry.directory ? entry.path : folder.path)}>
        <Icon name="arrow" size={11} style={{ visibility: entry.directory ? 'visible' : 'hidden', transform: expanded ? 'rotate(90deg)' : undefined }} />
        <Icon name={entry.directory ? 'folder' : 'files'} size={15} /><span>{entry.name}</span>
        {!entry.directory && <small>{entry.size < 1024 * 1024 ? `${Math.max(1, Math.round(entry.size / 1024))}k` : `${(entry.size / (1024 * 1024)).toFixed(1)}m`}</small>}
      </button>
      </div>
      {entry.directory && expanded && <FolderBranch path={entry.path} depth={depth + 1} ancestors={[...ancestors, pathKey(folder.path)]} tree={tree} />}
    </div>
  })}{!entries.length && <p className="file-tree-note" style={{ paddingLeft: 22 + depth * 14 }}>{tree.query ? 'No matching files.' : 'Empty folder · drop files here'}</p>}
    {folder.truncated && <p className="file-tree-note">First 1,500 entries shown. Filter by name to narrow the folder.</p>}
  </div>
}

function treeKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'))
  const current = rows.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0) return
  event.preventDefault()
  const row = rows[current], expanded = row.getAttribute('aria-expanded')
  if (event.key === 'ArrowRight' && expanded === 'false') return row.click()
  if (event.key === 'ArrowLeft' && expanded === 'true' && current > 0) return row.click()
  let next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current + (event.key === 'ArrowUp' ? -1 : 1)
  if (event.key === 'ArrowLeft') {
    next = current - 1
    while (next > 0 && Number(rows[next].getAttribute('aria-level')) >= Number(row.getAttribute('aria-level'))) next--
  }
  rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus()
}

export default function FilesRail() {
  const { repo, workspace } = useService()
  // The workspace shortcut opens the active workspace, which may be its own repo outside this one.
  const shortcutPath = (name: string) => name === 'workspace' && workspace ? workspace.root : `${repo}/${name}`
  const storageKey = `buw.files.${pathKey(repo)}`
  // The site does not reopen a panel on every load; the local app remembers its file tree.
  const [open, setOpen] = useState(() => host.files && localStorage.getItem(`${storageKey}.open`) === 'true')
  const tools = (['files', 'settings', 'skills', 'mcp'] as const).filter(name => name === 'files' ? host.files : name === 'mcp' ? host.mcp : true)
  const [panel, setPanel] = useState<'files' | 'skills' | 'mcp' | 'settings'>(tools[0])
  const [installer, setInstaller] = useState(false)
  const [root, setRoot] = useState(repo)
  const [typedPath, setTypedPath] = useState(repo)
  const [rootFolder, setRootFolder] = useState<Folder | null>(null)
  const [mode, setMode] = useState<'main' | 'all'>('main')
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(`${storageKey}.expanded`) || '[]'); return new Set(Array.isArray(saved) ? saved.filter(item => typeof item === 'string') : []) } catch { return new Set() }
  })
  const [selected, setSelected] = useState(repo)
  const [destination, setDestination] = useState(repo)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [revision, setRevision] = useState(0)
  const [dropTarget, setDropTarget] = useState('')
  const [copying, setCopying] = useState(false)
  const copyLock = useRef(false)
  const internalDrag = useRef<{ path: string; directory: boolean; handled: boolean } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const loaded = useCallback((folder: Folder) => setRootFolder(folder), [])
  useEffect(() => { localStorage.setItem(`${storageKey}.open`, String(open)) }, [storageKey, open])
  useEffect(() => { localStorage.setItem(`${storageKey}.expanded`, JSON.stringify([...expanded].slice(-300))) }, [storageKey, expanded])
  useEffect(() => {
    if (!open || !host.files) return
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 10000)
    return () => { window.removeEventListener('focus', refresh); clearInterval(timer) }
  }, [open, refresh])
  const navigate = (path: string) => { setRoot(path); setTypedPath(path); setSelected(path); setDestination(path); if (pathKey(path) !== pathKey(root)) setRootFolder(null); setQuery(''); setError('') }
  // Tab completes the last folder name like a shell; several matches are listed in the status.
  const completePath = async () => {
    const result = await completeFolder(typedPath)
    if (!result) return
    setTypedPath(result.value); setStatus(matchSummary(result.matches))
  }
  // On a phone the rail is not a column but a menu behind the button at the top right (global.css).
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    if (!menu) return
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenu(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])
  const showPanel = (next: 'files' | 'skills' | 'mcp' | 'settings') => {
    setMenu(false)
    if (open && panel === next) { setOpen(false); return }
    if (next === 'skills' && host.files) { setMode('all'); navigate(`${repo}/.claude/skills`) }
    if (next === 'files' && panel !== 'files') { setMode('main'); navigate(repo) }
    setPanel(next); setOpen(true)
  }
  const toggle = (path: string) => {
    setSelected(path); setDestination(path)
    setExpanded(current => { const next = new Set(current), key = pathKey(path); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  const copy = useCallback(async (files: File[], folder: string) => {
    if (copyLock.current || !files.length) return
    if (files.length > 100) { setError('Copy up to 100 files at a time.'); return }
    if (files.some(file => file.size > 1024 * 1024 * 1024)) { setError('Choose files of 1 GB or less.'); return }
    copyLock.current = true; setCopying(true); setError(''); setDropTarget('')
    let count = 0, renamed = 0
    try {
      for (const file of files) {
        setStatus(`Copying ${count + 1} of ${files.length} to ${fileName(folder)}…`)
        const result = await uploadFile(file, folder)
        count++; if (result.renamed) renamed++
      }
      setStatus(`Copied ${count} ${count === 1 ? 'file' : 'files'} to ${fileName(folder)}.${renamed ? ' Existing files kept; copies renamed.' : ''}`)
    } catch (error) { setError(message(error)); setStatus(count ? `Copied ${count} of ${files.length} files before the error.` : '') }
    finally {
      copyLock.current = false; setCopying(false); setSelected(folder); setDestination(folder)
      setExpanded(current => new Set([...current, pathKey(folder)])); refresh()
    }
  }, [refresh])
  const dropFiles = useCallback(async (event: DragEvent, folder: string) => {
    event.preventDefault(); event.stopPropagation(); setDropTarget('')
    const gesture = internalDrag.current
    if (gesture) {
      gesture.handled = true
      if (gesture.directory) { setStatus(''); setError('Drop folders into a terminal to insert their paths. Use Explorer to move folders.'); return }
      if (copyLock.current) return
      copyLock.current = true; setCopying(true); setError('')
      try {
        const result = await api<{ path: string; moved: boolean }>('/files/move', { path: gesture.path, folder })
        setStatus(result.moved ? `Moved ${fileName(result.path)} to ${fileName(folder)}.` : '')
        if (result.moved) { setSelected(result.path); setDestination(folder); setExpanded(current => new Set([...current, pathKey(folder)])) }
      } catch (error) { setError(message(error)); setStatus('') }
      finally { copyLock.current = false; setCopying(false); refresh() }
      return
    }
    if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setError('Drop individual files into a folder. Folder transfers are available in Explorer.'); return }
    await copy(Array.from(event.dataTransfer.files), folder)
  }, [copy, refresh])
  const dropProps = (folder: string) => ({
    onDragOver: (event: DragEvent) => {
      // A drag that began in the tree carries text/plain, not Files.
      const moving = !!internalDrag.current
      if (!moving && !event.dataTransfer.types.includes('Files')) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = copyLock.current ? 'none' : moving ? 'move' : 'copy'; setDropTarget(pathKey(folder))
    },
    onDragLeave: (event: DragEvent) => {
      event.stopPropagation()
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget('')
    },
    onDrop: (event: DragEvent) => {
      // eslint-disable-next-line react-hooks/refs -- This returned event handler runs on a user drop, never during render.
      void dropFiles(event, folder)
    },
  })
  const tree: TreeControls = {
    expanded, selected, dropTarget, query, revision, toggle, dropProps,
    // Nothing else clears the gesture now that the shell no longer reports the drop.
    dragEnd: () => { if (!internalDrag.current?.handled) setStatus(''); internalDrag.current = null; setDropTarget('') },
    // Where the panel overlays the content, a chosen file takes the screen: put the panel away.
    preview: entry => { if (window.matchMedia('(max-width: 960px)').matches) setOpen(false); setSelected(entry.path); setDestination(entry.path.replace(/[\\/][^\\/]+$/, '')); api<Preview>(`/preview?path=${encodeURIComponent(entry.path)}`).then(setPreview).catch(reportError) },
    drag: (event, path, directory) => {
      // A plain browser drag. text/plain still drops the path into a terminal or an
      // editor, and the tree's own drop handler still moves the file.
      internalDrag.current = { path, directory, handled: false }
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', path)
      setError(''); setStatus(directory ? 'Drop this folder path into a terminal or an editor. Esc cancels.' : 'Drop into another folder to move it, or into a terminal to insert its path. Esc cancels.')
    },
  }
  return <aside className={`files-container ${open ? 'expanded' : ''} ${menu ? 'menu-open' : ''}`}>
    <button className="rail-toggle" onClick={() => setMenu(v => !v)} aria-expanded={menu} aria-label="Tools" title="Tools"><Icon name="more" size={22} /></button>
    {menu && <div className="rail-backdrop" onClick={() => setMenu(false)} aria-hidden="true" />}
    {open && panel === 'settings' && <WorkspaceSettings onClose={() => setOpen(false)} />}
    {open && panel === 'mcp' && <Suspense fallback={null}><McpPanel onClose={() => setOpen(false)} /></Suspense>}
    {open && panel === 'skills' && !host.files && <SkillPacks onClose={() => setOpen(false)} />}
    {open && panel === 'skills' && host.files && installer && <SkillPacks onBack={() => setInstaller(false)} onClose={() => { setInstaller(false); setOpen(false) }} />}
    {open && host.files && (panel === 'files' || (panel === 'skills' && !installer)) && <div className="files-panel"><header><h2>{panel === 'skills' ? 'Skills' : 'Files'}</h2><div>
      <button className="desk-icon" disabled={copying} onClick={() => input.current?.click()} title={`Copy files into ${fileName(destination)}`} aria-label="Add files"><Icon name="plus" size={16} /></button>
      <button className="desk-icon" onClick={refresh} title="Refresh files"><Icon name="refresh" size={15} /></button><button className="desk-icon" onClick={() => setOpen(false)} title="Collapse files"><Icon name="close" size={17} /></button>
    </div></header>
      <input ref={input} type="file" multiple hidden onChange={event => { void copy(Array.from(event.target.files || []), destination); event.target.value = '' }} />
      {panel === 'files' ? <><div className="file-mode"><button className={mode === 'main' ? 'selected' : ''} onClick={() => { setMode('main'); navigate(repo) }}>Main folders</button><button className={mode === 'all' ? 'selected' : ''} onClick={() => setMode('all')}>All files</button></div>
      <div className="file-shortcuts">{['inbox', 'projects', 'workspace', 'knowledge', 'processes'].map(name => { const path = shortcutPath(name); return <button key={name} {...dropProps(path)} className={dropTarget === pathKey(path) ? 'drop-target' : ''} title={path} onClick={() => { if (path !== `${repo}/${name}`) { navigate(path); setSelected(path); setDestination(path); return } navigate(repo); setExpanded(current => new Set([...current, pathKey(path)])); setSelected(path); setDestination(path) }}><Icon name="folder" size={14} />{name}</button> })}</div></> : <div className="skill-locations">{[['Claude', '.claude/skills'], ['Codex', '.agents/skills'], ['Knowledge', 'knowledge'], ['Processes', 'processes']].map(([label, path]) => <button key={path} aria-pressed={pathKey(root) === pathKey(`${repo}/${path}`)} onClick={() => { setMode('all'); navigate(`${repo}/${path}`) }}>{label}</button>)}<button className="skill-install-open" onClick={() => setInstaller(true)}><Icon name="plus" size={12} />Install in a project…</button><p>Skills a project deploys with APM · open a SKILL.md to read.</p></div>}
      <form className="file-path" onSubmit={event => { event.preventDefault(); setMode('all'); navigate(typedPath) }}><button type="button" title="Parent folder" onClick={() => { setMode('all'); navigate(rootFolder?.parent || repo) }}><Icon name="up" size={15} /></button><input value={typedPath} onChange={event => setTypedPath(event.target.value)} onKeyDown={event => { if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); void completePath() } }} spellCheck={false} aria-label="Folder path" /><button type="submit" title="Open folder"><Icon name="arrow" size={14} /></button></form>
      <div className="file-filter"><Icon name="search" size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter file names…" aria-label="Filter file names in expanded folders" /></div>
      <div className={`file-list ${dropTarget === pathKey(destination) ? 'drop-area' : ''}`} role="tree" aria-label="Folder tree" onKeyDown={treeKeys} {...dropProps(destination)}>
        <div role="none" className="file-entry" {...dropProps(root)}><button role="treeitem" aria-level={1} aria-expanded="true" aria-selected={pathKey(selected) === pathKey(root)} className={`file-row file-root-row ${dropTarget === pathKey(root) ? 'drop-target' : ''}`} onClick={() => { setSelected(root); setDestination(root) }} {...dropProps(root)} title={root}><Icon name="arrow" size={11} style={{ transform: 'rotate(90deg)' }} /><Icon name="folder" size={15} /><span>{pathKey(root) === pathKey(repo) ? 'bunnyUFO' : fileName(root)}</span></button></div>
        <FolderBranch key={`${root}:${mode}`} path={root} mode={mode} tree={tree} onLoad={loaded} />
      </div>
      <div className="file-transfer-status" aria-live="polite">{error && <p className="desk-error-inline">{error}</p>}{status && <p>{status}</p>}<small title={destination}>{copying ? 'Transferring files…' : 'Drag to move · drop files to copy'}</small></div>
      <footer><button onClick={() => navigate(repo)}>bunnyUFO root</button></footer>
    </div>}
    <div className="files-rail">{tools.map(name => <button key={name} className={`rail-tool ${open && panel === name ? 'active' : ''}`} onClick={() => showPanel(name)} title={name === 'mcp' ? 'MCP' : name[0].toUpperCase() + name.slice(1)} aria-label={`Toggle ${name}`} aria-pressed={open && panel === name}><Icon name={name === 'files' ? 'folder' : name} size={18} /><span>{name === 'mcp' ? 'MCP' : name}</span></button>)}
      <button className="rail-tool" title="Keyboard shortcuts ( Ctrl+H )" aria-label="Keyboard shortcuts" onClick={() => { setMenu(false); window.dispatchEvent(new Event('bunnyufo-shortcuts')) }}><Icon name="keyboard" size={18} /><span>Shortcuts</span></button></div>
  </aside>
}
