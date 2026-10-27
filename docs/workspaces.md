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

## The Hub

`HUB=1` in the site API's `api.env` turns on the Hub: `/api/hub/…` routes over the `inbox`
section of the cards bucket (`site/api/hub.mjs`). The local service serves the same routes over
its own bucket whenever it has one (`HUB=0` turns them off). `/api/capabilities` reports
`hub`, `chat` and `transcribe`. Reads are open wherever the site is; writes need a signed-in
user (`Remote-User`), like every other write.

| Route | Does |
|---|---|
| `GET /api/hub/today`, `/inbox?filter=`, `/events?since=&project=`, `/projects` | What needs the owner, what runs, what happened (a seven-day window of events) |
| `GET /api/hub/asks/:id`; `POST …/answer`, `…/snooze`, `…/cancel` | An Ask and its state; answering writes `answer.json` once (a second answer is a 409 carrying the first) |
| `POST /api/hub/reviews/:id/done` | Hide a review in Needs you: writes a `review-done` event that names the `ready-for-review` event's file (`:id`); a second call writes nothing |
| `GET /api/hub/reviews/:id` | One review's detail, from its `ready-for-review` event in the last seven days (404 otherwise): title, summary, checked links, card files, screenshots in before/after pairs, verdicts, and whether it is `done` |
| `POST /api/hub/requests` | A request to an agent: `{ project, text, when, drawing? }` |
| `GET /api/hub/beads/:project`, `/map/:project` | The Beads copy, and the progress map built from it |
| `GET /api/hub/file?path=`, `/drawings`, `/drawings/:id`; `POST /drawings[/:id]` | Ask and drawing files, and Sketch drafts |
| `GET /api/hub/chat`, `/chat/:id` | The newest 30 conversations, and one conversation's lines. Chat needs `HERMES_URL` and `HERMES_API_KEY`, and a signed-in user where writes need `Remote-User` (503 when off, 401 without a user) |
| `GET /api/hub/chat/:id/images/:file` | A picture sent in a conversation, behind the same chat gate (not `/hub/file`). `Cache-Control: private`, `nosniff`, sandboxed |
| `POST /api/hub/chat` | `{ conversation?, text, images? }`; the reply streams back as server-sent events (`delta`, `created`, `done` with the saved user line, `error`). `images` is up to 4 `{ type: 'image/jpeg' \| 'image/png', data: <base64> }`, each at most 1.5 MB decoded, 5 MB together, 1 to 2048 px a side; the bytes are checked, metadata (EXIF, GPS) is stripped, and `text` may be empty with a picture. They reach Hermes as `image_url` data URLs and are stored beside the conversation as `chat/<id>/<file>`. If Hermes refuses them: 422, nothing saved. The body limit is 7 MB |
| `POST /api/hub/transcribe` | Push-to-talk: audio (webm, ogg, mp4 or mpeg, at most 2 MB) in, `{ text }` out, through `STT_URL` |

A blocked session stays in Needs you until any later event from the same session arrives (a
`resumed`, a `session-ended`, a newer `blocked`, anything that carries the session); the mod posts
`resumed` when a blocked session moves on. A `blocked` event may carry `url` (a Remote Control link
into the session; the bare `https://claude.ai/code` counts as no link) and `appUrl` (the desktop
app's `claude://claude.ai/epitaxy/local_<uuid>`). With no `url` the row says to open the Claude app.

A `ready-for-review` event may also carry `prs` (GitHub pull request links), `cardDir` (`<section>/<card folder>`), `cardFiles` (`.md` paths inside that folder, such as `briefs/x.md`), `screenshots` (https image links), `deployUrl` (an https build link) and `verdicts` (`{ leg: smoke|review|qa, result: pass|fail|noted, text }`, at most three). The review view (`#/~hub/review/<file>`) checks each field again, shows what is there and an empty line for what is not, and reads the card files from the site's `/w/<cardDir>/<path>`. On the local service, which has no `/w/` route, a file shows as not here and the view offers the card instead.

Everything the Hub writes goes under `sections/inbox/` and nowhere else; `inboxKey()` in
`hub.mjs` builds every key it uses. State is derived from the files that exist (an Ask with an
`answer.json` is answered), never stored. The keys of `api.env` that belong to the Hub: `HUB`,
and for chat `HERMES_URL`, `HERMES_API_KEY`, `HERMES_MODEL`, `STT_URL`, `STT_API_KEY`, `STT_MODEL`.

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

It saves through the card API's file routes, one whole file per doc, at
`sections/<section>/card-responses/<card>/<doc>.json` (`GET`/`PUT /sections/<id>/files/…`,
`Authorization: Bearer <passphrase>`). A save reads the latest file, applies the page's pending
items (`null` deletes one) and writes it back, so two browsers saving in the same instant can
lose one write: this is a single-user store. The passphrase is kept in the browser's
`localStorage` (`buw.cardApiPassphrase`) by `store.signIn()`; without it, or when the API cannot
be reached, input stays in `localStorage` (`mode` is `'local'`) and is pushed on the next open.
The card id comes from `<html data-buw-card="…">`.

Why that key: the card API refuses a path whose first segment starts with `_` or `.`, and a file
inside a card folder would be deleted by the next `npm run publish`. `card-responses/` is outside
every card folder, and `scripts/shared/s3-sync.mjs` skips it on publish and pull, so the name is
reserved (no card folder may use it).

**Known limit:** the card API sets no CORS headers, so a browser on the published site cannot
call it yet and the page stays in local mode. It needs a `CorsConfiguration` on the HTTP API
(allowing the site's origin, the `Authorization` and `Content-Type` headers and the GET/PUT
methods) or a same-origin proxy route on the site. The local service's sandboxed origin is not
covered.
