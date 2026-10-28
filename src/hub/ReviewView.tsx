import { useEffect, useRef, useState } from 'react'
import type { Item, ReviewDetail, ShotPair, Verdict } from '../lib/hub'
import { ago } from '../lib/hub'
import { MarkdownView } from '../components/MarkdownDocument'
import { entityHash, hubHash, reviewHash } from '../lib/route'
import { setFlash } from './flash'
import { linkSummary } from './summaryLinks'
import { ReviewActions } from './ItemRow'
import Md from './Md'
import { useHubData } from './useHub'

const LEG_LABEL: Record<Verdict['leg'], string> = { smoke: 'Smoke tests', review: 'Review', qa: 'QA' }
const DOT: Record<Verdict['result'], string> = { pass: 'g', fail: 'r', noted: 'y' }

/** The card files are served by the site at /w/<section>/<folder>/<path>; each segment is encoded. */
const cardPath = (cardDir: string, path: string) => `/w/${[...cardDir.split('/'), ...path.split('/')].map(encodeURIComponent).join('/')}`

type CardFile = { state: 'loading' } | { state: 'ok'; text: string } | { state: 'missing' }

/**
 * A card file from the site. It counts only when the answer is 200 and Markdown or plain text: the
 * local service answers an unknown path with the app's HTML, and that is "not here", like a 404 or
 * a network error.
 */
function useCardFile(cardDir: string | undefined, path: string | undefined): CardFile {
  const key = cardDir && path ? `${cardDir}\n${path}` : ''
  const [loaded, setLoaded] = useState<{ key: string; file: CardFile }>({ key: '', file: { state: 'loading' } })
  useEffect(() => {
    if (!key || !cardDir || !path) return undefined
    const controller = new AbortController()
    fetch(cardPath(cardDir, path), { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const type = response.headers.get('Content-Type') ?? ''
        if (response.status === 200 && /^(text\/markdown|text\/plain)/i.test(type)) setLoaded({ key, file: { state: 'ok', text: await response.text() } })
        else setLoaded({ key, file: { state: 'missing' } })
      })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ key, file: { state: 'missing' } }) })
    return () => controller.abort()
  }, [key, cardDir, path])
  return key && loaded.key === key ? loaded.file : { state: 'loading' }
}

const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)$/
const prLabel = (url: string) => {
  const match = PR_RE.exec(url)
  return match ? `${match[1]} #${match[2]}` : 'Open link'
}

/** A link that is not a pull request: a card of this site (its hash is a route) or any other page. */
const otherLinkLabel = (url: string) => {
  try { return new URL(url).hash.startsWith('#/') ? 'Open card' : 'Open link' } catch { return 'Open link' }
}

