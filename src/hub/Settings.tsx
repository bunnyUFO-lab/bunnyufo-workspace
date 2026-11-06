import ThemePicker from '../components/ThemePicker'
import WorkspaceSettings from '../local/WorkspaceSettings'
import { SkillPacksBody } from '../local/SkillPacks'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'
import { host } from '../lib/host'
import { Section } from '../ui/Layout'
import './settings.css'

/**
 * Settings: the theme, the workspaces, the keyboard shortcuts (the Ctrl+H sheet reads the same list) and the skill packs.
 * Every host shows it, with or without a Hub. Away, the PC and the next-item setting join it in item 5; Skills moves to Team in item 10.
 */
export default function Settings() {
  return (
    <div className="hub-settings" data-settings>
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
      <Section title="Skill packs"><div className="settings-card"><SkillPacksBody files={host.files} /></div></Section>
    </div>
  )
}
