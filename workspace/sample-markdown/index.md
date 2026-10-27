---
title: "Sample Markdown card"
parent: "Samples"
nav_order: 2
description: "The format of a text-first card: one Markdown file per tab."
render_with_liquid: false
---
# Sample Markdown card

A text-first card: hubs, specs, guides and reports that may become docs. It is one Markdown
file per tab, listed in `workspace.json` under the card's `steps`.

## What goes in one

- A short lead that says what the page is for.
- Sections with plain headings, so the docs site can build its navigation.
- Tables, lists and code blocks; images beside the page, linked by relative path.

| Field | Example |
| --- | --- |
| `id` | `sample-markdown` |
| `folder` | `sample-markdown` |
| `steps` | `[{ "name": "Overview", "path": "index.md" }]` |

```bash
npm run -s workspace path   # the folder your own cards live in
```

> Your own cards live in a separate workspace folder, not in this repository. See
> `docs/workspaces.md`.