function Shot({ url, caption, alt, onFail }: { url: string; caption: string; alt: string; onFail: (url: string) => void }) {
  const [failed, setFailed] = useState(false)
  return (
    <figure className="hub-review-shot" data-shot>
      {failed
        ? <span className="hub-muted"><a href={url} target="_blank" rel="noopener noreferrer">Open image</a></span>
        : <a href={url} target="_blank" rel="noopener noreferrer"><img loading="lazy" src={url} alt={alt} onError={() => { setFailed(true); onFail(url) }} /></a>}
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

function Shots({ pairs }: { pairs: ShotPair[] }) {
  const [failed, setFailed] = useState<string[]>([])
  const total = pairs.reduce((count, pair) => count + [pair.before, pair.after, pair.other].filter(Boolean).length, 0)
  const fail = (url: string) => setFailed(previous => (previous.includes(url) ? previous : [...previous, url]))
  if (failed.length >= total) return <p className="hub-muted" data-shots-failed>The screenshots could not load here. They are in the pull request.</p>
  return (
    <>
      {pairs.map((pair, index) => (
        <div className="hub-review-pair" key={index} data-pair>
          {(['before', 'after', 'other'] as const).map(slot => {
            const url = pair[slot]
            if (!url) return null
            const name = slot === 'other' ? pair.label : [slot === 'before' ? 'Before' : 'After', pair.label].filter(Boolean).join(' · ')
            return <Shot key={slot} url={url} caption={name || 'Screenshot'} alt={`${pair.label || 'Screenshot'}${slot === 'other' ? '' : `, ${slot}`}`} onFail={fail} />
          })}
        </div>
      ))}
    </>
  )
}

/** The Hub's view of one review: what came with it, the files on its card read in place, and Mark done. `route` is `<event file>[/<card file path>]`. */
export default function ReviewView({ route }: { route: string }) {
  const slash = route.indexOf('/')
  const id = slash < 0 ? route : route.slice(0, slash)
  const file = slash < 0 ? undefined : route.slice(slash + 1) || undefined
  const { data: detail, error } = useHubData<ReviewDetail>(`/reviews/${encodeURIComponent(id)}`)
  const root = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const pushes = useRef(0)
  const previous = useRef<string | undefined>(undefined)

  const inferred = detail?.inferred
  const cardDir = detail?.cardDir ?? inferred?.cardDir
  const files = detail?.cardFiles ?? inferred?.cardFiles ?? []
  const listed = files.find(entry => entry.path === file)
  const content = useCardFile(listed ? cardDir : undefined, listed?.path)
  const loadedDetail = !!detail

  useEffect(() => {
    if (!loadedDetail) return
    if (file) title.current?.focus()
    else {
      pushes.current = 0
      if (previous.current) {
        const button = [...(root.current?.querySelectorAll<HTMLElement>('[data-file]') ?? [])].find(node => node.dataset.file === previous.current)
        button?.focus()
      }
    }
    previous.current = file
  }, [file, loadedDetail])

  if (!detail) {
    return (
      <>
        <p className="hub-empty" role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p>
        {error && <p><a className="hub-btn" href={hubHash('inbox')}>Back to the Inbox</a></p>}
      </>
    )
  }

  const open = (path: string) => {
    if (path === file) return
    pushes.current += 1
    window.location.assign(reviewHash(id, path))
  }
  const close = () => {
    if (pushes.current > 0) window.history.go(-pushes.current)
    else window.location.assign(reviewHash(id))
  }
  const item: Item = { kind: 'review', id, title: detail.title, at: detail.at, ...(detail.url ? { url: detail.url } : {}), ...(detail.card ? { card: detail.card } : {}) }
  const verdicts = detail.verdicts ?? []
  const linked = linkSummary(detail.summary ?? '', { repo: inferred?.repo, prs: detail.prs ?? [], id, files: files.map(entry => entry.path) })
  const foundPrs = !detail.prs?.length && linked.prs.length > 0
  // Only a pull request goes under Pull requests; any other `url` (a card, a page) is a button in the head.
  const urlIsPr = !!detail.url && PR_RE.test(detail.url)
  const prs = detail.prs?.length ? detail.prs : foundPrs ? linked.prs : urlIsPr && detail.url ? [detail.url] : []
  const otherUrl = detail.url && !urlIsPr ? detail.url : undefined
  const folder = file && file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''
  // An event from before reviews carried links and results: one note instead of four empty sections.
  const legacy = !detail.prs?.length && !detail.cardDir && !detail.cardFiles?.length && !detail.screenshots?.length && !detail.deployUrl && !verdicts.length
  const cardLink = detail.card && <a className="hub-btn" href={detail.card} target="_blank" rel="noopener noreferrer">Open the card</a>
  const sprintCard = inferred && <a className="hub-btn" href={`/${encodeURIComponent(inferred.section)}${entityHash(inferred.card.id)}`} target="_blank" rel="noopener noreferrer" data-sprint-card>Sprint card: {inferred.card.title}</a>
  const found = inferred || foundPrs
  const showFiles = !legacy || files.length > 0

  return (
    <div className="hub-review" ref={root} data-open={file ? 'true' : undefined}>
      <div className="hub-review-head">
        <p><a className="hub-btn" href={hubHash('inbox')} data-back-top>‹ Inbox</a></p>
        <div className="hub-top">
          <h2>{detail.title}</h2>
          <span>
            {detail.project && <span className="hub-pill">{detail.project}</span>}
            {detail.source && <> <span className="hub-pill">{detail.source}</span></>}
          </span>
        </div>
        <p className="hub-muted">Posted {ago(detail.at)}{detail.host ? ` from ${detail.host}` : ''}.</p>
        {detail.summary && <Md text={linked.text} />}
        {otherUrl && <p><a className="hub-btn" href={otherUrl} target="_blank" rel="noopener noreferrer" data-link-head>{otherLinkLabel(otherUrl)}</a></p>}
      </div>
      <div className="hub-review-grid" data-solo={files.length || file ? undefined : 'true'}>
        <div className="hub-review-side">
          {legacy && (
            <section className="hub-panel" aria-label="Older review">
              <p className="hub-muted" data-legacy>{found
                ? 'This review was posted before reviews carried their links and test results. The links here were found from the text of the summary.'
                : 'No links or test results came with this review.'}</p>
              {!showFiles && (cardLink || sprintCard) && <p>{cardLink}{sprintCard}</p>}
            </section>
          )}
          {!legacy && <section className="hub-panel" data-section="status" aria-label="Status">
            <h3>Status</h3>
            {verdicts.length === 0 && <p className="hub-muted">No test or review results came with this item.</p>}
            {verdicts.map(verdict => (
              <p className="hub-review-line" key={verdict.leg} data-verdict={verdict.leg}>
                <span className={`hub-dot ${DOT[verdict.result]}`} aria-hidden="true" />
                <span><b>{LEG_LABEL[verdict.leg]}</b> {verdict.text}</span>
              </p>
            ))}
            {verdicts.length > 0 && !verdicts.some(verdict => verdict.leg === 'qa') && <p className="hub-muted">QA did not run for this item.</p>}
          </section>}
          <section className="hub-panel" data-section="prs" aria-label="Pull requests">
            <h3>Pull requests</h3>
            {prs.length === 0 && <p className="hub-muted">No pull request link came with this item.</p>}
            {foundPrs && <p className="hub-muted" data-found>Found in the summary.</p>}
            <div className="hub-review-links">
              {prs.map(url => <a className="hub-btn" key={url} href={url} target="_blank" rel="noopener noreferrer">{prLabel(url)}</a>)}
            </div>
          </section>
          {!legacy && <section className="hub-panel" data-section="shots" aria-label="Screenshots">
            <h3>Screenshots</h3>
            {detail.screenshots?.length ? <Shots pairs={detail.screenshots} /> : <p className="hub-muted">No screenshots came with this item.</p>}
          </section>}
          {showFiles && <section className="hub-panel" data-section="files" aria-label="Files on the card">
            <h3>Files on the card</h3>
            {files.length === 0 && <p className="hub-muted">No brief or reports came with this item.</p>}
            <div className="hub-review-files">
              {files.map(entry => (
                <button type="button" className="hub-btn hub-review-file" key={entry.path} data-file={entry.path} aria-current={entry.path === file ? 'true' : undefined} onClick={() => open(entry.path)}>
                  {entry.label}<small>{entry.path}</small>
                </button>
              ))}
            </div>
            {(cardLink || sprintCard) && <p>{cardLink}{sprintCard}</p>}
          </section>}
          {!legacy && <section className="hub-panel" data-section="try" aria-label="Try it">
            <h3>Try it</h3>
            {detail.deployUrl
              ? <p><a className="hub-btn" href={detail.deployUrl} target="_blank" rel="noopener noreferrer">Open the build</a></p>
              : <p className="hub-muted">No deployed build yet. The stack deploys after it merges.</p>}
          </section>}
          <section className="hub-panel" aria-label="Mark done">
            {detail.done
                ? <p data-done>Marked done {ago(detail.doneAt ?? detail.at)}{detail.doneBy ? ` by ${detail.doneBy}` : ''}</p>
                : (
                  <>
                    <p className="hub-muted" data-done-hint>Mark done hides this review from Needs you. It does not approve or merge anything.</p>
                    <ReviewActions item={item} links={false} onDone={() => { setFlash('Marked done. It is gone from Needs you.'); window.location.replace(hubHash('inbox')) }} />
                  </>
                )}
          </section>
        </div>
        {(files.length > 0 || file) && <section className="hub-panel hub-review-reader" aria-label="File">
          {file ? (
            <>
              <button type="button" className="hub-btn hub-review-back" onClick={close}>‹ Back to the review</button>
              <h3 tabIndex={-1} ref={title}>{listed?.label ?? 'File'} <span>{file}</span></h3>
              {!listed && <p className="hub-muted" data-file-missing>This file is not listed for this review.</p>}
              {listed && content.state === 'loading' && <p className="hub-muted">Loading…</p>}
              {listed && content.state === 'ok' && <MarkdownView text={content.text} baseUrl={cardPath(cardDir ?? '', folder)} />}
              {listed && content.state === 'missing' && (
                <>
                  <p className="hub-muted" data-file-missing>This file is not on the site yet. The card may not be published.</p>
                  {cardLink && <p>{cardLink}</p>}
                </>
              )}
            </>
          ) : <p className="hub-muted">Pick a file to read it here.</p>}
        </section>}
      </div>
      <p><a className="hub-btn" href={hubHash('inbox')}>Back to the Inbox</a></p>
    </div>
  )
}
