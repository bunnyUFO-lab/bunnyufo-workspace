import { useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceCard } from '../types'
import { cardFile } from '../local/client'
import { host } from '../lib/host'
import { publishedCardUrl, repoFileUrl } from '../lib/links'
import { AddSection, EditCard } from './CardEdits'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import { libraryHash } from '../lib/route'
import { behindHash } from '../lib/entries'
import Icon from '../ui/Icon'
import ItemMenu from './ItemMenu'
import { useCardMenu } from './CardMenu'
import StepTab from './TabEdits'
import TabOrganize from './TabOrganize'

/** The ⋯ beside the pencil: Rename, Category, Move to workspace, Delete. */
function CardMore({ card }: { card: WorkspaceCard }) {
  const { items, dialogs } = useCardMenu(card)
  return <><ItemMenu label="More for this card" items={items} className="crumb-more" />{dialogs}</>
}

interface TopbarProps {
  entity: WorkspaceCard | null
  stepIndex: number
  onStep: (id: string, index: number) => void
  /** The first crumb: one step back (lib/entries `back`), or the Library when nothing of ours is behind. */
  onBack: () => void
  /** The Library, for the crumbs that name a place rather than a step back. */
  onHome: () => void
  /** The card list is folded away (beside a card below 1400 px): the button that brings it back. */
  onShowList?: () => void
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

const FADE = 28

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function Topbar({ entity, stepIndex, onStep, onBack, onHome, onShowList, onProject, showProject, liveAppUrl }: TopbarProps) {
  const [copied, setCopied] = useState(false)
  // Where Back goes, in words: the Library when that is the screen behind this one (or nothing of ours is, and Back falls to it).
  const behind = behindHash()
  const backLabel = !behind || /^#\/~hub\/library$/.test(behind) ? 'Library' : 'Back'
  const [organizing, setOrganizing] = useState(false)
  const tabs = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(0)
  const overflow = useOverflowEdges(tabs, [entity?.id, entity?.steps.length, stepIndex, adding])
  // Bring the active tab inside the visible part of the bar, clear of the fade and the arrows.
  // Computed by hand: scrollIntoView would also move the page. Opening a card jumps; changing tab slides.
  const shownCard = useRef<string | null>(null)
  useLayoutEffect(() => {
    const list = tabs.current
    const tab = list?.querySelector<HTMLElement>('.step-tab.active')
    if (!list || !tab) return
    const first = shownCard.current !== (entity?.id ?? null)
    shownCard.current = entity?.id ?? null
    const reveal = (behavior: ScrollBehavior) => {
      const left = tab.offsetLeft - FADE
      const right = tab.offsetLeft + tab.offsetWidth + FADE
      let target = list.scrollLeft
      const max = list.scrollWidth - list.clientWidth
      if (left < list.scrollLeft) target = Math.max(0, left)
      else if (right > list.scrollLeft + list.clientWidth) target = Math.min(max, right - list.clientWidth)
      // Next to an end (only the add button can follow the last tab), go all the way: a few pixels
      // short would leave a fade over nothing.
      if (tab.offsetLeft <= FADE) target = 0
      else if (tab.offsetLeft + tab.offsetWidth >= list.scrollWidth - 2 * FADE) target = max
      if (Math.abs(target - list.scrollLeft) >= 1) list.scrollTo({ left: target, behavior })
    }
    reveal(first || reducedMotion() ? 'auto' : 'smooth')
    // The bar can still be settling (the menu sliding, fonts arriving): keep the tab in view as it resizes.
    // Only a real change of size re-reveals (the bar, or the tabs inside it): the observer's first
    // callback arrives at once and would cut the smooth slide short.
    let width = list.clientWidth
    let content = list.scrollWidth
    const observer = new ResizeObserver(() => {
      if (list.clientWidth === width && list.scrollWidth === content) return
      width = list.clientWidth
      content = list.scrollWidth
      reveal('auto')
    })
    observer.observe(list)
    for (const child of list.children) observer.observe(child)
    return () => observer.disconnect()
  }, [entity?.id, stepIndex])
  const scrollTabs = (direction: 1 | -1) => tabs.current?.scrollBy({
    left: direction * tabs.current.clientWidth * 0.8, behavior: reducedMotion() ? 'auto' : 'smooth',
  })
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
    <div className="topbar">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        {onShowList && (
          <button type="button" className="crumb-link ui-showlist" onClick={onShowList} data-show-list title="Show the card list ( [ )">
            Show list
          </button>
        )}
        {/* The first crumb is the way back: one step of history, or the Library when this card was opened from a link. */}
        <a
          className={`crumb-link${entity ? ' crumb-back' : ''}`}
          href={libraryHash()}
          onClick={event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            onBack()
          }}
          title={entity ? 'Back ( Esc )' : 'Home'}
          aria-label={entity ? (backLabel === 'Library' ? 'Back to the Library' : 'Back') : undefined}
          data-home-link="crumb"
          data-back=""
        >
          {entity ? (
            <>
              {/* A desktop's small pill keeps its arrow and word; a phone gets a chevron and where it goes (global.css). */}
              <span className="crumb-back-wide" aria-hidden="true">← Back</span>
              <span className="crumb-back-phone" aria-hidden="true"><Icon name="back" size={22} />{backLabel}</span>
            </>
          ) : 'Workspace'}
        </a>
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
            {editable && <CardMore key={`more-${entity.id}`} card={entity} />}
          </>
        )}
      </nav>

      {entity && (
        <div className="topbar-right">
          {entity.steps.length > 0 && (
            <div className="step-tabs-wrap" data-overflow={overflow}>
              <div className="step-tabs" role="tablist" ref={tabs}>
                {entity.steps.map((_, i) => (
                  <StepTab key={i} card={entity} index={i} active={i === stepIndex} onStep={onStep} onOrganize={editable ? () => setOrganizing(true) : undefined} />
                ))}
                {editable && <AddSection key={entity.id} card={entity} onStep={onStep} onNaming={() => setAdding(n => n + 1)} />}
              </div>
              {overflow.includes('start') && (
                <button type="button" className="step-tabs-arrow" data-edge="start" tabIndex={-1} aria-hidden="true" onClick={() => scrollTabs(-1)}>‹</button>
              )}
              {overflow.includes('end') && (
                <button type="button" className="step-tabs-arrow" data-edge="end" tabIndex={-1} aria-hidden="true" onClick={() => scrollTabs(1)}>›</button>
              )}
            </div>
          )}
          {editable && entity.steps.length > 0 && (
            <button type="button" className="step-tab step-tab-organize" onClick={() => setOrganizing(true)} aria-haspopup="dialog">Organize</button>
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
      {organizing && editable && entity && (
        <TabOrganize key={entity.id} card={entity} activePath={entity.steps[stepIndex]?.path ?? ''} onClose={() => setOrganizing(false)} />
      )}
    </div>
  )
}
