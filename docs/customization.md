# Make Workspace yours

## Change in Settings

Use the right-hand Settings rail for the display and behavior controls. Under **Appearance**,
choose **Dark**, **Light** or **System**. Dark is the default. Light uses dark text on white;
System follows your device. The choice applies at once to navigation, file previews, Markdown
and standard reports, is saved for next time, and syncs between browser tabs connected to the
same service.

Agents run in your own terminal; terminal settings belong there (`tools/wezterm/` has an
example WezTerm config).

## Change with an agent

| Ask for | Where it belongs |
| --- | --- |
| "Save this reliable modeling method." | A focused note in `knowledge/` |
| "Make this repeatable." | A workflow in `processes/` and, if useful, a skill in its own package |
| "Add a report tab to this project." | The existing card's steps in the active workspace's `workspace.json` |
| "Create a new research task." | A dated card folder in the active workspace and one registry entry |
| "Change fonts, colors or spacing everywhere." | Shared application and report styles |
| "Add another main folder." | Files rail defaults in the application source |

A useful instruction is: "Read AGENTS.md, propose a small change, implement it, verify the
result, and prepare the update. Ask before restarting the app."

## A small project structure

Keep one pinned project hub with Brief, Plan and Assets tabs. Put lasting source files under
`projects/<project>/`; keep the pages you read in its card folder. Add one card for an
independent task, not one card per generated image. Related iterations become tabs in the same
card. Archive superseded work.

## Optional providers

Nothing here installs MCP servers. Use the MCP panel to inspect your project and global
configuration, then follow the provider's own instructions. Keep MCP connections in your own
user settings; credentials stay local or in the provider's login store. Use the client's
documented support for environment secrets rather than putting a token in a connection file.

For fal.ai, use the `fal-ai-generation` skill from `art-pipeline-skills` and set `FAL_KEY` in
`.env`. Check the exact model schema before starting a paid job. Higgsfield uses its own CLI
setup and account.

## Design rules

Use Markdown for text-first pages people maintain or reuse: readable headings, relative image
paths and GitHub-flavoured tables, no Liquid or kramdown-only syntax, so the same page renders
in the app and on the Just the Docs site. `npm run docs:sync` writes the navigation front matter
from the active workspace's `workspace.json`. Use HTML with `_shared/report.css` for
presentation-first pages: visual reports and anything with graphics, effects, 3D models, video
or other media. An independent design, such as a game demo, can add
`data-buw-theme="custom"` to its root element to keep its own palette.

`workspace/sample-markdown` and `workspace/sample-html` show both formats. The
`workspace-authoring` skill holds the full rules; if you change the design system, update that
skill and the shared styles together.
