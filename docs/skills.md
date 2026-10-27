# Skills

Every skill is an [APM](https://microsoft.github.io/apm/) package. None is kept in this
repository: a project depends on the packages it needs instead of receiving copies.

| Package | Holds | Install |
| --- | --- | --- |
| [bunnyUFO-lab/workspace-skills](https://github.com/bunnyUFO-lab/workspace-skills) | Cards and reports, project hubs, planning, handoffs, dev sprints, dictation setup | `apm install bunnyUFO-lab/workspace-skills#v1.0.1` |
| [bunnyUFO-lab/gamedev-skills](https://github.com/bunnyUFO-lab/gamedev-skills) | Unity, Blender, 3D production, level design, game UI, VFX, audio, playtesting, Notion planning | `apm install bunnyUFO-lab/gamedev-skills#v1.0.1` |
| [bunnyUFO-lab/art-pipeline-skills](https://github.com/bunnyUFO-lab/art-pipeline-skills) | Sprite Studio pixel art, ComfyUI workflows, fal.ai, Higgsfield, image references, video review | `apm install bunnyUFO-lab/art-pipeline-skills#v1.0.0` |

Each package's README lists its skills and what they need beyond the skill files (MCP servers,
Blender, the Unity CLI, a `FAL_KEY`, and so on).

## Claude Code: the plugin

Claude Code can take the workspace package once per user as the `bunnyufo` plugin, which every
repository then sees:

```text
/plugin marketplace add bunnyUFO-lab/workspace-skills
/plugin install bunnyufo@workspace-skills
```

## Any agent: APM in the project

Run `apm install` from the root of the project that needs the skills. APM writes them into
`.claude/skills/<name>/SKILL.md` for Claude Code and `.agents/skills/<name>/SKILL.md` for Codex
and OpenCode, with each skill's `scripts/`, `references/` and other folders. Commit the deployed
skills with that project and keep `apm_modules/` (the dependency cache) gitignored.
`apm install --update`, or moving the pinned tag in the project's `apm.yml`, picks up a new
release.

> **Known issue, APM 0.33.0.** `apm install` fails with
> `Unable to prepare Git clone configuration probe` when the project sits at a long Windows path
> (it works at about 100 characters and fails at about 190, even with `core.longpaths` on).
> Claude Code worktrees under `.claude/worktrees/` are long enough to hit it, so install from the
> repository root.

## Editing a skill

Clone its package, edit `.apm/skills/<name>/`, commit and tag a release. Projects pick the
change up with `apm install --update` or by moving their pin; the plugin with
`/plugin marketplace update workspace-skills`.

Nothing syncs back. An edit made in a deployed copy is not overwritten either: APM skips a file
it did not write, so the copy and its package drift apart quietly.

## Where the app shows them

The Skills panel lists the skills it finds in a project and in your user folders.
**Install in a project…** (also Settings > Skills, and the Skills button on the published site)
copies the install command for each package. The app installs nothing itself.

A skill does not authenticate a provider or install a tool. Follow its setup references and
bring your own account.
