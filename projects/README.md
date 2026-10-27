# Projects

Each game keeps its code, `CLAUDE.md` and technical docs in its own repository.
The workspace holds what matters across sessions and repositories: a **project
hub card** per game (`workspace/<project>/`: Overview, Game design, Log) and
**task cards** that start as a plan and end as a report. Hubs record the game
repository's path, which links an agent working there back to its hub.

Create and use them through the `workspace-link` skill (from
`bunnyUFO-lab/workspace-skills`) rather than by hand: its `buw-workspace.mjs` script lists
projects (`projects`) and makes a hub (`new-project "<Title>" --repo <game repo>`).

Use this folder for longer source material that is not a Workspace page, such as
design documents to import or exported specs, in `projects/<project>/`.
