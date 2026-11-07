import { useState, type ReactNode } from 'react'
import { hubPost } from '../../lib/hub'
import type { JobChange, JobChangeAnswer, ModelRef, ScheduleJob, ScheduleSource } from '../../lib/hubTeam'
import { Fold } from '../../ui/Layout'
import { isDear, opusNote } from '../agentEditField'
import { useWaitingPoll } from '../useWaitingPoll'
import { backWords, cadenceOf, changeLine, cronOf, cronProblem, lineDiff, NAME_RE, NOT_YET, POSTS_NOTE, promptProblem, recallNext, rememberNext, SCRIPT_NOTE, WEEKDAY_NAMES, whenWords, type Cadence, type CadenceKind } from './scheduleEditModel'
import { modelWords, onWords } from './schedulesModel'
import './agentDetails.css'
import './scheduleEdit.css'

type Refresh = (signal: AbortSignal) => Promise<void>

const refName = (ref: ModelRef) => `${ref.provider} · ${ref.model}`
const FOLLOW = 'follow'
const keyOf = (ref: ModelRef | null) => (ref ? `${ref.provider}/${ref.model}` : FOLLOW)
const pending = (change: JobChange | undefined) => change?.state === 'waiting' || change?.state === 'applied'

/** The cadence field: every day, chosen weekdays or a cron text, with a time, and the words under it. */
function CadenceField({ cadence, onChange, zone, disabled }: { cadence: Cadence; onChange: (next: Cadence) => void; zone: string | undefined; disabled: boolean }) {
  const kinds: [CadenceKind, string][] = [['daily', 'Every day'], ['weekdays', 'Chosen weekdays'], ['custom', 'Custom cron']]
  const expr = cronOf(cadence)
  const problem = cronProblem(expr)
  const toggle = (day: number) => onChange({ ...cadence, days: cadence.days.includes(day) ? cadence.days.filter(item => item !== day) : [...cadence.days, day].sort() })
  return (
    <div className="ae-field" role="group" aria-label="Cadence" data-edit-cadence>
      <span>Cadence</span>
      <div className="se-seg" role="radiogroup" aria-label="How often">
        {kinds.map(([kind, label]) => (
          <button key={kind} type="button" role="radio" aria-checked={cadence.kind === kind} className={`hub-btn${cadence.kind === kind ? ' pri' : ''}`} disabled={disabled} data-cadence-kind={kind}
            onClick={() => onChange(kind === 'custom' ? { ...cadence, kind, custom: cronOf(cadence) || cadence.custom } : { ...cadence, ...(cadence.kind === 'custom' ? cadenceOf(cadence.custom) : {}), kind })}>{label}</button>
        ))}
      </div>
      {cadence.kind !== 'custom' && (
        <label className="se-time"><span>Time</span><input type="time" value={cadence.time} disabled={disabled} onChange={event => onChange({ ...cadence, time: event.target.value })} data-cadence-time /></label>
      )}
      {cadence.kind === 'weekdays' && (
        <div className="se-days" role="group" aria-label="Days">
          {WEEKDAY_NAMES.map((name, day) => <button key={name} type="button" className={`hub-btn${cadence.days.includes(day) ? ' pri' : ''}`} aria-pressed={cadence.days.includes(day)} disabled={disabled} onClick={() => toggle(day)} data-cadence-day={day}>{name}</button>)}
        </div>
      )}
      {cadence.kind === 'custom' && (
        <input type="text" value={cadence.custom} disabled={disabled} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Cron text" onChange={event => onChange({ ...cadence, custom: event.target.value })} data-cadence-custom />
      )}
      {cadence.kind === 'weekdays' && cadence.days.length === 0 && <small className="hub-error" data-cadence-problem>Pick at least one day.</small>}
      {(cadence.kind === 'custom' || cadence.days.length > 0) && problem && <small className="hub-error" data-cadence-problem>{problem}</small>}
      {!problem && expr && <small className="team-dim" data-cadence-words><code>{expr}</code> {whenWords(expr, zone) || 'Runs on this cron text.'}</small>}
    </div>
  )
}

