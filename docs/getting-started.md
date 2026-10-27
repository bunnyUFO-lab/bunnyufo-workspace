# Getting started

bunnyUFO Workspace is a web app: a React UI served by one Node service, run locally in Docker.
Its files are ordinary project files, and the agents are ordinary CLI sessions that you run in
your own terminal.

## Start the app

Clone this repository, then:

```bash
WORKSPACE=/path/to/your-workspace docker compose up -d
```

Open <http://127.0.0.1:8300>. `WORKSPACE` is a folder holding a `workspace.json`; leave it
unset to see this repository's two sample cards. The ports are published on `127.0.0.1` only,
so nothing else on the network can reach them. Putting the app on a LAN or a public name needs
an authenticating proxy in front.

You get cards, reports, files, skills and MCP panels. Settings and the workspace registry live
in a Docker volume, so they survive a rebuild.

## Connect an agent

Install at least one agent CLI and sign in with your own account:

- [Claude Code](https://code.claude.com/docs/en/setup)
- [Codex CLI](https://developers.openai.com/codex/cli)
- [OpenCode](https://opencode.ai/docs/)

Open a terminal in the repository folder and start the CLI (`claude`, `codex` or `opencode`).
It reads the `AGENTS.md` rules (Claude Code reads `CLAUDE.md`, which points there). Skills, MCP
servers and permissions come from your own user settings; this repository ships none. Keep the
normal CLI permission flow unless you deliberately choose to bypass it.

Try: "Create a small project plan in `projects/`. Ask me for the idea and target platform
before writing it." Or ask for a card in your own workspace — see [workspaces](workspaces.md).

`tools/wezterm/` holds an example WezTerm config with shortcuts that open agents in new tabs.

### Subscriptions and API keys

Claude Code can use a Claude Pro or Max login, and Codex an eligible ChatGPT subscription. You
do not add an API key to the Workspace for them; they keep their own authentication and limits.
See [Claude authentication](https://code.claude.com/docs/en/authentication) and
[Codex authentication](https://developers.openai.com/codex/auth).

OpenCode uses its own provider setup: your chosen provider decides authentication, billing and
models. A Claude Code subscription does not automatically give access through third-party
clients.

The MCP panel lists Claude Code, Codex, Kimi and Cursor configurations; use OpenCode's own MCP
controls to inspect its connections.

## Install skills

Skills come from three [APM](https://microsoft.github.io/apm/) packages. For Claude Code,
take the workspace package once as a plugin:

```text
/plugin marketplace add bunnyUFO-lab/workspace-skills
/plugin install bunnyufo@workspace-skills
```

In a project that needs skills (a game repository, say), install them with APM from its root:

```bash
apm install bunnyUFO-lab/gamedev-skills#v1.0.1        # Unity, Blender, 3D, level, UI, VFX, audio
apm install bunnyUFO-lab/art-pipeline-skills#v1.0.0   # Sprite Studio, ComfyUI, fal.ai, references
apm install bunnyUFO-lab/workspace-skills#v1.0.1      # cards, hubs, planning, handoffs, sprints
```

The app's Skills panel and Settings > Skills copy these commands for you. See
[skills](skills.md).

## Your first cards

The two sample cards, one Markdown and one HTML, show the formats. Your own cards go in a
workspace folder of your own, registered with `npm run workspace add` — see
[workspaces](workspaces.md). Or ask an agent for a card and let the `workspace-authoring`
skill write it there.

Each card in the home grid has an **archive** button next to its status dot. Archived cards
gather in an **archive** section at the foot of the grid and of the menu, folded shut and
counted in its heading. **restore** brings a card back and dates it today. Every section
heading folds its section away, and stays folded in this browser until you open it again.

Pinned, archived, tags and the order of the pinned list are **card state**, not card content:
they never go into `workspace.json`. With a cards bucket registered they live in its
`state.json`, shared with the published site, so a pin made on a phone shows everywhere;
without one they go to `.buw/card-state.json` (in the container, the state volume).

Use Files to inspect `projects`, `knowledge` and `processes`. A Markdown file opens in Preview;
switch to Edit and Save to change it. The Help button opens a quick guide.

Browse the cards as a Just the Docs site with `npm run docs` (needs Docker; the first run
downloads Ruby and gems), then open <http://localhost:4000>.

## Optional dictation

Optional local dictation into terminals is described in
[voice dictation](../knowledge/voice-dictation.md).

## Work on the app itself

From a fresh clone, `npm ci` installs the UI and the service dependencies (its `postinstall`
runs `npm --prefix server ci`; run that yourself if you disable lifecycle scripts). Node.js
22.20+ is required.

```bash
npm run dev        # the UI on http://localhost:3009, with hot reload, serving the active workspace
npm run service    # the Node service; it prints the address to open
```

`npm run dev` does not start the service. `npm run redeploy -- --app` rebuilds the container
image and restarts it; an agent should prepare and verify a rebuild, then ask before
restarting the app. See [architecture](architecture.md) for the checks to run.

## On another computer

Clone the repository, start the container, register your workspace folders again and sign in
to your CLIs. Recreate `.env` locally. Cards travel through the bucket (`npm run publish --
--pull`) or your own Git history; credentials, local app state and CLI histories do not.
