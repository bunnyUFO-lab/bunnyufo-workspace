# Workspaces

A **workspace** is a folder of cards: a `workspace.json` registry, one folder per card, and its
own Just the Docs site configuration (`_config.yml`, `Gemfile`, `docker-compose.yml`,
`_shared/`). The app shows one workspace at a time.

- **The app's own `workspace/`** holds two sample cards, one Markdown and one HTML, to show the
  formats. It keeps the shared report styles and the site template every workspace copies, and
  is the fallback when nothing else is registered.
- **Your own cards live in folders outside the app,** one per workspace, anywhere on disk (for
  example `~/workspaces/<name>`). Each is registered in a user-level file,
  `~/.buw/workspaces.json`, together with the place in the cards bucket it publishes to:
  `"bucket": "s3://<bucket>/sections/<id>"`. The folder may be a git repo if you want history;
  publishing does not need it to be.
- **Everything agrees on the active workspace:** every checkout, agent worktree and helper
  script reads that same file.

## Commands

```bash
npm run workspace
```

Lists the workspaces; `*` marks the active one.

```bash
npm run -s workspace path
```

Prints the active workspace folder. Agents use this to find where cards go.

```bash
npm run workspace add ~/workspaces/my-workspace --name "My workspace" --bucket s3://my-cards/sections/my-workspace --site https://<your-site>/my-workspace --use
```

Registers a folder (it must contain `workspace.json`). `--bucket` is where it publishes,
`--site` the "Published site" link shown in Settings, and `--use` also makes it active.

```bash
npm run workspace set my-workspace --bucket s3://my-cards/sections/my-workspace
```

Changes where a registered workspace publishes (`--repo`, `--site` and `--name` the same way;
an empty value removes the field).

```bash
npm run workspace use my-workspace
```

Switches the active workspace. `template` switches back to the sample cards. You can also
switch in the app, under Settings > Workspaces.

```bash
npm run workspace remove my-workspace
```

Unregisters a workspace only; its folder and files are untouched.

```bash
npm run workspace update-shared
```

Copies the app's `workspace/_shared` (report styles, image viewer, `card-data.js`) into the
active workspace after an app update.

```bash
npm run workspace migrate my-cards
```

Gives every registered workspace that has no bucket yet `s3://my-cards/sections/<id>`.

### Which workspace is used

1. `--content <folder|id>`: the service and scripts.
2. `BUW_CONTENT`.
3. `BUW_WORKSPACE`, only when it points straight at a folder with `workspace.json`. When it
   points at the app repo, it keeps its usual meaning: "where the app is".
4. The registry's active entry.
5. The app's own `workspace/`.

A session started with `--content` or `BUW_CONTENT` cannot switch workspaces in the app. The
Docker container is one of these: it sets `BUW_CONTENT=/workspace`, the folder `WORKSPACE`
mounts.

## Cards and docs

- **`npm run docs:sync`** refreshes the navigation front matter, home and category pages of
  the **active** workspace. Use `--content <folder|id>` for another workspace, or `--template`
  for the sample cards.
- **`npm run docs`** serves the active workspace's site on <http://localhost:4000> (set
  `BUW_DOCS_PORT` to change the port). **`npm run docs:build`** builds it once.
- **The `gamedev-workspace` skill helper** finds a game repo's hub in whichever registered
  workspace links that repo, so project logs and task cards reach the right workspace.

## Publishing

```bash
npm run publish
```

What it does:

1. Compares the workspace folder with its place in the cards bucket: every registered card
   folder, `workspace.json` and `_shared/`. The Jekyll scaffolding (`_config.yml`, `Gemfile`,
   `_sass/`, `categories/`, `index.md`) stays local; the site does not need it.
2. Refuses likely secrets (`.env`, keys, `*secret*.json` and similar) and files over 50 MB.
3. Merges the bucket's card list into the local one first, so cards made on the site are kept
   and their folders come down.
4. Uploads what changed here, brings down what changed on the site, and deletes what was removed
   here. A file changed in both places is left alone and reported; `--force` uploads this
   folder's copy anyway. The site serves the bucket, so the card is live when the command returns.

Telling "changed here" from "changed on the site" needs a record of the last sync, which publish
and pull keep in the workspace's `.buw/sync.json`. Before a workspace has one, this folder's copy
wins, except where the bucket's copy is newer, which is reported instead.

It needs AWS credentials that can write the bucket: the aws CLI's default profile
(`~/.aws/credentials`), or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the environment.
The region is found from the bucket itself.

Several agents may be working in one workspace at once, so publish only touches its own scope:
the cards you name, or otherwise every registered card folder plus the card list and `_shared/`.
Everything else in the folder — another session's half-written card that is not registered yet,
a scratch file — is left alone, on disk and in the bucket.

```bash
npm run publish -- --card my-card            # just this card (and the card list); repeat --card for more
npm run publish -- --path my-card/run-2      # or name paths directly
npm run publish -- --dry-run                 # show what would be uploaded or deleted
npm run publish -- --pull                    # the other way: fetch what the bucket has and this folder lacks
npm run publish -- --allow-deletes           # publish although more than 5 files would be deleted
```

A publish that would delete **more than 5** objects from a workspace's place in the bucket stops
before it writes anything, and lists them: a folder that lost its files must not empty the site.
Check the list, then publish again with `--allow-deletes` (`--force` does not imply it). The limit is
per workspace, so with `--all` the others still go. `--dry-run` prints the same warning. A
workspace's bucket must be `s3://<bucket>/sections/<id>`; anything else is refused.

`--pull` is for a workspace started on the site, or a card edited on another machine: objects
with no local file are written, and so are files that changed only on the site since the last
sync. A local file that changed here (or in both places) is reported and left alone — publish
it, or `--pull --force` to take the bucket's copy.

### Publishing every workspace

```bash
npm run publish -- --all
```

`--all` walks every registered workspace in turn and does the ordinary publish in each; the
sample cards and folders that have moved are skipped. A workspace that cannot publish (no bucket
registered, a secret in a card) is reported and the rest still go; the summary names each one,
and the command exits non-zero if any needs attention. `--dry-run`, `--pull` and `--allow-deletes` work with it;
`--content`, `--card` and `--path` do not.

`tools/workspace/unpublished-hook.mjs` says when any registered workspace still holds card files
that differ from the bucket, and points at `--all`. It compares md5s against a listing and
uploads nothing. Register it as a `Stop` hook in your own agent settings if you want it.
`npm run redeploy` reports the same diff per workspace, and whether the site lists the section.

## The site

One private S3 bucket holds every section:

```
s3://<bucket>/
  sections/<id>/workspace.json      the card list; its "name" is what the switcher shows
  sections/<id>/<card folder>/…     the card files, exactly as in the workspace folder
  sections/<id>/_shared/…           report styles and scripts (reports load ../_shared/)
  state.json                        pinned, archived, tags and the pinned order, for every section
```

