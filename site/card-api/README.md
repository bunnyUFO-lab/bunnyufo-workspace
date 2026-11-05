# Card API

Read and publish workspace cards from anywhere, with **one passphrase you choose**. That works
from a cloud agent, a new laptop or another machine. The agent needs no AWS account and no way
into the home server, and nothing has to be generated or installed first.

```
agent ──passphrase──▶ https://api.workspaces.example.net (API Gateway, throttled) ──▶ Lambda ──▶ s3://<cards bucket>/sections/*
                                                                              role: get/put/delete under sections/,
                                                                              list under sections/; denied: deleting
                                                                              versions, versioning/lifecycle changes
```

The site (`workspaces.example.net`) still reads the same bucket through `site/api`, so a card
published here is on the site as soon as the call returns. Pins, archives and tags (`state.json`)
are out of this API's reach.

**How safe is a memorable passphrase?** It guards notes, not money. The API takes at most 10
requests a second, so four random words (16 or more characters) would take far longer to guess
than anyone would spend. The worst case is someone editing cards. Bucket versioning (step 1
below) lets you undo that, and a new passphrase is one deploy away.

## Why SAM

It is CloudFormation with a shorter syntax for Lambda and API Gateway. It is free, you already
use it, and the whole thing is one template and one function with no dependencies, so nothing
needs bundling. Terraform would add a state backend to look after, CDK a bootstrap stack and a
build, and Terragrunt is for many environments. None of them buys anything at this size.

## Cost

Nothing at this volume. Lambda's free tier (1M requests a month) is permanent. HTTP API costs
$1 per million requests after the first year's free tier. The certificate is free, and Route 53
already hosts the zone. Logs are kept 30 days.

## Set up (once)

From any machine with AWS access: the home PC, or **AWS CloudShell** in the browser, which
already has the aws and SAM CLIs. Clone this repo there first.

1. **Turn on versioning** on the bucket, so any overwrite can be rolled back:

   ```bash
   aws s3api put-bucket-versioning --bucket <bucket> --versioning-configuration Status=Enabled
   ```

2. **Deploy.** The first run asks for the passphrase. It also creates the API's domain (`cardApi.domain` in `~/.buw/deploy.json`), with
   its certificate and DNS record in the Route 53 zone, which it finds by itself:

   ```bash
   site/card-api/deploy.sh <bucket>          # --region if the bucket is not in us-east-1
   ```

   The domain, region, stack and the browser origins allowed to call the API (CORS) come from
   `~/.buw/deploy.json`, then `BUW_CARD_API_DOMAIN`, `_REGION`, `_STACK`, `_ORIGINS`, then the flags
   `--domain`, `--region`, `--stack`, `--origins a,b`. The origins are passed on every deploy,
   because CloudFormation resets a parameter that is left out to its default. With no domain the
   script prints its usage and stops. `BUW_DEPLOY_CONFIG` moves the file.

   ```json
   {
     "cardApi": { "domain": "api.workspaces.example.net", "region": "us-east-1", "stack": "buw-card-api",
                  "origins": ["https://workspaces.example.net", "http://localhost:3009"] },
     "web":  { "publicUrl": "https://games.example.net" },
     "itch": { "url": "https://<user>.itch.io" },
     "lanIp": "192.0.2.107"
   }
   ```

   Only `cardApi` is read here; `web`, `itch` and `lanIp` are for `tools/gamedev-deploy.py`.
   Clients find the API through `BUW_CARD_API`, or `"cardApi": "https://api.workspaces.example.net"` in
   `~/.buw/config.json` (`BUW_CONFIG` moves that file). The API serves its own client at `/cards.mjs`
   with its address filled in.

   Later runs keep the passphrase; `--new-passphrase` changes it. The first deploy takes a few
   minutes while the certificate is validated.

## Where an agent runs

The site's **Skills** panel has all of this under **Workspace API setup**, with copy buttons.
On the home PC, agents use its AWS credentials and need nothing here.