/** The model field: follow the profile, or one of the host's models. A model set now but not offered stays in the list, marked. */
function ModelField({ value, onChange, options, current, followed, disabled, note }: { value: string; onChange: (key: string) => void; options: ModelRef[]; current: ModelRef | null; followed: string | undefined; disabled: boolean; note?: string }) {
  const choices = [...options]
  if (current && !choices.some(item => keyOf(item) === keyOf(current))) choices.push(current)
  const chosen = choices.find(item => keyOf(item) === value) ?? null
  const dear = chosen && isDear(chosen.model) ? opusNote(chosen, []) : null
  return (
    <label className="ae-field">
      <span>Model</span>
      <select value={value} disabled={disabled} onChange={event => onChange(event.target.value)} data-edit-model>
        <option value={FOLLOW}>Follow the profile{followed ? ` (${followed})` : ''}</option>
        {choices.map(ref => <option key={keyOf(ref)} value={keyOf(ref)}>{refName(ref)}{isDear(ref.model) ? ' · billed through the API' : ''}{options.some(item => keyOf(item) === keyOf(ref)) ? '' : ' (not offered now)'}</option>)}
      </select>
      {note && <small className="team-dim">{note}</small>}
      {dear && <p className="hub-banner ad-note" role="note" data-edit-opus-note>{dear.replace('every reply on this profile bills', 'every run of this job bills')}</p>}
    </label>
  )
}

/** Now and new, side by side for the schedule and the model, and the prompt's changed lines. */
function Preview({ rows, prompt }: { rows: { name: string; now: string; next: string }[]; prompt: { before: string; after: string } | null }) {
  const lines = prompt ? lineDiff(prompt.before, prompt.after).filter(line => line.mark !== '=') : []
  return (
    <div className="se-preview hub-banner ad-note" role="note" data-edit-preview>
      {rows.map(row => (
        <div key={row.name} className="se-pair" data-preview={row.name}>
          <b>{row.name}</b>
          <span><small>Now</small>{row.now}</span>
          <span><small>New</small>{row.next}</span>
        </div>
      ))}
      {prompt && <div data-preview="prompt"><b>Prompt</b><pre className="ad-pre se-diff">{lines.map((line, index) => <span key={index} className={line.mark === '+' ? 'se-add' : 'se-del'}>{line.mark} {line.text}{'\n'}</span>)}</pre></div>}
    </div>
  )
}

/** A job's newest change as one row: what is happening, and the way back. */
export function ChangeRow({ job, onBack, busy }: { job: ScheduleJob; onBack: () => void; busy: boolean }) {
  const change = job.change
  if (!change) return null
  const line = changeLine(change, job, recallNext(change.id))
  return (
    <div className={`se-change se-${line.tone}`} role="status" data-job-change={change.state} data-job-change-id={change.id}>
      <p data-job-change-line>{line.text}</p>
      {change.canUndo && job.editable && <button type="button" className="hub-btn" disabled={busy} onClick={onBack} data-job-undo>{backWords(change)}</button>}
    </div>
  )
}

