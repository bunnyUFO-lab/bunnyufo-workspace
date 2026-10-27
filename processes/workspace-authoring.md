# Authoring a Workspace card

Text-first card pages are Markdown; visual reports and media pages are HTML
(see the `workspace-authoring` skill for which to use). The Workspace app shows them as tabs and the Just the
Docs site (`npm run docs`, http://localhost:4000) shows the same files with
navigation and search. The active workspace's `workspace.json` is the registry
for both. Cards live in the active workspace: `npm run -s workspace path` prints its
folder, written `<workspace>/` below (see `docs/workspaces.md`).

1. Read the current registry and reuse the relevant project or task card.
2. Create a dated folder only for a new independent task, e.g.
   `<workspace>/2026-10-06_goblin-sprites/`. Keep sources and output media local
   to that task or its project folder.
3. Write each text tab as a `.md` file in English by default: a `# Title` heading,
   then portable GitHub-flavoured Markdown (tables, lists, fenced code, images
   with alt text, relative links). No raw HTML or Liquid.
4. Register the card: stable `id`, `title`, `description`, `category`, `folder`,
   `created`, `updated`, `status: "active"` and `steps` (tab names and files).
   Keep one main project pinned when it is the user's working hub.
5. If the workspace is also served as a Just the Docs site (`npm run docs`), run
   `npm run docs:sync`. It writes the navigation front matter into each page,
   regenerates `<workspace>/index.md`, `<workspace>/categories/*.md` and any
   `gallery.md`, and keeps archived cards out of that site. Never edit those
   generated keys or pages by hand. The published site does not need this step.
6. Update `updated` after meaningful changes; preserve `created`. Do not mark
   personal work `sample: true`. Archive finished work with `"status": "archived"`.
7. Check every changed tab in the app (Preview and Edit) and, when Docker runs,
   in `npm run docs`; then run `npm run test:template` and report the outcome.
   A built installer is not an installed update.
8. Publish without being asked once an initial draft is complete or a report is
   finalized, but not while still ideating: `npm run publish -- --card <id>`
   uploads that card and the card list to the workspace's place in the cards
   bucket, and the site serves it at once — no commit, no push
   (`npm run publish -- --all` when the work spans several workspaces). Before
   asking for feedback, confirm with `npm run redeploy -- --site` that nothing is
   left to upload and the site lists the section.

A new page needs no front matter; after `npm run docs:sync` it begins like:

```markdown
---
title: "Goblin Sprites"
parent: "Image Gen"
nav_order: 2
description: "Four goblin variants and the chosen walk cycle."
render_with_liquid: false
---
# Goblin Sprites

![Four 32px goblin variants](variants.png)
```

Use an HTML page for presentation-first content: a visual report-back that will
not become docs, comparisons, graphics, effects, 3D models or video. A live
local tool belongs in a step `url`, not an HTML wrapper. Give an HTML page `data-buw-report="document"` and the
shared `../_shared/report.css` and `report.js`, and link it from the card's
Markdown page; the docs site navigation lists Markdown pages only.
