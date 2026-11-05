import { useState } from 'react'
import type { CardRevert, CardWriteGroup } from '../lib/hub'
import { HubError, ago, hubPost } from '../lib/hub'
import { hubHash } from '../lib/route'
import { host } from '../lib/host'
import { NAME_NOTE, verb, willDo } from './cardWriteText'
import './cardWrites.css'

/** `job:20261105-research-a1b2` is the request the run came from; its page is the Hub's request screen. */
function Who({ group }: { group: CardWriteGroup }) {
  const job = group.context?.startsWith('job:') ? group.context.slice(4) : null
  const when = group.at ? ago(group.at) : ''
  return (
    <small className="cw-meta">
      {when}
      {job
        ? <> · <a href={hubHash('request', job)} data-cw-job>job {job.length > 9 ? `${job.slice(0, 8)}…` : job}</a></>
        : group.context === 'chat' ? ' · chat' : ''}
      {' · '}token {group.token}
    </small>
  )
}

/** Revert, in two steps in place: the button, then what Yes will do and Yes or No. No modal. */
function RevertButton({ section, group, onDone }: { section: string; group: CardWriteGroup; onDone: () => void }) {
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [done, setDone] = useState<{ at: string | null; partial?: boolean; left?: boolean } | null>(group.reverted ? { at: group.reverted.at, ...(group.reverted.partial ? { partial: true } : {}), ...(group.reverted.left ? { left: true } : {}) } : null)
  if (done?.left) return <p className="cw-done" data-cw-reverted>You changed this file after the agent, so it was left alone{done.at ? ` · ${ago(done.at)}` : ''}</p>
  if (done) return <p className="cw-done" data-cw-reverted>{done.partial ? 'Partly reverted' : 'Reverted'} by you{done.at ? ` · ${ago(done.at)}` : ''}{note ? <span data-cw-left-alone> · {note}</span> : null}</p>
  if (!group.canRevert || !host.write) return null
  const revert = async () => {
    setBusy(true); setError('')
    try {
      const answer = await hubPost<CardRevert>('/card-writes/revert', { section, folder: group.folder, batch: group.batch })
      window.dispatchEvent(new Event('bunnyufo-workspace-changed'))
      if (answer.leftAlone?.length) setNote(`Left alone: ${answer.leftAlone.map(item => `${item.file.split('/').slice(1).join('/') || item.file} (${item.why.charAt(0).toLowerCase()}${item.why.slice(1)})`).join('; ')}`)
      setDone({ at: answer.reverted.at })
      onDone()
    } catch (problem) {
      setAsk(false)
      setError(problem instanceof HubError || problem instanceof Error ? problem.message : 'The revert did not go through.')
    } finally { setBusy(false) }
  }
  return (
    <div className="cw-revert">
      {error && <p className="cw-error" role="alert" data-cw-error>{error}</p>}
      {ask
        ? (
          <div className="cw-confirm" role="group" aria-label="Revert this?">
            <span className="cw-will" data-cw-will>{willDo(group)}</span>
            <span className="cw-confirm-q">Revert this?</span>
            <button type="button" className="cw-btn pri" disabled={busy} onClick={() => void revert()} data-cw-yes>Yes</button>
            <button type="button" className="cw-btn" disabled={busy} onClick={() => setAsk(false)} data-cw-no>No</button>
          </div>
        )
        : <button type="button" className="cw-btn cw-revert-btn" onClick={() => { setError(''); setAsk(true) }} data-cw-revert>Revert</button>}
    </div>
  )
}

function Row({ section, group, showCard, onDone }: { section: string; group: CardWriteGroup; showCard: boolean; onDone: () => void }) {
  return (
    <li className="cw-row" data-cw-row data-batch={group.batch}>
      <p className="cw-what"><b className="cw-agent" title={NAME_NOTE} data-cw-agent>{group.agent}</b> {verb(group.title)}{showCard && group.cardTitle ? <span className="cw-card"> in {group.cardTitle}</span> : null}</p>
      {group.why && <p className="cw-why" data-cw-why>{group.why}</p>}
      <Who group={group} />
      {group.files.length > 0 && (
        <details className="cw-files">
          <summary>{group.files.length} {group.files.length === 1 ? 'file' : 'files'} ›</summary>
          <ul>{group.files.map(file => <li key={file.file}>{file.file}</li>)}</ul>
        </details>
      )}
      <RevertButton key={`${group.batch}${group.reverted ? '-done' : ''}`} section={section} group={group} onDone={onDone} />
    </li>
  )
}

/** Rows as the card page's sheet and the project page's Library tab show them. Text only: an agent's words are never drawn as HTML. */
export function CardWriteRows({ section, groups, showCard = false, onDone = () => {} }: { section: string; groups: CardWriteGroup[]; showCard?: boolean; onDone?: () => void }) {
  return <ul className="cw-list" data-cw-list>{groups.map(group => <Row key={`${group.folder}/${group.batch}/${group.reverted?.at ?? "live"}`} section={section} group={group} showCard={showCard} onDone={onDone} />)}</ul>
}