/** The edit form of one job: cadence, model, prompt, then Save, Pause or Resume, and Remove in a fold. Mounted with the job's rev as its key, so a changed job starts again from what it is now. */
function JobForm({ job, source, send, busy, error }: { job: ScheduleJob; source: ScheduleSource; send: (body: Record<string, unknown>) => void; busy: boolean; error: string | null }) {
  const edits = source.edits
  const zone = source.timezone
  const [cadence, setCadence] = useState<Cadence>(() => cadenceOf(job.schedule))
  const current: ModelRef | null = job.provider && job.model ? { provider: job.provider, model: job.model } : null
  const half = !!job.provider !== !!job.model
  const [model, setModel] = useState(keyOf(current))
  const [prompt, setPrompt] = useState(job.prompt)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const wait = pending(job.change)
  const off = busy || wait
  const expr = cronOf(cadence)
  const scheduleDirty = expr !== job.schedule
  const modelDirty = model !== keyOf(current)
  const promptDirty = !!job.promptEditable && prompt !== job.prompt
  const problem = (scheduleDirty ? cronProblem(expr) : '') || (promptDirty ? promptProblem(prompt) : '')
  const dirty = scheduleDirty || modelDirty || promptDirty
  const chosen = [...(edits?.models ?? [])].find(item => keyOf(item) === model) ?? null
  const state = onWords(job)
  const followed = source.profileModels?.[job.profile]
  const save = () => {
    const to: Record<string, unknown> = {}
    if (scheduleDirty) to.schedule = expr
    if (promptDirty) to.prompt = prompt
    if (modelDirty) Object.assign(to, chosen ? { provider: chosen.provider, model: chosen.model } : model === FOLLOW ? { provider: null, model: null } : {})
    send({ op: 'edit', job: job.name, base: job.rev, to })
  }
  const rows = [
    ...(scheduleDirty ? [{ name: 'Schedule', now: `${job.schedule}`, next: expr }] : []),
    ...(modelDirty ? [{ name: 'Model', now: modelWords(job, followed).model || 'Follow the profile', next: chosen ? chosen.model : `Follow the profile${followed ? ` (${followed})` : ''}` }] : []),
  ]
  return (
    <form className="ae-form se-form" onSubmit={event => event.preventDefault()} data-job-form={job.name}>
      <CadenceField cadence={cadence} onChange={setCadence} zone={zone} disabled={off} />
      <ModelField value={model} onChange={setModel} options={edits?.models ?? []} current={current} followed={followed} disabled={off || half} note={half ? 'This job sets a model without a provider, or the other way round. Fix it on the host first.' : undefined} />
      <label className="ae-field">
        <span>Prompt</span>
        <textarea value={prompt} rows={10} disabled={off || !job.promptEditable} onChange={event => setPrompt(event.target.value)} spellCheck={false} data-edit-prompt />
        {!job.promptEditable && <small className="team-dim" data-edit-prompt-off>This prompt was cut or had secret-like text replaced in the export, so it cannot be edited here. The other settings can.</small>}
        {job.script && <small className="team-dim" data-edit-script-note>{SCRIPT_NOTE}</small>}
      </label>
      {dirty && (rows.length > 0 || promptDirty) && <Preview rows={rows} prompt={promptDirty ? { before: job.prompt, after: prompt } : null} />}
      {problem && <p className="hub-error" role="alert" data-edit-problem>{problem}</p>}
      {error && <p className="hub-error" role="alert" data-edit-error>{error}</p>}
      <div className="ae-actions se-actions">
        <button type="button" className="hub-btn pri" disabled={!dirty || !!problem || off} onClick={save} data-edit-save>Save change</button>
        <button type="button" className="hub-btn" disabled={off} onClick={() => send({ op: state.on ? 'pause' : 'resume', job: job.name, base: job.rev })} data-edit-toggle>{state.on ? 'Pause' : 'Resume'}</button>
      </div>
      <Fold level={4} title="Remove this job" open={removeOpen} onToggle={() => setRemoveOpen(value => !value)} data={{ 'data-fold': 'remove-job' }}>
        <div className="ae-field">
          {job.script && <p className="hub-banner ad-note" role="note" data-remove-script-note>{POSTS_NOTE}</p>}
          <span>Type {job.name} to remove it</span>
          <input type="text" value={typed} onChange={event => setTyped(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Job name" data-remove-name />
          <button type="button" className="hub-btn" disabled={off || typed !== job.name} onClick={() => send({ op: 'remove', job: job.name, base: job.rev })} data-edit-remove>Remove job</button>
        </div>
      </Fold>
    </form>
  )
}

/** Posts one press and reads the page again. The next run before it goes in the tab's memory, for "Next run moved". */
function usePress(refresh: Refresh) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async (body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const answer = await hubPost<JobChangeAnswer>('/team/briefs/job-change', body)
      rememberNext(answer.change, answer.nextRunAt)
      await refresh(new AbortController().signal)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.')
      void refresh(new AbortController().signal).catch(() => undefined)
    } finally { setBusy(false) }
  }
  return { busy, error, send: (body: Record<string, unknown>) => { void send(body) } }
}

/**
 * Editing one Hermes job from its page (ws-eh2 G). `job.editable` comes from the Hub only for a signed-in viewer when the host says it can apply a
 * change; without it the job's page shows the change row, if any, and a line that edits are not available yet.
 */
