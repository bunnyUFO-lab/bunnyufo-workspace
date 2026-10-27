import { useState } from 'react'

/**
 * The three skill packages, and a button that copies the command to install one.
 *
 * Every skill is an APM package now, this workspace's own included, so nothing here can
 * install anything — and that is the point. The commands are what you need in the project
 * that wants the skills, which is never the machine-and-folder this is rendered in: the
 * published site read on a phone, or the app sitting in the workspace repository.
 */
interface Pack {
  name: string
  what: string
  /** owner/repo, shown as the link and the only identifier worth reading at a glance. */
  repo: string
  command: string
}

const PACKS: Pack[] = [
  {
    name: 'Game development',
    what: 'Unity, Blender, 3D production, level design, game UI, VFX, audio, playtesting, Notion planning.',
    repo: 'bunnyUFO-lab/gamedev-skills',
    command: 'apm install bunnyUFO-lab/gamedev-skills#v1.0.1',
  },
  {
    name: 'Art pipeline',
    what: 'Sprite Studio pixel art, ComfyUI workflows, fal.ai, Higgsfield, image references, video review.',
    repo: 'bunnyUFO-lab/art-pipeline-skills',
    command: 'apm install bunnyUFO-lab/art-pipeline-skills#v1.0.0',
  },
  {
    name: 'Workspace',
    what: 'Cards and reports, project hubs, planning, handoffs, dev sprints, dictation setup.',
    repo: 'bunnyUFO-lab/workspace-skills',
    command: 'apm install bunnyUFO-lab/workspace-skills#v1.0.1',
  },
]

/**
 * The command is not shown. It is longer than the panel, and printing it only bought a
 * horizontal scrollbar on every row — the title and the repository say what this is, and the
 * button is what you came for. `title` still carries the text for anyone who wants to read it.
 */
export function Copy({ command, label = 'Copy install command' }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      className="site-skill-copy"
      title={command}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(command)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        } catch {
          // Clipboard refused: no permission, or a plain-http origin on the LAN. Say so,
          // because with the command hidden there is nothing to select by hand instead.
          setFailed(true)
          window.setTimeout(() => setFailed(false), 2600)
        }
      }}
      aria-label={`${label}: ${command}`}
    >
      <span aria-hidden="true">{copied ? '✓' : failed ? '!' : '⧉'}</span>
      {copied ? 'Copied' : failed ? 'Copy failed' : label}
    </button>
  )
}

export default function SkillPacks() {
  return (
    <>
      {PACKS.map(pack => (
        <div key={pack.name} className="site-skill">
          <strong>{pack.name}</strong>
          <small>{pack.what}</small>
          <div className="site-skill-row">
            <a href={`https://github.com/${pack.repo}`} target="_blank" rel="noreferrer">{pack.repo}</a>
            <Copy command={pack.command} />
          </div>
        </div>
      ))}
    </>
  )
}
