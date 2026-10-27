# Changelog

## Unreleased

- First public version: a web app for project cards and reports, run locally with Docker or
  served from a published site. Ships two sample cards (Markdown and HTML) to show the formats.
- **Make cards by hand, on the site or locally.** ＋ New card on the board, ＋ after a card's tabs
  for another Markdown section, a pencil for the title and description, and a Markdown editor
  that refuses to overwrite a newer version. The site's ＋ New section is now ＋ New workspace,
  and new workspaces start without the sample cards.
- **＋ New workspace in the local app too.** The switcher makes the folder beside the open
  workspace and registers it, publishing where its neighbours do; adding a folder you already
  have is **Add existing folder…**. The New card form picks its project from chips instead of
  a native drop-down, which ignored the dark theme.
- **A real Markdown editor.** CodeMirror replaces the plain text box: syntax highlighting,
  undo, a formatting toolbar (Ctrl+B, Ctrl+I, Ctrl+K…), `/` commands for tables, task lists,
  code and more, Enter continuing lists and table rows, a URL pasted over selected text
  becoming a link, and **Split** showing the editor and the preview side by side when the
  screen has room. Preview is now called **View**. It loads only when someone edits.
- **Publish keeps what was made on the site.** It merges the bucket's card list first, brings
  down files changed only there, and reports a file changed in both places instead of
  overwriting it (`.buw/sync.json` records the last sync; `--force` keeps this folder's copy).
