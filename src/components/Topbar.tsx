import { useEffect, useRef, useState } from 'react'
import type { WorkspaceCard } from '../types'
import { cardFile } from '../local/client'
import { host } from '../lib/host'
import { publishedCardUrl, repoFileUrl } from '../lib/links'
import { AddSection, EditCard } from './CardEdits'

interface TopbarProps {
  entity: WorkspaceCard | null
  stepIndex: number
  onStep: (id: string, index: number) => void
  onHome: () => void
  /** Home, filtered to one project: the breadcrumb's middle step. */
  onProject: (id: string) => void
  /** Only show that step when there is more than one project to tell apart. */
  showProject: boolean
  /** A step that is a live web app (Sprite Studio, ComfyUI): opening it in a real browser tab. */
  liveAppUrl: string | null
}

const GithubMark = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
  </svg>
)

export default function Topbar({ entity, stepIndex, onStep, onHome, onProject, showProject, liveAppUrl }: TopbarProps) {
  const [copied, setCopied] = useState(false)
  // Its own height, which a phone needs to slide it out of view (global.css): it wraps to two rows
  // or three depending on the card's tabs, so no fixed number would do.
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const observer = new ResizeObserver(() => el.style.setProperty('--topbar-height', `${el.offsetHeight}px`))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const file = entity?.steps[stepIndex]?.path ?? ''
  const source = entity && file ? repoFileUrl(entity, file) : null
  const localPath = host.files && entity && file ? cardFile(entity, file) : null
  const published = entity ? publishedCardUrl(entity, stepIndex) : null
  // Cards in the starter examples ship with the app; everything else can be edited where cards can be made.
  const editable = !!entity && host.cards && !entity.workspace.builtin

  const copyPath = async () => {
    if (!localPath) return
    try {
      await navigator.clipboard.writeText(localPath)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard refused (no permission, or an insecure origin): leave the button unchanged.
    }
  }

  return (
    <div className="topbar" ref={bar}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        {/* With a card open the first crumb is a plain way back, not just a word in a path. */}
        <button
          className={`crumb-link${entity ? ' crumb-back' : ''}`}
          onClick={onHome}
          title={entity ? 'Back to the cards ( Esc )' : undefined}
        >
          {entity ? <><span aria-hidden="true">←</span> Cards</> : 'Workspace'}
        </button>
        {entity && showProject && (
          <>
            <span className="crumb-sep">/</span>
            <button
              className="crumb-link"
              onClick={() => { onProject(entity.workspace.id); onHome() }}
              title={`Show only ${entity.workspace.name}`}
            >
              {entity.workspace.name}
            </button>
          </>
        )}
        {entity && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{entity.title}</span>
            {editable && <EditCard key={entity.id} card={entity} />}
          </>
        )}
      </nav>

      {entity && (
        <div className="topbar-right">
          {entity.steps.length > 0 && (
            <div className="step-tabs" role="tablist">
              {entity.steps.map((s, i) => (
                <button
                  key={i}
                  role="tab"
                  aria-selected={i === stepIndex}
                  className={`step-tab${i === stepIndex ? ' active' : ''}`}
                  onClick={() => onStep(entity.id, i)}
                  title={s.name}
                >
                  {s.name}
                </button>
              ))}
              {editable && <AddSection key={entity.id} card={entity} onStep={onStep} />}
            </div>
          )}
          {liveAppUrl && (
            <a className="open-ext" href={liveAppUrl} target="_blank" rel="noreferrer"
              title="Open the app in a browser" aria-label="Open the app in a browser">
              ▶
            </a>
          )}
          {source && (
            <a className="open-ext" href={source} target="_blank" rel="noreferrer"
              title="Open this page in the repository" aria-label="Open this page in the repository">
              <GithubMark />
            </a>
          )}
          {localPath && (
            <button type="button" className="open-ext" onClick={copyPath}
              title={copied ? 'Copied' : `Copy file path: ${localPath}`} aria-label="Copy file path">
              {copied ? '✓' : '⧉'}
            </button>
          )}
          {published && (
            <a className="open-ext" href={published} target="_blank" rel="noreferrer"
              title="Open this card on the published site" aria-label="Open this card on the published site">
              ↗
            </a>
          )}
        </div>
      )}
    </div>
  )
}
