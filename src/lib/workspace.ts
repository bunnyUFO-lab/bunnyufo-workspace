import { useCallback, useEffect, useRef, useState } from 'react'
import type { CardWorkspace, WorkspaceCard, WorkspaceEntity, WorkspaceState } from '../types'
import { api } from '../local/client'
import { host } from './host'
import { activeSite, allSites, contentBase } from './sites'
import { applyCardState } from './archiveRule.ts'

const POLL_MS = 30_000
export { ARCHIVE_DAYS, archiveCutoff } from './archiveRule.ts'

/** What one load produced: every workspace, and every card tagged with the one it came from. */
export interface WorkspaceData {
  workspaces: CardWorkspace[]
  cards: WorkspaceCard[]
}

const EMPTY: WorkspaceData = { workspaces: [], cards: [] }

/** The service's answer: each registered workspace with its own cards and content base. */
interface AllCards {
  active: string
  workspaces: (CardWorkspace & { contentBase: string; entities: WorkspaceEntity[] })[]
}

const tag = (workspace: CardWorkspace, entities: WorkspaceEntity[]): WorkspaceCard[] =>
  entities.filter(e => e && typeof e.id === 'string').map(e => ({ ...e, workspace }))

/** Local app: one call, because the service already knows the user's registry. */
async function loadLocal(): Promise<WorkspaceData> {
  const { workspaces } = await api<AllCards>('/workspace/all')
  const data: WorkspaceData = { workspaces: [], cards: [] }
  for (const item of workspaces) {
    const workspace: CardWorkspace = {
      id: item.id, name: item.name, base: item.contentBase, root: item.root,
      repo: item.repo ?? null, site: item.site ?? null, bucket: item.bucket ?? null, active: item.active, builtin: !!item.builtin,
      ...(item.retired && Object.keys(item.retired).length ? { retired: item.retired } : {}),
    }
    data.workspaces.push(workspace)
    data.cards.push(...tag(workspace, item.entities))
  }
  return data
}

/**
 * What has been pinned or put away since the site was published.
 *
 * The workspace.json files Caddy serves are build output: they say what the repository said at
 * publish time, and a pin made on a phone five minutes ago is not in them. The write API keeps
 * that in a state file instead of committing it, and this is where the page reads it back. A
 * site without the API answers nothing and the published files stand on their own, as before.
 */
async function cardState(): Promise<Record<string, Partial<WorkspaceEntity> & { restoredAt?: string }>> {
  try {
    const res = await fetch('/api/card-state', { cache: 'no-store' })
    if (!res.ok) return {}
    const answer = await res.json()
    return answer && typeof answer.cards === 'object' && answer.cards ? answer.cards : {}
  } catch {
    return {}
  }
}

/**
 * A published site has no service, so each workspace it serves is fetched from its own base
 * (lib/sites). A site that fails to answer is skipped rather than emptying the whole list — one
 * workspace published mid-request must not take the other projects off the screen.
 */
async function loadSite(): Promise<WorkspaceData> {
  const sites = allSites.length
    ? allSites
    : [{ id: 'workspace', name: activeSite?.name ?? 'Workspace', base: contentBase }]
  // Asked for alongside the workspaces, not after them: it is one small request and waiting for
  // it in series would add a round trip to every refresh.
  const stateLoad = cardState()
  const loaded = await Promise.all(sites.map(async site => {
    try {
      const res = await fetch(`${site.base}/workspace.json`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const parsed = JSON.parse(await res.text()) as WorkspaceState
      const workspace: CardWorkspace = {
        id: site.id, name: site.name, base: site.base,
        repo: 'repo' in site ? site.repo ?? null : null,
        repoPath: 'path' in site ? site.path : undefined,
        branch: 'branch' in site ? site.branch : undefined,
        active: site.id === (activeSite?.id ?? 'workspace'),
        ...('archived' in site && site.archived ? { archived: true } : {}),
        ...(parsed?.retired && typeof parsed.retired === 'object' && Object.keys(parsed.retired).length ? { retired: parsed.retired } : {}),
      }
      return { workspace, entities: Array.isArray(parsed?.entities) ? parsed.entities : [] }
    } catch {
      return null
    }
  }))
  const reachable = loaded.filter(item => item !== null)
  if (!reachable.length) throw new Error('No workspace could be loaded')
  const state = await stateLoad
  return {
    workspaces: reachable.map(item => item.workspace),
    cards: reachable.flatMap(item =>
      tag(item.workspace, item.entities.map(e => applyCardState(e, state[`${item.workspace.id}/${e.id}`]))),
    ),
  }
}

/**
 * Loads every workspace the app can see and keeps them fresh: refetch on window focus /
 * visibility and a light poll while the tab is visible. State only changes when the content
 * actually changed, so re-renders are cheap. A failed load (or a mid-write half-file from an
 * agent) flips `offline` and keeps the last good data.
 */
export function useWorkspace() {
  const [data, setData] = useState<WorkspaceData | null>(null)
  const [offline, setOffline] = useState(false)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const rawRef = useRef('')

  const reload = useCallback(async () => {
    try {
      const loaded = host.workspaces ? await loadLocal() : await loadSite()
      const raw = JSON.stringify(loaded)
      if (raw !== rawRef.current) {
        rawRef.current = raw
        setData(loaded)
      }
      setOffline(false)
      setLastSync(new Date())
    } catch {
      setOffline(true)
      setData(current => current ?? EMPTY)
    }
  }, [])

  useEffect(() => {
    // Initial fetch — every setState inside reload happens after an await,
    // never synchronously, so cascading-render concerns don't apply here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload()
    const refresh = () => {
      if (document.visibilityState === 'visible') reload()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('bunnyufo-workspace-changed', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, POLL_MS)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('bunnyufo-workspace-changed', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(timer)
    }
  }, [reload])

  return { data, offline, lastSync }
}