export function JobEdit({ job, source, refresh }: { job: ScheduleJob; source: ScheduleSource; refresh: Refresh }): ReactNode {
  const { busy, error, send } = usePress(refresh)
  // Read again every few seconds while the host has not shown the change, up to ten minutes (the same wait as the model change).
  useWaitingPoll(pending(job.change), refresh)
  const available = source.edits?.available
  const [open, setOpen] = useState(false)
  return (
    <div className="se-edit" data-job-edit>
      <ChangeRow job={job} busy={busy} onBack={() => { if (job.change) send({ undo: job.change.id, base: job.rev }) }} />
      {!job.editable && source.edits && !available && <p className="hub-empty" data-edits-off>{NOT_YET}</p>}
      {job.editable && (
        <Fold level={3} title="Change this job" sub="Schedule, model, prompt, pause or remove" open={open} onToggle={() => setOpen(value => !value)} data={{ 'data-fold': 'edit-job' }}>
          <JobForm key={job.rev} job={job} source={source} send={send} busy={busy} error={error} />
        </Fold>
      )}
    </div>
  )
}

/** "Add a job" at the foot of the list: name, cadence, where it posts, model and prompt. Folded away until wanted. */
export function AddJob({ source, refresh, listed }: { source: ScheduleSource; refresh: Refresh; listed: string[] }) {
  const edits = source.edits
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [cadence, setCadence] = useState<Cadence>({ kind: 'daily', time: '08:00', days: [1], custom: '0 8 * * *' })
  const [target, setTarget] = useState('')
  const [model, setModel] = useState(FOLLOW)
  const [prompt, setPrompt] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const { busy, error, send } = usePress(refresh)
  useWaitingPoll(!!sent && !listed.includes(sent), refresh)
  if (!edits?.targets || !edits.models) return null
  const targets = edits.targets
  const expr = cronOf(cadence)
  const chosen = edits.models.find(item => keyOf(item) === model) ?? null
  const place = target || targets[0]?.id || ''
  const problem = (name && !NAME_RE.test(name) ? 'A name uses lower case letters, digits and dashes, 3 to 60 characters, and starts with a letter.' : '')
    || (listed.includes(name) ? 'A job with that name exists.' : '') || cronProblem(expr) || (prompt ? promptProblem(prompt) : '')
  const ready = NAME_RE.test(name) && !problem && !!prompt.trim() && !!place
  const add = () => {
    setSent(name)
    send({ op: 'add', job: name, base: '', to: { schedule: expr, prompt, postsTo: place, provider: chosen?.provider ?? null, model: chosen?.model ?? null } })
  }
  return (
    <Fold level={3} title="Add a job" open={open} onToggle={() => setOpen(value => !value)} data={{ 'data-fold': 'add-job' }}>
      {sent && !listed.includes(sent) && !error && <p className="se-change se-wait" role="status" data-add-wait>Waiting for the Hermes host: {sent} appears in the list when it reports.</p>}
      <form className="ae-form se-form" onSubmit={event => event.preventDefault()} data-add-form>
        <label className="ae-field"><span>Name</span><input type="text" value={name} onChange={event => setName(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} data-add-name /></label>
        <CadenceField cadence={cadence} onChange={setCadence} zone={source.timezone} disabled={busy} />
        <label className="ae-field">
          <span>Posts to</span>
          <select value={place} onChange={event => setTarget(event.target.value)} disabled={busy} data-add-target>{targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
          {targets.length === 0 && <small className="team-dim">The Hermes host lists no place to post yet.</small>}
        </label>
        <ModelField value={model} onChange={setModel} options={edits.models} current={null} followed={undefined} disabled={busy} />
        <label className="ae-field"><span>Prompt</span><textarea value={prompt} rows={8} onChange={event => setPrompt(event.target.value)} spellCheck={false} disabled={busy} data-add-prompt /></label>
        {problem && <p className="hub-error" role="alert" data-add-problem>{problem}</p>}
        {error && <p className="hub-error" role="alert" data-add-error>{error}</p>}
        <div className="ae-actions se-actions"><button type="button" className="hub-btn pri" disabled={!ready || busy} onClick={add} data-add-save>Add job</button></div>
      </form>
    </Fold>
  )
}
