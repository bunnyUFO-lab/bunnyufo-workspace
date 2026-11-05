import { useState } from 'react'
import type { CardWriteSections } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { useHubData } from './useHub'
import './cardWrites.css'

/**
 * Where agents can write: one native checkbox per Library section, and `assistant` locked on, because it is where they fall back
 * to. A change saves at once as an explicit list (the card API may not read a file that is missing), and takes up to 30 seconds to
 * reach the card API. Turning a section off refuses later writes; cards already there stay.
 */
export default function AgentCardSettings() {
  const { data, error, reload } = useHubData<CardWriteSections>('/card-write-sections')
  const [busy, setBusy] = useState<string | null>(null)
  // The box shows the owner's tap at once; the saved list replaces it when the Hub has answered.
  // It belongs to the list it was tapped on: when a newer list arrives it no longer counts.
  const [tapped, setTapped] = useState<{ on: Record<string, boolean>; list: CardWriteSections | null }>({ on: {}, list: null })
  const [failure, setFailure] = useState('')
  // The Hub's list can be a few seconds behind a save: this page remembers that it saved, so the "not saved yet" line does not come back.
  const [saved, setSaved] = useState(false)
  const shown = tapped.list === data ? tapped.on : {}
  if (!data) return error ? <p className="hub-error" role="alert">{error}</p> : null
  const send = async (key: string, body: object, on?: boolean) => {
    setBusy(key); setFailure(''); setSaved(false)
    if (on !== undefined) setTapped({ on: { ...shown, [key]: on }, list: data })
    try { await hubPost('/card-write-sections', body); setSaved(true); reload() } catch (problem) {
      setFailure(`Not saved: ${problem instanceof Error ? problem.message : 'the setting was not saved.'} The box is back as it was.`)
      setTapped({ on: {}, list: null })
    } finally { setBusy(null) }
  }
  const owner = host.write
  return (
    <section className="cw-setting" aria-labelledby="cw-setting-title" data-card-write-setting>
      <h3 id="cw-setting-title">Where agents can write</h3>
      <p>Pick the sections where agents can add cards and tabs. They never delete, and every write shows who made it, with a Revert.</p>
      {data.unreadable && <p className="hub-error" role="alert">The setting file could not be read, so no agent may write to a project section until it is saved again.</p>}
      <ul>
        {data.sections.map(item => (
          <li key={item.id} {...(item.locked ? { 'data-locked': '' } : {})}>
            <label>
              <input type="checkbox" checked={shown[item.id] ?? item.on} disabled={!owner || !!item.locked || busy !== null} data-card-write-section={item.id}
                onChange={event => void send(item.id, { section: item.id, on: event.target.checked }, event.target.checked)} />
              <span>{item.name}{item.locked ? <small> · Always on: it is where they fall back to.</small> : null}</span>
            </label>
          </li>
        ))}
      </ul>
      {owner && !data.saved && !saved && !data.unreadable && (
        <p className="cw-setting-note" data-card-write-unsaved>
          Not saved yet, so every section is on. <button type="button" className="cw-btn" disabled={busy !== null} onClick={() => void send('save', { save: true })} data-card-write-save>Save this list</button>
        </p>
      )}
      {saved && <p className="cw-setting-note" role="status" data-card-write-saved>Saved.</p>}
      {failure && <p className="hub-error" role="alert" data-card-write-error>{failure}</p>}
      <p className="cw-setting-note">Changes save at once and take effect within 30 seconds. Cards already there stay.</p>
    </section>
  )
}
