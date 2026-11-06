import ThemePicker from '../components/ThemePicker'
import WorkspaceSettings from '../local/WorkspaceSettings'
import { SkillPacksBody } from '../local/SkillPacks'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'
import { host } from '../lib/host'
import { Section } from '../ui/Layout'
import AwayToggle from './AwayToggle'
import PcTile from './PcTile'
import { useAutoNext } from './useGoNext'
import { useTodayScreen } from './useHub'
import './needs.css'
import './settings.css'

/** The PC's status and the wake, as Today used to draw them: the one place that shows the whole of it. */
function PcSection() {
  const { data } = useTodayScreen()
  if (!data) return <p className="hub-muted">Loading…</p>
  if (!data.pc && !data.wake?.wakeAvailable) return <p className="hub-muted" data-pc-none>No PC has reported yet.</p>
  return <PcTile pc={data.pc ?? null} wake={data.wake} />
}

/** "Next item after answering": off unless turned on here. Kept in this browser. */
function NextItemSetting() {
  const [on, set] = useAutoNext()
  return (
    <div className="settings-next">
      <label className="settings-switch">
        <input type="checkbox" role="switch" checked={on} onChange={event => set(event.target.checked)} data-next-item-setting />
        <span>Next item after answering</span>
      </label>
      <p className="hub-muted">Off: you stay on the item after you answer, with a Next item button. On: the next item opens by itself.</p>
    </div>
  )
}

/**
 * Settings: the theme, the workspaces, the keyboard shortcuts (the Ctrl+H sheet reads the same list) and the commands to install skills on a PC.
 * Every host shows it, with or without a Hub. Away, the PC with its Wake and the next-item setting need a Hub. What Hermes has installed is on Team.
 */
export default function Settings() {
  return (
    <div className="hub-settings" data-settings>
      {host.hub && <Section title="Away"><div className="settings-card" data-settings-away><AwayToggle /></div></Section>}
      {host.hub && <Section title="Gaming PC"><div className="settings-card" data-settings-pc><PcSection /></div></Section>}
      {host.hub && <Section title="Next item"><div className="settings-card" data-settings-next><NextItemSetting /></div></Section>}
      <Section title="Appearance"><div className="settings-card"><ThemePicker /></div></Section>
      {(host.workspaces || host.files) && <Section title="Workspace"><div className="settings-card"><WorkspaceSettings /></div></Section>}
      <Section title="Keyboard shortcuts">
        <div className="settings-card" data-settings-shortcuts>
          {SHORTCUT_GROUPS.map(group => (
            <div key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map(item => (
                  <div key={item.keys.join('+') + item.does} className="shortcut-row">
                    <dt>{item.keys.map((key, index) => <span key={index}>{index > 0 && '+'}<kbd>{key}</kbd></span>)}</dt>
                    <dd>{item.does}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Install skills on a PC"><div className="settings-card"><SkillPacksBody files={host.files} /></div></Section>
    </div>
  )
}
