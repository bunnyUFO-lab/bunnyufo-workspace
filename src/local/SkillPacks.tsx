import { Icon } from './Icons'
import Packs from '../components/SkillPacks'
import CardAccess from '../components/CardAccess'
import './skill-packs.css'

/**
 * Install skills, in the app.
 *
 * There used to be an installer here: pick a project folder, tick skills, and the service
 * copied them in and wrote a lockfile. Every skill is an APM package now, so the app has
 * nothing left to copy — what it can usefully do is hand over the command for the project
 * you are about to open a terminal in.
 */
export default function SkillPacks({ onBack, onClose }: { onBack?: () => void; onClose: () => void }) {
  return <div className="files-panel skill-packs">
    <header><h2>Install skills</h2><div>
      {onBack && <button className="desk-icon" onClick={onBack} title="Back to skills" aria-label="Back to skills"><Icon name="back" size={16} /></button>}
      <button className="desk-icon" onClick={onClose} title="Close" aria-label="Close"><Icon name="close" size={17} /></button>
    </div></header>
    <div className="skill-packs-body">
      <p className="skill-packs-intro">Run one of these with <a href="https://microsoft.github.io/apm/" target="_blank" rel="noreferrer">APM</a> inside the project that needs the skills, from its root — not a worktree. They deploy into <code>.claude/skills/</code> (and <code>.agents/skills/</code> for Codex), which you commit with the project.</p>
      <Packs />
      {onBack
        ? <p className="skill-packs-foot">Claude Code can take the workspace package as a plugin instead: <code>/plugin marketplace add bunnyUFO-lab/workspace-skills</code>, then <code>/plugin install bunnyufo@workspace-skills</code>.</p>
        // No local files to browse: what is left is how to install, and how an agent reads these cards.
        : <CardAccess />}
    </div>
  </div>
}
