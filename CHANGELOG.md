# Changelog

## Unreleased

- **Pictures on inbox items, as in chat.** An Ask you can answer with a note, and a checklist's note, get chat's picture button and tray: pick, paste (on a PC) or take a photo, see it, remove it, then send. The picture is saved when you pick it, so Undo still works and a reload keeps it. `cards ask get/wait` and `cards checklist get/wait` now download the pictures on their own, into `.buw/pictures/` of the checkout (kept out of git), and print each file's full path, so an agent that waits for your answer gets them. A run question and a decline say why they take no picture. Chat uses the same button and tray, with no change in how it works. Not yet: steps and playtest issues keep their own picture buttons.
- **Chat card links open the card.** A link in a reply to a card on this site is an **Open card** button that opens the card in a new tab. An agent's HTML card no longer downloads: the site now serves a file stored as a generic binary with the type its name gives, and its ETags changed so a browser that took the bad answer fetches the file again.
- **Data sections are not served as files.** The inbox, hidden sections and saved card answers answer 404 under `/w/`; the signed-in app reads them through the Hub.
- **A new shell.** A rail on a desktop and five tabs on a phone (Today, Chat, Library, Projects, Search) replace the Operate, Plan and Know groups, the More menu and the phone's side bar. Opening the site lands on Today. Back walks one history: the browser's back, Alt+Left and the Back buttons agree, a sheet closes on Back, and a filter chip adds no step. Settings is a screen. Old links keep working. Beside a card, the card list folds below 1400 px, with a Show list button.
- **Agent card-writing text.** The brief and the chat personas now say to prefer a new tab, that an existing script file cannot be edited, and that editing an owner's HTML tab turns off its saving until reverted.
- **Who wrote what, and Revert.** A card an agent has written to shows one line above it (who, what, when) with its history; the project page lists the newest agent writes; **Revert** puts an edit's old text back, takes an added tab off (the "+" form brings it back) or puts an added card in the Trash, and a later publish from the PC keeps that. Team gains **Where agents may add cards**, a checkbox per Library section. A tab an agent adds to your card gets no card bridge.
- **Jobs write their card to the project.** A research, mockup or question job is signed with the project's own section when it is a Library section agent cards are on for, else `assistant`; its brief and the chat personas say who is writing and why, and the result links the card in either section. Only a `CARD:` line naming `assistant` or the signed project counts.
- **Agent card writes, gated.** The card API gains a `@library` write right for agents: they add cards and tabs to project sections, never delete, say who and why, and each write leaves a record in the inbox. Publish and pull now skip a site key that is not a safe path on this PC.
- **`cards put` removes nothing unless you pass `--remove`.** A file gone from the folder now stays in the section and is listed as kept; before, `put` removed it. For project sections an agent may only add to, `put` takes `--agent`, `--why`, `--context` and `--edit`, `get` records the version it read, `sections` shows how each section may be written, and `request card <id>` prints a finished request's card.
- **What jobs delivered.** Work has a Jobs tab: Running and Finished, with a project filter, and for each job who ran it, when, and a pill for what it delivered (a card, a PR, Asks, a list of steps, a task, a follow-up job) or how it ended. A finished job's page now leads with what it found and its deliverables, each with a button that opens it, and keeps the log in a closed fold. A grilling run that files Asks and ends with `ASKS:` now reads as done with its Asks, not as failed, and Asks and lists a run files remember which job made them.
- **Jobs in a chat.** When Hermes proposes jobs in a reply, a Jobs block under it lists each one (what it is, who does it, where it runs, what it delivers) with Read the job, one Approve all button for the ones on screen, and Change to open the approval page. Each row then follows its job and opens the card or the PR when it finishes. Helpers Hermes starts inside the chat are now labelled as helpers, apart from jobs. A persona's proposals are flagged and have no one tap.
- **Send while Hermes answers.** A message sent during a reply waits as a dashed Queued row and goes out when the reply ends, as one turn when there are several. After a Stop or a failure the rows say Not sent, with Send now and Cancel, and nothing goes out by itself. The Hub delivers them, so a reload, a locked phone or a restart of the service loses nothing. Limited card-API tokens can no longer write under `chat/`.
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
  Uploads and deletes are conditional, so a change written to the bucket during a publish is
  never overwritten; the site's copy is saved under `.buw/conflicts`, the report says how to
  settle each file, and a real publish that leaves conflicts exits with code 2.
