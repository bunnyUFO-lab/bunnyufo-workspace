import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { host } from '../lib/host'
import type { HubProject } from '../lib/hub'
import { HubError, hubGet, hubPost, remember } from '../lib/hub'
import type { ApproveAnswer, SpawnRoute, SpawnTarget } from '../lib/hubSpawn'
import { CAPS_LINE, MACHINE, RULE_TO, approvedNote, estimateCost, guessPreset } from '../lib/hubSpawn'
import type { PresetList } from './spawnData'
import { cachedPresets, loadPresets } from './spawnData'
import { hubHash } from '../lib/route'
import { openFromClick } from './ItemRow'
import { setFocus } from './needsFocus'
import { SPAWN_EVENT, takeSpawn } from './spawnStore'
import type { SpawnOptions } from './spawnStore'
import './runs.css'

const ICONS: Record<string, string> = {
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9.5 4.25 4.25 0 0 1 17 18z"/>',
  hand: '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10m0-2.5a1.5 1.5 0 0 1 3 0V11m0-2a1.5 1.5 0 0 1 3 0v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 14.5a1.5 1.5 0 0 1 2.4-1.8L9 15"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  face: '<circle cx="12" cy="12" r="8.5"/><path d="M9 10v.01M15 10v.01M9 15c1.7 1.5 4.3 1.5 6 0"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
}

function Icon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] ?? ICONS.spark }} />
}

const PROJECT_KEY = 'buw.hub.project'
const OTHER = '__other'