A section whose `workspace.json` carries `"hidden": true` holds data, not cards (the agents' `inbox`):
`/sites.json` lists it with `hidden: true` and `/w/<id>/…` serves it, but the switcher and the
unknown-site list never show it. The ids `inbox` and `assistant` are reserved for the card API: no
local workspace can be registered with them or publish over them.

A small service (`site/api`, container `buw-site-api`, port 8099) is the only thing that reads
it. Caddy (`site/caddy/Caddyfile`) forwards `/sites.json`, `/w/<id>/<file>` and `/api/*` to it:

- `/sites.json` lists the sections the bucket holds, so a new section is in the switcher as soon
  as its `workspace.json` is uploaded. Nothing on the server has to be edited.
- `/w/<id>/<file>` streams the object with its ETag and content type. Only keys under
  `sections/` are reachable this way; `state.json` and anything else in the bucket are not.
- `/api/card-state`, `/api/workspace/status`, `/api/workspace/pin`, `/api/workspace/pins` and
  `/api/workspace/tags` read and write `state.json`. `/api/sections` starts a section: the
  `workspace/` template plus an empty card list carrying the name, put into the bucket.

The rest of the site is **this app's own browser UI**: card grid, tabs, Markdown and HTML
reports, the same as the local app. The site's root opens the first section, and `/<id>` opens
that section. An address naming a section that is not in the bucket says so rather than showing
another one.

### Changing a card from a browser

The site can pin, reorder, archive, restore and tag a card, and start a new section, not only
read them.

A card's **content** is what `npm run publish` uploads. Pinned, archived, tags and the order of
the pinned list are not content: they say which cards you want in front of you and they change
often. They live in `state.json` in the bucket, one object for every section, and the page lays
it over the card lists when it reads them, so a pin shows at once and no card file is touched.
**The local app reads and writes the same object** when a registered workspace names a bucket
and the machine has credentials for it, so a pin made on a phone is the pin the app shows;
without a bucket it falls back to `.buw/card-state.json`. `site/api/card-state.mjs` is the one
module behind both; every write re-reads the object and puts it back conditionally on the ETag
it read, so two devices never overwrite each other.

The UI asks `/api/capabilities` once on load: a site without the service (or with no bucket
configured) answers read-only, with no controls that would fail when pressed.

### Setting up the server

1. **A bucket and a key**, once, with the aws CLI's default profile:

   ```bash
   tools/workspace/setup-bucket.sh my-cards [--region us-east-1] [--import-state /path/to/card-state.json]
   ```

   It creates the bucket (public access blocked, versioning on — every run turns it on again and
   it is never suspended), an IAM user allowed to list, get and put in that bucket, delete only
   under `sections/inbox/`, and never delete versions or change versioning or lifecycle rules, and
   prints the key once. `--import-state` seeds `state.json` from an existing card-state file.
2. **The key on the server**, in `$BUW_DOCS_ROOT/_app/api.env`, readable by root alone:

   ```
   BUW_S3_BUCKET=my-cards
   BUW_S3_REGION=us-east-1
   AWS_ACCESS_KEY_ID=…
   AWS_SECRET_ACCESS_KEY=…
   REQUIRE_REMOTE_USER=1
   ```

   `REQUIRE_REMOTE_USER=1` makes the service refuse any write without a `Remote-User` header
   (see the lock below). It is never in this repository and never deployed from it. The service reads that file
   itself (`BUW_ENV_FILE`), through the `BUW_DOCS_ROOT` mount — not as a compose `env_file`,
   which would need the user running the deploy to be able to read it too.
3. **The service:** `site/deploy/publish-site-api.sh` runs the tests, copies `site/api` (with the
   `workspace/` template beside it) to `$BUW_DOCS_ROOT/_app/api` and brings the container up on the
   Docker network that Caddy shares.
4. **The UI:** `site/deploy/publish-ui.sh` builds it and swaps it into `$BUW_DOCS_ROOT/_app/ui`.
5. **Caddy** is `site/caddy/Caddyfile`: it proxies `/api/*`, `/w/*` and `/sites.json` to the
   service and serves the UI for everything else, on port 4000. `publish-site-api.sh`
   validates it, copies it to `$CADDY_DIR/Caddyfile` and restarts Caddy when it changed. The
   compose file that runs Caddy there is not part of this repository; it must set `NPM_IP` (below).

Run the two scripts from any CI or by hand, from the repository root, with these variables:

| Variable | Default | Purpose |
|---|---|---|
| `BUW_DOCS_ROOT` | required | the server's site folder (`/srv/buw-docs` is the usual one) |
| `CADDY_DIR` | required (`publish-site-api.sh`) | the Caddy stack's folder, holding its `docker-compose.yml` |
| `BUW_DOCKER_NETWORK` | `buw-docs_default` | the Docker network Caddy and the service share |
| `BUW_SITE_API` | `buw-site-api:8099` | the service, as Caddy reaches it |
| `CADDY_PORT` | `4000` | the port the health check calls |
| `SHA` | `git rev-parse HEAD` | the commit the UI release is named after |

Run them from a private repository's CI on your own runner, never from a public repository's workflows.

Two more keys can go in `api.env`: `BUW_SITE_URL` (the address people sign in at, named in the
read-only message) and `BUW_CARD_API` (the card API's address, which pages learn from `/api/capabilities`).

Writes also need an `Origin` header that matches the site: the origin of `BUW_SITE_URL`, or the comma list in
`BUW_SITE_ORIGINS` if you set it. A request with no `Origin`, or from another page, gets 403, and a write whose
`Content-Type` is not `application/json` gets 415. With `BUW_SITE_URL` unset or
malformed, every write is refused.

Who may write is who has passed the passkey check. The service has no login of its own: writes
need the `Remote-User` header that Nginx Proxy Manager sets after the check. Caddy locks the port to
match. Anything but GET, HEAD and OPTIONS is refused (403) unless the TCP peer is NPM
(its address is `NPM_IP` in Caddy's environment, such as `192.0.2.11`; with none set, every write from
the LAN is refused), and `Remote-User` is stripped from every
request that is not from NPM, so it cannot be forged from the LAN. With `REQUIRE_REMOTE_USER=1` the
service also answers 401 to a write with no header, and `/api/capabilities` reports the site
read-only, so a visitor on the LAN sees no controls. Reads stay open. On the LAN,
`http://192.0.2.35:4000` is read-only; writes go through the signed-in address (https://workspaces.example.net).

NPM must forward the header before the flag is turned on: in its proxy host, the
`proxy_set_header Remote-User $user;` line has to sit inside `location /`, because nginx drops
server-level `proxy_set_header` lines in a location that sets its own.

Locally, `npm run dev` proxies `/api`, `/sites.json` and `/w` to `127.0.0.1:8099` (or
`BUW_SITE_API`), so a service started by hand (`BUW_S3_BUCKET=my-cards node site/api/main.mjs`,
with the aws CLI's default profile) gives the preview exactly what the published site shows,
controls included.

### Development copy

A second, separate copy of the site runs a branch of this repository, so a change can be tried on the
real cards before it merges. It is its own stack, never a path on the real site: its own Caddy, its own
site-API container, its own site folder, and its own key, which can write only what is listed below.
It reads every real card section.

The same code serves both; these settings make the difference (all optional, and with none set the
service is the real one):

| Setting | Where | Real value | Development copy |
|---|---|---|---|
| `HUB_INBOX` | site API | `inbox` | `inbox-dev`. The Hub reads and writes this section only. It must be `inbox` or `inbox-<name>`, or the service refuses to start. |
| `BUW_STATE_KEY` | site API | `state.json` | `dev-state.json`: pins, archives and tags stay out of the real state. |
| `BUW_DEV` | site API | unset | `1`. Writes to a card section are refused (403) unless its id starts with `dev-`, and `/api/capabilities` reports `dev: { branch, sha, pr, at }`, read from the `.deployed-ref` file the deploy leaves beside `server.mjs`. The app shows a banner and prefixes its title with `[dev]`. |
| `BUW_INBOX_SECTION` | `cards` client | `inbox` | `inbox-dev`. Without an explicit `BUW_DISCORD_NEEDS_YOU`, no ping is sent, so a test item never sends a link to the real site to a phone. |
| `BUW_SITE_API` | Caddy | `buw-site-api:8099` | the dev container's name and port. |
| `BUW_COMPOSE_PROJECT`, `BUW_SITE_API_CONTAINER`, `BUW_DOCKER_NETWORK` | `publish-site-api.sh`, compose | `api`, `buw-site-api`, `buw-docs_default` | names of their own. Both stacks deploy from a folder called `api`, so without a project name compose would see one project and replace the real container. |

The card API accepts `inbox-dev` beside `inbox` with the same rules (answers and snoozes stay the
Hub's). Widening it needs `site/card-api/deploy.sh` once, from the PC.

Deploy a branch with the `publish-dev.yml` workflow of the deploy repository:
`gh workflow run publish-dev.yml -R <owner>/<deploy repo> -f branch=<branch>`. The copy's address is
`devUrl` in `~/.buw/hub.json`. Stacked pull requests each branch from the one below; deploy the tip of
the stack there before asking for review.

## The Hub

`HUB=1` in the site API's `api.env` turns on the Hub: `/api/hub/…` routes over the `inbox`
section of the cards bucket (`site/api/hub.mjs`). The local service serves the same routes over
its own bucket whenever it has one (`HUB=0` turns them off). `/api/capabilities` reports
`hub` and `chat`. Reads are open wherever the site is; writes need a signed-in
user (`Remote-User`), like every other write.

| Route | Does |
|---|---|
| `GET /api/hub/today`, `/inbox?filter=`, `/events?since=&project=`, `/projects` | What needs the owner, what runs, what happened (a seven-day window of events) |
| `GET /api/hub/asks/:id`; `POST …/answer`, `…/snooze`, `…/cancel` | An Ask and its state; answering writes `answer.json` once (a second answer is a 409 carrying the first); an answered Ask also carries `delivery`: where the answer went, from `delivered.json` and up to 3 `watch-*.json` (see below) |
| `GET /api/hub/checklists/:id` | A checklist: the list as the agent wrote it plus `state`, `done`, `total`, each item's `done` and `at`, `submit`, `pickup`, `cancel` and the `files` in its folder |
| `POST /api/hub/checklists/:id/items/:item` | `{ done: boolean }`: tick or untick one item. Writes one create-only `tick-` or `untick-` file; nothing when the item already is as asked; 409 unless the list is `open`. Answers with the fresh detail |
| `POST /api/hub/checklists/:id/files` | `{ for: "03" \| "issue", image: { type: 'image/jpeg' \| 'image/png', data: <base64> } }`: one picture for a step (evidence) or a playtest issue (screenshot), in the chat picture shape and with the chat limits: at most 1.5 MB decoded, 1 to 2048 px a side, the bytes checked against the type (WebP and GIF are 415), EXIF and GPS stripped. Writes one create-only `evidence-<step>-<stamp>-<rand4>.<jpg\|png>` or `shot-<stamp>-<rand4>.<jpg\|png>` in the list's own folder. 201 `{ file, at }`; 404 for a step the list does not have; 409 unless the list is `open`, beyond 5 pictures for a step or 30 screenshots; the body limit is 8 MB. The detail carries `evidence` (`{ "03": { file, at } }`, the newest per step) and `shots` |
| `POST /api/hub/checklists/:id/submit` | `{ note? }`: send the list back. Writes `submit.json` create-only (with the done and open item ids) and then a `checklist-submitted` event; 409 for a cancelled list, and for a second submit (the 409 carries the first `submit`) |
| `POST /api/hub/reviews/:id/done` | Hide a review in Needs you: writes a `review-done` event that names the `ready-for-review` event's file (`:id`); a second call writes nothing |
| `GET /api/hub/reviews/:id` | One review's detail, from its `ready-for-review` event in the last seven days (404 otherwise): title, summary, checked links, card files, screenshots in before/after pairs, verdicts, and whether it is `done` |
| `POST /api/hub/requests` | A request to an agent: `{ project, text, when, drawing? }`, or from Spawn `{ project, text, preset, title?, repo?, needs?, target?, doneWhen?, agent?, replaces?, drawing? }`: needs a signed-in user, stores `origin: { kind: owner }` (a body `origin` or `followUp` is ignored) and the routed `target`, and answers `{ id, target, why }` (see Requests) |
| `GET /api/hub/presets`, `/presets/route?preset=&project=&repo=`, `/presets/brief?request=` | The eight presets for the Spawn sheet (no templates) with the five routing rules; where a job would run (`{ target, rule, why }`); the rendered brief of a request the owner starts at the PC (400 for any other) |
| `GET /api/hub/requests/:id` | One request: `{ request, state, approved?, taken?, runs, result?, hermesRun?, retry?, fires, stop?, declined?, files, report }`. `runs` and `fires` are the newest 20 `run-*` and `fire-*` files, newest first; `approved` comes without `run.brief`; 404 for an id that is not a request |
| `POST /api/hub/requests/:id/approve` | `{ target? }`: sign `approved.json` (Ed25519, key `HUB_SIGNING_KEY`) and hand the request to its target. 201 `{ state, approved (without run.brief), waiting?, cloud? }`. 503 without a key, 400 for a target the preset does not allow, an `at-pc` request, a cloud run without a repo or a repo with no cloud routine (nothing is signed), 409 unless the state is `proposed`. No cap is checked: a full target makes the request wait in `approved` and `waiting` says why. For `cloud`, `cloud` is `{ fired, reason?, next? }` (`reason` `daily-cap` with `next` the owner's next midnight, or the failure of the fire); a failed fire is still a 201 and the approval stands |
| `POST /api/hub/requests/:id/fire` | Retry: fire the repo's cloud routine again. Needs a signed-in user (401). 200 `{ fired, reason?, fire }`. 409 unless the request is `approved` for `cloud`, when the newest ok fire is under 10 minutes old (it names the minutes), when today's cap is used (it names the reset time) or when the approval fails the server's own check (signature with the server's public key, `requestSha256` against the stored `request.json`, `expires`) |
| `POST /api/hub/requests/:id/stop` | `{ reason? }`: a signed `stop.json`, in `approved`, `expired`, `taken`, `running` or `lost`; a Hermes run is stopped too |
| `POST /api/hub/requests/:id/again` | `{ target?, text?, title? }`: for an `expired`, `failed`, `lost` or `proposed` request. Makes a new request that `replaces` it, approves that one, and retires the old: a proposal gets `declined.json`, the others a signed stop naming the new id. Answers `{ id, state, approved, waiting? }` |
| `GET /api/hub/requests/:id/events` | Server-sent events of a Hermes request run: `message.delta`, `tool.started`, `tool.completed`, `approval.request`, `approval.settled`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`, then `state { state }` and the end. The site's follower feeds it (recent events are replayed); closing the page never stops the run. 409 when the request has no Hermes run; a finished request answers `state` at once |
| `GET /api/hub/hermes-approvals/:id` | One Hermes approval: `{ approval, answer?, state }` (`open`, `answered` or `expired`) |
| `POST /api/hub/hermes-approvals/:id/answer` | `{ choice: once \| deny }`: forwards the answer to the Hermes run, then writes `answer.json` `{ choice, at, by, forwarded: true }`. Needs a signed-in user. After the 5 minutes, or when the run has ended, or when Hermes no longer waits, it writes `forwarded: false` with the reason and answers 409. A second answer is 409 |
| `POST /api/hub/requests/:id/answer-run` | `{ text }` (1 to 2000 characters): answers a Hermes run that ended with a question (state `asking`). First claims the old request with the signed stop `answered by <new id>` (create-only, so of two answers at once one gets 409 and only one run starts), then makes a new request that `replaces` it with `followUp { from, question, answer, summary }` and `textOrigin` (who wrote the job text: an answer does not make the owner its author), and approves it for Hermes. In the brief only `answer` follows "The owner answered:"; the run's question and summary are quoted line by line and labelled as not the owner's words. Without a signing key the new request stays a proposal and the old one stays as it is. If starting fails after the claim, the new request stays a proposal with the answer kept in it. 409 in any other state, so a second answer is refused. "Close" is `…/stop`, which is allowed in `asking` |
| `POST /api/hub/requests/:id/decline` | `{ reason? }`: writes `declined.json` create-only. Only a request nobody has acted on (`open`, `proposed`, `expired`); anything else is 409 |
| `POST /api/hub/requests/:id/done` | `{ summary? }`: Mark done for a request the owner runs at the PC (`target: at-pc`). Writes `result.json` with outcome `manual`; 400 for any other request, 409 once it has a state past `proposed`. Not signed |
| `GET /api/hub/beads/:project`, `/map/:project` (and `POST /map/:project/marks`, see the owner's marks) | The Beads copies of the project merged (see Beads copies), and the progress map built from them |
| `GET /api/hub/file?path=`, `/drawings`, `/drawings/:id`; `POST /drawings[/:id]` | Ask and drawing files, and Sketch drafts |
| `GET /api/hub/discord/asks`, `POST /api/hub/discord/answer` | The Asks bot only, with its own bearer token and no `Remote-User` (see Answers from Discord) |
| `GET /api/hub/chat`, `/chat/:id` | The newest 30 conversations, and one conversation's lines. Chat needs `HERMES_URL` and `HERMES_API_KEY`, and a signed-in user where writes need `Remote-User` (503 when off, 401 without a user) |
| `GET /api/hub/chat/:id/images/:file` | A picture sent in a conversation, behind the same chat gate (not `/hub/file`). `Cache-Control: private`, `nosniff`, sandboxed |
| `POST /api/hub/chat` | `{ conversation?, text, images? }`; the reply streams back as server-sent events (`started` with the run id on a Hermes run, `delta`, `created`, `done` with the saved user line, `error`). A run outlives its browser: when the page goes away Hermes finishes and the reply is saved to the conversation. `images` is up to 4 `{ type: 'image/jpeg' \| 'image/png', data: <base64> }`, each at most 1.5 MB decoded, 5 MB together, 1 to 2048 px a side; the bytes are checked, metadata (EXIF, GPS) is stripped, and `text` may be empty with a picture. They reach Hermes as `image_url` data URLs and are stored beside the conversation as `chat/<id>/<file>`. If Hermes refuses them: 422, nothing saved. The body limit is 7 MB |
| `POST /api/hub/chat/stop` | `{ run }`: ends a reply that this relay is carrying (the `run` from `started`). 404 for any other run, 401 without a user, and the usual Origin check. A closed page is not a stop |

Voice input was removed on 2026-10-29; see git history to bring it back.

A blocked session stays in Needs you until any later event from the same session arrives (a
`resumed`, a `session-ended`, a newer `blocked`, anything that carries the session); the mod posts
`resumed` when a blocked session moves on. A `blocked` event may carry `url` (a Remote Control link
into the session; the bare `https://claude.ai/code` counts as no link) and `appUrl` (the desktop
app's `claude://claude.ai/epitaxy/local_<uuid>`). With no `url` the row says to open the Claude app.

A `ready-for-review` event may also carry `prs` (GitHub pull request links), `cardDir` (`<section>/<card folder>`), `cardFiles` (`.md` paths inside that folder, such as `briefs/x.md`), `screenshots` (https image links), `deployUrl` (an https build link) and `verdicts` (`{ leg: smoke|review|qa, result: pass|fail|noted, text }`, at most three). The review view (`#/~hub/review/<file>`) checks each field again, shows what is there and an empty line for what is not, and reads the card files from the site's `/w/<cardDir>/<path>`. On the local service, which has no `/w/` route, a file shows as not here and the view offers the card instead.

### Cloud runs

The routine a cloud request fires, its environment and its fixed prompt are in [Cloud routines](cloud-routines.md).

### Requests

A request is a folder `requests/<id>/` in the inbox. Every file in it is create-only. The state is never
stored: it is the first row below that matches the files, so it cannot disagree with them. A request
without a `preset` is a legacy one (`when` set, no approval) and is only ever `open`, `taken` or `declined`.

| File | Written by | Holds |
|---|---|---|
| `request.json` | the site API, or an agent through the card API | `id`, `project`, `createdAt`, `by`, `text`, and `when` or `preset`; optional `title` (120), `repo`, `needs` (`unity`, `gpu`, `comfyui`, `sprite-studio`, `lan`, `local-files`), `target` (`pc`, `cloud`, `hermes`, `at-pc`: the proposal), `doneWhen` (400), `agent` (the agent an avatar job is for), `fromAsk`, `choice` and `subject` (the avatar sheet request only; site API only), `origin` (`{ kind: owner \| agent \| run, name }`), `replaces`, `followUp`. `origin.kind: owner` and `followUp` come only from the site API |
| `approved.json`, `stop.json` | the site API | the signed approval and the signed stop |
| `taken.json` | the runner | who took it and when |
| `run-<stamp>.json` | the run | a progress line; the newest decides whether it still runs |
| `fire-<stamp>-<rand4>.json` | the site API | one cloud-routine fire attempt: `{ v: 1, at, routine, ok, status, session?, sessionId?, reason?, dryRun?, by: hub \| sweep }`. Create-only, one per attempt, so a fire that answered 200 and started nothing can be tried again. `reason` is `network`, `timeout` or `http-<code>`. The routine's URL and token are never written anywhere |
| `hermes-run.json`, `hermes-retry.json` | the site API | the Hermes run, and the one retry on quota |
| `result.json`, `report.md` | the run (`hub` for Hermes and `at-pc`) | `outcome` (`pr`, `card`, `failed`, `manual`, `question`, `unknown`), `summary`, `question` (600) when it asks; the report is Markdown up to 256 KB, served at `/api/hub/file?path=requests/<id>/report.md` |
| `declined.json` | the site API | `{ at, by, reason? }` |

| # | State | Rule |
|---|---|---|
| 1 | `declined` | `declined.json` |
| 2 | `stopped` | `stop.json`, and (`result.json`, or not taken, or lost by row 7) |
| 3 | `stopping` | `stop.json`, taken, no `result.json` |
| 4 | `asking` | `result.json` with outcome `question` and no `stop.json` |
| 5 | `failed` / `done` | `result.json`: `failed` when the outcome is `failed`, else `done` |
| 6 | `running` | taken, and the newest `run-*` is under 20 minutes old, or a Hermes follower is on it, or the PC report shows its session busy |
| 7 | `lost` | taken more than 20 minutes ago, and not running |
| 8 | `taken` | taken |
| 9 | `expired` | `approved.json` past its `expires` |
| 10 | `approved` | `approved.json` |
| 11 | `proposed` | has a `preset`, none of the above |

Presets live in `site/api/presets.mjs`, in code, so no inbox token can rewrite a template: `code-task`, `docs`,
`research`, `market-research`, `game-teardown`, `playtest-build`, `sprite-set`, `agent-avatar`, and the hidden
`agent-avatar-sheet`, which only the Hub starts (after the owner picks a variant) and a request body cannot name. A run is never
longer than `MAX_RUN_MINUTES` (120): research kinds and `agent-avatar` 30, `docs` 60, the rest and `agent-avatar-sheet` 120. Hermes
presets have `model: null` and the site never sends a provider or model on an ordinary run. The target
comes from the first matching rule: (1) project `bunnylink` is `at-pc`; (2) the preset or request needs
something only the PC has: `pc`; (3) research: `hermes`; (4) the project's `runsOn` in
`project-defaults.mjs` is `pc`: `pc`; (5) a repo is known: `cloud`, else `pc`. A result outside the preset's
targets becomes its first target, and `cloud` without a cloud routine for the repo becomes `pc`.

Signed files (`approved.json`, `stop.json`) carry `signature`: base64 Ed25519 over the canonical JSON of the rest
of the file (keys sorted at every depth, no whitespace). `approved.json` holds `request`, `project`, `repo`,
`target` (never `at-pc`), `requestSha256` (of `request.json` as stored), `limits.minutes` (at most 120), `expires`
(72 hours on), `nonce`, `at`, `by` and a `run` block (`preset`, `model`, `permissionMode`, `opensWindows`, `allow`,
`brief`). The private key is made on the site server and never leaves it; runners keep the public key.
`site/api/test/fixtures/signing-vector.json` is a signed sample made with a throwaway key for every verifier to
check against. `/api/capabilities` reports `approve` (a key and a signed-in user), `approveReason` and `policy`.

Hermes runs (`hermes-dispatch.mjs`, `hermes-follower.mjs`, `hermes-runs.mjs`, `run-outcome.mjs`). Approving a
`hermes` request writes `taken.json` (`runner: hermes`), starts a run with `{ input: run.brief }` and the request id
as idempotency key (no provider, no model: Hermes's own default and fallback chain apply), writes
`hermes-run.json`, and follows the run in the site API process, so `report.md` and `result.json` are written even
with no page open. A run that ends `completed` with a `CARD: assistant/<folder>` line is outcome `card`; without
one it is `failed` ("finished without a card"). When Hermes drops a run's event buffer (a few minutes after the last
reader) the follower polls the status instead; only a 404 on the status ends the request `unknown`
(`hermes-forgot`, pointing at the newest `assistant` card made after the start). A run that fails with `429` or
`quota` in its error is started once more on Anthropic (`HERMES_RETRY_MODEL`, default `claude-sonnet-5-5`, key
`<id>-retry`), recorded in `hermes-retry.json`; a second quota failure is `failed` with reason `usage-limit`. The
follower stops a run at `limits.minutes` (`time-limit`). At most 3 Hermes runs go at a time: a fourth approval is
signed and waits in `approved` (`waiting` in the answer); a run that ends, and a sweep every 60 s, start the oldest
waiting one. After a restart, the hub and the page loads (at most once per 30 s) re-attach to every run without a
result. `HERMES_URL` and `HERMES_API_KEY` must be set; without them an approval waits.

Hermes approvals: Hermes asks before it writes a protected instruction file (in practice the only thing that asks in
Hermes's sandbox). Each ask becomes `hermes-approvals/<yyyymmdd>-hermes-<4>-<4>/approval.json` (`runId`, `requestId` and
`promptId` = Hermes's prompt id, `executionGeneration`, `request`, `chat`, `title`, `detail`, `command`,
`description`, `choices`, `createdAt`, `expiresAt` = 300 seconds on). The id comes from a hash of the run and the
prompt, so a replayed event writes nothing and pings nothing. `#needs-you` gets one ping per approval, ending
"Answer within 5 minutes." (`HUB_DISCORD_NEEDS_YOU`, silent without it). An open approval is a Needs you row of kind
`hermes-approval` (needs kind `approval`, label "Hermes approval"); it leaves when it is answered, when its run
has a result, or at `expiresAt`, because Hermes denies it on its own after 300 seconds.

Run questions: Hermes clarify stays off, so a run asks by ending its output with a question. When a run is `completed`
with no `CARD: assistant/<folder>` line and its last paragraph (after the last blank line, Markdown emphasis removed)
ends in `?` and is at most 600 characters, `result.json` has outcome `question` with that `question` and a `summary` (the
first 500 characters of the output); the state is `asking` and the request is a Needs you row of kind
`run-question` ("Hermes asks"). A `CARD:` line always wins, and Chat turns never use this rule.

A copy the owner approves keeps who wrote the text (`textOrigin`) and, separately, who wrote the "done when" (`doneWhenOrigin`): rewriting the text does not make an agent's "done when" the owner's, and the signed brief marks it as written by that agent, on one line. Only a "done when" the owner changes carries no mark.

Policy approval (`policy.mjs`, off by default): `HUB_POLICY_APPROVE` is a comma list of preset kinds, `research` and/or
`docs` (anything else is ignored; the tap stays for code, build and art). With a signing key and at least one kind, the
site API signs eligible proposals by itself: at start, every 60 seconds, and on page loads (at most every 30 seconds).
It signs through the same path as a tap, for the target the request already proposes, with `by: "policy"`, so a full
Hermes or cloud target makes the request wait. Who is eligible is decided from the object's user metadata `writer`,
which the writer's token sets and the body cannot: `site` (the site API wrote it; the body says `origin.kind: owner`) or
`agent` (the card API wrote it for an agent session's token; the body says `origin.kind: agent`). A request with no
origin, no `writer`, a `writer` of `runner` or `hermes`, or a body that disagrees with its writer is never signed by
policy and waits for a tap, so no run starts runs unattended. `HUB_POLICY_PER_DAY` (default 10) limits the policy
signatures per Pacific day (`America/Los_Angeles`), counted from the day's `approved.json` files with `by: "policy"` (a
tap does not count); over it a proposal stays with the note "Policy limit reached today" and a tap still signs it.
`/api/capabilities` `policy` lists the active kinds. Until the card API leaves `writer: agent` on an agent session's
`request.json`, only the site's own requests are signed.

Cloud runs (`routines.mjs`): a repo has a cloud target when the site API's environment holds the pair
`CLAUDE_ROUTINE_<REPO_KEY>_URL` and `_TOKEN` (`REPO_KEY` is the repo's name part in capitals with every other character
as `_`: `owner/my-repo` is `MY_REPO`). A half pair is logged once by key name and ignored. `CLAUDE_ROUTINE_<REPO_KEY>_REPO=owner/name` is required: the routine serves only that exact repo. Without it the routine is refused (fail closed): nothing is sent, the fire record has `reason: routine-repo-unset` and the log says which key is missing. Approving a cloud request signs
it, then fires the routine with one POST whose body is exactly `{"text":"<request id>"}` (the routine fetches the signed
approval itself), unless today's count of ok fires has reached `HUB_CLOUD_DAILY` (default 10): then the request waits in
`approved`. A day is the owner's day in `HUB_TIME_ZONE` (an IANA name, default `UTC`). Every attempt is one
`fire-<stamp>-<rand4>.json`. Retry (`POST …/fire`) checks the approval again with the server's own public key before it
fires. `HUB_ROUTINE_BETA` overrides the beta header. `HUB_ROUTINE_DRY_RUN=1` makes every repo count as having a routine
and sends nothing; the record carries `dryRun: true`, and it wins over real keys. The URL and the token are never logged
or stored. `/api/capabilities` `cloudRepos` lists the repo keys that have a routine.

The cloud fire queue (`routines.mjs`, `sweep()`): any valid approved cloud request is fired, however it was signed (a tap,
a policy signature written straight to the bucket, a wait at the cap or after a 429). The sweep runs at start and every
5 minutes (only with a routine key or the dry run, and a signing key), never twice at once. Candidates are approved, not
taken, stopped, declined or finished, with no ok fire; the oldest approval goes first. Before a fire the sweep checks the
approval with the server's public key (signature, `requestSha256` against the stored `request.json`, `expires`); a
failure writes nothing, logs `skip <id>: <reason>` and raises a Today alert "Approval for <title> failed the server's
check". At the daily cap a request waits until the owner's next midnight. A 429 from the Fire URL, or a request whose
`result.json` has `reason: usage-limit`, pauses every cloud fire for 60 minutes (held in memory; a restart costs at most
one more 429). A fire that failed is tried again 5, 15 and 45 minutes after the attempt before it, then the request
stops and shows Retry; a 4xx other than 429 stops it at once. A 429 costs no retry. An ok fire 20 minutes old with no
`taken.json` or `result.json` is "fired, not started": a Today alert with Retry, and never an automatic second fire.
Request detail and list rows carry `cloud: { status, reason?, next? }` for an `approved` cloud request (detail adds
`fires`): `status` is `queued`, `fired`, `waiting` (`daily-cap`, `usage-limit` or `retry`), `fire-failed` or `not-started`.

Move to the cloud: a request approved for the PC, not taken, that has waited 6 hours is offered on Today (`offers` in
`GET /hub/today`; list rows carry `offer: "move-to-cloud"`). It must use a preset that allows the cloud, need nothing only the
PC has, have a repo with a routine, and not be in the `bunnylink` project or in `HUB_CLOUD_NEVER` (comma-separated project
names, empty by default). The old approval is checked first (this host's signature, this request, target `pc`, not expired,
and on the route the hash of `request.json`): an approval signed by another key is never offered or re-signed.
`POST /hub/requests/:id/move-to-cloud` (signed-in user) is Approve again with the cloud as the target, in this order: the old
request's signed stop `moved to the cloud: <new id>` is written first (create-only, so it is the lock: a PC take before it, or a
second move from any process, gets a 409 and nothing is made), then the new request that `replaces` it is made under that id,
signed and handed to the fire queue (the daily cap and a pause apply, and a move at the cap waits). If that second part fails the
old request stays stopped and the owner approves the work again by hand. `request take --runner` refuses (exit 5) a request with
a stop, a decline or a result, before the claim and again after it.

Wake the PC (`site/api/pc-wake.mjs`): `GET /hub/today` and `GET /hub/pc` carry `wake: { state, wakeAvailable }`. The state comes
from the newest `pc/status-*` and `pc/wake-*` files only (nothing probes the PC): `awake` (a status in the last 12 minutes),
`woke` (a status newer than a wake of the last 30 minutes), `waking` (a wake under 5 minutes old, no status since), `off` (a
wake 5 to 60 minutes old, no status since) and `asleep-or-off`. `POST /hub/pc/wake` (signed-in user, Origin check) posts an empty
body to the secret `HUB_WAKE_URL` with a 10 s limit, writes `pc/wake-<stamp>.json` `{ at, by }`, and answers 429 inside a
minute of the last wake, 404 when `HUB_WAKE_URL` is unset (the kill switch) and 502 when the controller did not take the call.
No answer, log line or file holds the URL. With `HUB_WAKE_ON_APPROVE=1`, Approve of a `pc` request sends the same wake when
the state is `asleep-or-off`; the approval never fails because of it, and the answer carries `wake: "sent"` when one went.

A `proposed` request is a Needs you row of kind `approval`. `failed`, `lost` and `expired` requests
appear in Today's alerts for a day. `src/lib/needsKinds.ts` and `hub-model.mjs` hold the kind rules.

### Beads copies

Every worktree pushes its own Beads export (`cards beads push --project <p>`, run in the worktree), so a stale checkout cannot roll the roadmap back. The inbox holds:

```
beads/<project>/<copy>.jsonl       bd export output, one issue per line
beads/<project>/<copy>.meta.json   { v: 2, pushedAt, host, count, repo, worktree, main, root, branch }
beads/<project>.jsonl + .meta.json  the older single copy: still read, never written again
```

`<copy>` is `<host>-<first 10 hex of sha256 of the worktree root>`: the root is lower-cased with forward slashes, so one worktree always writes the same copy. A hash stands in for the worktree name because the card API refuses a `.json` file whose name contains `token`, `secret`, `password` or `credential`. `--copy <id>` names the copy by hand. `root` is for the hub-hooks mod's own clean-up and is not shown in the UI.

The site reads the newest 30 copies of a project (by `pushedAt`) and the older single copy, and keeps for each issue the version with the greatest `updated_at` (a missing or bad date is oldest; a tie goes to the later push). `meta` is the newest copy's `pushedAt`, `host` and `repo` plus `count` and `copies` (`copy`, `host`, `worktree`, `main`, `pushedAt`, `count` for each). A project with only the older file answers as before, with its own `meta`. A project is listed when it has any copy. An issue removed with `bd delete` stays in other copies until they are pruned.

### The owner's marks on the Roadmap

A task that waits on the owner (yellow on the Roadmap because of the `needs-owner` label) with no Ask and nothing in Needs you has **Mark done** and **No longer needed** on its sheet. The Hub cannot run `bd`, so the mark is a log of create-only files, one folder per issue, and the Roadmap and Work show the issue as closed until Beads says so itself:

```
bead-marks/<project>/<bead id>/<stamp>-<verdict>-<rand4>.json
  done | not-needed | undo   the Hub only (POST /api/hub/map/:project/marks, signed in): { v: 1, project, bead, verdict, at, by, reason? }  (reason: not-needed only, 200 characters)
  applied                    an agent, after bd close: { v: 1, project, bead, verdict: "applied", at, by: <host>, mark: <file it applied>, session? }
```

The current verdict is the newest of done, not-needed and undo. A mark is **active** when that verdict is done or not-needed, no `applied` file names it, and the merged Beads issue is not closed. An active mark only ever turns an open issue closed on the map and in Work (`/hub/beads/:project` stays the raw export); it stops by itself when Beads shows the issue closed or an `applied` file exists, so a push that still has the issue open changes nothing. The route refuses a task with an open or snoozed Ask (409), one with an item in Needs you (409), one that is not waiting on the owner (409) and a closed one (409); a repeat of the active verdict is a 200 that writes nothing; undo after an agent applied it is refused (reopen it with `bd reopen`). The card API (rule from PR #121, deployed 2026-10-30) keeps `…-done|not-needed|undo-….json` to the Hub (`OWNER_FILES`), lets an agent put only the `applied` note, create-only, and tags everything it writes there `x-amz-meta-writer: card-api`; the Hub already ignores a verdict with a writer. Until then an agent token could still write a verdict file.

**Applying marks (agent side).** In a session in that project's repository, for each mark listed by `cards mark list --project <p>`:

1. `bd show <id>`. If it is open: `bd close <id> --reason "Done (owner, Roadmap <date>)"`, or for no longer needed `bd close <id> --reason "Not needed (owner, Roadmap <date>): <reason>"` and `bd update <id> --add-label not-needed`; then `bd export -o .beads/issues.jsonl` and commit it with the session's work, as that repository's rules say.
2. `cards mark applied --project <p> --bead <id>` (prints `nothing to apply` and exits 0 when no mark is active). If the issue was already closed, only this step is needed.

The `bd close` is what the hub-hooks push sends, so the Roadmap shows the real close within a minute. `BUW_INBOX_SECTION=inbox-dev` points both commands at the development inbox.

### Checklists

A checklist is a set of steps only the owner can do, posted by an agent (`cards checklist create`) and ticked one at a
time on the phone: Inbox, **To do**, open the list, expand a step to read its guide (Markdown, commands with a Copy
button, links), tick it, and press **Submit** when done. Everything is under `sections/inbox/checklists/<id>/` and is
written create-only; nothing is ever overwritten or deleted. `<id>` has the Ask shape
(`<yyyymmdd>-<project>-<slug>-<rand4>`).

| File | Writer | Meaning |
|---|---|---|
| `checklist.json` | agent | The list (title, `context?`, `card?`, `bead?`, `from`, `items`: `{ id: "01"…"50", text, group?, guide?, link? }`). Written once. Limits: 1 to 50 items; text 200, group 80, guide and context 4000 characters; links are `http(s)`; 256 KB |
| `tick-<item>-<stamp>-<rand4>.json`, `untick-…` | Hub only | The owner ticked or unticked item `<item>` at `<stamp>` (UTC with milliseconds, `20261027T143012123Z`, the Hub's clock). Body `{ item, done, at, by }` |
| `submit.json` | Hub only | `{ at, by, note?, done: [ids], open: [ids] }` |
| `evidence-<step>-<stamp>-<rand4>.jpg\|png`, `shot-<stamp>-<rand4>.jpg\|png` | Hub only | The owner's picture for step `<step>`, or for a playtest issue. The newest evidence file per step is the one shown; the card API refuses an agent writing or deleting them, and `cards checklist get <id> --into <dir>` downloads them. Served by `/api/hub/file?path=checklists/<id>/<file>` (only these names) |
| `pickup.json` | agent | The agent read the submission and acted on it (`{ at, host, session? }`) |
| `cancel.json` | agent | The agent withdrew the list (`{ at, by }`) |

State comes from file names alone, so a folder listing is enough. The list's state, first match winning: `cancel.json`
is `cancelled`, `pickup.json` is `picked-up`, `submit.json` is `submitted`, else `open`. An item is done when its
mark file with the greatest stamp in the name (the greater `<rand4>` on a tie; never S3's `LastModified`) is a `tick`.
Progress is the done items over `items.length`. An `open` list is in Needs you even when every item is ticked, because
Submit is the hand-back; the Inbox's **To do** filter lists every list but the cancelled ones, open first. Ticking
after Submit is refused (409), so the agent acts on what was submitted. A list is found while its id falls in this
month or the last, like an Ask.

Two events go to the Activity feed: `checklist-created` (from the CLI) and `checklist-submitted` (from the Hub, after
`submit.json`). Nothing derives a checklist's state from events. The card API refuses ticks, unticks and `submit.json`
from a limited token (they are the Hub's) and lets one create `checklist.json` only with `If-None-Match: *`.

### Design reviews

An Ask is a **Design review** when its `ask.json` has `decisions`, an `image`, or an option with an `image`. Needs you
shows it as its own kind (picture left, decisions right), and it never gets Discord buttons (`discordEligible()` refuses it).

```json
{
  "image": "card-wood-v2.png",
  "decisions": [
    { "id": "d1", "text": "Frame: warm oak, not dark walnut", "detail": "Matches the Wood board" },
    { "id": "d2", "text": "Stack counter in the top-right corner" }
  ]
}
```

- `image`: a file name in the Ask's folder (letters, digits, `.`, `_`, `-`; at most 120 characters), shown at the left and the
  background of the owner's drawing.
- `decisions`: 1 to 10, ids `d1`..`dN` in order, `text` 1 to 200 characters, `detail` at most 500. A malformed `decisions`
  or `image` is dropped when the Ask is read, so it shows as a plain Question (one log line per Ask).
- An Ask with options that have pictures and no decisions is the **pick** variant: a 2x2 grid, one option chosen.
- The answer gains `decisions`: `{ "d1": { "verdict": "approve" }, "d2": { "verdict": "change", "note": "Bottom-left" } }`.
  When the Ask has decisions every id needs a verdict (`approve`, `change` or `skip`); a `note` is at most 1000
  characters. `choice`, `note` and `drawing` keep their meaning.

### Playtests

A checklist is a **Playtest** when its `checklist.json` has `"kind": "playtest"`. Needs you shows it as its own kind: the build link, the
steps to try, what to look for, and a report.

```json
{ "kind": "playtest", "build": "https://example.test/build", "platform": "web", "lookFor": "Any moment where it gets hard all at once." }
```

- `build`: an `https://` link of at most 2000 characters, required. `platform`: `web` (default), `windows`, `mac`, `linux`, `android` or
  `ios`. `lookFor`: at most 2000 characters. A list that is not a playtest takes none of these.
- The items are the "what to try" steps and tick as in any checklist.
- `submit.json` of a playtest also holds `rating` (1 to 5), `verdict` (`ship`, `fix-first` or `rethink`) and `issues` (up to 30 of
  `{ text, shot? }`, `text` 1 to 500 characters, `shot` a `shot-...` picture already stored in the folder through `POST .../files`
  with `for: "issue"`). A playtest needs `rating` and `verdict`; a steps list refuses all three (400 "Only a playtest takes a rating.").
- The `checklist-submitted` event's summary reads "Rating 4/5 · Fix first · 2 issues".

### Answers from Discord

A simple multiple-choice Ask also arrives as a Discord direct message with one button per option, and a
click records the choice in `answer.json` with `via: "discord"`. The Hub then shows "via Discord". Notes,
drawings and Asks that require a passkey stay in the web app. The bot is `site/asks-bot/`; it runs as a
container beside the site API and calls it over the Docker network. Nothing here is on by default: both
`HUB_DISCORD_TOKEN_SHA256` and `HUB_DISCORD_OWNER_ID` must be in `api.env`, or the two routes answer 404.

**Trust model.**

- Discord interactions that reach the bot over the gateway are not signed, so the server cannot prove that a
  click happened. It trusts whoever holds the narrow bot token. The token lives only on the server that
  already holds the bucket keys.
- The token opens exactly two routes: list the open Asks that qualify (each with a `rev`), and record one
  `choice` on one open Ask that qualifies, as the owner, once. It writes nothing else: every other route ignores
  `Authorization`, and with `REQUIRE_REMOTE_USER=1` their writes still get 401. A passkey session cannot use these
  two routes either.
- The bot sets the `user` field of a click, and the server compares it with `HUB_DISCORD_OWNER_ID`. That check
  catches a bug in the bot, not a thief who holds the token.
- Each listed Ask carries a `rev`, the first 16 hex characters of the sha256 of its `ask.json`. The click sends it
  back and the server reads `ask.json` fresh. If the Ask changed since the message was posted (a relabelled option, a
  `requirePasskey` set later) the answer is a 409 and nothing is written. `answer.json` stays create-only, so a
  double click, a replay or a race with the web app keeps the first answer.
- The bot raises an alarm when an Ask is answered `via: "discord"` with an interaction id it did not send. The alarm only covers Asks the bot posted: a stolen token answering an Ask the bot never posted raises none.

**Which Asks qualify.** `discordEligible()` in `site/api/hub-model.mjs` is the only place the rule lives: 2 to 5
options, each with a label of 1 to 80 characters and no picture, no drawing, and `requirePasskey` is not `true`.

**Rerun Asks.** The PC watcher asks "run it again" for a run it saw denied a tool call, and for a run that ended before its own Ask was answered. Such an Ask carries `rerun`: `{ request, kind: 'denied' }` or `{ request, kind: 'continue', ask }`, always with `requirePasskey`. `cards ask create` refuses a malformed `rerun` and names the field. The field is only a pointer, and the Hub (`site/api/hub-rerun.mjs`) acts on a web answer only: the Discord route never reaches it, an Ask without `requirePasskey: true` is refused, and "Keep it denied" or `drop` write nothing. The request must be the Hub's own for the PC (`approved.json` verifies with the server key, covers the stored `request.json`, target `pc`), in the Ask's project, in state `failed`, `lost` or `expired`, and never Bunnylink. The answer makes one copy under a fixed id, `<the request id>-<4 hex of a hash of it>`, owner origin, `replaces` the original, `fromAsk` the Ask, approves it through the same signing path as Approve (new nonce, new hash) and gives the original a signed stop `run again as <copy>`, so a second Ask, a second answer or a retry meets the one copy ("Already approved again as ..."). Something else at that id counts only when the site wrote it as the owner's rerun of the same request. If the approval fails the copy stays `proposed` (one tap in Needs you) and the next answer finishes it. For `continue` the Hub reads the run's own Ask (`ask`, same project, `from.request` the run) and signs its question and the chosen option's label (plus the note) into the copy as `followUp`; the continue Ask's own copies of them are ignored. The answer response carries `rerun: { started, request?, kind?, already?, message?, why? }`; a failed rerun never undoes the answer. Nothing here reuses an old approval: the PC verifies the copy like any other.

**Avatar Asks.** The Agent avatar runs make two kinds of Ask, both with `requirePasskey`. `ask.json` may carry `avatar`: `{ agent, request, subject? }` for the pick of one of four variants (options `a` to `d`, with pictures), or `{ agent, sheet }` for the check of a finished sheet (options `use` and `skip`). `cards ask create` refuses a malformed `avatar` and names the field. The field is only a pointer: the Hub checks the request or the sheet itself before it acts on an answer. Answering a pick (web only) makes one request, `<the avatar request id>-<4 hex of a hash of it>` with preset `agent-avatar-sheet`, owner origin, the agent, the pick and the subject, and approves it with the same signing path as Approve: the pick's request must be an `agent-avatar` request for the same agent whose `approved.json` verifies with the server key, covers its `request.json` as stored, and carries that preset, and the Ask must require a passkey. So an avatar request starts at most one sheet run, whichever Ask names it. The avatar request must not be stopped or declined, and the `subject` must be a plain path (letters, digits, spaces and `. _ / : -`). A second answer is a 409. If something is already at that id, it counts only when the site wrote it (request metadata), for the same agent: a proposal whose approve failed is finished by the next pick, an approved one for the same Ask is reported as started, anything else starts nothing ("That request id is taken"). `approve` refuses a hidden-preset request the site did not write. Answering `use` on a sheet check writes the owner's avatar choice through the same code as `POST /api/hub/team/:agent/avatar`; `skip` writes nothing. The answer response carries `avatar: { started, request?, message?, why? }` or `avatar: { chosen, sheet?, why? }`; a failed check never undoes the answer.

**Where the answer went.** The `hub-hooks` mod leaves two agent-written files in an Ask's folder, both create-only: `watch-<first 8 of the session>.json` (`{ v: 1, session, host, folder, project, at, url?, appUrl? }`, the session that posted the Ask and watches it) and `delivered.json` (`{ v: 1, at, session, host, how }`, `how` one of `turn`, `woke`, `prompt`, `next-session`, `start`). They are not the owner's, so the Hub validates every field (strings up to 120 characters, ids `[A-Za-z0-9_-]`, links only `https:` or `claude:`, anything else dropped) and the Ask view labels them "reported by" the host. `GET /api/hub/asks/:id` returns `delivery` for an answered Ask (`deliveryOf` in `site/api/hub-model.mjs`): `{ state: 'delivered', how, at, host?, folder?, session? }`, `{ state: 'watching' | 'stale', minutes, host?, folder?, url?, appUrl?, watchers }` (`stale` from 5 minutes after the answer) or `{ state: 'none' }`. The Ask view shows one line under the answer, and none once the Ask is picked up.

**Requiring a passkey.** An Ask opts out with `"requirePasskey": true` in `ask.json`, or `cards ask create
--require-passkey`. Set it on every Ask that approves a merge, a deploy, spending, a deletion or secrets. A writer
that forgets the flag fails open, so the bot is not started until the skills and the assistant set it. The Hub marks
such an Ask "Passkey only". The card API makes `ask.json` create-only for limited tokens (a replace, an upload URL or a
delete is refused), so an agent cannot rewrite an Ask after the owner was shown it; limited tokens also cannot delete
Hub answer files.

**Data leaves for Discord.** An Ask's question and option labels reach Discord's servers. Do not put secrets in an Ask.

**Kill switches, in this order.**

1. Stops a stolen bot token: remove `HUB_DISCORD_TOKEN_SHA256` and `HUB_DISCORD_OWNER_ID` from `api.env` and restart the
   site API (the homelab repo has a script for it, `asks-bot-env.sh --off`). Both routes then answer 404 to everyone.
2. Stops the bot: `docker compose down` in the bot's folder on the server.
3. Reset the bot token in the Discord Developer Portal and make a new narrow token with `node site/asks-bot/new-token.mjs`.

Reverting this feature leaves every existing `answer.json` valid; without the label code the Hub shows those answers as "by owner".

Everything the Hub writes goes under `sections/inbox/` and nowhere else; `inboxKey()` in
`hub.mjs` builds every key it uses. State is derived from the files that exist (an Ask with an
`answer.json` is answered), never stored. The keys of `api.env` that belong to the Hub: `HUB`,
`HUB_DISCORD_TOKEN_SHA256` and `HUB_DISCORD_OWNER_ID` for the Asks bot, and for chat `HERMES_URL`, `HERMES_API_KEY`, `HERMES_MODEL`.

## Making a new workspace

In the local app, open the switcher under the logo and choose **＋ New workspace…**. It makes
a folder beside the open workspace with the template files and an empty card list, registers
it, and gives it the bucket and site of its neighbours with its own id in place of theirs, so
`npm run publish` puts it on the site. **Add existing folder…** registers a folder you already
have.

By hand:

1. **Create the folder** by copying the app's `workspace/` template files: `_config.yml`,
   `Gemfile`, `Gemfile.lock`, `docker-compose.yml`, `index.md`, `_shared/`, `_sass/` and
   `.gitignore`. Leave the sample cards behind.
2. **Start an empty card list:** a `workspace.json` with
   `{ "name": "<Name>", "entities": [] }`. The optional `name` is what the published site's
   switcher shows; without it the site falls back to the id in title case.
3. **Register it:**
   `npm run workspace add <folder> --name "<Name>" --bucket s3://<bucket>/sections/<id> --site https://<your-site>/<id> --use`.
   The app cannot work out `--site` on its own; without it a workspace can look unpublished
   while its site is fine.
4. **Check it:** `npm run publish`, then open the site and confirm the workspace is in the
   switcher.

Or start it from the site's switcher on any device (**＋ New workspace…**), then
`npm run workspace add` the folder locally and `npm run publish -- --pull` to bring it down.

## Making cards by hand

On the published site and in the local app, **＋ New card** on the board makes a card: a title,
an optional description, and the workspace it goes in. It starts with one Markdown section and
opens in the editor. On a card, **＋** after the tabs adds another Markdown section, and the pencil
beside the title changes the title and description. Every Markdown section has Edit and Save
(Ctrl+E, Ctrl+S).

The editor is CodeMirror, with Markdown highlighting and undo. A toolbar above it formats the
selection: bold (Ctrl+B), italic (Ctrl+I), strikethrough, heading, link (Ctrl+K), inline code,
quote, bulleted, numbered and task lists, a code block and a table. Typing `/` at the start of a
line offers blocks to insert (`/table`, `/todo`, `/code`, `/details`…); Tab moves between the
fields they leave to fill. Enter continues a list item or a table row. Select some text and
paste a URL to make it a link, `[text](url)`.

**View** shows the rendered page. On a wide enough screen, **Split** shows the editor and the
preview side by side, with the preview following the editor's scroll; the choice is remembered
in this browser, and on a narrow screen it falls back to Edit.

A card made this way is a folder named `<date>_<id>` with an `index.md`, registered in
`workspace.json` like a card an agent writes. On the site it is written straight into the
bucket; locally, into the workspace folder. A save names the version it started from, so two
editors cannot silently overwrite each other: a save made over a newer version is refused, and
the editor offers their version or yours. HTML sections are not edited here yet.

Both services answer the same routes (`site/api/card-writes.mjs`): `POST /api/cards`,
`/api/cards/update`, `/api/cards/section`, `/api/cards/section/rename`, `/api/cards/markdown`,
and `GET /api/cards/markdown`.

## Cards from anywhere

A session without a workspace folder — a cloud agent, a new laptop — can still read and publish
cards with `npm run cards`: with the machine's AWS credentials when it has them, otherwise
through the **card API** (`site/card-api`, a SAM stack), which needs only a passphrase in
`BUW_CARDS_PASSWORD`. Set `BUW_CARD_API` to your card API's address. The API reaches
`sections/*` in the cards bucket and nothing else:

```bash
npm run cards -- get https://<your-site>/my-workspace#/my-card --into ./ws
npm run cards -- put ./ws --section my-workspace --card my-card
```

Setup, where to put the passphrase for each kind of agent, and the routes are in
[site/card-api/README.md](../site/card-api/README.md).

## Card responses: saving what a viewer enters

A card page can save input (ratings, sentences) and read it back with `_shared/card-data.js`
(no dependencies; `npm run workspace update-shared` copies it into a workspace):

```js
const store = await BuwCardData.open({ doc: 'listen-v2' });
store.set('item-1', { ratings: { clarity: 'good' } });   // local now, saved after 800 ms
store.get('item-1'); store.all(); store.mode;            // 'server' | 'local'
store.on('status', (status, message) => {});             // saved | saving | offline | error
store.exportJson();                                      // download the whole doc
```

A card page holds no credential and never calls `/api`. The Workspace app shows the card in a frame
and saves for it: `card-data.js` sends the app a message (`window.postMessage`), and the app calls the
site API as the signed-in user, for that one card only. It stores one whole file per doc at
`sections/<section>/card-responses/<card>/<doc>.json`, merging item by item (`null` deletes one), so
two browsers saving different items both land. The page learns its section and card from the app, not
from its own markup.

The app answers a message only when it comes from the frame it is showing and from the origin that
frame was loaded from, and replies to that origin, never `*`. A request is
`{ type: 'buw:bridge', v: 1, id, op, ...fields }`; the answer is `{ …, ok: true, result }` or
`{ …, ok: false, status, error, current? }`.

| `op` | fields | `result` |
|---|---|---|
| `hello` | none | `{ section, card, ops }` |
| `responses.get` | `doc` | `{ doc, etag }` (`doc` is `null` before the first save) |
| `responses.set` | `doc`, `set` (item → `{ updated, data }` or `null`, 1 to 200) | `{ doc, etag }` |
| `markdown.get` | `path` | `{ text, etag }` |
| `markdown.save` | `path`, `text`, `base` | `{ text, etag }`; a stale `base` fails with 409 and `current` |

`path` must be one of the card's Markdown steps. A card's Markdown answer is read and saved with
`BuwCardData.bridge.call('markdown.get', { path })` and `('markdown.save', { path, text, base: etag })`.
Writes are limited to 10 a second per frame (429).

Every card page shares the content host's origin, so any card page can script the card frame the app is
showing if it holds a handle to the app's window. The app shell therefore must not be framed or reachable
through a window another page holds: the site sends `Cross-Origin-Opener-Policy: same-origin`,
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` with it (Caddyfile, and the
stand-in in `server/test/card-sandbox-ui.mjs`, which tries all three attacks: framing the app, opening it in
a popup, and keeping a popup open while the owner moves to another card). The app also answers the bridge only
when it is a top-level window with no opener. Keep these headers on any proxy in front of the app. When the app cannot save (signed out, or the local
app), every op answers 401 and the page falls to local mode at once.

Opened in its own tab, a card has no app to ask: `store.mode` is `'local'`, input stays in the
browser's `localStorage`, `store.message` says "Open this card inside the Workspace, signed in, to
save it.", and `exportJson()` still works. `store.signIn()` takes no passphrase and never prompts; it
asks the app again.

Why that key: the card API (agents' file routes) refuses a path whose first segment starts with `_` or `.`, and a file
inside a card folder would be deleted by the next `npm run publish`. `card-responses/` is outside
every card folder, and `scripts/shared/s3-sync.mjs` skips it on publish and pull, so the name is
reserved (no card folder may use it).

**Known limit:** the card API sets no CORS headers, so a browser on the published site cannot
call it yet and the page stays in local mode. It needs a `CorsConfiguration` on the HTTP API
(allowing the site's origin, the `Authorization` and `Content-Type` headers and the GET/PUT
methods) or a same-origin proxy route on the site. The local service's sandboxed origin is not
covered.

## Mission control: PC status, Work and Team

### PC status

The Gaming PC's report script writes a status file about once a minute to `inbox/pc/status-<YYYYMMDDTHHMMSSZ>.json` (create-only, at most 64 KB, `v: 1`; `pc` is one of the Hub's folders). The file holds the host slug, whether someone is using the machine, the GPU band, ComfyUI and Unity, and the open Claude Code sessions (name, status, folder, repo, project, branch, links). `sessions` is `null` when the PC could not list them. `runs` is always `[]` for now.

| Route | Does |
|---|---|
| `GET /api/hub/pc` | `{ pc, status }`: the summary (`state` is `on`, or `asleep-or-off` when the file is over 15 minutes old; `ageSeconds`, `inUse`, `keepAwake`, `gpu`, `comfy`, `unity`, busy and idle session counts) and the cleaned file. Both are `null` when there is no valid file |
| `GET /api/hub/today` | Also carries `working` (the Working now list) and `pc` (the summary or `null`). `counts.running` is the number of `working` and `needs-you` items; `running` is still the event-derived list, for old clients |

The site reads the newest file in this hour and the one before (the day prefixes only when both are empty), never from a cache. A file that fails `validStatus` (wrong version, bad host or time, over 30 sessions) counts as no file; inside a valid one, folders and repos are cut to their last path segment, links must be real session links, and unknown fields are dropped.

Working now (`site/api/hub-pc.mjs`) has one item per session with a fresh status: `busy` is `working`, `idle` is `idle`, and a session with an open `blocked` event is `needs-you`. A running session from a `session-started` event on another host is added. Events from the PC's own host are dropped while its status is fresh. With no fresh status it is the event-derived list, as before. The Beads id comes from the branch name and the project's prefix in `site/api/project-defaults.mjs`.

### Work

`GET /api/hub/work[?project=<id>]` returns `{ lanes, counts, at }`: six lanes (`backlog`, `ready`, `running`, `blocked`, `review`, `done`) of cards `{ key, source, id, project, title, lane, state, why?, signs, live?, updatedAt, href }`. `source` is `beads`, `request` or `hermes`; `key` is `bead:<id>`, `request:<id>` or `run:<id>`. Without `project` it covers every project with a Beads copy plus all requests; with one, that project's issues and requests. `counts` are real totals: Backlog keeps the newest 50 cards and Done the newest 30 of the last 14 days.

| Source | Backlog | Ready | Running | Blocked | Review | Done |
|---|---|---|---|---|---|---|
| Beads issue | `deferred` | `open` with every blocker closed | `in_progress` | `blocked`; `open` with an open blocker; an open Ask on the bead or label `needs-owner` (why: "needs you") | not closed and an open `pr-opened` or `ready-for-review` event | `closed` |
| Request | `open` and `proposed`, and any unknown state | `approved`, `taken` | `running`, `stopping` | `lost`, `failed`, `at-pc`, `asking` (why: "asked you a question"), `expired` | `done` with an open PR on its bead | `done` |
| Hermes run | | | `running` | `waiting`, `waiting-approval` | | `completed` |

Milestones and issues with children are left out (the map shows them). A task that only inherited the `milestone` label from its milestone is a task, by the same rule the map uses (`milestoneIssuesOf`). A busy or idle session in a fresh PC status whose branch names the bead gives the card `live: { host, session, state }`. `signs` are the map's (`issueSigns` in `hub-map.mjs`). `hermesRuns` is always empty for now: no store exists yet, and the mapping is tested with fixtures. A bead's `href` opens the map panel; a request's opens Needs you's requests filter.

### Spawn

Spawn is the sheet that sends a job to an agent. Open it from the Spawn button in the Today and Needs you headers, from "Spawn work" on Work (for the project shown), or from the palette: Ctrl+K, then `Spawn: <what you want>` (a word list guesses the preset). It is a dialog on a desktop and a bottom sheet under 768 px. The code is `src/hub/Spawn.tsx`; its styles are in `src/hub/runs.css`.

It reads `GET /api/hub/presets` and `/api/hub/projects`, and asks `GET /api/hub/presets/route` (150 ms after the last change) where the job runs and which of the five rules matched. A target chosen by hand reads "your choice" and highlights no rule. The button depends on the host's capabilities: `approve` true creates the request and then signs it (`POST /requests/:id/approve { target }`); otherwise it reads "Save as a proposal" and only creates. A Bunnylink job (`at-pc`) reads "Add to Needs you": you start it at the PC. If the request is saved but approving fails, the toast says it waits in Needs you, with the reason. The agent is the preset's `agent`, shown as text.

The Repo field of a code or docs job is a picker: the project's own repo first (its section's `tracked.repo`, so it is the default), then the other known repos, then "Another repo…" for owner/name by hand. `GET /api/hub/presets/repos` returns `{ repos: [{ repo, project? }] }`: each table project's tracked repo in table order, then the `owner/name` entries of `HUB_KNOWN_REPOS` (comma list, optional). A request's repo must be `owner/name` as GitHub spells them (letters, digits and single dashes in the owner); anything else is a 400.

### The Approval item

A proposed request is a Needs you item of kind Approval (`src/hub/ApprovalView.tsx`, a case in `NeedsItem.tsx`), and `#/~hub/request/<id>` opens the same item on its own page: this is the link a `#needs-you` ping carries. It shows the preset and project, who asked, and for a request that an agent or a run wrote the line "Written by <name>, not by you. Read it before approving." It also shows the text, where it runs and why (with a machine choice), its side effects, the time limit and when it starts. Approve (`POST /requests/:id/approve { target }`, or `again` for an expired one), Edit (Spawn on the request; its Approve calls `again` with the new text), and Decline (an optional reason) all hand the next item to the list (`Approved · next: …`). A request for the PC (`at-pc`) has Copy prompt and Mark done instead of Approve. A request signed by policy reads "Signed by policy". A request in any other state shows its state and outcome; the run drawer fills that page later.

### The run drawer

`src/hub/RunDrawer.tsx` shows one request's run: id, preset and state chips, the text, where it runs, a timeline (written, approved by whom or "Signed by policy", taken, each `run-*` newest first with "Open session", the stop, the result) and, at the end, the result with its PR and card links, usage and `report.md`. For a request with a Hermes run and no result it follows `GET /api/hub/requests/:id/events` while the view is open (`runStream.ts`): the answer text accumulates, a tool line shows `preview` and turns done or failed, and a Hermes approval shows its command with a link to answer it in Needs you. On `state` it reads the request again; closing the view closes the stream. Stop (signed) shows while a run can be stopped; Approve again for expired, failed and lost requests. A retry on quota says "Codex quota reached; retried on Anthropic."; the `asking` state shows the question and an Answer link. A plain click on a request row (Needs you's Requests filter, a Today alert made from a request) opens it as a side drawer on a desktop and a bottom sheet under 768 px; "Open as a page" and `#/~hub/request/<id>` show the same view as a page.

### Team

The agent list is app code (`AGENTS` in `site/api/hub-team.mjs`): Hermes, Briefs, Claude Code, and the three research agents (Researcher, Market researcher, Teardown), which are Hermes runs and carry the Spawn `presets` they take. "Give work" on their card opens Spawn on the first preset. A request card on Work links to `#/~hub/request/<id>`; declined and stopped requests are hidden, and a click opens the run drawer. Later milestones add an entry when an agent gets work. The model labels follow the Hermes profile docs (`main` runs on Codex gpt-6-sol with Sonnet, then DeepSeek, as fallbacks; `briefs` runs on Haiku 5.5 with the DeepSeek fallback).

| Route | Does |
|---|---|
| `GET /api/hub/team` | `{ agents }`: each agent with `status` (`working`, `needs-you`, `failed`, `idle`, `offline`), `task` and `sprite`. Claude Code also carries `sessions` (its Working now items) |
| `POST /api/hub/team/:agent/avatar` | `{ kind: 'builtin', key }` (a key of `BUILTIN_KEYS`) or `{ kind: 'random', salt }` (a whole number, 0 to 9999). 400 for anything else, 404 for an agent not in the list, 401 without a signed-in user |

Statuses: Claude Code is `needs-you` if a session is, else `working` if one is, else `idle` when sessions exist or the PC status is fresh, else `offline`. Hermes asks `HERMES_URL` `/health` (no key, 1.5 s, cached 60 s): healthy is `idle` with "Last chat <ago>", otherwise `offline`; with no `HERMES_URL` it is `offline`, "Not set up". Briefs is always `idle`.

An avatar choice is the owner's. The site writes it as a create-only file, `inbox/team/<agent>/avatar-<YYYYMMDDTHHMMSSZ>-<rand4>.json` = `{ kind, key | salt, at, by }`, and the newest name is the current sprite; none means the default. Undo posts the previous choice again. The write is guarded in two places: the route needs a signed-in user and an allowed origin like every Hub write, and the card API refuses `team/<agent>/avatar-*.json` to any token that is not unrestricted (`OWNER_FILES`, for PUT, upload URLs and DELETE), so an agent cannot set or clear an avatar. `BUILTIN_KEYS` is a copy of the client list in `src/hub/team/sprites.ts`; `site/api/test/hub-team.test.mjs` fails if the two differ.

### Custom sprites

A custom sprite is a pet sheet an agent made on the Gaming PC: `inbox/team/<agent>/sheet-<YYYYMMDDTHHMMSSZ>-<rand4>.png` and a `.json` of the same name. The PNG is 1536 x 1872 (8 columns by 9 rows of 192 x 208 frames, art drawn at 48 x 52 and scaled x4); the rows are `idle`, `run-right`, `run-left`, `waving`, `jumping`, `failed`, `waiting`, `running`, `review`. The JSON is `{ v: 1, agent, frame, cols, rows: [{ state, frames, fps }], source?, sha256, at }`.

The site never serves or uses a sheet it has not checked. A sheet is listed only when the JSON is under 16 KB and parses with `v: 1`, the `agent` of the folder, frame 192 x 208, 8 columns and nine rows in the fixed order with `frames` 1 to 8 and `fps` 1 to 24, and the PNG is at most 4 MB, 1536 x 1872 by its header, and hashes to the JSON's `sha256`. The verdict is cached by key and ETag, so a PNG is hashed once. `source` is provenance only and is never trusted.

| Route | Does |
|---|---|
| `GET /api/hub/team/:agent/sheets` | `{ sheets: [{ sheet, at, rows, url, current }] }`, newest first, at most 20, only checked sheets. 404 for an agent not in the list |
| `POST /api/hub/team/:agent/avatar` with `{ kind: 'custom', sheet }` | The sheet must be listed now. The site writes the owner-only avatar file `{ kind: 'custom', sheet, sha256, at, by }` with the hash it computed. 400 "That sheet isn't ready or failed its check." otherwise; 401 signed out |
| `GET /api/hub/file?path=team/<agent>/sheet-<stamp>.png` | Serves a listed sheet's PNG with the usual sandbox headers. No other file under `team/` is served |

Putting a sheet in the folder changes nothing by itself. A sheet is an agent's sprite only while the newest avatar choice names it and the sheet is still listed with that same `sha256`; if the bytes change or the files go, the Team screen falls back to the newest older choice that still resolves, then the default. In `GET /api/hub/team` the sprite is `{ kind: 'custom', sheet, url, frame, cols, rows }`, where `url` is a path under the API base.