| Where | What to do |
|---|---|
| Any terminal (another PC, a laptop) | Paste the panel's **setup command**. It saves the client to `~/.buw/cards.mjs` and runs `login`, which asks for the passphrase once (hidden), checks it, and keeps it in `~/.buw/card-api-password`. Agents there run `node ~/.buw/cards.mjs …`. |
| Claude Code cloud | Either the environment variable `BUW_CARDS_PASSWORD` = the passphrase, with network access **Custom** and the API's domain among the allowed domains (keep the default package managers on). Or, where the environment editor offers it, **Add secret**: type Bearer, allowed website the API's domain, header `Authorization`, prefix `Bearer`, value the passphrase. With the secret the session never holds the passphrase: the client sends no header of its own, and the environment adds this one. Either way the agent fetches the client with `curl -fsSL https://api.workspaces.example.net/cards.mjs -o ~/.buw/cards.mjs --create-dirs`. |
| GitHub Copilot coding agent, CI | A secret `BUW_CARDS_PASSWORD` (for Copilot: the repo's Settings → Environments → `copilot`), and the API's domain on the firewall allow list. |

`BUW_CARDS_PASSWORD` wins over the saved file. In this repo, `npm run cards` runs the same
client. Never paste the passphrase into a chat.

**Optional extra tokens.** `node site/card-api/new-token.mjs <name> [--sections a,b | --rights 'read=*;write=inbox'] [--out <file>]`
makes a random token limited to some sections or verbs, which can be revoked on its own (deploy
again after). With `--out` the token goes to that file (mode 0600, never overwritten) and only
its name, rights and path are printed. Most setups never need one.

A token's scope is the text after the colon in `~/.buw/card-api-tokens` (`BUW_CARD_TOKENS`):

| Scope | Means |
|---|---|
| none | read, write and delete on every section |
| `a\|b` | all three, on those sections only |
| `read=*;write=inbox\|assistant` | only the verbs listed, each on `*` (every section) or on some; a verb not listed is not allowed. Each verb at most once. |

The verbs: **read** is every `GET` (and `resolve`), **write** is `PUT` of a card or a file and
`POST uploads`, **delete** is `DELETE` of a file. A section the token may not read is also left
out of `GET /sections`. Deploy the handler before putting a rights entry in the tokens file: an
older handler cannot parse it and answers 500 to everyone.

**The Hermes config exporter's token.** `hermes-config=<sha256>:write=inbox` (make it with `new-token.mjs hermes-config --rights 'write=inbox' --out <file>`).
It may only create `agent-config/export-<YYYYMMDDTHHMMSSZ>.json` and `agent-config/changes/<ask id>/result.json` in the inbox (see below), and read
`agent-config/changes/<ask id>/approved.json` and `result.json` there (a narrow read in the handler, not a `read=inbox` right). Deploy the handler with the `agent-config/` rule
*before* adding this token to `BUW_CARD_TOKENS`: an older handler would let a `write=inbox` token write anywhere in the inbox.

## Use

```bash
npm run cards -- sections
npm run cards -- list magic-loops
npm run cards -- get https://workspaces.example.net/magic-loops#/loops-plan --into ./ws
npm run cards -- get "Loops plan" --into ./ws          # or section/card, or the id
# edit ./ws/<card folder>/…, or make a new card folder and add its entry to ./ws/workspace.json
npm run cards -- put ./ws --section magic-loops --card loops-plan [--dry-run]
```

### The inbox commands

The hidden `inbox` section is how agents, hooks and the Hub pass things to each other. Every command
works over the API and over `--via s3`. Requests are retried on network errors, 429 and 5xx (three
times, 500 ms doubling). Only `event` is spooled when the API stays down: the line goes to
`~/.buw/spool.jsonl` (`BUW_SPOOL`) and the next inbox command sends it (a day old: dropped).

```bash
npm run cards -- event <kind> --title <t> [--project --bead --ask --url --summary --source]
npm run cards -- event pr-merged|pr-closed --title <t> --url <pr link> --pr-closed-at <iso>   # fixed file name per PR close; a repeat prints `exists <file>`
GITHUB_TOKEN=$(gh auth token) npm run cards -- pr-sync --repo <owner/repo> --project <p> --prefix <bead prefix> [--days 7] [--dry-run]
npm run cards -- ask create --project <p> [--bead <b>] (--file ask.json | --question <t>) [--option <id>=<label>[@<image>]]... [--decision <text[|detail]>]... [--image <file>]...   # prints the id; pings #needs-you when a webhook is set
npm run cards -- ask create --project <p> --kind decision --question <t> --changes <changes.json>   # a plan: 1 to 20 changes the owner approves row by row (docs/workspaces.md, "Plans")
npm run cards -- ask create --project <p> --question <t> --agent-edit <edit.json>   # propose a chat-persona edit (role, prompt, model); only the owner's Apply answer applies it (docs/workspaces.md, "A persona edit")
npm run cards -- beads show --project <p> [--open] [--json]   # read-only: the project's merged Beads copy
npm run cards -- plan apply <ask id> [--dry-run] [--journal <file>]   # run the approved rows of an answered plan with bd; the journal makes a rerun skip rows done
npm run cards -- mark apply --project <p> [--json]   # the PC applies the owner's marks in Beads (writes no mark and no applied note); apply pending --project <p> --json lists what waits
npm run cards -- ask list [--project <p>] [--answered | --open] [--all]
npm run cards -- ask get <id>
npm run cards -- ask pickup <id>      # also: ask cancel <id>; exit 3 if someone already did
npm run cards -- checklist create --project <p> (--file checklist.json | --title <t> --item <text>...) [--bead <b>] [--card <url>] [--playtest --build <https url> [--platform <p>] [--look-for <t>]]   # prints the id; pings #needs-you
npm run cards -- checklist list [--project <p>] [--open | --submitted] [--all]   # id, state, done/total, project, title
npm run cards -- checklist get <id> [--json]
npm run cards -- checklist wait <id> [--timeout <min, 30, max 240>] [--every <s, 20, min 5>]   # 0 on submit, 3 on cancel, 4 on timeout
npm run cards -- checklist pickup <id>   # exit 2 when not submitted, 3 when already picked up; also: checklist cancel <id> (3 when cancelled or submitted)
npm run cards -- request list [--project <p>] [--open]
npm run cards -- request take <id> --bead <b>      # exit 3 if taken
npm run cards -- request create --project <p> --text <t> [--when next-sprint|nightly|record]
npm run cards -- beads push --project <p> [--from <file.jsonl>]   # default: `bd export`
```

**Reviews need something to act on.** A `ready-for-review` event (`events/<day>/<name>.json`) needs a pull request link (`url` or `prs`, a GitHub pull request) or an `ask`, the one line saying what the owner should decide or do. Without them the API answers 422 and `cards event ready-for-review` exits 2 with the same words. Every other event kind and every other file is unchanged.

**Pull request events and the reconcile.** A repository's `hub-events.yml` workflow posts `pr-opened`, `pr-merged` and
`pr-closed` events when a PR changes. A missed post (the secret was not set yet, the API was down, the workflow did not
exist) would leave a review item waiting for a merge it never hears about. So the same workflow also runs `pr-sync` every
6 hours, and on demand (`gh workflow run hub-events.yml`, optional `days`): it lists the repository's PRs closed in the
last 7 days (1 to 30 with `--days`) and posts their close events. The live post and `pr-sync` write the same file,
`events/<UTC day of the close>/<HHMMSS>-gh-<owner>-<repo>-<n>-<merged|closed>.json`, create-only with the close time as
`ts`, so whichever comes second gets "already exists" and nothing is posted twice. Nothing needs to read the Hub first.
By hand from the PC: `GITHUB_TOKEN=$(gh auth token) node ~/.buw/cards.mjs pr-sync --repo <owner/repo> --project <p> --prefix <bead prefix>`
(`--dry-run` lists the files it would write). The reconcile job uses GitHub's own read-only token and the repository's
existing card API secret; it needs nothing new. Until the card API serves a client that has `pr-sync`, the job prints a
warning and exits 0.

**The #needs-you ping.** After `ask create` or `checklist create` the CLI posts one message to a Discord webhook when it
finds one, looking in this order: `BUW_DISCORD_NEEDS_YOU`, `discord.needsYou` in `~/.buw/hub.json`,
the file `~/.buw/secrets/discord-webhook-needs-you`. The message is `Agent needs you · <Project>`, the
question or the checklist's title and step count (200 characters) and, with `siteUrl` in `hub.json` or `BUW_SITE_URL`, a link to
`<siteUrl>/#/~hub/ask/<id>` (`…/checklist/<id>` for a list); no mentions. With no webhook nothing happens. If the post fails (5 s
timeout) the message is appended to the shared spool as a `discord` line for the hub-hooks mod to
replay; the address is never stored, and the exit code stays 0.

`put` uploads only what differs (by md5), removes files that are gone, and only then adds or
updates the card's entry in the section's `workspace.json`. That way a card never shows up on
the site before its files do. The entry is written conditionally on the ETag it read, so a
card added from another device at the same moment is never lost.

**Which way it goes.** The API first:

1. **The card API**, whenever there is a passphrase: `BUW_CARDS_PASSWORD`, else
   `~/.buw/card-api-password`. Its address is `BUW_CARD_API`, else `"cardApi"` in
   `~/.buw/config.json`; there is no built-in host, and without one the client says so.
2. **Directly to the bucket**, when there is no passphrase but the machine has AWS credentials and
   knows the bucket. The credentials are `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or a
   profile in `~/.aws/credentials`, the same file the aws CLI reads. The bucket comes from
   `BUW_S3_BUCKET` or a bucket in the workspace registry. This runs the API's own handler on the
   machine, so the rules are the same either way. SSO and `credential_process` profiles are not
   read; use static keys or the API.
3. Otherwise **the API with no header**, for an environment that adds it (a cloud secret). A 401
   then says how to set a passphrase up.

`--via s3` or `--via api` (or `BUW_CARDS_VIA`) forces one. The first line of output, on stderr,
says which was used. The client is `site/card-api/cards.mjs` (`scripts/cards.mjs` runs it); it
needs only Node 22, and the API serves it at `/cards.mjs` so a session without this repo can
fetch it. On its own it has only the API.

On the home PC, with a registered workspace, keep using `npm run publish`. `cards` is for
places with no workspace folder.

## Routes

Every route but `GET /cards.mjs` (the client, which holds nothing secret) needs
`Authorization: Bearer <passphrase or token>`.

| Route | What it does |
|---|---|
| `GET /sections` | the sections this token may use |
| `GET /sections/{section}` | the section's name and card list |
| `GET /sections/{section}/cards/{card}` | the entry and its files, each with a 15-minute download URL |
| `PUT /sections/{section}/cards/{card}` | add or update the entry (body: the entity). Its folder must already hold files. |
| `GET /sections/{section}/files?prefix=<p>` | the files under a prefix: `{ files: [{ path, size, etag, lastModified }], truncated }`, sorted, 1000 at most (`truncated: true` beyond; keep prefixes narrow, such as `asks/202610`). The prefix is empty or relative, with no `..`, and not starting with `/`, `_` or `.`. |
| `GET/PUT/DELETE /sections/{section}/files/{folder}/{path}` | one file, up to 4 MB through the API. A `PUT` may send `If-None-Match: *` (create only) or `If-Match: "<etag>"` (replace only that version); either answers 412 when it does not hold. |
| `POST /sections/{section}/uploads` | upload URLs for bigger files. Body: `{ "files": [{ "path": "<folder>/<file>" }] }` |
| `GET /resolve?ref=…` | which card a site link, `section/card`, id or title names |

What it refuses:
- in the `inbox` section, `asks/*/answer.*`, `asks/*/snooze.json`, `requests/*/declined.json` and, in
  `checklists/*/`, the `tick-*` and `untick-*` files and `submit.json`, from any token whose `write` right is limited: only the Hub (through the site API) or the
  passphrase writes answers. `ask.json`, `checklist.json`, `delivered.json` and `watch-*.json` (the delivery files in an Ask's or a checklist's folder) are create-only for such a token
  (`If-None-Match: *`, never an upload URL), and it cannot delete any of these files
- in the `inbox` and `inbox-dev` sections, for a limited `write` right, the files only the Hub writes (same 403, same
  rule, no delete): `requests/*/approved.json`, `stop.json`, `hermes-run.json`, `hermes-retry.json`, `fire-*.json`,
  `answer-*.json`, everything under `hermes-approvals/`, and an agent's `team/<agent>/avatar-*.json` and `team/<agent>/persona-*.json` (a persona edit is the prompt of every chat, so `hermes-main` may not write one)
- in the same sections, an `asks/*/ask.json` with an `agentEdit` field that fails the shape check (422, the problems named; `site/api/agent-edit.mjs`)
- in the same sections, a run's files `requests/*/taken.json`, `run-*.json`, `result.json` and `report.md` (403 "Only a run
  writes run files.", no delete), unless the token is named `pc-runner`, or named `cloud-<project>` and
  `requests/<id>/request.json` exists with that `project` (one read, only for these writes). Any other limited token,
  `hermes-main` and the old `cloud` token included, is refused; the passphrase is not limited. This means a session that
  holds only a limited token can no longer `cards request take` a request: legacy takes need the passphrase or a runner token
- the `pc-runner` token writes `requests/<id>/run-*.json` and `result.json` only when that request already has a `taken.json` naming the PC runner (`"runner": "pc"`; the claim writes it before the run starts, and `taken.json` and `report.md` themselves are not gated). Otherwise 403 "taken.json is not there"
- `requests/*/request.json` is create-only for a limited writer like `ask.json`, and a limited writer's request whose
  `origin.kind` is `owner` is refused: only the Hub marks a request as the owner's
- `writer` metadata: a `request.json` put by a limited token named `agent` or `agent-<name>` is stored with the object
  metadata `x-amz-meta-writer: agent`. No other token gets it (`pc-runner`, `cloud-<project>`, `hermes-main`, the old
  shared tokens, the passphrase), and metadata sent by a caller is ignored: only the handler sets it. The Hub's policy
  approval signs only when the stored `origin` and this `writer` agree, so policy never signs a request from a token
  that is not named `agent` or `agent-*`
- `writer` metadata on `asks/*/ask.json`: a limited token's ask.json is stored with `x-amz-meta-writer: pc-runner` (the token named
  `pc-runner`, the PC watcher's), `agent` (`agent`/`agent-<name>`) or `other` (any other limited token); the passphrase's carries
  nothing. Only the handler sets it (a caller's `x-amz-meta-*` headers are ignored, and ask.json cannot go through an upload URL).
  The Hub starts a run from an Ask's `rerun` pointer only when this is `pc-runner`. A PC run holds that token in its environment too, so the
  mark excludes other tokens (a cloud run, a bot, an agent session), not a run's own code; against a run the gate is on the PC (the rules
  must equal what the watcher computed, and the rerun gate)
- in the `inbox` and `inbox-dev` sections, anything under `agent-config/` from a limited writer unless the token is named `hermes-config`, the path is
  `agent-config/export-<YYYYMMDDTHHMMSSZ>.json` (stamp `\d{8}T\d{6,9}Z`), the write sends `If-None-Match: *` and it is not an upload URL request (403, no
  delete for a limited deleter). The same token may also create `agent-config/changes/<ask id>/result.json` (the host's answer to a signed profile change, same rules;
  the Hub's `approved.json` beside it is never writable by a token). The `hermes-config` token is refused every other inbox path.
  It has no `read` right: the handler lets it, in the `inbox` section only (not `inbox-dev`), list a prefix that starts with `agent-config/changes/` (the
  listing shows only `approved.json` and `result.json` files) and get `agent-config/changes/<id>/approved.json` or `result.json`. Reading an export, an ask or anything else is still 403. A file it creates is stored with the object metadata
  `x-amz-meta-writer: hermes-config`, set only by the handler; the passphrase's files there carry no mark, and the site API ignores an export without it
- files that look like secrets (`.env`, keys, `*token*.json` and the like)
- for a limited writer outside the inboxes, a first path segment the site keeps for itself (`card-responses`, `_shared`, `workspace.json`, `state.json`, `sections`, `inbox`), on put, upload and as an entry `folder` (403)
- `library-writes.json` and `card-writes/` in an inbox, for every caller, the passphrase included (the setting and the records are not written through a route; reading `card-writes/` needs only `read`)
- paths outside a card folder (`workspace.json`, `_shared/`, dot-files)
- registering a card whose folder holds a file over 50 MB
- a folder that already belongs to another card

## The `@library` right

A `write` list may end with `@library`: `read=*;write=inbox|assistant|@library`. It lets the token add to any
**Library section**: a section with a card list that is not `hidden`, not `archived`, and whose id is not `inbox` or
`inbox-*`. A literal right still wins, so `assistant` behaves as before. The right never deletes (`delete` has no
`@library`), and an older handler answers 500 to every caller when it sees `@library`, so deploy the handler before
changing a token.

What a Library write must do:
- send `If-None-Match: *` (create) or `If-Match: "<etag>"` (edit), else 428
- send `x-card-agent` (name), `x-card-why` (URI-encoded, 1 to 300 characters) and for an edit `x-card-context` (`chat` or `job:<id>`), else 422. `x-card-batch` (8 to 32 lower-case letters and digits) groups the writes of one `put`. `agent`, `why` and `context` are what the agent says; the token is proven
- use paths every part of which is safe on Windows (project sections come down to the owner's PC): letters, digits, space, dot, dash, underscore and brackets, no device names (`con`, `nul`, `com1`), no trailing dot or space; a card `folder` is stricter: letters, digits, dot, dash, underscore
- stay under 4 MB per file: no upload URLs for a Library section (403)
- not write into a Trash or moved card's folder (409), or a name that differs only by case from a file there (409); reserved and retired names are compared without case
- not put a file below an existing file, or where a folder already is (409): S3 allows it, Windows does not, and one such key would stop every publish and pull
- an `If-Match` edit of an existing `.html` tab marks that step `agentTab: true` (the record says `markedAgentTab`), so the viewer gives it no card bridge; a posted step never brings back a tab in `removedTabs`

The entry route keeps its shape, but the server builds the entry. A **new card** may set `id, title, description, type, category,
created, updated, folder, steps, defaultStep, status` only (422 names any other field); `status` is `active`; a step is
`{ name, path, viewer? }` with the `path` of a file already in the folder (no `url` step). For an **existing card** everything
posted is ignored except steps with a new `path`, which are appended with `agentTab: true` (set by the server). The answer
names the ignored fields (`ignored`), or `{ unchanged: true }` when nothing was added. The list is written with the `If-Match` it
read, so `retired` and every other top-level field are untouched. 409 and 412 are both a lost race and retried.

`GET /sections` and `GET /sections/{id}` carry `access`: `direct` (a literal or unrestricted write right), `library`, or `read`
(also a Library section the owner turned off).

**The setting.** `library-writes.json` at the root of the inbox, `{ "v": 1, "off": ["<section>"], "at", "by" }`, written
by the Hub. No file means every section is on. A file with a writer mark, one that does not parse or has a bad shape turns every
Library section off (logged); a storage error answers 503. It is read at most every 30 seconds. Sections that start with `dev-`
use `inbox-dev` for the setting and the records.

**The record.** Each write by a limited token outside the inboxes (a Library right or a literal one such as `assistant`)
leaves one create-only file, `card-writes/<section>/<folder>/<stamp>-<rand>.json` in the inbox, marked `writer: card-api`:
`{ v, id, section, folder, file, kind (new-card | new-tab | edit), entry, agent, token, versionId, previousVersionId, etag,
previousEtag, context, why, batch, at }`. An entry write adds a record with `entry: true`, `cardId` and `steps`. The passphrase
leaves none. If a record cannot be written (tried twice), the file is already in place: the answer is 200 with
`recorded: false` and the function log keeps the row for 30 days. **Known limit:** such a write has no row and no Revert; the
object's own `x-amz-meta-writer` and `x-amz-meta-agent` still name the writer.

## Develop

```bash
node --test site/card-api/test/*.test.mjs      # against the stand-in S3, with scripts/cards.mjs end to end
cd site/card-api && sam validate --lint
```