/** "Research and docs may be signed by policy." for the kinds the server signs without a tap. */
const policyLine = (kinds: string[]) => {
  const words = kinds.map(kind => kind.charAt(0).toUpperCase() + kind.slice(1))
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1].toLowerCase()}` : words[0]
  return `${list} may be signed by policy.`
}

const AUTO = 'auto'

const startsNote = (target: SpawnTarget) => (target === 'hermes' ? 'Starts on Hermes right away.' : target === 'pc' ? 'Starts on the PC within the hour (its next hourly check).' : target === 'cloud' ? 'Starts in the cloud.' : 'You start it at the PC.')

/** The Spawn sheet: pick a job, see where it runs and why, then send it. A dialog on a desktop, a bottom sheet on a phone. */
/** What the toast says after Spawn, and where the new run or item is: `run` is a started request, `needs` a request that waits in Needs you. */
interface Note { text: string; run?: string; needs?: string }

function SpawnSheet({ options, onClose, onDone }: { options: SpawnOptions; onClose: () => void; onDone: (note: Note) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const uid = useId()
  const edit = options.edit
  // An avatar job is for one agent: Spawn offers it only when it was opened for an agent (Make a new one, or an edit of one).
  const agent = edit?.agent ?? options.agent
  const [data, setData] = useState<PresetList | null>(cachedPresets)
  const [projects, setProjects] = useState<HubProject[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [presetId, setPresetId] = useState(() => {
    const wanted = edit?.preset ?? options.preset ?? (options.text ? guessPreset(options.text) : 'code-task')
    return wanted === 'agent-avatar' && !agent ? 'code-task' : wanted
  })
  const [project, setProject] = useState(edit?.project ?? options.project ?? '')
  const [repo, setRepo] = useState(edit?.repo ?? '')
  const [otherRepo, setOtherRepo] = useState(false)
  const [known, setKnown] = useState<{ repo: string; project?: string }[]>([])
  const [text, setText] = useState(edit?.text ?? options.text ?? '')
  const [doneWhen, setDoneWhen] = useState(edit?.doneWhen ?? '')
  const [model, setModel] = useState(edit?.model ?? AUTO)
  const [override, setOverride] = useState<SpawnTarget | ''>((edit?.target as SpawnTarget | undefined) ?? '')
  const [route, setRoute] = useState<SpawnRoute | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const node = dialog.current
    if (node && !node.open) node.showModal()
  }, [])

  // The text box takes the focus once the form is there (the presets may still be on their way).
  const loaded = !!data
  useEffect(() => { if (loaded) dialog.current?.querySelector<HTMLElement>('textarea')?.focus() }, [loaded])

  useEffect(() => {
    const controller = new AbortController()
    if (!cachedPresets()) {
      loadPresets(controller.signal).then(
        answer => setData(answer),
        (failure: unknown) => { if ((failure as { name?: string }).name !== 'AbortError') setLoadError(failure instanceof Error ? failure.message : 'Presets did not load.') },
      )
    }
    hubGet<{ repos: { repo: string; project?: string }[] }>('/presets/repos', controller.signal).then(
      answer => setKnown(answer?.repos ?? []),
      () => { /* no list: the field still takes owner/name */ },
    )
    hubGet<{ projects: HubProject[] }>('/projects', controller.signal).then(
      answer => {
        // An answer that is not JSON reads as null: treat it as no projects, never as a thrown error.
        const list = answer?.projects ?? []
        setProjects(list)
        setProject(current => current || (list.find(item => item.id === remember(PROJECT_KEY))?.id ?? list.find(item => item.beads)?.id ?? list[0]?.id ?? ''))
      },
      (failure: unknown) => { if ((failure as { name?: string }).name !== 'AbortError') setLoadError(failure instanceof Error ? failure.message : 'Projects did not load.') },
    )
    return () => controller.abort()
  }, [])

  const offers = (item: { id: string }) => item.id !== 'agent-avatar' || !!agent
  const preset = data?.presets.find(item => item.id === presetId && offers(item)) ?? data?.presets.find(offers) ?? null
  const wantsRepo = !!preset?.fields.includes('repo')
  const repoValid = !repo.trim() || /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[\w.-]{1,100}$/.test(repo.trim())
  const projectRepo = known.find(item => item.project === project)

  // The server decides where it runs; ask again 150 ms after the last change.
  useEffect(() => {
    if (!preset || !project || !repoValid) return undefined
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ preset: preset.id, project })
      if (wantsRepo && repo.trim()) query.set('repo', repo.trim())
      hubGet<SpawnRoute>(`/presets/route?${query}`, controller.signal).then(
        answer => { setRoute(answer); setRouteError(null) },
        (failure: unknown) => { if ((failure as { name?: string }).name !== 'AbortError') { setRoute(null); setRouteError(failure instanceof Error ? failure.message : 'The route did not load.') } },
      )
    }, 150)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [preset, project, repo, wantsRepo, repoValid])

  // A preset with fewer targets than the chosen one drops the choice.
  // Bunnylink work is never sent anywhere: the only place is "You, at the PC", and there is nothing to choose.
  const bunnylink = project === 'bunnylink'
  const allowed = preset?.targets ?? []
  const choice = !bunnylink && override && allowed.includes(override) ? override : ''
  const target: SpawnTarget | null = bunnylink ? 'at-pc' : choice || route?.target || null
  const changed = !!choice && !!route && choice !== route.target
  const atPc = target === 'at-pc'
  // The model menu is for Hermes jobs only; a PC, cloud or at-the-PC job shows none and sends none. Auto sends nothing.
  const models = target === 'hermes' ? data?.models ?? [] : []
  const picked = models.find(entry => entry.id === model) ?? models[0]
  const sendModel = target === 'hermes' && picked && picked.id !== AUTO ? picked.id : undefined
  const canApprove = host.approve && !atPc
  const trimmed = text.trim()
  const ready = !!preset && !!project && !!trimmed && repoValid && !!target && !busy
  // Why the button is off, first thing first.
  const missing = busy ? null : !trimmed ? 'Write what it should do.' : !project ? 'Pick a project.' : !repoValid ? 'The repo is owner/name.' : !target ? (routeError ?? 'Working out where it runs…') : null

  const send = useCallback(async () => {
    if (!preset || !target) return
    setBusy(true)
    setError(null)
    let id: string | null = null
    try {
      if (edit && canApprove) {
        // One signed path: the server copies the request, approves the copy and retires the old one.
        // Send only what changed: an Edit that leaves the text alone keeps the "written by" marker the server holds with it.
        const again = await hubPost<ApproveAnswer & { id: string }>(`/requests/${encodeURIComponent(edit.id)}/again`, {
          target,
          ...(trimmed !== edit.text.trim() ? { text: trimmed } : {}),
          ...(target === 'hermes' && (picked?.id ?? AUTO) !== (edit.model ?? AUTO) ? { model: picked?.id ?? AUTO } : {}),
          ...(doneWhen.trim() !== (edit.doneWhen ?? '').trim() ? { doneWhen: doneWhen.trim() } : {}),
        })
        onDone({ text: approvedNote(target, again.waiting, again.wake), run: again.id })
        return
      }
      const created = await hubPost<{ id: string; target: SpawnTarget }>('/requests', {
        project, text: trimmed, preset: preset.id,
        ...(wantsRepo && repo.trim() ? { repo: repo.trim() } : {}),
        ...(agent && preset.id === 'agent-avatar' ? { agent } : {}),
        ...(doneWhen.trim() ? { doneWhen: doneWhen.trim() } : {}),
        ...(choice ? { target: choice } : {}),
        ...(sendModel ? { model: sendModel } : {}),
        ...(edit ? { replaces: edit.id } : {}),
      })
      id = created.id
      if (edit) await hubPost(`/requests/${encodeURIComponent(edit.id)}/decline`, { reason: `replaced by ${id}` })
      if (!canApprove) {
        onDone({ text: atPc ? 'Added to Needs you. You start it at the PC.' : 'Saved as a proposal. It waits in Needs you.', needs: id })
        return
      }
      const signed = await hubPost<ApproveAnswer>(`/requests/${encodeURIComponent(id)}/approve`, { target })
      onDone({ text: approvedNote(target, signed.waiting, signed.wake), run: id })
    } catch (failure) {
      const reason = failure instanceof HubError || failure instanceof Error ? failure.message : 'It did not work.'
      if (id) onDone({ text: `Saved, but not approved. It waits in Needs you: ${reason}`, needs: id })
      else setError(reason)
    } finally {
      setBusy(false)
    }
  }, [preset, target, project, trimmed, wantsRepo, repo, doneWhen, choice, canApprove, atPc, edit, onDone, agent, picked, sendModel])

  const machine = target ? MACHINE[target] : null
  const button = busy ? (atPc ? 'Adding…' : canApprove ? 'Approving…' : 'Saving…') : atPc ? 'Add to Needs you' : canApprove ? 'Approve' : 'Save as a proposal'
  const ids = { project: `${uid}-project`, repo: `${uid}-repo`, text: `${uid}-text`, done: `${uid}-done`, where: `${uid}-where`, model: `${uid}-model` }

  return (
    <dialog
      ref={dialog}
      className="spawn-sheet"
      aria-labelledby={`${uid}-title`}
      data-spawn-sheet
      onClose={onClose}
      onClick={event => { if (event.target === dialog.current) dialog.current?.close() }}
    >
      <div className="sp-head">
        <Icon name="spark" />
        <h2 id={`${uid}-title`}>{edit ? 'Edit the request' : 'Spawn work'}</h2>
        <button type="button" className="hub-btn sp-x" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </div>
      <div className="sp-body">
        {loadError && <p className="hub-error" role="alert">{loadError}</p>}
        {!data && !loadError && <p className="hub-empty">Loading…</p>}
        {data && preset && (
          <>
            <div>
              <div className="sp-label" id={`${uid}-tpl`}>Template</div>
              <div className="sp-tpls" role="group" aria-labelledby={`${uid}-tpl`}>
                {data.presets.filter(item => offers(item) && (!edit || item.id === preset.id)).map(item => (
                  <button key={item.id} type="button" className={`sp-tpl${item.id === preset.id ? ' on' : ''}`} aria-pressed={item.id === preset.id} disabled={!!edit} data-preset={item.id} onClick={() => { setPresetId(item.id); setOverride('') }}>
                    <Icon name={item.icon} />{item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={wantsRepo ? 'sp-two' : 'sp-one'}>
              <label className="sp-field" htmlFor={ids.project}>Project
                <select id={ids.project} value={project} disabled={!!edit} onChange={event => { setProject(event.target.value); setOverride('') }} data-spawn-project>
                  {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              {wantsRepo && (
                <div className="sp-field">
                  <label htmlFor={ids.repo}>Repo</label>
                  {edit ? (
                    <input id={ids.repo} value={repo} disabled readOnly data-spawn-repo />
                  ) : (
                    <select id={ids.repo} value={otherRepo ? OTHER : repo} onChange={event => { const value = event.target.value; setOtherRepo(value === OTHER); setRepo(value === OTHER ? '' : value) }} data-spawn-repo-pick>
                      <option value="">{projectRepo ? `${projectRepo.repo} (this project's)` : "The project's repo"}</option>
                      {known.filter(item => item.repo !== projectRepo?.repo).map(item => <option key={item.repo} value={item.repo}>{item.repo}{item.project ? ` · ${projects.find(row => row.id === item.project)?.name ?? item.project}` : ''}</option>)}
                      <option value={OTHER}>Another repo…</option>
                    </select>
                  )}
                  {!edit && otherRepo && <input value={repo} onChange={event => setRepo(event.target.value)} placeholder="owner/name" aria-label="Repo as owner/name" autoComplete="off" spellCheck={false} aria-invalid={!repoValid} autoFocus data-spawn-repo />}
                </div>
              )}
            </div>
            <p className="sp-agent" data-spawn-agent>Agent · <b>{preset.agent}</b></p>
            <label className="sp-field" htmlFor={ids.text}>What should it do?
              <textarea id={ids.text} value={text} onChange={event => setText(event.target.value)} placeholder={preset.example} rows={4} maxLength={4000} data-spawn-text />
            </label>
            {preset.fields.includes('doneWhen') && (
              <label className="sp-field" htmlFor={ids.done}>Done when
                <input id={ids.done} value={doneWhen} onChange={event => setDoneWhen(event.target.value)} maxLength={400} autoComplete="off" data-spawn-done />
              </label>
            )}
            <div>
              <div className="sp-label" id={ids.where}>Runs on</div>
              <div className="sp-route" role="group" aria-labelledby={ids.where} data-spawn-route={target ?? ''}>
                {machine && route ? (
                  <>
                    <span className="sp-mach"><Icon name={machine.icon} /></span>
                    <div className="sp-route-t">
                      <b data-spawn-machine>{machine.name}</b>
                      <p data-spawn-why>{changed ? `You changed it from ${MACHINE[route.target].name}` : route.why}<span className="sp-faint"> · {changed ? 'your choice' : `rule ${route.rule}`}</span></p>
                      {data.rules.length > 0 && (
                        <ol className="sp-rules" aria-label="Routing rules">
                          {data.rules.map(rule => (
                            <li key={rule.rule} className={!changed && rule.rule === route.rule ? 'hit' : ''} aria-current={!changed && rule.rule === route.rule ? 'true' : undefined} data-rule={rule.rule}>
                              <span className="n">{rule.rule}</span><span>{rule.text} → {RULE_TO[rule.rule] ?? ''}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                      <p className="sp-faint sp-caps">{CAPS_LINE}</p>
                      {host.policy.length > 0 && <p className="sp-faint sp-caps" data-spawn-policy>{policyLine(host.policy)}</p>}
                    </div>
                    <select className="sp-pick" aria-label="Change where it runs" value={bunnylink ? 'at-pc' : choice} disabled={bunnylink} onChange={event => setOverride(event.target.value as SpawnTarget | '')} data-spawn-target>
                      {bunnylink ? <option value="at-pc">{MACHINE['at-pc'].name}</option> : <option value="">Auto</option>}
                      {!bunnylink && allowed.map(item => <option key={item} value={item}>{MACHINE[item].name}</option>)}
                    </select>
                  </>
                ) : <p className="hub-muted" role={routeError ? 'alert' : undefined}>{routeError ?? 'Working out where it runs…'}</p>}
              </div>
            </div>
            {models.length > 0 && picked && (
              <div className="sp-model-row" data-spawn-model-row>
                <label className="sp-label" htmlFor={ids.model}>Model</label>
                <div className="sp-model">
                  <select id={ids.model} className="sp-pick" value={picked.id} onChange={event => setModel(event.target.value)} data-spawn-model>
                    {models.map(entry => <option key={entry.id} value={entry.id} title={entry.note}>{entry.id === AUTO ? entry.label : `${entry.label} · API`}</option>)}
                  </select>
                  <span className="sp-faint" data-spawn-model-note>{picked.note}</span>
                </div>
              </div>
            )}
            <div className="sp-est" data-spawn-estimate>
              <div><span>Estimated cost</span><b>{estimateCost(preset.estimate.cost, target)}</b></div>
              <div><span>Time</span><b>{preset.estimate.time}</b></div>
              <div className="wide"><span>Result</span><b>{preset.produces}</b></div>
            </div>
          </>
        )}
        {error && <p className="hub-error" role="alert" data-spawn-error>{error}</p>}
      </div>
      <div className="sp-foot">
        <span className="sp-spacer" />
        <button type="button" className="hub-btn" onClick={() => dialog.current?.close()}>Cancel</button>
        <span className="sp-go">
          <button type="button" className="hub-btn pri" disabled={!ready} aria-busy={busy} onClick={() => void send()} data-spawn-go>{button}</button>
          <span className="sp-note" data-spawn-note>
            {missing ? missing : atPc ? 'You start it at the PC. Copy its prompt from the item in Needs you.' : canApprove && target ? startsNote(target) : host.approveReason ?? 'Waits in Needs you until it is approved.'}
          </span>
        </span>
      </div>
    </dialog>
  )
}

/** Mounted once in the Hub screen: opens the sheet when `openSpawn` is called, and says what happened after it closes. */
export default function SpawnHost() {
  const [options, setOptions] = useState<SpawnOptions | null>(null)
  const [toast, setToast] = useState<Note | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const timer = useRef(0)

  useEffect(() => {
    const open = () => {
      const next = takeSpawn()
      if (!next || !host.write) return
      if (!(document.activeElement instanceof HTMLElement && document.activeElement.closest('dialog'))) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOptions(next)
    }
    open()
    window.addEventListener(SPAWN_EVENT, open)
    return () => { window.removeEventListener(SPAWN_EVENT, open); window.clearTimeout(timer.current) }
  }, [])

  const close = useCallback(() => setOptions(null), [])
  // The focus goes back to what opened the sheet once the sheet is gone.
  const showing = !!options
  useEffect(() => {
    if (showing) return
    const back = opener.current
    opener.current = null
    if (back && document.contains(back)) back.focus({ preventScroll: true })
  }, [showing])
  const done = useCallback((note: Note) => {
    setToast(note)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), 8000)
    close()
  }, [close])

  return (
    <>
      {options && <SpawnSheet options={options} onClose={close} onDone={done} />}
      {toast && (
        <div className="runs-toast" role="status" data-spawn-toast>
          <span>{toast.text}</span>
          {toast.run && <> <span data-spawn-where>It shows in Working now once it starts.</span> <a href={hubHash('request', toast.run)} onClick={event => { openFromClick(event, toast.run as string); setToast(null) }} data-spawn-toast-link="run">Open run</a></>}
          {toast.needs && <> <a href={hubHash('needs')} onClick={() => { setFocus(`approval-${toast.needs}`); setToast(null) }} data-spawn-toast-link="needs">Open in Needs you</a></>}
        </div>
      )}
    </>
  )
}
