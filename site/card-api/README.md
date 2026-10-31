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
npm run cards -- ask create --project <p> [--bead <b>] (--file ask.json | --question <t>) [--option <id>=<label>[@<image>]]... [--decision <text[|detail]>]... [--image <file>]...   # prints the id; pings #needs-you when a webhook is set
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
  passphrase writes answers. `ask.json`, `checklist.json`, `delivered.json` and `watch-*.json` (an Ask's delivery files) are create-only for such a token
  (`If-None-Match: *`, never an upload URL), and it cannot delete any of these files
- in the `inbox` and `inbox-dev` sections, for a limited `write` right, the files only the Hub writes (same 403, same
  rule, no delete): `requests/*/approved.json`, `stop.json`, `hermes-run.json`, `hermes-retry.json`, `fire-*.json`,
  `answer-*.json`, and everything under `hermes-approvals/`
- in the same sections, a run's files `requests/*/taken.json`, `run-*.json`, `result.json` and `report.md` (403 "Only a run
  writes run files.", no delete), unless the token is named `pc-runner`, or named `cloud-<project>` and
  `requests/<id>/request.json` exists with that `project` (one read, only for these writes). Any other limited token,
  `hermes-main` and the old `cloud` token included, is refused; the passphrase is not limited. This means a session that
  holds only a limited token can no longer `cards request take` a request: legacy takes need the passphrase or a runner token
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
  The Hub starts a run from an Ask's `rerun` pointer only when this is `pc-runner`
- files that look like secrets (`.env`, keys, `*token*.json` and the like)
- paths outside a card folder (`workspace.json`, `_shared/`, dot-files)
- registering a card whose folder holds a file over 50 MB
- a folder that already belongs to another card

## Develop

```bash
node --test site/card-api/test/*.test.mjs      # against the stand-in S3, with scripts/cards.mjs end to end
cd site/card-api && sam validate --lint
```
