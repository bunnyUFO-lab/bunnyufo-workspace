import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { MapWayfinder, WayfinderQuestion } from '../lib/hub'
import { hubHash } from '../lib/route'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { startChat } from './chatStart'
import { openSpawn } from './spawnStore'
import { COST, actionFor, chatDraft, questionSeed, sessionPrompt } from './questionSeed'
import './questions.css'

export const DECISION_MAX = 500

/** Copy text to the clipboard; false when the browser refuses. */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

interface Item { key: string; label: string; cost: string; run: () => void }

/**
 * The ways to resolve one open Wayfinder question: one main button by kind with its cost beside it, a menu with the others
 * (Answer here, Talk it through in Hermes Chat, Copy prompt for Claude Code or Codex), and a small "Answer here" form.
 * Every way ends in the owner's answer, which is what changes Beads: the buttons only open Spawn or Chat prefilled, copy text, or
 * (Answer here) write the owner's own decision as a mark. Nothing here files or approves anything by itself.
 * `layout` row is the Destination row (a ⋯ menu); `sheet` is the side sheet's Resolve block (the same choices laid out as buttons).
 */
export default function QuestionActions({ project, repoName, wayfinder, item, layout }: { project: string; repoName: string; wayfinder: MapWayfinder; item: WayfinderQuestion; layout: 'row' | 'sheet' }) {
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [copied, setCopied] = useState('')
  const uid = useId()
  const blocked = item.blockedBy.length > 0
  const action = actionFor(item.type, blocked)
  const write = host.write

  useEffect(() => {
    if (!menu) return
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) setMenu(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menu])
  useEffect(() => { if (menu) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus() }, [menu])

  const spawn = (mode: 'grilling' | 'research') => {
    setMenu(false)
    openSpawn({ preset: 'question', project, text: questionSeed(project, wayfinder, [item.id], mode) })
  }
  const talk = () => {
    setMenu(false)
    startChat({ persona: 'hermes', draft: chatDraft(wayfinder, item) })
    window.location.hash = hubHash('chat')
  }
  const copyPrompt = async (who: string) => {
    setMenu(false)
    setCopied((await copy(sessionPrompt(repoName, wayfinder, item))) ? `Copied the prompt for ${who}. Paste it into a session in the repo.` : 'The prompt could not be copied.')
  }
  const openAnswer = () => { setMenu(false); setCopied(''); setProblem(''); setAnswering(true) }

  async function record(verdict: 'done' | 'not-needed') {
    const reason = text.replace(/\s+/g, ' ').trim()
    if (verdict === 'done' && !reason) return
    setBusy(true)
    setProblem('')
    try {
      await hubPost(`/map/${encodeURIComponent(project)}/marks`, { bead: item.id, verdict, ...(reason ? { reason } : {}) })
      setAnswering(false)
      setText('')
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  const items: Item[] = [
    ...(write && action.main !== 'answer' ? [{ key: 'answer', label: 'Answer here', cost: COST.free, run: openAnswer }] : []),
    ...(host.chat ? [{ key: 'chat', label: 'Talk it through in Hermes Chat', cost: COST.chat, run: talk }] : []),
    { key: 'claude', label: 'Copy prompt for Claude Code', cost: COST.claude, run: () => void copyPrompt('Claude Code') },
    { key: 'codex', label: 'Copy prompt for Codex', cost: COST.codex, run: () => void copyPrompt('Codex') },
  ]

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); trigger.current?.focus(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const all = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    all[(at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
  }

  const main = action.main && write && (
    <div className="hub-q-main">
      <button
        type="button" className="hub-btn pri hub-q-btn" data-q-main={action.main}
        onClick={() => (action.main === 'answer' ? openAnswer() : spawn(action.main === 'research' ? 'research' : 'grilling'))}
      >{action.label}</button>
      <span className="hub-q-cost" data-q-cost>{action.cost}</span>
      {action.note && <p className="hub-q-note" data-q-note>{action.note}</p>}
    </div>
  )

  return (
    <div className={`hub-q hub-q-${layout}`} ref={root} data-q-actions={item.id} onKeyDown={layout === 'row' ? onMenuKey : undefined}>
      {blocked && <p className="hub-q-after" data-q-after>After: {item.blockedBy.join(', ')}</p>}
      {main}
      {layout === 'row' ? (
        <div className="hub-q-more">
          <button
            type="button" ref={trigger} className="hub-btn hub-q-menu-btn" aria-label={`More ways to resolve: ${item.title}`} aria-haspopup="menu" aria-expanded={menu} aria-controls={`${uid}-menu`}
            data-q-menu onClick={() => setMenu(value => !value)}
          >⋯</button>
          {menu && (
            <div className="hub-q-menu" id={`${uid}-menu`} role="menu" aria-label="Ways to resolve this question" data-q-menu-list>
              {items.map(entry => (
                <button key={entry.key} type="button" role="menuitem" className="hub-q-item-btn" data-q-item-action={entry.key} onClick={entry.run}>
                  <span>{entry.label}</span><span className="hub-q-cost">{entry.cost}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <ul className="hub-q-list" aria-label="Other ways to resolve this question">
          {items.map(entry => (
            <li key={entry.key}>
              <button type="button" className="hub-btn hub-q-item-btn" data-q-item-action={entry.key} onClick={entry.run}>{entry.label}</button>
              <span className="hub-q-cost">{entry.cost}</span>
            </li>
          ))}
        </ul>
      )}
      {answering && write && (
        <form className="hub-q-answer" data-q-answer onSubmit={event => { event.preventDefault(); void record('done') }}>
          <label className="hub-q-field">Your decision
            <textarea value={text} maxLength={DECISION_MAX} rows={3} autoFocus onChange={event => setText(event.target.value)} data-q-text />
          </label>
          <span className="hub-q-count" aria-hidden="true">{text.length} / {DECISION_MAX}</span>
          <div className="hub-actions start">
            <button type="submit" className="hub-btn pri" disabled={busy || !text.trim()} data-q-record>Record decision</button>
            <button type="button" className="hub-btn" disabled={busy} onClick={() => void record('not-needed')} data-q-not-needed>Not needed</button>
            <button type="button" className="hub-btn" disabled={busy} onClick={() => { setAnswering(false); setProblem('') }}>Cancel</button>
          </div>
          <p className="hub-q-note">It is saved as your decision and shows on the Roadmap at once. The PC closes the question in Beads within minutes.</p>
        </form>
      )}
      {problem && <p className="hub-error" role="alert">{problem}</p>}
      {copied && <p className="hub-q-note" role="status" data-q-copied>{copied}</p>}
    </div>
  )
}
