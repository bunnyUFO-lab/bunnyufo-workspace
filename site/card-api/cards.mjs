#!/usr/bin/env node
// Read and publish cards from a session with no registered workspace: a cloud session, another
// machine, a phone's terminal. It reaches the cards one of two ways, the API first:
//
//   1. The card API, when there is a passphrase: from BUW_CARDS_PASSWORD, else from
//      ~/.buw/card-api-password (`login` writes it). Its address is BUW_CARD_API, else "cardApi" in
//      ~/.buw/config.json (BUW_CONFIG moves that file); when the API serves this file at /cards.mjs
//      it fills in its own address. There is no built-in host.
//   2. AWS credentials, when there is no passphrase and this machine has keys
//      (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or a profile in ~/.aws/credentials) and knows the
//      bucket (BUW_S3_BUCKET, or a bucket in the workspace registry). The card API's own handler
//      then runs here, against the bucket, so the rules are the same either way.
//
// With neither, it asks the API with no Authorization at all, for an environment that adds the
// header itself (a Claude Code cloud secret).
//
// `--via s3` or `--via api` (or BUW_CARDS_VIA) picks one instead. The API serves this file at
// /cards.mjs, and it runs there on its own with Node 22; it then has only the API. In the app
// repository, scripts/cards.mjs (`npm run cards`) runs it.
//
//   npm run cards -- login                             ask for the passphrase once and keep it
//   npm run cards -- sections                          the sections this token may use, and how: write, add (a project section, new cards and tabs only) or read
//   npm run cards -- list <section>                    a section's cards
//   npm run cards -- get <link | section/card | name> [--into <folder>] [--text | --all]
//        fetch a card into <folder>/<card folder>/ and add its entry to <folder>/workspace.json; the version of each file read
//        goes to <folder>/.cards-base.json, which `put --edit` needs (never uploaded). Eight files at a time. Media over 1 MB
//        is left out and listed (--text: all non-text files left out; --all: nothing left out); what was left out goes to
//        <folder>/.cards-skipped.json, and `put` never removes those, even with --remove
//   npm run cards -- link <link | section/card | name>
//        print the address a person opens the card at (<site>/<section>#/<card>). The site is BUW_SITE_URL, else "siteUrl" in
//        ~/.buw/hub.json or config.json, else the card API's address without its leading "api.". `get` and `put` print it too.
//   npm run cards -- put <folder> --section <section> --card <id> [--dry-run]
//          [--agent <name> --why <text> [--context chat|job:<id>] [--edit] [--remove]]
//        upload the card folder (what differs), then its entry. It removes nothing unless --remove (a change from before, when a file gone
//        from the folder was removed from the section). In a section marked `add` (a project's), --agent and --why are required, only new
//        files go up unless --edit (a file read with `get`, so its version is known), --remove is refused and files over 4 MB are refused.
//        A file or entry that changed in the bucket meanwhile stops the run with exit 3.
//
// <folder> is a workspace folder: a workspace.json and the card folders beside it. `get` makes
// one if it is not there, so `get` → edit → `put` works in an empty directory.
//
// The hidden `inbox` section holds what agents and the Hub pass to each other (all files, written
// create-only unless said). Every command works over both ways in; `--via` picks one.
//
//   cards event <kind> --title <t> [--project <p> --bead <b> --ask <id> --review <file> --url <u> --summary <s> --source <s>]
//        post an event to events/<date>/. A failed send is kept in ~/.buw/spool.jsonl (BUW_SPOOL) and
//        retried by the next inbox command.
//        --pr-closed-at <iso> (pr-merged or pr-closed with a PR link as --url only; at most 30 days old): the event's ts is that time and
//        its file name is fixed by the PR (events/<day>/<HHMMSS>-gh-<owner>-<repo>-<n>-<merged|closed>.json), so a second post of the same
//        close prints "exists <file>" and writes nothing.
//   cards pr-sync --repo <owner/repo> --project <p> --prefix <bead prefix> [--days 7] [--dry-run]   (needs GITHUB_TOKEN or GH_TOKEN; BUW_GITHUB_API for tests)
//        post the close event of every PR of the repo closed in the last --days days (1 to 30), under the same fixed file names, so a
//        missed live event is filled in and nothing is posted twice. One line per PR (posted|exists|failed <file>), then a summary;
//        exit 1 when a PR failed or GitHub did not answer 200 (nothing is spooled: the next run is the retry). On the PC:
//        GITHUB_TOKEN=$(gh auth token) node ~/.buw/cards.mjs pr-sync --repo <owner/repo> --project <p> --prefix <ws|bl|...>
//   cards ask create --project <p> [--bead <b>] (--file ask.json | --question <text>) [--option <id>=<label>[@<image file>]]...
//        [--decision <text[|detail]>]... [--image <file>]... [--require-passkey] [--kind approval|verify|design|decision] [--changes <changes.json>] [--agent-edit <edit.json>] [--prose-ok]
//        --agent-edit proposes an edit of an agent's chat persona (ws-im1.4.1): edit.json is { op: "persona", agent, base, role?, prompt?, model?, why? } with at least one of role, prompt and
//        model (base: the version you read, `default` or persona-<stamp>-<rand4>; the Hub's GET /hub/team/<agent>/persona lists them). The Ask is --kind approval with --require-passkey and the
//        two options apply ("Apply this edit") and skip ("Leave it as it is"); nothing changes until the owner answers apply over the web, and an edit written against an older version is not applied.
//        Or (ws-im1.4.2) { op: "profile", profile: "main"|"briefs", primary: { provider, model }, fallbacks: [{ provider, model }] (0 to 4), why? }: the Hermes profile's model and fallback order. The
//        Hub checks it against the model list the Hermes host published, signs it on the owner's Apply, and the host applies it within 5 minutes.
//        Toolsets, skills, SOUL.md and scheduled jobs cannot be proposed. The card API and the Hub check the same rules.
//        --changes files a plan (ws-qdh.3): a JSON list of 1 to 20 changes, each { op, ... } with op create (title, type task|feature|epic, parent?, description?,
//        labels?), update (bead, title?, description?), dep (bead, blocks: bead must be done before blocks), close (bead, reason), label (bead, add?, remove?) or card
//        (card: assistant/<folder>). A bead is a Beads id, or #n for the n-th change when that one is a create. Labels: wayfinder:<type>, milestone, roadmap, needs-owner, later.
//        The Hub shows one Design review row per change (approve, change or skip); the Ask is --kind decision and takes no --option, --decision or --image. A command
//        written into a change's text is refused; the card API and the Hub check the same rules.
//        put an Ask (its pictures first, ask.json last) and post an ask-created event; prints its id
//        then, when a #needs-you webhook is configured (BUW_DISCORD_NEEDS_YOU, `discord.needsYou` in
//        ~/.buw/hub.json, or ~/.buw/secrets/discord-webhook-needs-you), post a short note there with a
//        link to the Ask (`siteUrl` in hub.json or BUW_SITE_URL). A failed post is spooled for hub-hooks to
//        replay and never changes the exit code; the webhook address is never printed or stored. The note
//        @mentions the owner, so it buzzes their phone, when their Discord user id is known (BUW_DISCORD_OWNER_ID,
//        or ~/.buw/secrets/discord-owner-user-id); a dev inbox never mentions anyone.
//        A simple multiple-choice Ask (2 to 5 options, no pictures, no drawing) also gets Discord buttons once the
//        Asks bot runs. --require-passkey (or "requirePasskey": true in ask.json) keeps an Ask in the Hub, where only you,
//        signed in with your passkey, can answer it (the passkey is a sign-in check; the answer itself is not signed): set it on any Ask that approves a merge, a deploy, spending, a deletion or secrets.
//        Never put a secret in an Ask: its question and option labels can reach Discord.
//        "avatar" in the file marks an Ask of the sprite flow: { agent, request, subject? } (pick one of four variants) or { agent, sheet }
//        (use this sheet?); the Hub acts on the answer. Use it with --require-passkey.
//        "rerun" in the file marks an Ask whose answer runs a finished PC run again: { request, kind: 'denied' } (a denied run: "I ran the
//        allow lines; run it again") or { request, kind: 'continue', ask } (the run ended before its Ask `ask` was answered). The Hub checks
//        every claim in it, makes one approved copy of the run and signs it; only an Ask with --require-passkey can do that.
//        A `denied` rerun may also carry `allow`: 1 to 5 rules (`Bash(<command>)` or `mcp__<server>__<tool>`) that the "allow" option adds to the
//        project's PC allow list; the Hub signs them in a grant and the PC applies them only when they are the ones it suggested itself.
//        --kind (or "kind" in ask.json) says what the Ask is, so the Hub badges and filters it: approval (a merge, a deploy, spending,
//        a new secret, anything behind the passkey), verify (did it work: a live check), design (pick a look or a layout), decision
//        (everything else). Anything else is refused. Left out, the Hub guesses from the Ask and says so.
//        --question makes an Ask without a file; --option repeats (an option's picture must be among the --image files).
//        --decision repeats (1 to 10) and makes a Design review: each becomes { id: d1, d2, ... , text, detail } (a "|" splits
//        the text from a detail); a file that has decisions refuses them on the command line. With decisions and exactly one
//        --image and no options, that picture is the one the decisions are about; allowDrawing is on unless the file says no.
//        A command written into the question, a decision or the context outside a fenced code block is refused (exit 2). Put it in a
//        ```bash block. --prose-ok skips that check, for text that only looks like a command, and prints a warning.
//   cards beads show --project <p> [--open] [--json]      (read-only) the project's merged Beads copy, compact: id, status, type, title, parent, labels, blocked-by
//   cards plan apply <ask id> [--dry-run] [--again] [--journal <file>]       run the rows of an answered change-list Ask that the owner approved, in order, with bd (argument arrays, no shell);
//        a changed row uses the owner's text (a create's or update's description, a close's reason). Refuses an Ask that is not answered, has no changes, is for another
//        project than this repository's (its CLAUDE.md "Beads project:"), or was picked up already (--again). Stops at the first failure and lists the rows left.
//        Afterwards: bd export -o .beads/issues.jsonl, commit it, then cards ask pickup <id>.
//   cards ask list [--project <p>] [--answered | --open] [--all]     id, state, project, question
//   cards ask get <id> [--into <dir>]                                 ask.json, answer.json, pickup.json, cancel.json; for a design
//        review also one line per decision ("d1 approve", "d2 change: Bottom-left"). When the owner attached pictures (or drew), they are downloaded
//        with no extra flag and each file's full path is printed ("saved: <path>").
//   Pictures: they go into --into <dir> when given, else <git root>/.buw/pictures/<kind>-<id>/ (that folder is added to the checkout's
//        info/exclude first, so it can never be committed), else the system temp folder. Open each file with your image reader.
//   cards ask pickup <id> | cards ask cancel <id>                     exit 3 when someone else already did
//   cards ask wait <id> [--timeout <minutes, 30, max 240>] [--every <seconds, 20, min 5>] [--json]
//        exit 0 once answered (prints what get prints, or { ask, answer } with --json), 3 on cancel, 4 on timeout or when the
//        Ask expired; a snoozed Ask keeps waiting. Pictures are downloaded as for get (--json adds "saved")
//   cards checklist create --project <p> (--file checklist.json | --title <t> --item <text> [--command <cmd> [--shell bash|powershell|cmd]]...) [--bead <b>] [--card <url>]
//        [--kind verify|setup|investigate|develop] [--playtest --build <https url> [--platform web|windows|mac|linux|android|ios] [--look-for <text>]]
//        --kind (or "kind" in checklist.json) says what the steps are for, so the Hub badges and filters them: verify (a live check, a
//        test), setup (install, paste a key, sign in), investigate (find out, look into), develop (build, fix). Anything else is refused;
//        a playtest is --playtest and takes no --kind. Left out, the Hub guesses from the title and says so.
//        put a checklist for the owner to tick off in the Hub (a list of steps, each with an optional guide) and post a
//        checklist-created event; prints its id, then pings #needs-you like an Ask. The Hub writes ticks and the submission
//        (owner-only files); nothing is ever overwritten. --file takes the checklist.json shape without id, project,
//        createdAt, from and the item ids (the CLI adds them): title, context?, card?, items[{ text, group?, guide?, link?, command?, shell? }].
//        An item's `command` is exactly the text the owner runs, nothing else (1 to 2000 characters, blank lines around it trimmed): the Hub
//        shows it under the item as a code block with a Copy button. One command per item; the item text says where to run it. `shell`
//        (bash, powershell or cmd) is the block's language. --command and --shell attach to the --item before them; --command with no --item
//        before it is an error. A command in a guide or an Ask goes in a fenced code block, never in prose.
//        --playtest makes it a Playtest: the items are what to try, --build (https only) is the build to open, --platform
//        defaults to web, --look-for says what to watch for. The #needs-you ping reads "Playtest: <title>".
//        A step whose text has a command in it (a `git ...` span, or "Run: ...") and no --command is refused (exit 2), nothing written: put the
//        command in --command with --shell and keep the text to where and why. --prose-ok skips the check (text that only looks like a command).
//   cards checklist list [--project <p>] [--open | --submitted] [--all]    id, state, done/total, project, title
//   cards checklist get <id> [--json] [--into <dir>]                        progress, the items (an item's command on the line under it), submit.json (for a playtest also its
//        build, rating, verdict and issues in plain lines). Once submitted, the owner's pictures (evidence-<step>-….png|jpg for every step,
//        shot-….png|jpg per playtest issue, shot-note-….png|jpg for the note) are downloaded as above and their paths printed; --into <dir> picks the folder
//        (and downloads them before the list is submitted too)
//   cards checklist wait <id> [--timeout <minutes, 30, max 240>] [--every <seconds, 20, min 5>]
//        exit 0 on submit (prints what get prints; a reopened list is waited on again), 3 on cancel, 4 on timeout
//   cards checklist pickup <id>     exit 2 when not submitted, 3 when already picked up. The owner may reopen a submitted list to change it: it is then `open` again
//        with `revision n` (list and get print it, and get keeps the replaced submission as `previous`), `wait` waits for the new submission, and pickup
//        writes pickup-<n>.json for it, so an answer you already picked up is never mistaken for the new one.
//   cards checklist cancel <id>     exit 3 when already cancelled or submitted
//   cards request list [--project <p>] [--open | --approved] [--target pc|cloud|hermes]   --approved: signed, not yet taken, not stopped, declined, finished or expired
//   cards request take <id> --bead <b>                                exit 3 when already taken; exit 4 for a request with a
//        preset (a dispatched run starts only from its approval)
//   cards request take <id> --runner pc|cloud --nonce <n> [--session <id or link>]   a runner claims an approval it has verified
//                                                                   exit 5 (stopped, declined or finished) means: do not start the run
//        (taken.json with the nonce, no bead); exit 5 when the nonce is not the approval's
//   cards request verify <id> [--target pc|cloud] [--repo owner/name]   check the owner's signature and every limit; prints one JSON line
//        { id, project, repo, target, limits, nonce, preset }, or exits 5 with the first failed check (unsigned, bad-signature,
//        wrong-request, hash-mismatch, expired, bad-limits, no-run-block, stopped, declined, finished, nonce-used, wrong-target, wrong-repo;
//        a hermes approval is always wrong-target here, and an unreadable taken.json is nonce-used).
//        The public key: HUB_SIGNING_PUBKEY (base64 SPKI or PEM), else the file BUW_APPROVAL_PUBKEY names, else
//        ~/.buw/secrets/approval-signing-key.pub; none is exit 5
//   cards request brief <id> [--target pc|cloud] [--repo owner/name]                                          verify, then print the run's brief (exit 5 when invalid)
//   cards request run <id> --state started|working|turn-ended|usage-limit [--last <text>] [--link <url>]   a progress file (secrets masked)
//   cards request finish <id> --outcome pr|card|failed --summary <s> [--pr <url>] [--card <link>] [--reason <r>] [--report <file.md>]
//        report.md then result.json, both create-only (exit 3 when result.json exists); posts pr-opened or alert
//   cards request state <id>                                          proposed | approved | taken | running | stopping | stopped | done | failed | lost | expired | declined
//   cards request card <id>                                           the card a finished request made, as <section>/<folder> (its result's card); exit 3 and "No card yet." when there is none
//   cards request create --project <p> --text <t> [--when next-sprint|nightly|record] [--by <name>]
//        [--preset <id> [--title <t>] [--repo owner/name] [--needs unity,gpu,comfyui,sprite-studio,lan,local-files]
//        [--target pc|cloud|hermes|at-pc] [--done-when <t>] [--origin-run <id>]]
//        --preset makes a request the owner approves in the Hub (no --when); it pings #needs-you like an Ask, linking
//        /#/~hub/request/<id>. --target is only a proposal. origin is { kind: run } when --origin-run or BUW_REQUEST_ID
//        is set, else { kind: agent }; never owner.
//   cards sheet put --request <id> --stamp <YYYYMMDDTHHMMSSZ-xxxx> --png <file> --meta <file>   an avatar sheet run's sheet: team/<agent>/sheet-<stamp>.png, then .json (create-only).
//        The agent is the one on that request (preset agent-avatar-sheet), never an argument. The JSON must name the request in source.request. PC runs reach it through run-sheet.mjs.
//   cards beads push --project <p> [--from <file.jsonl>] [--copy <id>]   this worktree's Beads copy (`bd export` by default; <id> defaults to <host>-<hash of the worktree root>)
//   cards mark list --project <p> [--json]                            the owner's marks on the Roadmap that no agent has applied yet (bead, verdict, time, reason), oldest first
//   cards mark apply --project <p> [--json]                           the PC's step for each active mark: bd close / bd label remove, cancel the bead's open Asks and checklists; writes NO owner file and no applied note (cards mark applied does, after the push)
//   cards apply pending --project <p> --json                          what is waiting for the PC: { plans: [answered change-list Ask ids not picked up], marks: n }; read-only
//   cards mark applied --project <p> --bead <id>                      after `bd close` (done, not-needed) or `bd label remove <id> needs-owner` (unblock): writes the applied note for the active mark; "nothing to apply" and exit 0 when there is none
//   cards feedback list [--project <p>] [--unfiled] [--json]          the owner's Not useful records (key, kind, id, project, reason, time, bead or -); --unfiled keeps those no session has filed as a bug. Only records the Hub wrote count; others end in an "ignored (not written by the Hub): n" line
//   cards feedback show --project <p> --key <key> [--json]            one record with its copy (what a fix's regression fixture is made from)
//   cards feedback body --project <p> --key <key>                     the bead description to file it with: reason, item, source, title, the bead it named and the show command; never the copy
//   cards feedback filed --project <p> --key <key> --bead <id>        after `bd create`: writes the filed note (create-only); prints "already filed as <X>: close yours ..." when an earlier note names another bead
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Node's fetch ignores HTTPS_PROXY unless told at startup (Node 22.21 and later), and a cloud
// session reaches the internet only through its proxy. Start again with it on; an older Node
// ignores the variable and carries on as before.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const again = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(again.status ?? 1);
}

const MAX_INLINE = 4 * 1024 * 1024;
const USAGE = 'Usage: npm run cards -- login | sections | list <section> | get <ref> [--into <folder>] [--text | --all] | link <ref> | put <folder> --section <s> --card <id> [--dry-run] [--agent <name> --why <text> [--context chat|job:<id>] [--edit] [--remove]]  [--via s3|api]\n'
  + '       npm run cards -- event <kind> --title <t> [--pr-closed-at <iso>] | pr-sync --repo <owner/repo> --project <p> --prefix <p> [--days 7] [--dry-run] | ask create|list|get|pickup|cancel | checklist create|list|get|wait|pickup|cancel | request list|take|create [--preset <id> ...]|verify|brief|run|finish|state|card | sheet put | beads push --project <p> | mark list|apply|applied --project <p> | apply pending --project <p> --json | feedback list|show|body|filed --project <p>\n'
  + '       ask create --project <p> (--file ask.json | --question <t>) [--option <id>=<label>[@<image>]]... [--decision <text[|detail]>]... [--image <file>]... [--kind approval|verify|design|decision] [--changes <changes.json>] [--agent-edit <edit.json>]\n'
  + '       beads show --project <p> [--open] [--json] | plan apply <ask id> [--dry-run] [--again] [--journal <file>] | apply pending --project <p> --json\n'
  + '       checklist create --project <p> (--file checklist.json | --title <t> --item <text> [--command <cmd> [--shell bash|powershell|cmd]]...) [--kind verify|setup|investigate|develop] [--playtest --build <https url> [--platform <p>] [--look-for <t>]] [--prose-ok]';
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** The cards bucket this machine knows of: BUW_S3_BUCKET, else the first one the registry names. */
async function knownBucket(env = process.env) {
  if (env.BUW_S3_BUCKET) return env.BUW_S3_BUCKET;
  const file = env.BUW_REGISTRY || path.join(os.homedir(), '.buw', 'workspaces.json');
  try {
    const registry = JSON.parse(await readFile(file, 'utf8'));
    const url = (registry.workspaces ?? []).map(item => item?.bucket).find(value => /^s3:\/\/[^/]+/.test(value ?? ''));
    return url ? /^s3:\/\/([^/]+)/.exec(url)[1] : null;
  } catch {
    return null;
  }
}

/**
 * Straight to the bucket with this machine's AWS credentials: the card API's handler, run here.
 * Null when the repo's modules are not beside this file, or there is no bucket or no key.
 */
async function directTransport() {
  let s3, cardApi;
  try {
    s3 = await import('../api/s3.mjs');
    cardApi = await import('./handler.mjs');
  } catch {
    return null;
  }
  const bucket = await knownBucket();
  if (!bucket || !(await s3.loadCredentials())) return null;
  const local = randomBytes(24).toString('hex');
  const handle = cardApi.createCardApi({
    bucket: s3.createBucket({ bucket, region: process.env.BUW_S3_REGION, endpoint: process.env.BUW_S3_ENDPOINT || undefined }),
    tokens: [{ name: 'local', hash: sha256(local), rights: { read: null, write: null, delete: null } }],
    prefix: process.env.BUW_S3_PREFIX || 'sections',
  });
  return {
    label: `s3://${bucket} with this machine's AWS credentials`,
    async send(method, route, { headers, body }) {
      const url = new URL(route, 'http://local');
      const result = await handle({
        requestContext: { http: { method } },
        rawPath: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: { ...headers, authorization: `Bearer ${local}` },
        body: body === undefined ? undefined : Buffer.from(body).toString('base64'),
        isBase64Encoded: true,
      });
      return new Response(Buffer.from(result.body, result.isBase64Encoded ? 'base64' : 'utf8'), { status: result.statusCode, headers: result.headers });
    },
  };
}

// filled in by the card API when it serves this file (handler.mjs)
const SERVED_API = '';

const PASSWORD_FILE = () => process.env.BUW_CARDS_PASSWORD_FILE || path.join(os.homedir(), '.buw', 'card-api-password');

/** "cardApi" from ~/.buw/config.json (BUW_CONFIG moves it), or ''. */
function configuredApi() {
  try {
    const file = process.env.BUW_CONFIG || path.join(os.homedir(), '.buw', 'config.json');
    const value = JSON.parse(readFileSync(file, 'utf8')).cardApi;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** The card API's address: BUW_CARD_API, else config.json, else the host that served this file, else ''. */
const apiBase = () => (process.env.BUW_CARD_API || configuredApi() || SERVED_API).replace(/\/+$/, '');

/** The site people open cards on: BUW_SITE_URL, else "siteUrl" in hub.json or config.json, else the API's address without its leading "api.". '' when nothing says. */
async function siteBase() {
  let configured = '';
  try { configured = JSON.parse(readFileSync(process.env.BUW_CONFIG || path.join(os.homedir(), '.buw', 'config.json'), 'utf8')).siteUrl; } catch { /* no config */ }
  const named = [process.env.BUW_SITE_URL, (await hubConfig())?.siteUrl, configured].find(value => typeof value === 'string' && value.trim());
  if (named) return named.trim().replace(/\/+$/, '');
  try {
    const url = new URL(apiBase());
    if (!/^api\./i.test(url.hostname)) return '';
    url.hostname = url.hostname.slice(4);
    return url.origin;
  } catch {
    return '';
  }
}

/** The address a person opens a card at, or '' when the site is not known. Never the card API or the /w/ file host. */
async function cardLink(section, id) {
  const site = await siteBase();
  return site ? `${site}/${encodeURIComponent(section)}#/${encodeURIComponent(id)}` : '';
}

/** apiBase(), or an error saying where to set it. */
function requireApi() {
  const api = apiBase();
  if (!api) throw new Error('No card API is set: set BUW_CARD_API, or "cardApi" in ~/.buw/config.json.');
  return api;
}

/** The passphrase: BUW_CARDS_PASSWORD, else the file `login` wrote, else none. */
async function password() {
  if (process.env.BUW_CARDS_PASSWORD) return { token: process.env.BUW_CARDS_PASSWORD, from: 'BUW_CARDS_PASSWORD' };
  try {
    const token = (await readFile(PASSWORD_FILE(), 'utf8')).trim();
    if (token) return { token, from: PASSWORD_FILE() };
  } catch {}
  return { token: '', from: null };
}

/**
 * Over HTTPS to the card API. With no passphrase it sends no Authorization header: a Claude Code
 * cloud secret adds the header on its way out, and the session never holds the value.
 */
function apiTransport(api, { token, from }) {
  const label = `the card API at ${api}${from ? '' : ' (no passphrase here; relying on the environment to add it)'}`;
  return {
    label,
    anonymous: !token,
    send: (method, route, { headers, body }) => fetch(`${api}${route}`, { method, headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers, body }),
  };
}

/** Ask for the passphrase without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return reject(new Error('login needs a terminal to type the passphrase into.'));
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let typed = '';
    const done = value => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      value === null ? reject(new Error('Cancelled.')) : resolve(value);
    };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(typed);
        if (char === '\u0003') return done(null);
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else if (char >= ' ') typed += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** `login`: ask for the passphrase, check it against the API, and keep it for later runs. */
async function login() {
  const api = requireApi();
  const token = (await askHidden(`Card API passphrase (for ${api}): `)).trim();
  if (!token) throw new Error('No passphrase typed.');
  const response = await fetch(`${api}/sections`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new Error('The card API does not know that passphrase. Nothing was saved.');
  if (!response.ok) throw new Error(`GET /sections: ${response.status}. Nothing was saved.`);
  const { sections } = await response.json();
  const file = PASSWORD_FILE();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  console.log(`Saved to ${file} (readable by you only, where the system allows). ${sections.length} section(s): ${sections.map(item => item.id).join(', ')}`);
}

async function pickTransport(via) {
  if (via && !['s3', 'api'].includes(via)) throw new Error('--via is s3 or api.');
  // The API first: one passphrase, the same everywhere. S3 when asked for, or when there is no
  // passphrase and this machine has keys.
  const pass = await password();
  if (via !== 's3' && (pass.token || via === 'api')) return apiTransport(requireApi(), pass);
  const direct = await directTransport();
  if (direct) return direct;
  if (via === 's3') throw new Error('No way to the bucket here: needs AWS credentials (env or ~/.aws/credentials) and BUW_S3_BUCKET or a registered workspace bucket.');
  return apiTransport(requireApi(), pass);
}

const noPassphrase = () => 'The card API wants its passphrase, and none reached it. On a terminal, run `node cards.mjs login` '
  + '(or `npm run cards -- login`) once. In a Claude Code cloud environment, add a secret for '
  + `${new URL(apiBase()).host} with the header Authorization: Bearer <passphrase>. Elsewhere, set BUW_CARDS_PASSWORD.`;

let transport;
async function call(method, route, { body, raw, contentType, headers: extra = {} } = {}) {
  const response = await send(method, route, {
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : raw !== undefined ? { 'content-type': contentType || 'application/octet-stream' } : {}), ...extra },
    body: body !== undefined ? JSON.stringify(body) : raw,
  });
  if (response.status === 401 && transport.anonymous) throw Object.assign(new Error(noPassphrase()), { status: 401 });
  if (raw === undefined && method === 'GET' && route.includes('/files/')) {
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const moved = data.movedTo?.section && !String(data.error).includes(data.movedTo.section) ? ` Moved to ${data.movedTo.section}${data.movedTo.folder ? `/${data.movedTo.folder}` : ''}.` : '';
    throw Object.assign(new Error(`${method} ${route}: ${response.status} ${data.error ?? ''}${moved}`), { status: response.status, data });
  }
  return data;
}

const enc = value => value.split('/').map(encodeURIComponent).join('/');
const md5 = buffer => createHash('md5').update(buffer).digest('hex');

async function filesUnder(root) {
  const found = [];
  const visit = async (dir, relative) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  await visit(root, '');
  return found.map(file => file.slice(1)).sort();
}

async function readRegistry(folder) {
  try {
    return JSON.parse(await readFile(path.join(folder, 'workspace.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { entities: [] };
    throw error;
  }
}

/** The etags `get` read, kept beside the workspace.json it writes: { "<section>/<path>": "<etag>" }. A `put --edit` is conditional on these. */
const BASE_FILE = '.cards-base.json';

async function readBase(folder) {
  try {
    const value = JSON.parse(await readFile(path.join(folder, BASE_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The one card a link or a name means; several stop the run with the list. */
async function resolveCard(ref) {
  const { matches } = await call('GET', `/resolve?ref=${encodeURIComponent(ref)}`);
  if (matches.length > 1) {
    console.error(`"${ref}" matches several cards; name one as section/card:`);
    for (const match of matches) console.error(`  ${match.section}/${match.id}  ${match.title}`);
    process.exit(2);
  }
  return matches[0];
}

/** `link <ref>`: only the address on stdout, so a script can use it. */
async function link(ref) {
  const { section, id } = await resolveCard(ref);
  const address = await cardLink(section, id);
  if (!address) throw new Error('The site is not known: set BUW_SITE_URL, or "siteUrl" in ~/.buw/config.json.');
  console.log(address);
}

/** The line `get` and `put` end with, so an agent copies the right address instead of building one. */
async function printCardLink(section, id) {
  const address = await cardLink(section, id);
  if (address) console.log(`Link to give people: ${address}`);
}

/** Files `get` reads as text. Anything else is media: skipped by --text, and over MEDIA_LIMIT skipped by default (--all takes everything). */
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.xml', '.svg', '.log']);
const MEDIA_LIMIT = 1024 * 1024;
const GET_PARALLEL = 8;
/** What `get` left out, beside .cards-base.json: { "<section>/<path>": size }. `put` never reads these as removed. */
const SKIPPED_FILE = '.cards-skipped.json';

async function readSkipped(folder) {
  try {
    const value = JSON.parse(await readFile(path.join(folder, SKIPPED_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const isText = file => TEXT_EXT.has(path.extname(file).toLowerCase());
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function get(ref, into, { text = false, all = false } = {}) {
  const { section, id } = await resolveCard(ref);
  const card = await call('GET', `/sections/${section}/cards/${encodeURIComponent(id)}`);
  const etags = {};
  const skipped = card.files.filter(file => !all && !isText(file.path) && (text || file.size > MEDIA_LIMIT));
  const left = new Set(skipped);
  const wanted = card.files.filter(file => !left.has(file));
  // A few at a time: one by one took minutes on a card of hundreds of files. The API host throttles
  // (429): the pool halves when it does, waits as long as Retry-After says, and grows back after a run of successes.
  const pool = { allowed: GET_PARALLEL, active: 0, streak: 0, bucket: true };
  const base429 = Number(process.env.BUW_CARDS_RETRY_MS) || 500;
  const readInline = async route => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await send('GET', route, { headers: {} }, { retry: false }).catch(error => {
        if (attempt >= 8) throw error;
        return null;
      });
      if (response && response.status !== 429 && response.status < 500) { pool.streak += 1; if (pool.streak >= 20 && pool.allowed < GET_PARALLEL) { pool.allowed += 1; pool.streak = 0; } return response; }
      if (attempt >= 8) return response;
      pool.streak = 0;
      pool.allowed = Math.max(1, Math.floor(pool.allowed / 2));
      const told = Number(response?.headers.get('retry-after'));
      await delay(Math.min(10000, told > 0 ? told * 1000 : base429 * 2 ** Math.min(attempt, 4)) * (0.8 + Math.random() * 0.4));
    }
  };
  await mapLimit(wanted, GET_PARALLEL, async file => {
    while (pool.active >= pool.allowed) await delay(20);
    pool.active += 1;
    try {
      const target = path.join(into, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      // From the bucket by the short-lived URL the card listing gave (the API host throttles per request, and
      // 850 requests through it took minutes). A session that reaches only the API host fails that fetch once, and
      // every file after it goes through the API instead (up to 4 MB each; a bigger one has only its URL).
      let body;
      let response;
      if (pool.bucket) {
        try {
          response = await fetch(file.url);
        } catch {
          if (file.size > MAX_INLINE) throw new Error(`Could not download ${file.path}: the bucket is not reachable from here.`);
          pool.bucket = false;
        }
        if (response && !response.ok) {
          if (file.size > MAX_INLINE) throw new Error(`GET ${file.path}: ${response.status}`);
          response = undefined;
        }
      }
      if (!response) {
        if (file.size > MAX_INLINE) response = await fetch(file.url);
        else {
          const route = `/sections/${section}/files/${enc(file.path)}`;
          response = await readInline(route);
          if (response.status === 401 && transport.anonymous) throw Object.assign(new Error(noPassphrase()), { status: 401 });
          if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${await response.text()}`);
        }
      }
      body = Buffer.from(await response.arrayBuffer());
      // The etag of the very bytes read, so a later edit is conditional on what was seen and not on a newer listing.
      const etag = response.headers.get('etag')?.replace(/^W\//, '').replace(/^"|"$/g, '');
      if (etag && file.size <= MAX_INLINE) etags[`${section}/${file.path}`] = etag;
      await writeFile(target, body);
    } finally {
      pool.active -= 1;
    }
  });
  const registry = await readRegistry(into);
  const entities = [...(registry.entities ?? []).filter(item => item?.id !== card.entity.id), card.entity];
  await mkdir(into, { recursive: true });
  await writeFile(path.join(into, 'workspace.json'), `${JSON.stringify({ ...registry, entities }, null, 2)}
`);
  const prefix = `${section}/${card.entity.folder}/`;
  const base = { ...(await readBase(into)) };
  for (const key of Object.keys(base)) if (key.startsWith(prefix)) delete base[key];
  await writeFile(path.join(into, BASE_FILE), `${JSON.stringify({ ...base, ...etags }, null, 2)}
`);
  const before = { ...(await readSkipped(into)) };
  for (const key of Object.keys(before)) if (key.startsWith(prefix)) delete before[key];
  const left_out = Object.fromEntries(skipped.map(file => [`${section}/${file.path}`, file.size]));
  const record = { ...before, ...left_out };
  if (Object.keys(record).length) await writeFile(path.join(into, SKIPPED_FILE), `${JSON.stringify(record, null, 2)}
`);
  else await rm(path.join(into, SKIPPED_FILE), { force: true });
  console.log(`${section}/${id} -> ${path.join(into, card.entity.folder)} (${wanted.length} file(s)); entry in ${path.join(into, 'workspace.json')}`);
  if (skipped.length) {
    const total = skipped.reduce((sum, file) => sum + file.size, 0);
    console.log(`Left out ${skipped.length} file(s), ${mb(total)}, ${text ? 'not text' : 'media over 1 MB'}:`);
    for (const file of skipped.slice(0, 10)) console.log(`  ${file.path}  (${mb(file.size)})`);
    if (skipped.length > 10) console.log(`  ... and ${skipped.length - 10} more`);
    console.log('get --all brings everything. They stay in the section: put will not remove them.');
  }
  await printCardLink(section, id);
}

/** What `sections` says about where this token may write. */
const ACCESS_WORDS = { direct: 'write', library: 'add', read: 'read' };
const AGENT_RE = /^[A-Za-z0-9][\w .-]{0,39}$/;
const CONTEXT_RE = /^(chat|job)(:[A-Za-z0-9._-]{1,120})?$/;

/**
 * Upload a card folder, then its entry. It removes nothing unless `remove` is set, in every section.
 * `access` (from GET /sections/<s>) is `library`: files are only created, an edit needs `--edit`, the
 * etag `get` recorded, and who and why; `direct`: as before, with the delete step behind `--remove`.
 */
async function put(folder, section, id, dryRun, { agent, why, context, edit = false, remove: removeGone = false } = {}) {
  const registry = await readRegistry(folder);
  const entity = registry.entities?.find(item => item?.id === id);
  if (!entity) throw new Error(`${path.join(folder, 'workspace.json')} has no card "${id}".`);
  const local = await filesUnder(path.join(folder, entity.folder));
  if (!local.length) throw new Error(`${path.join(folder, entity.folder)} has no files.`);
  if (agent !== undefined && !AGENT_RE.test(agent)) throw new Error('--agent is 1 to 40 characters: letters, digits, space, dot, dash, underscore, starting with a letter or digit.');
  if (context !== undefined && !CONTEXT_RE.test(context)) throw new Error('--context is chat or job:<id>.');
  const reason = why === undefined ? undefined : why.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (why !== undefined && !reason) throw new Error('--why needs some text.');

  let access = 'direct';
  try {
    access = (await call('GET', `/sections/${section}`)).access ?? 'direct';   // an older API has no field
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const library = access === 'library';
  const refusals = [];
  if (access === 'read') refusals.push(`This token may not add to ${section}. Write to assistant instead.`);

  let remote = [];
  try {
    remote = (await call('GET', `/sections/${section}/cards/${encodeURIComponent(id)}`)).files;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const remoteByPath = new Map(remote.map(file => [file.path, file]));
  const base = await readBase(folder);
  const leftOut = await readSkipped(folder);
  const fresh = [];
  const changed = [];
  for (const file of local) {
    const body = await readFile(path.join(folder, entity.folder, ...file.split('/')));
    const key = `${entity.folder}/${file}`;
    const there = remoteByPath.get(key);
    if (!there) fresh.push({ key, body });
    else if (there.etag !== md5(body)) changed.push({ key, body, listed: there.etag, seen: base[`${section}/${key}`] });
  }
  const upload = [...fresh, ...changed];
  const localKeys = new Set(local.map(file => `${entity.folder}/${file}`));
  const absent = remote.map(file => file.path).filter(key => !localKeys.has(key));
  const notFetched = absent.filter(key => `${section}/${key}` in leftOut);   // get left these out: not here, never removed
  const gone = absent.filter(key => !notFetched.includes(key));
  const remove = removeGone ? gone : [];
  const kept = [...(removeGone ? [] : gone), ...notFetched];
  const unchanged = local.length - upload.length;

  if (library) {
    if (removeGone) refusals.push(`--remove is not allowed in ${section}: a project section only takes new files and edits.`);
    if (changed.length && !edit) refusals.push(`These files differ from the bucket, and a change needs --edit (run get first, then edit, then put --edit):\n${changed.map(item => `  ${item.key}`).join('\n')}`);
    if (edit) {
      const unread = changed.filter(item => !item.seen).map(item => item.key);
      if (unread.length) refusals.push(`get did not record the version of these files, so an edit cannot be conditional on it; run get again into a fresh folder:\n${unread.map(key => `  ${key}`).join('\n')}`);
    }
    const big = upload.filter(item => item.body.length > MAX_INLINE).map(item => item.key);
    if (big.length) refusals.push(`A project section takes files through the API, at most 4 MB each:\n${big.map(key => `  ${key}`).join('\n')}`);
    if (!dryRun && !agent) refusals.push('--agent <name> is needed to write to a project section.');
    if (!dryRun && !reason) refusals.push('--why <text> is needed to write to a project section.');
  }

  if (library) {
    console.log(`${section}/${id}: ${fresh.length} new, ${changed.length} edit, ${unchanged} unchanged, ${kept.length} kept (in the bucket, not here)`);
  } else {
    console.log(`${section}/${id}: ${upload.length} to upload, ${remove.length} to remove, ${unchanged} unchanged${kept.length ? `, ${kept.length} kept (in the bucket, not here; add --remove to remove)` : ''}`);
  }
  for (const { key } of fresh) console.log(`  + ${key}`);
  for (const { key } of changed) console.log(`  ~ ${key}`);
  for (const key of remove) console.log(`  - ${key}`);
  for (const key of kept) console.log(`  = ${key}  (kept${notFetched.includes(key) ? ', left out by get' : ''})`);
  if (notFetched.length) console.log(`${notFetched.length} left out by get, not removed (get --all brings them).`);
  if (kept.length > notFetched.length && !library) console.log('Note: put removes nothing without --remove. Before, a file gone from this folder was removed from the section.');
  if (refusals.length) {
    for (const text of refusals) console.error(`Refused: ${text}`);
    throw new Exit(2);
  }
  if (dryRun) return;

  const headers = {
    ...(agent ? { 'x-card-agent': agent } : {}),
    ...(reason ? { 'x-card-why': encodeURIComponent(reason) } : {}),
    ...(agent || library ? { 'x-card-context': context ?? 'chat' } : {}),
    'x-card-batch': rand(8),
  };
  const conditions = item => (!remoteByPath.has(item.key) ? { 'if-none-match': '*' } : { 'if-match': `"${library ? item.seen : item.seen ?? item.listed}"` });
  const big = upload.filter(item => item.body.length > MAX_INLINE);
  const urls = big.length ? new Map((await call('POST', `/sections/${section}/uploads`, { body: { files: big.map(item => ({ path: item.key })) } })).uploads.map(item => [item.path, item.url])) : new Map();
  const done = [];
  let unrecorded = false;
  const lost = (error, what) => {
    console.error(`Stopped: ${what} changed in the bucket since it was read (${error.status}${error.data?.error ? ` ${error.data.error}` : ''}).`);
    console.error(done.length ? `Already uploaded: ${done.join(', ')}. A rerun skips what matches; run get into a fresh folder to see the other change.` : 'Nothing was uploaded.');
    throw new Exit(3);
  };
  for (const item of upload) {
    if (item.body.length > MAX_INLINE) {
      const response = await fetch(urls.get(item.key), { method: 'PUT', body: item.body });
      if (!response.ok) throw new Error(`Upload of ${item.key} failed: ${response.status} ${await response.text()}`);
    } else {
      try {
        const answer = await call('PUT', `/sections/${section}/files/${enc(item.key)}`, { raw: item.body, headers: { ...headers, ...conditions(item) } });
        if (answer.recorded === false) unrecorded = true;
      } catch (error) {
        if (error.status === 412 || error.status === 409) lost(error, item.key);
        throw error;
      }
    }
    done.push(item.key);
  }
  for (const key of remove) await call('DELETE', `/sections/${section}/files/${enc(key)}`);
  let result;
  try {
    result = await call('PUT', `/sections/${section}/cards/${encodeURIComponent(id)}`, { body: entity, headers });
  } catch (error) {
    if (error.status === 412 || error.status === 409) lost(error, `the card list entry for ${id}`);
    throw error;
  }
  if (result.recorded === false) unrecorded = true;
  if (result.ignored?.length) console.log(`The card list kept its own ${result.ignored.join(', ')}: an agent only adds new tabs to an existing card, so those changes did nothing.`);
  console.log(`${result.unchanged ? 'Nothing to change in' : result.created ? 'Added' : 'Updated'} ${section}/${id}${agent ? ` as ${agent}` : ''}.`);
  if (unrecorded) console.error('Warning: this write was not recorded, so it has no row and no Revert in the Hub.');
  await printCardLink(section, id);
}

// ---------------------------------------------------------------------------------------------
// The inbox: events, Asks, requests and Beads copies, all files in the hidden `inbox` section.
// ---------------------------------------------------------------------------------------------

const EVENT_KINDS = ['session-started', 'session-ended', 'blocked', 'ready-for-review', 'pr-opened', 'pr-merged', 'pr-closed', 'ci-failed', 'ci-passed', 'deployed', 'ask-created', 'alert', 'review-done', 'resumed', 'checklist-created', 'checklist-submitted', 'checklist-reopened'];
const WHEN = ['next-sprint', 'nightly', 'record'];
// The handler's filter on file names; checked here too, so a bad name fails before it is sent.
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;
const SECRET_WORDS = /token|secret|password|credential/i;
const DAY = 24 * 3600 * 1000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** An error that ends the command with a given exit code (3: someone else got there first). */
class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const hostName = () => (os.hostname() || 'host').toLowerCase().replace(/[^a-z0-9-]/g, '-');
/** The Claude Code session this command runs in. Claude Code sets CLAUDE_CODE_SESSION_ID; CLAUDE_SESSION_ID is the older name. Shown, never trusted for routing. */
const sessionEnv = () => process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '';
const rand = bytes => randomBytes(bytes).toString('hex');
const isoNow = () => new Date().toISOString();
const clip = (text, length) => (String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, length));

/** Every inbox path goes through here: lower-case ids, no `..`, no names the card API would refuse. */
function inboxPath(...parts) {
  const clean = parts.join('/').split('/').filter(part => part !== '');
  if (clean.length < 2 || clean.some(part => part === '.' || part === '..' || part.startsWith('.') || /[\\\0]/.test(part)) || clean[0].startsWith('_')) {
    throw new Error(`Not an inbox path: ${parts.join('/')}`);
  }
  const joined = clean.join('/');
  if (SECRET.test(joined)) throw new Error(`${joined} looks like a secret, so the card API would refuse it.`);
  return joined;
}

/** "Should we rotate the API token?" → "should-we-rotate-the-api"; the words the file-name filter refuses are dropped. */
function slugOf(text, words = 5) {
  const slug = String(text ?? '').toLowerCase().split(/\s+/)
    .map(word => word.replace(/[^a-z0-9]+/g, ''))
    .filter(word => word && !SECRET_WORDS.test(word))
    .slice(0, words).join('-');
  return slug || 'item';
}

const idSafe = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');   // 20261026T143012
const newId = (project, text) => `${stamp().slice(0, 8)}-${idSafe(project)}-${slugOf(text)}-${rand(2)}`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRIES = 3;
/** One request, retried on network errors, 429 and 5xx: 500 ms, 1 s, 2 s, each give or take 20%. */
async function send(method, route, options, { retry = true } = {}) {
  const base = Number(process.env.BUW_CARDS_RETRY_MS) || 500;
  for (let attempt = 0; ; attempt += 1) {
    const last = !retry || attempt >= RETRIES;
    let response;
    try {
      response = await transport.send(method, route, options);
    } catch (error) {
      if (last) throw error;
    }
    if (response && !(response.status === 429 || response.status >= 500)) return response;
    if (last) return response;
    await delay(base * 2 ** attempt * (0.8 + Math.random() * 0.4));
  }
}

/** The inbox section: `inbox`, or `inbox-<name>` for the development copy (BUW_INBOX_SECTION). */
const INBOX_RE = /^inbox(-[a-z0-9]+)?$/;
const INBOX = (() => {
  const wanted = process.env.BUW_INBOX_SECTION || 'inbox';
  if (!INBOX_RE.test(wanted)) {
    console.error(`BUW_INBOX_SECTION must be "inbox" or "inbox-<name>", not "${wanted}".`);
    process.exit(2);
  }
  return wanted;
})();
const fileRoute = file => `/sections/${INBOX}/files/${enc(file)}`;
const failure = async (method, route, response) => {
  if (response.status === 401 && transport.anonymous) return new Error(noPassphrase());
  const data = await response.json().catch(() => ({}));
  return Object.assign(new Error(`${method} ${route}: ${response.status} ${data.error ?? ''}`.trim()), { status: response.status });
};

/**
 * Put one inbox file. Resolves { state: 'ok' | 'exists' | 'transient' }: 'exists' is a 412 on a
 * create-only write, 'transient' a network error, 429 or 5xx that outlasted the retries. Anything
 * else (a 4xx) throws.
 */
async function putInbox(file, body, { createOnly = false, contentType = 'application/json', retry = true, section = INBOX } = {}) {
  const route = `/sections/${section}/files/${enc(file)}`;
  let response;
  try {
    response = await send('PUT', route, { headers: { 'content-type': contentType, ...(createOnly ? { 'if-none-match': '*' } : {}) }, body }, { retry });
  } catch (error) {
    return { state: 'transient', reason: error.cause?.code ?? error.message };
  }
  if (response.ok) return { state: 'ok' };
  if (response.status === 412) return { state: 'exists' };
  if (response.status === 429 || response.status >= 500) return { state: 'transient', reason: `HTTP ${response.status}` };
  throw await failure('PUT', route, response);
}

/** A write that must land: a transient failure is an error here, and 'exists' is for the caller. */
async function mustPut(file, body, options) {
  const result = await putInbox(file, body, options);
  // A create-only retry that gets 412 may be meeting its own first write, whose answer was lost.
  if (result.state === 'exists' && typeof body === 'string' && await readInbox(file).catch(() => null) === body) return 'ok';
  if (result.state === 'transient') throw new Error(`Could not write inbox/${file} (${result.reason}). Nothing was spooled; run it again.`);
  return result.state;
}

/** The text of an inbox file, or null when it is not there. */
async function readInbox(file) {
  const route = fileRoute(file);
  const response = await send('GET', route, { headers: {} });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure('GET', route, response);
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

async function readJson(file) {
  const text = await readInbox(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Files under a prefix, as the API lists them. A prefix keeps to a month or a day, so it stays under the 1000 cap. */
async function listInbox(prefix) {
  const route = `/sections/${INBOX}/files?prefix=${encodeURIComponent(prefix)}`;
  const response = await send('GET', route, { headers: {} });
  if (!response.ok) throw await failure('GET', route, response);
  const { files, truncated } = await response.json();
  if (truncated) console.error(`(listing of ${prefix} was cut at ${files.length}; narrow it)`);
  return files.map(file => file.path);
}

// --- the spool: events that could not be sent, shared with the hub-hooks mod ---

const spoolFile = () => process.env.BUW_SPOOL || path.join(os.homedir(), '.buw', 'spool.jsonl');

async function spool(entry) {
  const file = spoolFile();
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ v: 1, at: isoNow(), kind: 'put', section: INBOX, contentType: 'application/json', createOnly: true, ...entry })}\n`);
}

/**
 * The only files a spooled `put` may write: an event (`events/<yyyy-mm-dd>/<name>.json`, what this client spools) and a run's progress file
 * (`requests/<id>/run-<stamp>-<rand4>.json`, what the hub-hooks mod spools, replayed only inside the run that owns that request). The spool is a plain file any local process can append to, and a
 * replay runs under whichever token the next command holds, so anything else (ask.json, request.json, approvals, stops, grants, answers) is
 * dropped, never sent: otherwise a line could get an Ask marked as the PC watcher's, or replace the mark of a request.
 */
const SPOOL_EVENT = /^events\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.json$/;
const SPOOL_RUN_FILE = /^requests\/([A-Za-z0-9._-]+)\/run-\d{8}T\d{9}Z-[a-z0-9]{4}\.json$/;
/**
 * A run file is replayed only by the run it belongs to: a PC run (BUW_RUN_FOLDER=1, which the watcher does not have) and its own request, read from the
 * run checkout's `.claude/run-current.json` (beside this client in `.claude/bin/`, else under the working directory). Anywhere else, a spooled run file is
 * dropped: under the watcher's token it would let a local process plant a future-stamped run file (a dead run reads as running) or fake timeline lines.
 */
function ownRunRequest() {
  if (process.env.BUW_RUN_FOLDER !== '1') return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of [path.join(here, '..', 'run-current.json'), path.join(process.cwd(), '.claude', 'run-current.json')]) {
    try {
      const id = JSON.parse(readFileSync(file, 'utf8'))?.requestId;
      if (typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id)) return id;
    } catch { /* no such file: try the next */ }
  }
  return null;
}
const spoolable = (file, ownRequest) => {
  if (typeof file !== 'string' || file.includes('..')) return false;
  if (SPOOL_EVENT.test(file)) return true;
  const run = SPOOL_RUN_FILE.exec(file);
  return !!run && ownRequest !== null && run[1] === ownRequest;
};

/**
 * Send up to 20 spooled `put` entries, oldest first. Only the two shapes above are replayed, always as a create-only JSON file. Sent (200) or already there (412) or older
 * than a day (or with no readable time): dropped. Any other answer, 4xx included (this command's
 * token may just be unable to write the inbox), or no answer: kept. Other kinds of line belong to the hooks and stay.
 */
async function replaySpool() {
  const file = spoolFile();
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const ownRequest = ownRunRequest();
  const keep = [];
  let tried = 0;
  let down = false;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;                                       // a torn line: drop it
    }
    if (entry?.v !== 1 || entry.kind !== 'put' || !INBOX_RE.test(String(entry.section)) || typeof entry.path !== 'string') {
      keep.push(line);
      continue;
    }
    if (!spoolable(entry.path, ownRequest) || typeof entry.body !== 'string') {
      console.error(`(spool: dropped a line for ${String(entry.path).replace(/[^\x20-\x7e]/g, '?').slice(0, 80)}: only events, and a run's own progress files, are replayed)`);
      continue;
    }
    if (!(Date.now() - Date.parse(entry.at) <= DAY)) continue;     // older than a day, or no readable time: expired
    if (down || tried >= 20) {
      keep.push(line);
      continue;
    }
    tried += 1;
    try {
      const result = await putInbox(inboxPath(entry.path), entry.body, { section: entry.section, createOnly: true, contentType: 'application/json', retry: false });
      if (result.state === 'transient') {
        down = true;
        keep.push(line);
      }
    } catch {
      // A refusal (401, 403, another 4xx) may be only this command's token: keep the line; the 24 h rule clears a truly bad one.
      keep.push(line);
    }
  }
  if (keep.length === lines.length && tried === 0) return;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, keep.length ? `${keep.join('\n')}\n` : '');
  await rename(temp, file);
}

// --- events ---

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

/**
 * The deterministic name of a PR close event: events/<UTC day of closedAt>/<HHMMSS>-gh-<owner>-<repo>-<n>-<merged|closed>.json.
 * The workflow's live post (--pr-closed-at) and `pr-sync` both build it here, so whichever comes second finds the file there.
 * `kind` is pr-merged or pr-closed, `url` a PR link, `closedAt` a date at most 5 minutes ahead of `now` and at most 30 days behind it.
 * Returns { file, ts }; throws on anything else.
 */
function prEventFile({ kind, url, closedAt, now = new Date() }) {
  if (kind !== 'pr-merged' && kind !== 'pr-closed') throw new Error('--pr-closed-at goes only with the event kinds pr-merged and pr-closed.');
  const match = PR_URL_RE.exec(String(url ?? ''));
  if (!match) throw new Error('--pr-closed-at needs --url to be a pull request link (https://github.com/<owner>/<repo>/pull/<n>).');
  const at = new Date(closedAt);
  if (!closedAt || Number.isNaN(at.getTime())) throw new Error(`--pr-closed-at is not a date: ${closedAt}`);
  if (at.getTime() > now.getTime() + 5 * 60000) throw new Error('--pr-closed-at is in the future.');
  if (at.getTime() < now.getTime() - 30 * DAY) throw new Error('--pr-closed-at is more than 30 days old.');
  const ts = at.toISOString();
  const tail = `-${match[3]}-${kind === 'pr-merged' ? 'merged' : 'closed'}.json`;
  const head = `${ts.slice(11, 19).replace(/:/g, '')}-gh-`;
  const slug = `${match[1]}-${match[2]}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 120 - head.length - tail.length);
  return { file: inboxPath('events', ts.slice(0, 10), `${head}${slug}${tail}`), ts };
}

function buildEvent(flags) {
  const kind = flags.kind;
  if (!EVENT_KINDS.includes(kind)) throw new Error(`Event kind is one of: ${EVENT_KINDS.join(', ')}.`);
  if (!flags.title) throw new Error('An event needs --title.');
  if (kind === 'ready-for-review' && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(String(flags.url ?? '')) && !(typeof flags.ask === 'string' && flags.ask.trim())) {
    console.error('A ready-for-review event needs a pull request link (--url <PR link>) or an ask (--ask "<what the owner should decide or do>"). Add the PR or the decision.');
    throw new Exit(2);
  }
  const closed = flags['pr-closed-at'] === undefined ? null : prEventFile({ kind, url: flags.url, closedAt: flags['pr-closed-at'] });
  const now = new Date();
  const host = hostName();
  const event = {
    ts: closed ? closed.ts : now.toISOString(), kind,
    ...(flags.project ? { project: flags.project } : {}),
    ...(flags.bead ? { bead: flags.bead } : {}),
    ...(flags.ask ? { ask: flags.ask } : {}),
    ...(flags.checklist ? { checklist: String(flags.checklist) } : {}),
    ...(flags.review ? { review: String(flags.review) } : {}),
    ...(sessionEnv() ? { session: sessionEnv() } : {}),
    host, source: flags.source || 'cli', title: String(flags.title),
    ...(flags.url ? { url: flags.url } : {}),
    ...(flags.summary ? { summary: String(flags.summary) } : {}),
  };
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  return { event, file: closed ? closed.file : inboxPath('events', now.toISOString().slice(0, 10), `${time}-${host}-${rand(3)}.json`) };
}

/** Post an event; when the API cannot be reached, keep it in the spool and say so. Never throws for that. */
async function postEvent(flags, { out = console.log } = {}) {
  const { event, file } = buildEvent(flags);
  const body = `${JSON.stringify(event, null, 2)}\n`;
  const result = await putInbox(file, body, { createOnly: true });
  if (result.state === 'transient') {
    await spool({ path: file, body });
    out(`spooled ${file} (${result.reason}); it is sent with the next inbox command`);
    return file;
  }
  out(result.state === 'exists' && flags['pr-closed-at'] !== undefined ? `exists ${file}` : file);
  return file;
}

// --- PR sync ---

const PR_SYNC_USAGE = 'Usage: pr-sync --repo <owner/repo> --project <p> --prefix <bead prefix> [--days 7] [--dry-run]';

/** The first bead id in text: `<prefix>-<3 to 10 letters or digits>` with optional .n parts, after the start or a non-alphanumeric. The same pattern as the Hub events workflow. */
function beadIn(text, prefix) {
  const found = new RegExp(`(^|[^a-z0-9])${prefix}-[a-z0-9]{3,10}(\\.[0-9]+)*`).exec(String(text ?? ''));
  return found ? found[0].replace(/^[^a-z0-9]+/, '') : '';
}

/** Post a close event for every pull request of a repository closed in the last --days days. Idempotent: the file names are deterministic and create-only. */
async function prSync(flags) {
  const repo = flags.repo;
  const prefix = flags.prefix;
  const days = flags.days === undefined ? 7 : Number(flags.days);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !flags.project || !prefix || !/^[a-z]{1,10}$/.test(prefix)) throw new Error(PR_SYNC_USAGE);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days is a whole number from 1 to 30.');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) { console.error('set GITHUB_TOKEN (on the PC: GITHUB_TOKEN=$(gh auth token))'); throw new Exit(2); }
  const base = (process.env.BUW_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const now = new Date();
  const cutoff = now.getTime() - days * DAY;
  const counts = { posted: 0, exists: 0, failed: 0 };
  let listFailed = false;
  const closedPrs = [];
  for (let page = 1; page <= 5; page += 1) {
    let response;
    try {
      response = await fetch(`${base}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'cards-pr-sync' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      console.error(`GitHub could not be reached (${error.cause?.code ?? error.message}).`);
      listFailed = true;
      break;
    }
    if (response.status !== 200) { console.error(`GitHub answered HTTP ${response.status} for the pull request list.`); listFailed = true; break; }
    const list = await response.json().catch(() => null);
    if (!Array.isArray(list)) { console.error('GitHub sent a pull request list that is not JSON.'); listFailed = true; break; }
    if (!list.length) break;
    closedPrs.push(...list);
    const last = Date.parse(list[list.length - 1]?.updated_at);
    if (Number.isFinite(last) && last < cutoff) break;
  }
  for (const pr of closedPrs) {
    const closedAt = Date.parse(pr?.closed_at);
    if (!Number.isFinite(closedAt) || closedAt < cutoff || typeof pr.html_url !== 'string') continue;
    const kind = pr.merged_at ? 'pr-merged' : 'pr-closed';
    let target;
    try { target = prEventFile({ kind, url: pr.html_url, closedAt: pr.closed_at, now }); } catch (error) { counts.failed += 1; console.log(`failed ${pr.html_url} (${error.message})`); continue; }
    if (flags['dry-run']) { console.log(`would write ${target.file}`); continue; }
    const bead = beadIn(pr.head?.ref, prefix) || beadIn(pr.title, prefix);
    const event = {
      ts: target.ts, kind, project: flags.project, ...(bead ? { bead } : {}),
      ...(sessionEnv() ? { session: sessionEnv() } : {}),
      host: hostName(), source: 'hub-reconcile',
      title: clip(`${flags.project}: PR ${kind === 'pr-merged' ? 'merged' : 'closed'}: ${pr.title ?? ''}`, 120), url: pr.html_url,
    };
    const result = await putInbox(target.file, `${JSON.stringify(event, null, 2)}\n`, { createOnly: true });
    if (result.state === 'ok') { counts.posted += 1; console.log(`posted ${target.file}`); }
    else if (result.state === 'exists') { counts.exists += 1; console.log(`exists ${target.file}`); }
    else { counts.failed += 1; console.log(`failed ${target.file} (${result.reason})`); }
  }
  if (flags['dry-run']) console.log(`pr-sync: dry run, ${closedPrs.length} closed PR(s) listed, nothing written`);
  else console.log(`pr-sync: ${counts.posted} posted, ${counts.exists} already there, ${counts.failed} failed`);
  if (counts.failed || listFailed) throw new Exit(1);
}

// --- Asks ---

const askState = (names, ask, snooze) => {
  if (names.has('cancel.json')) return 'cancelled';
  if (names.has('pickup.json')) return 'picked up';
  if (names.has('answer.json')) return 'answered';
  if (names.has('snooze.json') && Date.parse(snooze?.until) > Date.now()) return `snoozed until ${new Date(snooze.until).toISOString().slice(11, 16)}`;
  if (ask?.expiresAt && Date.now() > Date.parse(ask.expiresAt)) return 'expired';
  return 'open';
};

/** Folders of files, by the folder name under a listing's prefix: { id → Set of file names }. */
function groupFolders(paths, root) {
  const folders = new Map();
  for (const file of paths) {
    const [, id, ...rest] = file.split('/');
    if (file.split('/')[0] !== root || !id || !rest.length) continue;
    if (!folders.has(id)) folders.set(id, new Set());
    folders.get(id).add(rest.join('/'));
  }
  return folders;
}

/** This month's and last month's prefixes, or the whole folder with --all. */
function monthPrefixes(root, all) {
  if (all) return [`${root}/`];
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [stamp(last).slice(0, 6), stamp(now).slice(0, 6)].map(month => `${root}/${month}`);
}

async function listFolders(root, all) {
  const paths = (await Promise.all(monthPrefixes(root, all).map(listInbox))).flat();
  return groupFolders(paths, root);
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await work(items[at]);
    }
  }));
  return results;
}

/** The kinds an Ask or a list of steps can name, so the Hub can badge them (and filter on them). Keep equal to ASK_SUBTYPES and STEPS_SUBTYPES in site/api/hub-model.mjs. */
const ASK_KINDS = ['approval', 'verify', 'design', 'decision'];
const STEPS_KINDS = ['verify', 'setup', 'investigate', 'develop'];

/** `{ request }` when a run's id is in the environment (`BUW_REQUEST_ID`), so what a job files names the job. A file's own `from.request` wins over it. */
const requestEnv = () => {
  const id = process.env.BUW_REQUEST_ID?.trim();
  return id && /^[a-z0-9][a-z0-9-]{0,127}$/.test(id) ? { request: id } : {};
};

function askFromFile(raw, flags, id) {
  const now = new Date();
  const from = { host: hostName(), tool: flags.tool || 'claude-code', ...(sessionEnv() ? { session: sessionEnv() } : {}), ...requestEnv(), ...(raw.from ?? {}) };
  const ask = {
    id, project: flags.project,
    ...(flags.bead || raw.bead ? { bead: flags.bead || raw.bead } : {}),
    createdAt: now.toISOString(),
    expiresAt: raw.expiresAt ?? new Date(now.getTime() + 7 * DAY).toISOString(),
    from,
    question: raw.question,
    ...(raw.context ? { context: raw.context } : {}),
    ...(raw.options ? { options: raw.options } : {}),
    ...(raw.decisions ? { decisions: raw.decisions } : {}),
    ...(raw.image ? { image: raw.image } : {}),
    ...(raw.changes !== undefined ? { changes: raw.changes } : {}),
    ...(raw.avatar !== undefined ? { avatar: raw.avatar } : {}),
    ...(raw.rerun !== undefined ? { rerun: raw.rerun } : {}),
    ...(raw.agentEdit !== undefined ? { agentEdit: raw.agentEdit } : {}),
    ...(flags.kind !== undefined ? { kind: flags.kind } : raw.kind !== undefined ? { kind: raw.kind } : raw.changes !== undefined ? { kind: 'decision' } : {}),
    allowNote: raw.allowNote ?? true,
    allowDrawing: raw.allowDrawing ?? false,
    ...(flags['require-passkey'] ? { requirePasskey: true } : raw.requirePasskey !== undefined ? { requirePasskey: raw.requirePasskey } : {}),
  };
  return ask;
}

/** An Ask picture's file name: the server's rule. */
const ASK_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
/** The `avatar` field of an Ask (the sprite flow): an agent id, and a request id or a sheet name. */
const AVATAR_SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;
const AVATAR_SHEET_RE = /^sheet-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}$/;
/** Keep equal to SUBJECT_RE in site/api/presets.mjs (a test does). */
const AVATAR_SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/:-]{0,199}$/;
const AVATAR_REQUEST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
/** The `rerun` field of an Ask: a run to run again (`denied`), or a run that ended before its own Ask was answered (`continue`). */
const RERUN_KINDS = ['denied', 'continue'];
/** One phone-allowed rule: an exact Bash command rule (one trailing `:*` allowed) or an exact MCP tool (the PC checks the policy). Keep validRerunRule equal to the one in site/api/hub-rerun.mjs. */
const RERUN_MCP_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
// Printable ASCII only: a rule must read the same as what is signed (no format, filler, separator, private-use or combining characters).
const RERUN_ASCII_RE = /^[\x20-\x7e]+$/;
function validRerunRule(rule) {
  if (typeof rule !== 'string' || rule.length > 300 || !RERUN_ASCII_RE.test(rule)) return false;
  if (RERUN_MCP_RE.test(rule)) return true;
  const match = /^Bash\((.*)\)$/s.exec(rule);
  if (!match) return false;
  const body = match[1];
  if (body === '' || body !== body.trim() || body.includes('Bash(')) return false;
  const stars = body.split('*').length - 1;
  if (stars === 0) return true;
  // One trailing `:*` after a non-empty prefix is the watcher's own prefix form; any other `*` is a wildcard a run could steer.
  return stars === 1 && body.endsWith(':*') && body.slice(0, -2).trim() !== '';
}
const DECISION_LIMITS = { count: 10, text: 200, detail: 500 };

/** `--decision "text|detail"` → { id: 'd<n>', text, detail? }. The detail starts at the first "|". */
function decisionsFromFlags(values) {
  return values.map((value, index) => {
    const bar = value.indexOf('|');
    const text = (bar < 0 ? value : value.slice(0, bar)).trim();
    const detail = bar < 0 ? '' : value.slice(bar + 1).trim();
    return { id: `d${index + 1}`, text, ...(detail ? { detail } : {}) };
  });
}

/** `--option <id>=<label>[@<image file name>]` → { id, label, image? }. */
function optionFromFlag(value) {
  const equals = value.indexOf('=');
  if (equals < 1) throw new Error(`--option ${value}: write it as <id>=<label>, or <id>=<label>@<image file>.`);
  let label = value.slice(equals + 1).trim();
  // Text after the last "@" with no white space is a picture reference: a bare image file name, or an error.
  const tail = /@(\S*)$/.exec(label);
  let image;
  if (tail) {
    if (!ASK_IMAGE_RE.test(tail[1]) || !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(tail[1])) {
      throw new Error(`--option ${value}: the picture after @ is a file name like x.png (pass the path with --image).`);
    }
    image = tail[1];
    label = label.slice(0, tail.index).trim();
  }
  return { id: value.slice(0, equals).trim(), label, ...(image ? { image } : {}) };
}

/** The ask input to build from: the file, or --question, with the flags' options, decisions and picture added. */
async function askInput(flags) {
  const usage = 'Usage: ask create --project <p> [--bead <b>] (--file ask.json | --question <text>) [--option <id>=<label>[@<image>]]... [--decision <text[|detail]>]... [--image <file>]... [--require-passkey] [--kind approval|verify|design|decision] [--changes <changes.json>] [--agent-edit <edit.json>] [--prose-ok]';
  if (!flags.project || (!flags.file && !flags.question)) throw new Error(usage);
  if (flags.file && flags.question) throw new Error(`Give --file, or --question, not both. ${usage}`);
  const raw = flags.file ? JSON.parse(await readFile(flags.file, 'utf8')) : { question: flags.question };
  const images = flags.image ?? [];
  if (flags.changes) {
    // A change list (ws-qdh.3) is answered row by row: no options, decisions or picture beside it.
    if (raw.changes !== undefined) throw new Error('The file has changes already: give changes in the file or with --changes, not both.');
    if (flags.option || flags.decision || raw.options !== undefined || raw.decisions !== undefined || raw.image !== undefined || images.length) throw new Error('A change list is answered row by row: leave out --option, --decision and --image.');
    const listed = JSON.parse(await readFile(flags.changes, 'utf8'));
    raw.changes = Array.isArray(listed) ? listed : listed?.changes;
    if (raw.allowDrawing === undefined) raw.allowDrawing = false;
  }
  if (flags['agent-edit']) {
    // An agent edit is applied or left, nothing else: the two fixed options, a passkey, and no other kind of Ask beside it.
    if (raw.agentEdit !== undefined) throw new Error('The file has agentEdit already: give it in the file or with --agent-edit, not both.');
    if (flags.option || flags.decision || flags.changes || raw.options !== undefined || raw.decisions !== undefined || raw.image !== undefined || raw.changes !== undefined || images.length) throw new Error('An agent edit is answered Apply or Leave it: leave out --option, --decision, --changes and --image.');
    raw.agentEdit = JSON.parse(await readFile(flags['agent-edit'], 'utf8'));
    raw.options = AGENT_EDIT_OPTIONS.map(option => ({ ...option }));
    raw.requirePasskey = true;
    if (raw.kind === undefined && flags.kind === undefined) raw.kind = 'approval';
    if (raw.allowDrawing === undefined) raw.allowDrawing = false;
  }
  if (flags.option) {
    if (raw.options !== undefined) throw new Error('The file has options already: give options in the file or with --option, not both.');
    raw.options = flags.option.map(optionFromFlag);
  }
  if (flags.decision) {
    if (raw.decisions !== undefined) throw new Error('The file has decisions already: give decisions in the file or with --decision, not both.');
    raw.decisions = decisionsFromFlags(flags.decision);
    if (raw.allowDrawing === undefined) raw.allowDrawing = true;
  }
  if (raw.decisions !== undefined && raw.image === undefined && images.length === 1 && !(Array.isArray(raw.options) && raw.options.length)) raw.image = path.basename(images[0]);
  return raw;
}

/** The decisions' one-line summary of an answer: "d1 approve", "d2 change: Bottom-left". */
function decisionLines(answer) {
  const verdicts = answer?.decisions;
  if (!verdicts || typeof verdicts !== 'object') return [];
  return Object.keys(verdicts).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(id => `${id} ${verdicts[id]?.verdict ?? '?'}${verdicts[id]?.note ? `: ${String(verdicts[id].note).replace(/\s+/g, ' ')}` : ''}`);
}

function validateAsk(ask, imageNames) {
  const problems = [];
  if (typeof ask.question !== 'string' || !ask.question.trim()) problems.push('question is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ask.project ?? '')) problems.push('--project is lower-case letters, digits and dashes');
  if (Number.isNaN(Date.parse(ask.expiresAt))) problems.push('expiresAt is not a date');
  if (ask.options !== undefined) {
    if (!Array.isArray(ask.options)) problems.push('options is a list');
    else {
      const ids = new Set();
      for (const option of ask.options) {
        if (typeof option?.id !== 'string' || !option.id || typeof option.label !== 'string' || !option.label) problems.push('each option needs an id and a label');
        else if (ids.has(option.id)) problems.push(`option id ${option.id} is used twice`);
        else ids.add(option.id);
        if (option?.image !== undefined && !imageNames.includes(option.image)) problems.push(`option ${option?.id} names image ${option.image}, which is not among the --image files`);
      }
    }
  }
  if (ask.decisions !== undefined) {
    const L = DECISION_LIMITS;
    if (!Array.isArray(ask.decisions) || ask.decisions.length < 1 || ask.decisions.length > L.count) problems.push(`decisions is a list of 1 to ${L.count}`);
    else {
      ask.decisions.forEach((decision, index) => {
        const at = `decision ${index + 1}`;
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) { problems.push(`${at} is not an object`); return; }
        if (decision.id !== `d${index + 1}`) problems.push(`${at}: id is d${index + 1}`);
        if (typeof decision.text !== 'string' || !decision.text.trim() || decision.text.length > L.text) problems.push(`${at}: text is 1 to ${L.text} characters`);
        if (decision.detail !== undefined && (typeof decision.detail !== 'string' || decision.detail.length > L.detail)) problems.push(`${at}: detail is at most ${L.detail} characters`);
      });
    }
  }
  if (ask.image !== undefined) {
    if (typeof ask.image !== 'string' || !ASK_IMAGE_RE.test(ask.image)) problems.push('image is a file name of letters, digits, . _ - (up to 120, starting with a letter or digit)');
    else if (!imageNames.includes(ask.image)) problems.push(`image names ${ask.image}, which is not among the --image files`);
  }
  if (ask.avatar !== undefined) {
    const avatar = ask.avatar;
    if (!avatar || typeof avatar !== 'object' || Array.isArray(avatar)) problems.push('avatar is an object');
    else {
      const known = Object.keys(avatar).filter(name => !['agent', 'request', 'subject', 'sheet'].includes(name));
      if (known.length) problems.push(`avatar has no field ${known.join(', ')}`);
      if (typeof avatar.agent !== 'string' || !AVATAR_SLUG_RE.test(avatar.agent)) problems.push('avatar.agent is an agent id (lower-case letters, digits and dashes)');
      if (avatar.sheet !== undefined) {
        if (avatar.request !== undefined || avatar.subject !== undefined) problems.push('avatar names a sheet, or a request with its subject, not both');
        if (typeof avatar.sheet !== 'string' || !AVATAR_SHEET_RE.test(avatar.sheet)) problems.push('avatar.sheet is sheet-<YYYYMMDDTHHMMSSZ>-<4 letters or digits>');
      } else {
        if (typeof avatar.request !== 'string' || !AVATAR_REQUEST_RE.test(avatar.request)) problems.push('avatar needs a request id (or a sheet)');
        if (avatar.subject !== undefined && (typeof avatar.subject !== 'string' || !AVATAR_SUBJECT_RE.test(avatar.subject))) problems.push('avatar.subject is a path of up to 200 letters, digits, spaces and . _ / : - (no quotes or backticks)');
      }
    }
  }
  if (ask.rerun !== undefined) {
    const rerun = ask.rerun;
    if (!rerun || typeof rerun !== 'object' || Array.isArray(rerun)) problems.push('rerun is an object');
    else {
      const known = Object.keys(rerun).filter(name => !['request', 'kind', 'ask', 'allow'].includes(name));
      if (known.length) problems.push(`rerun has no field ${known.join(', ')}`);
      if (typeof rerun.request !== 'string' || !AVATAR_REQUEST_RE.test(rerun.request)) problems.push('rerun.request is a request id');
      if (!RERUN_KINDS.includes(rerun.kind)) problems.push(`rerun.kind is ${RERUN_KINDS.join(' or ')}`);
      if (rerun.kind === 'continue') {
        if (typeof rerun.ask !== 'string' || !AVATAR_REQUEST_RE.test(rerun.ask)) problems.push('rerun.ask is the id of the Ask the run left open');
      } else if (rerun.ask !== undefined) problems.push('rerun.ask is only for kind continue');
      if (rerun.allow !== undefined) {
        const rules = rerun.allow;
        if (rerun.kind !== 'denied') problems.push('rerun.allow is only for kind denied');
        else if (!Array.isArray(rules) || rules.length < 1 || rules.length > 5 || new Set(rules).size !== rules.length
          || !rules.every(validRerunRule)) {
          problems.push('rerun.allow is 1 to 5 different rules, each Bash(<command>) or mcp__<server>__<tool>, up to 300 characters, printable ASCII only, no * except one trailing :*');
        }
      }
    }
  }
  if (ask.changes !== undefined) {
    problems.push(...validateChanges(ask.changes));
    if (ask.kind !== 'decision') problems.push('an Ask with changes is --kind decision');
    if (ask.options !== undefined || ask.decisions !== undefined || ask.image !== undefined) problems.push('an Ask with changes has no options, decisions or image: the Hub makes one row per change');
  }
  if (ask.agentEdit !== undefined) problems.push(...validateAgentEdit(ask));
  if (ask.requirePasskey !== undefined && typeof ask.requirePasskey !== 'boolean') problems.push('requirePasskey is true or false');
  if (ask.kind !== undefined && !ASK_KINDS.includes(ask.kind)) problems.push(`--kind is one of: ${ASK_KINDS.join(', ')}`);
  if (typeof ask.allowNote !== 'boolean' || typeof ask.allowDrawing !== 'boolean') problems.push('allowNote and allowDrawing are true or false');
  if (problems.length) throw new Error(`ask.json is not valid: ${problems.join('; ')}.`);
}

// --- the Discord ping for a new Ask ---

async function hubConfig() {
  try { return JSON.parse(await readFile(process.env.BUW_HUB_CONFIG || path.join(os.homedir(), '.buw', 'hub.json'), 'utf8')); } catch { return null; }
}

/** The #needs-you webhook: BUW_DISCORD_NEEDS_YOU, then hub.json, then a secrets file. None: no ping. */
async function needsYouWebhook(hub) {
  if (process.env.BUW_DISCORD_NEEDS_YOU?.trim()) return process.env.BUW_DISCORD_NEEDS_YOU.trim();
  if (typeof hub?.discord?.needsYou === 'string' && hub.discord.needsYou.trim()) return hub.discord.needsYou.trim();
  try { return (await readFile(path.join(os.homedir(), '.buw', 'secrets', 'discord-webhook-needs-you'), 'utf8')).trim() || null; } catch { return null; }
}

/** The owner's Discord user id, for the @mention that makes a ping buzz their phone: BUW_DISCORD_OWNER_ID, then a secrets file. Only a well-formed id counts. */
async function ownerDiscordId() {
  let id = process.env.BUW_DISCORD_OWNER_ID?.trim();
  if (!id) try { id = (await readFile(path.join(os.homedir(), '.buw', 'secrets', 'discord-owner-user-id'), 'utf8')).trim(); } catch { return null; }
  return /^\d{15,25}$/.test(id) ? id : null;
}

const titleOf = id => String(id).split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

/**
 * Tell the owner an Ask or a checklist is waiting: `path` is the Hub link after the site's address. Silent without a
 * webhook; on a failed post the message is kept in the shared spool for hub-hooks to replay (no address in it), and
 * the exit code is never touched.
 */
async function pingNeedsYou({ project, text, path: link }) {
  const hub = await hubConfig();
  // A dev inbox must not ping the owner's phone with links to the real site: only an explicit webhook does.
  if (INBOX !== 'inbox' && !process.env.BUW_DISCORD_NEEDS_YOU?.trim()) return;
  const webhook = await needsYouWebhook(hub);
  if (!webhook) return;
  const site = String(hub?.siteUrl || process.env.BUW_SITE_URL || '').replace(/\/+$/, '');
  // The owner is mentioned only from the real Inbox, and allowed_mentions names only them, so text in the Ask can never ping anyone.
  const owner = INBOX === 'inbox' ? await ownerDiscordId() : null;
  const content = [`${owner ? `<@${owner}> ` : ''}**Agent needs you · ${titleOf(project)}**`, clip(text, 200), ...(site ? [`${site}${link}`] : [])].join('\n');
  const body = JSON.stringify({ content, allowed_mentions: owner ? { parse: [], users: [owner] } : { parse: [] } });
  try {
    const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Discord answered ${response.status}`);
  } catch (error) {
    const file = spoolFile();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ v: 1, at: isoNow(), kind: 'discord', target: 'needsYou', body })}\n`);
    console.error(`(Discord ping kept in the spool: ${error.name === 'TimeoutError' ? 'timed out' : error.message.replace(/https?:[^\s)]+/g, '')})`);
  }
}

/** Whether `body` starts with the bytes of the picture type its file extension names; null when the extension is not one of the known types. */
function pictureProblem(name, body) {
  const ext = path.extname(name).toLowerCase();
  const starts = (...bytes) => bytes.every((byte, index) => body[index] === byte);
  let ok;
  let type;
  if (ext === '.png') { type = 'PNG'; ok = starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a); }
  else if (ext === '.jpg' || ext === '.jpeg') { type = 'JPEG'; ok = starts(0xff, 0xd8, 0xff); }
  else if (ext === '.gif') { type = 'GIF'; ok = body.subarray(0, 4).toString('latin1') === 'GIF8'; }
  else if (ext === '.webp') { type = 'WebP'; ok = body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP'; }
  else if (ext === '.svg') { type = 'SVG'; ok = /^(?:\uFEFF)?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<(?:svg|\?xml)/i.test(body.subarray(0, 2048).toString('utf8')); }
  else return null;
  return ok ? null : `${name} is not a ${type} picture.`;
}

/** The Beads project the folder's CLAUDE.md names (`Beads project: \`x\``), looked up from the git root, else the working folder. Undefined when there is none. */
function folderProject() {
  const roots = [gitOut('rev-parse', '--show-toplevel'), process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      const found = /Beads project:\s*`([^`\s]+)`/i.exec(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'));
      return found ? found[1] : undefined;
    } catch { /* no CLAUDE.md here */ }
  }
  return undefined;
}

/** On stderr (stdout stays the id): the project asked for is not the folder's. Never an error. */
function projectNote(project) {
  const own = folderProject();
  if (!own || !project || own === project) return;
  console.error(`Note: this repository's Beads project is ${own}, not ${project}. The answer still comes back to this session, and to the next session in this repository. Use --project ${own} if the question is about this repository.`);
}

async function askCreate(flags) {
  const raw = await askInput(flags);
  const askTexts = [['The question', raw.question], ['The context', raw.context], ...(Array.isArray(raw.decisions) ? raw.decisions.flatMap((d, i) => [[`Decision ${i + 1}`, d?.text], [`Decision ${i + 1}'s detail`, d?.detail]]) : [])];
  for (const [where, text] of askTexts) refuseProseCommand(flags, where, text, 'Put the command in its own fenced code block.');
  const id = newId(flags.project, raw.question);
  const ask = askFromFile(raw, flags, id);
  const images = flags.image ?? [];
  validateAsk(ask, images.map(file => path.basename(file)));
  const uploads = [];
  for (const file of images) {
    const name = path.basename(file);
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error(`Image name ${name}: letters, digits, . _ - only.`);
    const body = await readFile(file);
    if (body.length > MAX_INLINE) throw new Error(`${name} is over 4 MB.`);
    const wrong = pictureProblem(name, body);
    if (wrong) throw new Error(wrong);
    uploads.push({ file: inboxPath('asks', id, name), body, contentType: IMAGE_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream' });
  }
  const askFile = inboxPath('asks', id, 'ask.json');
  // Pictures first and the ask last, so an ask is never listed before what it shows.
  for (const upload of uploads) await mustPut(upload.file, upload.body, { createOnly: true, contentType: upload.contentType });
  if (await mustPut(askFile, `${JSON.stringify(ask, null, 2)}\n`, { createOnly: true }) === 'exists') throw new Error(`${askFile} already exists; run it again.`);
  await postEvent({ kind: 'ask-created', title: clip(ask.question, 80), project: ask.project, bead: ask.bead, ask: id, source: 'cards', summary: 'A question is waiting for an answer.' }).catch(error => console.error(`(ask-created event skipped: ${error.message})`));
  await pingNeedsYou({ project: ask.project, text: ask.question, path: `/#/~hub/ask/${id}` }).catch(() => {});
  projectNote(ask.project);
  console.log(id);
}

async function askList(flags) {
  const folders = await listFolders('asks', flags.all);
  const wanted = flags.project ? new RegExp(`^\\d{8}-${flags.project.toLowerCase().replace(/[^a-z0-9-]/g, '')}-`) : null;
  const ids = [...folders.keys()].filter(id => !wanted || wanted.test(id)).sort();
  const rows = await mapLimit(ids, 8, async id => {
    const names = folders.get(id);
    const ask = names.has('ask.json') ? await readJson(inboxPath('asks', id, 'ask.json')) : null;
    const snooze = names.has('snooze.json') && !['cancel.json', 'pickup.json', 'answer.json'].some(name => names.has(name)) ? await readJson(inboxPath('asks', id, 'snooze.json')) : null;
    return { id, ask, state: askState(names, ask, snooze) };
  });
  for (const row of rows) {
    if (flags.project && row.ask?.project !== flags.project) continue;
    if (flags.answered && row.state !== 'answered') continue;
    if (flags.open && row.state !== 'open') continue;
    console.log(`${row.id}\t${row.state}\t${row.ask?.project ?? ''}\t${clip(row.ask?.question, 80)}`);
  }
}

const ANSWER_PICTURE_NAME = /^answer\.pic-\d{8}T\d{9}Z-[a-z0-9]{4}\.(?:png|jpg)$/;

/** The picture files an answer names: only well-formed names. A named file that is not there is reported when it is fetched. */
function answerPictureNames(answer) {
  const named = Array.isArray(answer?.pictures) ? answer.pictures.filter(name => typeof name === 'string' && ANSWER_PICTURE_NAME.test(name)) : [];
  if (answer?.drawing && answer.drawing.png === 'answer.png') named.push('answer.png');
  return [...new Set(named)];
}

/** Where downloaded pictures go: --into, else inside the checkout under .buw/pictures (kept out of git first), else the temp folder. */
async function picturesDir(kind, id, flags) {
  if (typeof flags?.into === 'string' && flags.into) { await mkdir(flags.into, { recursive: true }); return path.resolve(flags.into); }
  const run = args => { const out = spawnSync('git', args, { encoding: 'utf8', timeout: 10000 }); return out.status === 0 ? out.stdout.trim() : ''; };
  const top = run(['rev-parse', '--show-toplevel']);
  const exclude = top ? run(['rev-parse', '--git-path', 'info/exclude']) : '';
  if (top && exclude) {
    try {
      const file = path.resolve(exclude);
      let text = '';
      try { text = await readFile(file, 'utf8'); } catch { /* no file yet */ }
      if (!text.split(/\r?\n/).some(line => line.trim() === '.buw/pictures/')) {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}.buw/pictures/\n`);
      }
      const dir = path.join(top, '.buw', 'pictures', `${kind}-${id}`);
      await mkdir(dir, { recursive: true });
      return path.resolve(dir);
    } catch { /* falls to the temp folder: never write into a checkout without the exclude */ }
  }
  const dir = path.join(os.tmpdir(), 'cards-pictures', `${kind}-${id}`);
  await mkdir(dir, { recursive: true });
  return path.resolve(dir);
}

/** Download an item's pictures and return the full paths. A file already there is kept. A failed one prints a line and does not fail the command: the answer did arrive. */
async function savePictures(kind, folder, id, names, flags) {
  if (!names.length) return [];
  const dir = await picturesDir(kind, id, flags);
  const saved = [];
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      let present = false;
      try { present = (await readFile(target)).length > 0; } catch { /* not there yet */ }
      if (!present) {
        const bytes = await readInboxBytes(inboxPath(folder, id, name));
        if (!bytes) throw new Error('not found');
        await writeFile(target, bytes);
      }
      saved.push(target);
    } catch (error) {
      console.log(`picture not saved: ${name} (${error.message}). Try: cards ${kind} get ${id}`);
    }
  }
  return saved;
}

/** What `get` prints under the answer once the pictures are down. */
function printSaved(saved, count) {
  if (!count) return;
  console.log(`== pictures\nThe owner attached ${count} picture${count === 1 ? '' : 's'}. Open each file:`);
  for (const file of saved) console.log(`saved: ${file}`);
}

async function askGet(id, flags = {}) {
  id = idSafe(id);
  const names = (await listInbox(`asks/${id}/`)).map(file => file.split('/').slice(2).join('/'));
  if (!names.length) throw new Error(`No ask ${id}.`);
  const shown = ['ask.json', 'answer.json', 'pickup.json', 'cancel.json'];
  for (const name of shown) {
    if (!names.includes(name)) continue;
    const text = (await readInbox(inboxPath('asks', id, name))).trim();
    console.log(`== ${name}\n${text}`);
    if (name === 'ask.json') {
      let given = null;
      try { given = JSON.parse(text); } catch { /* shown as it is */ }
      if (Array.isArray(given?.changes) && !validateChanges(given.changes).length) console.log(`== changes\n${changeRows(given.changes).map(row => `${row.id}  ${row.text}`).join('\n')}`);
    }
    if (name === 'answer.json') {
      let answer = null;
      try { answer = JSON.parse(text); } catch { /* shown as it is */ }
      const lines = decisionLines(answer);
      if (lines.length) console.log(`== decisions\n${lines.join('\n')}`);
    }
  }
  const others = names.filter(name => !shown.includes(name));
  if (others.length) console.log(`== other files\n${others.join('\n')}`);
  const answered = names.includes('answer.json') ? await readJson(inboxPath('asks', id, 'answer.json')) : null;
  const named = answerPictureNames(answered);
  printSaved(await savePictures('ask', 'asks', id, named, flags), named.length);
}

/** Wait for the owner's answer. Exit 0 once answered (prints what `get` prints, or { ask, answer } with --json), 3 on cancel, 4 on timeout or an expired Ask. */
async function askWait(id, flags) {
  id = idSafe(id);
  const minutes = flags.timeout === undefined ? 30 : Number(flags.timeout);
  const seconds = flags.every === undefined ? 20 : Number(flags.every);
  if (!(minutes > 0) || minutes > 240) throw new Error('--timeout is a number of minutes above 0 and at most 240.');
  if (!(seconds >= 5)) throw new Error('--every is a number of seconds, at least 5.');
  const deadline = Date.now() + minutes * 60_000;
  const read = async () => {
    const names = new Set((await listInbox(`asks/${id}/`)).map(file => file.split('/').slice(2).join('/')));
    if (!names.size) throw new Error(`No ask ${id}.`);
    const ask = names.has('ask.json') ? await readJson(inboxPath('asks', id, 'ask.json')) : null;
    const snooze = names.has('snooze.json') && !['cancel.json', 'pickup.json', 'answer.json'].some(name => names.has(name)) ? await readJson(inboxPath('asks', id, 'snooze.json')) : null;
    return { names, ask, state: askState(names, ask, snooze) };
  };
  for (let first = true; ; first = false) {
    let view;
    try {
      view = await read();
    } catch (error) {
      if (first || /^No ask/.test(error.message)) throw error;
      console.error(`(poll failed, trying again: ${error.message})`);
    }
    if (view) {
      if (view.state === 'cancelled') { console.log(`${id}	cancelled`); throw new Exit(3); }
      if (view.state === 'answered' || view.state === 'picked up') {
        if (flags.json) {
          const answer = view.names.has('answer.json') ? await readJson(inboxPath('asks', id, 'answer.json')) : null;
          const named = answerPictureNames(answer);
          const saved = named.length ? await savePictures('ask', 'asks', id, named, flags) : null;
          console.log(JSON.stringify({ ask: view.ask, answer, ...(saved ? { saved } : {}) }));
        } else await askGet(id, flags);
        return;
      }
      if (view.state === 'expired' || Date.now() >= deadline) {
        console.log(`${id}	${view.state}	${view.ask?.project ?? ''}	(${view.state === 'expired' ? 'expired' : `timed out after ${minutes} min`})`);
        throw new Exit(4);
      }
    } else if (Date.now() >= deadline) {
      throw new Exit(4);
    }
    await delay(Math.max(0, Math.min(seconds * 1000, deadline - Date.now())));
  }
}

/** pickup.json and cancel.json, and taken.json for a request: create-only, and the second one in learns who was first. */
async function claim(folder, id, file, body) {
  const target = inboxPath(folder, id, file);
  if (await mustPut(target, `${JSON.stringify(body, null, 2)}\n`, { createOnly: true }) === 'exists') {
    const first = await readJson(target);
    console.error(`${folder}/${id}/${file} was written already${first ? ` by ${first.host ?? first.by ?? 'someone'} at ${first.at ?? '?'}` : ''}.`);
    throw new Exit(3);
  }
  console.log(`${folder}/${id}/${file}`);
}

const pickupBody = flags => ({ at: isoNow(), ...(sessionEnv() ? { session: sessionEnv() } : {}), host: hostName(), ...(flags.bead ? { bead: flags.bead } : {}) });

// --- Checklists: a list of steps for the owner, ticked one at a time in the Hub ---
// checklists/<id>/: checklist.json (this command), tick-/untick-<item>-<stamp>-<rand4>.json, submit.json and reopen-<n>.json (the Hub only),
// pickup.json and cancel.json (this command). The state is read from the file names alone. The owner may reopen a submitted list: that starts
// round n with `reopen-<n>.json`, and the round's files are `submit-<n>.json` (Hub) and `pickup-<n>.json` (this command); round 1 keeps the plain names.

const CHECKLIST_MARK_RE = /^(tick|untick)-(\d{2})-(\d{8}T\d{9}Z)-([a-z0-9]{4})\.json$/;
const CHECKLIST_LIMITS = { title: 200, items: 50, text: 200, group: 80, guide: 4000, command: 2000, context: 4000, link: 2000, file: 256 * 1024, build: 2000, lookFor: 2000 };
const ITEM_SHELLS = ['bash', 'powershell', 'cmd'];
const PLAYTEST_PLATFORMS = ['web', 'windows', 'mac', 'linux', 'android', 'ios'];

/** The round a list is in: the greatest n of a reopen-<n>.json (2 or more), else 1. Keep equal to checklistRevision in site/api/hub-model.mjs. */
function checklistRevision(names) {
  let revision = 1;
  for (const name of names) {
    const match = /^reopen-(\d{1,2})\.json$/.exec(name);
    if (match && Number(match[1]) > revision) revision = Number(match[1]);
  }
  return revision;
}
/** submit.json / pickup.json in round 1, submit-<n>.json / pickup-<n>.json after a reopen. */
const roundFile = (kind, revision) => (revision > 1 ? `${kind}-${revision}.json` : `${kind}.json`);

/** cancel.json → cancelled, the round's pickup → picked-up, its submit → submitted, else open (a reopened list is open again). */
const checklistState = names => {
  const revision = checklistRevision(names);
  return names.has('cancel.json') ? 'cancelled' : names.has(roundFile('pickup', revision)) ? 'picked-up' : names.has(roundFile('submit', revision)) ? 'submitted' : 'open';
};

/** The winning mark per item: the greatest stamp in the file name, the greater rand4 on a tie. → Map<item, { done, at }> */
function checklistMarks(names) {
  const best = new Map();
  for (const name of names) {
    const match = CHECKLIST_MARK_RE.exec(name);
    if (!match) continue;
    const [, action, item, time, tail] = match;
    const key = `${time}-${tail}`;
    if (!best.has(item) || key > best.get(item).key) {
      best.set(item, { key, done: action === 'tick', at: `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}.${time.slice(15, 18)}Z` });
    }
  }
  return new Map([...best].map(([item, { done, at }]) => [item, { done, at }]));
}

/** A command without the blank lines around it; its own lines, indentation and trailing spaces stay as written. */
const trimBlankLines = value => value.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');

const isHttps = value => { try { return new URL(value).protocol === 'https:' && /^https:\/\//i.test(value); } catch { return false; } };

// --- prose-command:start (self-contained: scripts/cards.test.mjs loads this block on its own) ---
/**
 * The command-looking part of a text, or null. Narrow on purpose: a false refusal blocks an agent.
 * Matches a backtick span that starts with a command word and has arguments, or has a flag; and what follows a
 * "Run:" style lead-in when it starts with a command word or a path. Text inside ``` fences is skipped.
 * Ids, names, URLs, a lone tool name and prose that only mentions a tool do not match.
 */
function proseCommand(text) {
  if (typeof text !== 'string') return null;
  const words = 'git|npm|npx|node|python|py|pwsh|powershell|cd|ssh|scp|curl|gh|bd|claude|docker|systemctl|pct|unity';
  const startsLikeCommand = new RegExp(`^(?:${words})\\s+\\S`);
  const scriptPath = /^\.[\\/]\S*(?:\.(?:ps1|sh|mjs|js|py|cmd|bat)\b|\s+\S)/;
  const flag = /\s--?[A-Za-z][\w-]*/;
  const proseSecond = /^(?:is|are|was|were|will|would|should|can|could|to|and|or|the|a|an|from|in|on|at|of|you|it|that|this|has|have|not|if|when|as|for|with|again|first|now|once|then|next|also|before|after|please|manually)$/i;
  // A program named by a hyphen, a dot or a path ("pixel-studio-comfy", "install.ps1", "tools/run") followed by an argument.
  const namedProgram = /^(?:[A-Za-z]\w*-[\w-]*\w|[\w-]+\.[A-Za-z0-9]{1,4}|[\w.~-]*[\\/][\w.\\/~-]*\w)$/;
  const outside = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  for (const span of outside.matchAll(/`([^`\n]+)`/g)) {
    const body = span[1].trim();
    if (/^https?:\/\//i.test(body)) continue;
    if (scriptPath.test(body) || (/\s/.test(body) && (startsLikeCommand.test(body) || flag.test(body)))) return body;
  }
  for (const lead of outside.matchAll(/(?:\bRun:|\bRun `|\bIn PowerShell:|\bIn Git Bash:|\bOver SSH:|\bIn a terminal:)[ \t]*`?([^`\n]*)/gi)) {
    const rest = lead[1].trim();
    const [first = '', second = ''] = rest.split(/\s+/);
    if (new RegExp(`^(?:${words})$`).test(first) && second && !proseSecond.test(second)) return rest;
    if (/^(?:[A-Za-z]:\\\S|~\/\S|\/\S+\/\S)/.test(first)) return rest;
    if (namedProgram.test(first) && second && !proseSecond.test(second)) return `${first} ${second.replace(/[.,;]+$/, '')}`;
  }
  return null;
}
// --- prose-command:end ---

// --- ask-changes:start (the same block is in site/api/ask-changes.mjs and site/card-api/cards.mjs; scripts/cards.test.mjs keeps them equal) ---
/**
 * The change list of a plan Ask (ws-qdh.3): what the owner approves, row by row, before a session applies it to Beads.
 * `validateChanges` returns the problems with a list (an empty array when it is good); it never throws. Every op, field and label is
 * allow-listed, ids are Beads ids (or `#n`, the n-th change of the list, for something an earlier `create` makes), and free text
 * may not hold a command. `describeChange` is the one line the Hub shows for a change: built from the op, with the agent's text
 * quoted inside it, never alone.
 */
const CHANGES_MAX = 20;
const CHANGE_OPS = ['create', 'update', 'dep', 'close', 'label', 'card'];
const CHANGE_KEYS = {
  create: ['op', 'title', 'type', 'parent', 'description', 'labels'],
  update: ['op', 'bead', 'title', 'description'],
  dep: ['op', 'bead', 'blocks'],
  close: ['op', 'bead', 'reason'],
  label: ['op', 'bead', 'add', 'remove'],
  card: ['op', 'card'],
};
const CHANGE_TYPES = ['task', 'feature', 'epic'];
const CHANGE_LIMITS = { title: 120, description: 2000, reason: 200, labels: 5 };
const CHANGE_BEAD = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]{0,60}$/;
const CHANGE_CARD = /^assistant\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const CHANGE_LABEL = /^(?:wayfinder:[a-z]{2,20}|milestone|roadmap|needs-owner|later)$/;

export function validateChanges(changes) {
  const problems = [];
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > CHANGES_MAX) return [`changes is a list of 1 to ${CHANGES_MAX}`];
  const made = new Set();
  const textOk = (at, name, value, max, { required = false } = {}) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) { problems.push(`${at}: ${name} is ${required ? `1 to ${max}` : `at most ${max}`} characters of text`); return; }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/.test(value)) { problems.push(`${at}: ${name} has a control character`); return; }
    const found = proseCommand(value);
    if (found) problems.push(`${at}: ${name} has a command in its text (${found.slice(0, 40)}); describe it in words`);
  };
  const beadOk = (at, name, value, index) => {
    if (typeof value === 'string' && CHANGE_BEAD.test(value)) return;
    const ref = typeof value === 'string' ? /^#([1-9][0-9]?)$/.exec(value) : null;
    if (ref && made.has(Number(ref[1])) && Number(ref[1]) < index + 1) return;
    problems.push(`${at}: ${name} is a Beads id, or #n for a create earlier in the list`);
  };
  const labelsOk = (at, name, value) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length < 1 || value.length > CHANGE_LIMITS.labels || new Set(value).size !== value.length || !value.every(label => typeof label === 'string' && CHANGE_LABEL.test(label))) {
      problems.push(`${at}: ${name} is 1 to ${CHANGE_LIMITS.labels} different labels from: wayfinder:<type>, milestone, roadmap, needs-owner, later`);
    }
  };
  changes.forEach((change, index) => {
    const at = `change ${index + 1}`;
    if (!change || typeof change !== 'object' || Array.isArray(change)) { problems.push(`${at} is not an object`); return; }
    if (!CHANGE_OPS.includes(change.op)) { problems.push(`${at}: op is one of ${CHANGE_OPS.join(', ')}`); return; }
    const extra = Object.keys(change).filter(key => !CHANGE_KEYS[change.op].includes(key));
    if (extra.length) problems.push(`${at}: ${change.op} has no field ${extra.join(', ')}`);
    if (change.op === 'create') {
      textOk(at, 'title', change.title, CHANGE_LIMITS.title, { required: true });
      textOk(at, 'description', change.description, CHANGE_LIMITS.description);
      if (change.type !== undefined && !CHANGE_TYPES.includes(change.type)) problems.push(`${at}: type is one of ${CHANGE_TYPES.join(', ')}`);
      if (change.parent !== undefined) beadOk(at, 'parent', change.parent, index);
      labelsOk(at, 'labels', change.labels);
      made.add(index + 1);
    } else if (change.op === 'update') {
      beadOk(at, 'bead', change.bead, index);
      textOk(at, 'title', change.title, CHANGE_LIMITS.title);
      textOk(at, 'description', change.description, CHANGE_LIMITS.description);
      if (change.title === undefined && change.description === undefined) problems.push(`${at}: update changes a title or a description`);
    } else if (change.op === 'dep') {
      beadOk(at, 'bead', change.bead, index);
      beadOk(at, 'blocks', change.blocks, index);
      if (change.bead === change.blocks) problems.push(`${at}: a bead cannot block itself`);
    } else if (change.op === 'close') {
      beadOk(at, 'bead', change.bead, index);
      textOk(at, 'reason', change.reason, CHANGE_LIMITS.reason, { required: true });
    } else if (change.op === 'label') {
      beadOk(at, 'bead', change.bead, index);
      labelsOk(at, 'add', change.add);
      labelsOk(at, 'remove', change.remove);
      if (change.add === undefined && change.remove === undefined) problems.push(`${at}: label adds or removes at least one label`);
    } else if (typeof change.card !== 'string' || !CHANGE_CARD.test(change.card)) {
      problems.push(`${at}: card is assistant/<folder>`);
    }
  });
  return problems;
}

/** The Design review rows of a valid change list: `{ id: 'd<n>', text, detail? }`, text up to 200 and detail up to 500 characters. */
export function changeRows(changes) {
  const clipText = (value, max) => { const flat = String(value ?? '').replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat; };
  const where = value => (/^#\d+$/.test(value) ? `new item ${value.slice(1)}` : value);
  return changes.map((change, index) => {
    let text;
    let detail = '';
    if (change.op === 'create') {
      text = `Add ${change.type ?? 'task'} "${clipText(change.title, 120)}"${change.parent ? ` under ${where(change.parent)}` : ''}`;
      detail = [change.description ? clipText(change.description, 400) : '', change.labels?.length ? `Labels: ${change.labels.join(', ')}` : ''].filter(Boolean).join(' · ');
    } else if (change.op === 'update') {
      text = `Change ${where(change.bead)}${change.title !== undefined ? ` to "${clipText(change.title, 120)}"` : ''}`;
      detail = change.description !== undefined ? `New description: ${clipText(change.description, 400)}` : '';
    } else if (change.op === 'dep') {
      text = `${where(change.bead)} must be done before ${where(change.blocks)}`;
    } else if (change.op === 'close') {
      text = `Close ${where(change.bead)}`;
      detail = `Reason: ${clipText(change.reason, 200)}`;
    } else if (change.op === 'label') {
      text = `Labels on ${where(change.bead)}`;
      detail = [change.add?.length ? `Add: ${change.add.join(', ')}` : '', change.remove?.length ? `Remove: ${change.remove.join(', ')}` : ''].filter(Boolean).join(' · ');
    } else {
      text = `Copy the card ${change.card} into this project's section`;
    }
    return { id: `d${index + 1}`, text: clipText(text, 200), ...(detail ? { detail: clipText(detail, 500) } : {}) };
  });
}
// --- ask-changes:end ---

// --- agent-edit:start (the same block is in site/api/agent-edit.mjs and site/card-api/cards.mjs; scripts/cards.test.mjs keeps them equal) ---
/**
 * `validateAgentEdit(ask)` returns the problems with an Ask's `agentEdit` field (an empty array when it is good); it never throws.
 * The field is one of two shapes, by `op`:
 *   { op: 'persona', agent, base, role?, prompt?, model?, why? }  at least one of role, prompt and model, the limits of the Edit page, and
 *     `base`, the version the proposal was written against (`default` or a persona-<stamp>-<rand4> id).
 *   { op: 'profile', profile, primary: { provider, model }, fallbacks: [{ provider, model }], why? }  the Hermes profile's model and its fallback
 *     order (0 to 4), every model once. The Hub checks the models against the list the Hermes host published, and the host checks again.
 * The Ask must require a passkey and offer exactly Apply and Leave it. Toolsets, skills, SOUL.md, jobs and the terminal are view-only and refused.
 */
const AGENT_EDIT_PERSONA_KEYS = ['op', 'agent', 'base', 'role', 'prompt', 'model', 'why'];
const AGENT_EDIT_PROFILE_KEYS = ['op', 'profile', 'primary', 'fallbacks', 'why'];
const AGENT_EDIT_VIEW_ONLY = ['toolsets', 'platformToolsets', 'skills', 'soul', 'cron', 'jobs', 'terminal', 'fallbacks', 'provider'];
const AGENT_EDIT_LIMITS = { role: 200, prompt: 8000, why: 400 };
const AGENT_EDIT_PROFILES = ['main', 'briefs'];
const AGENT_EDIT_MAX_FALLBACKS = 4;
const AGENT_EDIT_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
export const AGENT_EDIT_OPTIONS = [{ id: 'apply', label: 'Apply this edit' }, { id: 'skip', label: 'Leave it as it is' }];

export function validateAgentEdit(ask) {
  const problems = [];
  const edit = ask?.agentEdit;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return ['agentEdit is an object'];
  const profile = edit.op === 'profile';
  const keys = profile ? AGENT_EDIT_PROFILE_KEYS : AGENT_EDIT_PERSONA_KEYS;
  const viewOnly = Object.keys(edit).filter(name => AGENT_EDIT_VIEW_ONLY.includes(name) && !keys.includes(name));
  if (viewOnly.length) problems.push(`agentEdit cannot change ${viewOnly.join(', ')}: toolsets, skills, SOUL.md and scheduled jobs are view-only`);
  const extra = Object.keys(edit).filter(name => !keys.includes(name) && !AGENT_EDIT_VIEW_ONLY.includes(name));
  if (extra.length) problems.push(`agentEdit has no field ${extra.slice(0, 3).join(', ')}`);
  if (edit.op !== 'persona' && !profile) problems.push('agentEdit.op is persona or profile');
  const text = (name, max, multiline) => {
    const value = edit[name];
    if (value === undefined) return;
    if (typeof value !== 'string' || !value.trim() || value.length > max) problems.push(`agentEdit.${name} is 1 to ${max} characters of text`);
    else if ((multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/ : /[\u0000-\u001f\u007f\u2028\u2029]/).test(value)) problems.push(`agentEdit.${name} has a control character`);
  };
  text('why', AGENT_EDIT_LIMITS.why, false);
  if (profile) {
    if (!AGENT_EDIT_PROFILES.includes(edit.profile)) problems.push(`agentEdit.profile is ${AGENT_EDIT_PROFILES.join(' or ')}`);
    const model = item => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 2 && AGENT_EDIT_MODEL_ID.test(item.provider ?? '') && AGENT_EDIT_MODEL_ID.test(item.model ?? '');
    if (!model(edit.primary)) problems.push('agentEdit.primary is { provider, model }');
    if (!Array.isArray(edit.fallbacks) || edit.fallbacks.length > AGENT_EDIT_MAX_FALLBACKS || !edit.fallbacks.every(model)) problems.push(`agentEdit.fallbacks is a list of 0 to ${AGENT_EDIT_MAX_FALLBACKS} { provider, model }`);
    else if (model(edit.primary)) {
      const names = [edit.primary, ...edit.fallbacks].map(item => `${item.provider}/${item.model}`);
      if (new Set(names).size !== names.length) problems.push('agentEdit lists a model twice: the primary and each fallback are different');
    }
  } else {
    if (typeof edit.agent !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(edit.agent)) problems.push('agentEdit.agent is an agent id');
    if (typeof edit.base !== 'string' || !(edit.base === 'default' || /^persona-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}$/.test(edit.base))) problems.push('agentEdit.base is the version the edit was written against: default, or a persona-<stamp>-<rand4> id');
    text('role', AGENT_EDIT_LIMITS.role, false);
    text('prompt', AGENT_EDIT_LIMITS.prompt, true);
    if (edit.model !== undefined && (typeof edit.model !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,39}$/.test(edit.model))) problems.push('agentEdit.model is a chat model id');
    if (edit.role === undefined && edit.prompt === undefined && edit.model === undefined) problems.push('agentEdit changes the role, the prompt or the model');
  }
  if (ask.requirePasskey !== true) problems.push('an Ask with agentEdit requires a passkey (--require-passkey)');
  const options = ask.options;
  if (!Array.isArray(options) || options.length !== 2 || options.some((option, index) => option?.id !== AGENT_EDIT_OPTIONS[index].id || option?.label !== AGENT_EDIT_OPTIONS[index].label || Object.keys(option).length !== 2)) {
    problems.push('an Ask with agentEdit offers exactly the options apply ("Apply this edit") and skip ("Leave it as it is")');
  }
  if (ask.changes !== undefined || ask.decisions !== undefined || ask.image !== undefined || ask.avatar !== undefined || ask.rerun !== undefined) problems.push('an Ask with agentEdit has no changes, decisions, image, avatar or rerun');
  return problems;
}
// --- agent-edit:end ---

const bt = '`';
const PROSE_ESCAPE = ' --prose-ok skips this check (for text that only looks like a command) and prints a warning.';

/** Refuse a command written into prose unless --prose-ok; `fix` says how to repair it. Throws an Exit(2) after printing. */
function refuseProseCommand(flags, where, text, fix) {
  const found = proseCommand(text);
  if (!found) return;
  if (flags['prose-ok']) { console.error(`Warning: ${where} looks like it has a command (${bt}${found}${bt}); --prose-ok skipped the check.`); return; }
  console.error(`${where} has a command in its text: ${bt}${found}${bt}. ${fix}${PROSE_ESCAPE}`);
  throw new Exit(2);
}

/** The problems with a checklist input (the shape of checklist.json without id, project, createdAt, from and item ids). */
function validateChecklist(raw) {
  const L = CHECKLIST_LIMITS;
  const problems = [];
  const text = (value, max) => typeof value === 'string' && value.trim().length >= 1 && value.length <= max;
  const optional = (value, max) => value === undefined || (typeof value === 'string' && value.length <= max);
  const link = value => typeof value === 'string' && value.length <= L.link && /^https?:\/\//i.test(value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['the file is not an object'];
  if (!text(raw.title, L.title)) problems.push(`title is 1 to ${L.title} characters`);
  if (!optional(raw.context, L.context)) problems.push(`context is at most ${L.context} characters`);
  if (raw.card !== undefined && !link(raw.card)) problems.push('card is an http:// or https:// link of at most 2000 characters');
  if (raw.kind !== undefined && raw.kind !== 'playtest' && !STEPS_KINDS.includes(raw.kind)) problems.push(`--kind is one of: ${STEPS_KINDS.join(', ')} (or --playtest for a playtest)`);
  if (raw.kind === 'playtest') {
    if (typeof raw.build !== 'string' || !raw.build) problems.push('a playtest needs --build, the https link of the build');
    else if (raw.build.length > L.build || !isHttps(raw.build)) problems.push(`--build is an https:// link of at most ${L.build} characters`);
    if (raw.platform !== undefined && !PLAYTEST_PLATFORMS.includes(raw.platform)) problems.push(`--platform is one of: ${PLAYTEST_PLATFORMS.join(', ')}`);
    if (!optional(raw.lookFor, L.lookFor)) problems.push(`--look-for is at most ${L.lookFor} characters`);
  } else if (raw.build !== undefined || raw.platform !== undefined || raw.lookFor !== undefined) {
    problems.push('build, platform and lookFor belong to a playtest: add --playtest');
  }
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > L.items) problems.push(`items is a list of 1 to ${L.items}`);
  else {
    raw.items.forEach((item, index) => {
      const at = `item ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { problems.push(`${at} is not an object`); return; }
      if (!text(item.text, L.text)) problems.push(`${at}: text is 1 to ${L.text} characters`);
      if (!optional(item.group, L.group)) problems.push(`${at}: group is at most ${L.group} characters`);
      if (!optional(item.guide, L.guide)) problems.push(`${at}: guide is at most ${L.guide} characters`);
      if (item.link !== undefined && !link(item.link)) problems.push(`${at}: link is an http:// or https:// link of at most 2000 characters`);
      if (item.command !== undefined && (typeof item.command !== 'string' || !trimBlankLines(item.command).trim() || trimBlankLines(item.command).length > L.command)) problems.push(`${at}: command is 1 to ${L.command} characters`);
      if (item.shell !== undefined && !ITEM_SHELLS.includes(item.shell)) problems.push(`${at}: shell is one of: ${ITEM_SHELLS.join(', ')}`);
      if (item.shell !== undefined && item.command === undefined) problems.push(`${at}: shell goes with a command`);
    });
  }
  return problems;
}

/** The checklist.json to write: the input plus id, project, createdAt and from, with positional item ids. */
function checklistFromInput(raw, flags, id) {
  const card = flags.card || raw.card;
  const bead = flags.bead || raw.bead;
  return {
    id, project: flags.project, createdAt: isoNow(),
    from: { host: hostName(), tool: flags.tool || 'claude-code', ...(sessionEnv() ? { session: sessionEnv() } : {}), ...requestEnv() },
    ...(bead ? { bead } : {}),
    title: raw.title.trim(),
    ...(raw.context ? { context: raw.context } : {}),
    ...(card ? { card } : {}),
    ...(STEPS_KINDS.includes(raw.kind) ? { kind: raw.kind } : {}),
    ...(raw.kind === 'playtest' ? { kind: 'playtest', build: raw.build, platform: raw.platform ?? 'web', ...(raw.lookFor ? { lookFor: raw.lookFor } : {}) } : {}),
    items: raw.items.map((item, index) => ({
      id: String(index + 1).padStart(2, '0'), text: item.text.trim(),
      ...(item.group ? { group: item.group } : {}), ...(item.guide ? { guide: item.guide } : {}), ...(item.link ? { link: item.link } : {}),
      ...(item.command ? { command: trimBlankLines(item.command), ...(item.shell ? { shell: item.shell } : {}) } : {}),
    })),
  };
}

/** The names of the files in one checklist's folder; throws when there are none. */
async function checklistNames(id) {
  const names = (await listInbox(`checklists/${id}/`)).map(file => file.split('/').slice(2).join('/'));
  if (!names.includes('checklist.json')) throw new Error(`No checklist ${id}.`);
  return new Set(names);
}

/** Everything `get` shows: the list, its state, progress and the Hub's and the agent's files. */
const CHECKLIST_PICTURE_RE = /^(?:evidence-\d{2}|shot|shot-note)-(?:\d{8}T\d{9}Z)-[a-z0-9]{4}\.(?:png|jpg)$/;

/** The bytes of an inbox file, or null when it is not there. */
async function readInboxBytes(file) {
  const route = fileRoute(file);
  const response = await send('GET', route, { headers: {} });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure('GET', route, response);
  return Buffer.from(await response.arrayBuffer());
}

async function checklistRead(id) {
  const names = await checklistNames(id);
  const checklist = await readJson(inboxPath('checklists', id, 'checklist.json'));
  if (!checklist || !Array.isArray(checklist.items)) throw new Error(`checklists/${id}/checklist.json is not a checklist.`);
  const marks = checklistMarks(names);
  const items = checklist.items.map(item => ({ id: item.id, text: item.text, ...(typeof item.command === 'string' ? { command: item.command } : {}), done: !!marks.get(item.id)?.done, ...(marks.get(item.id) ? { at: marks.get(item.id).at } : {}) }));
  const read = async name => (names.has(name) ? readJson(inboxPath('checklists', id, name)) : undefined);
  const revision = checklistRevision(names);
  const [submit, pickup, cancel, reopen, previous] = await Promise.all([
    read(roundFile('submit', revision)), read(roundFile('pickup', revision)), read('cancel.json'),
    revision > 1 ? read(`reopen-${revision}.json`) : undefined, revision > 1 ? read(roundFile('submit', revision - 1)) : undefined,
  ]);
  // The newest picture per step, and the playtest screenshots, from the file names alone.
  const evidence = {};
  const every = {};
  const shots = [];
  const notePictures = [];
  for (const name of [...names].sort()) {
    if (!CHECKLIST_PICTURE_RE.test(name)) continue;
    if (name.startsWith('shot-note-')) notePictures.push(name);
    else if (name.startsWith('shot-')) shots.push(name);
    else { evidence[name.slice(9, 11)] = name; (every[name.slice(9, 11)] ??= []).push(name); }
  }
  for (const item of items) if (evidence[item.id]) { item.evidence = evidence[item.id]; if (every[item.id].length > 1) item.pictures = every[item.id]; }
  const view = {
    checklist, state: checklistState(names), done: items.filter(item => item.done).length, total: items.length, items, ...(shots.length ? { shots } : {}), ...(notePictures.length ? { notePictures } : {}),
    // After a reopen: the round, when the owner reopened, and the submission it replaces (what an agent may already have acted on).
    ...(revision > 1 ? { revision, ...(reopen ? { reopen } : {}), ...(previous ? { previous } : {}) } : {}),
    ...(submit ? { submit } : {}), ...(pickup ? { pickup } : {}), ...(cancel ? { cancel } : {}),
  };
  // Not part of the printed or JSON view: what `--into` downloads.
  Object.defineProperty(view, 'pictures', { value: [...names].filter(name => CHECKLIST_PICTURE_RE.test(name)).sort() });
  return view;
}

const minute = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

function printChecklist(view, asJson) {
  if (asJson) { console.log(JSON.stringify(view, null, 2)); return; }
  const { checklist, state, done, total, items } = view;
  console.log([checklist.id, state, `${done} of ${total} done`, checklist.project, ...(view.revision ? [`revision ${view.revision}`] : [])].join('\t'));
  console.log(checklist.title);
  if (view.revision) {
    const picked = view.previous && view.reopen?.pickedUp ? ' An earlier answer was picked up: act on the changes, not on that one.' : '';
    console.log(`(reopened by the owner${view.reopen?.at ? ` ${minute(view.reopen.at)}` : ''}: this is revision ${view.revision}, and it replaces the earlier submission, kept below as previous.${picked}${state === 'open' ? ' The owner is editing it; wait for the new submission.' : ''})`);
  }
  for (const item of items) {
    console.log(`${item.done ? '[x]' : '[ ]'} ${item.id} ${item.text}${item.done && item.at ? `  (${minute(item.at)})` : ''}`);
    if (item.command) console.log(item.command.split('\n').map(line => `     $ ${line}`).join('\n'));
    for (const name of item.pictures ?? (item.evidence ? [item.evidence] : [])) console.log(`     evidence: ${name}`);
  }
  for (const shot of view.shots ?? []) console.log(`screenshot: ${shot}`);
  for (const name of view.notePictures ?? []) console.log(`note picture: ${name}`);
  if (checklist.kind === 'playtest') {
    console.log(`playtest: ${checklist.build} (${checklist.platform ?? 'web'})${checklist.lookFor ? `; look for: ${String(checklist.lookFor).replace(/\s+/g, ' ')}` : ''}`);
    const report = view.submit;
    if (report) {
      const issues = Array.isArray(report.issues) ? report.issues : [];
      console.log(`rating: ${report.rating ?? '?'}/5, verdict: ${report.verdict ?? '?'}, ${issues.length} issue(s)`);
      issues.forEach((issue, index) => console.log(`  ${index + 1}. ${String(issue?.text ?? '').replace(/\s+/g, ' ')}${issue?.shot ? ` [${issue.shot}]` : ''}`));
    }
  }
  if (view.reopen) console.log(`== reopen-${view.revision}.json\n${JSON.stringify(view.reopen, null, 2)}`);
  if (view.previous) console.log(`== previous submission (revision ${view.revision - 1}, replaced)\n${JSON.stringify(view.previous, null, 2)}`);
  for (const name of ['submit', 'pickup', 'cancel']) if (view[name]) console.log(`== ${name}${view.revision && name !== 'cancel' ? `-${view.revision}` : ''}.json\n${JSON.stringify(view[name], null, 2)}`);
}

async function checklistCreate(flags) {
  const usage = 'Usage: checklist create --project <p> (--file checklist.json | --title <t> --item <text>...) [--bead <b>] [--card <url>] [--kind verify|setup|investigate|develop] [--playtest --build <https url> [--platform <p>] [--look-for <t>]] [--prose-ok]';
  if (!flags.project || (!flags.file && !flags.title)) throw new Error(usage);
  if (flags.file && (flags.title || flags.item)) throw new Error(`Give --file, or --title with --item, not both. ${usage}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(flags.project)) throw new Error('--project is lower-case letters, digits and dashes');
  const raw = flags.file ? JSON.parse(await readFile(flags.file, 'utf8')) : { title: flags.title, items: (flags.item ?? []).map((text, index) => ({ text, ...(flags.itemCommand?.[index] !== undefined ? { command: flags.itemCommand[index] } : {}), ...(flags.itemShell?.[index] !== undefined ? { shell: flags.itemShell[index] } : {}) })) };
  if (flags.kind !== undefined) {
    if (flags.playtest) throw new Error(`--kind names what the steps are for; a playtest is --playtest, not both. ${usage}`);
    raw.kind = flags.kind;
  }
  for (const name of ['build', 'platform', 'look-for']) if (flags[name] !== undefined && !flags.playtest) throw new Error(`--${name} belongs to a playtest: add --playtest. ${usage}`);
  if (flags.playtest) {
    if (raw.kind !== undefined && raw.kind !== 'playtest') throw new Error(`The file is not a playtest (kind ${JSON.stringify(raw.kind)}), so --playtest does not fit. ${usage}`);
    raw.kind = 'playtest';
    if (flags.build !== undefined) raw.build = flags.build;
    if (flags.platform !== undefined) raw.platform = flags.platform;
    if (flags['look-for'] !== undefined) raw.lookFor = flags['look-for'];
  }
  const problems = validateChecklist(raw);
  if (flags.card !== undefined && !/^https?:\/\//i.test(flags.card)) problems.push('--card is an http:// or https:// link');
  if (problems.length) throw new Error(`checklist.json is not valid: ${problems.join('; ')}.`);
  raw.items.forEach((item, index) => {
    if (item.command === undefined) refuseProseCommand(flags, `Step ${String(index + 1).padStart(2, '0')}`, item.text, 'Put it in --command (one command per step) with --shell, and keep the text to where and why.');
  });
  const id = newId(flags.project, raw.title);
  const checklist = checklistFromInput(raw, flags, id);
  const body = `${JSON.stringify(checklist, null, 2)}\n`;
  if (Buffer.byteLength(body) > CHECKLIST_LIMITS.file) throw new Error('checklist.json is not valid: the file is over 256 KB.');
  const file = inboxPath('checklists', id, 'checklist.json');
  if (await mustPut(file, body, { createOnly: true }) === 'exists') throw new Error(`${file} already exists; run it again.`);
  const steps = checklist.items.length;
  await postEvent({ kind: 'checklist-created', title: clip(checklist.title, 80), project: checklist.project, bead: checklist.bead, checklist: id, source: 'cards', summary: checklist.kind === 'playtest' ? `A build to try: ${steps} things to look at.` : `${steps} steps for you.` }, { out: console.error }).catch(error => console.error(`(checklist-created event skipped: ${error.message})`));
  await pingNeedsYou({ project: checklist.project, text: checklist.kind === 'playtest' ? `Playtest: ${checklist.title}` : `${checklist.title} (${steps} steps)`, path: `/#/~hub/checklist/${id}` }).catch(() => {});
  projectNote(checklist.project);
  console.log(id);
}

async function checklistList(flags) {
  const folders = await listFolders('checklists', flags.all);
  const wanted = flags.project ? new RegExp(`^\\d{8}-${flags.project.toLowerCase().replace(/[^a-z0-9-]/g, '')}-`) : null;
  const ids = [...folders.keys()].filter(id => folders.get(id).has('checklist.json') && (!wanted || wanted.test(id))).sort();
  const rows = await mapLimit(ids, 8, async id => {
    const names = folders.get(id);
    const state = checklistState(names);
    if ((flags.open && state !== 'open') || (flags.submitted && state !== 'submitted')) return null;
    const checklist = await readJson(inboxPath('checklists', id, 'checklist.json'));
    if (!checklist || !Array.isArray(checklist.items)) return null;
    const marks = checklistMarks(names);
    const done = checklist.items.filter(item => marks.get(item.id)?.done).length;
    return { id, state, done, total: checklist.items.length, project: checklist.project ?? '', title: clip(checklist.title, 80), revision: checklistRevision(names) };
  });
  for (const row of rows) if (row && (!flags.project || row.project === flags.project)) console.log([row.id, row.state, `${row.done}/${row.total}`, row.project, row.title, ...(row.revision > 1 ? [`revision ${row.revision}`] : [])].join('\t'));
}

/** A submitted list: every picture of it is downloaded and its full paths printed, with no flag. */
async function checklistFinish(id, view, flags) {
  const taking = view.state === 'submitted' || view.state === 'picked-up';
  if (taking && view.pictures.length) {
    const saved = await savePictures('checklist', 'checklists', id, view.pictures, flags);
    if (flags.json) view.saved = saved;
    printChecklist(view, flags.json);
    if (!flags.json) printSaved(saved, view.pictures.length);
    return;
  }
  printChecklist(view, flags.json);
}

async function checklistGet(id, flags) {
  id = idSafe(id);
  const view = await checklistRead(id);
  if (flags.into === undefined) return checklistFinish(id, view, flags);
  if (flags.into !== undefined) {
    if (typeof flags.into !== 'string' || !flags.into) throw new Error('--into is a folder to put the pictures in.');
    await mkdir(flags.into, { recursive: true });
    const saved = [];
    for (const name of view.pictures) {
      const bytes = await readInboxBytes(inboxPath('checklists', id, name));
      if (!bytes) continue;
      const target = path.join(flags.into, name);
      await writeFile(target, bytes);
      saved.push(target);
    }
    if (flags.json) view.saved = saved;
    printChecklist(view, flags.json);
    if (!flags.json) for (const target of saved) console.log(`saved: ${target}`);
    else if (!saved.length) console.error('(no pictures on this list)');
    return;
  }
  printChecklist(view, flags.json);
}

/** Wait for the owner to submit. Exit 0 on submit (prints what `get` prints), 3 on cancel, 4 on timeout (prints the progress). */
async function checklistWait(id, flags) {
  id = idSafe(id);
  const minutes = flags.timeout === undefined ? 30 : Number(flags.timeout);
  const seconds = flags.every === undefined ? 20 : Number(flags.every);
  if (!(minutes > 0) || minutes > 240) throw new Error('--timeout is a number of minutes above 0 and at most 240.');
  if (!(seconds >= 5)) throw new Error('--every is a number of seconds, at least 5.');
  const deadline = Date.now() + minutes * 60_000;
  for (let first = true; ; first = false) {
    let view;
    try {
      view = await checklistRead(id);
    } catch (error) {
      if (first || /^No checklist/.test(error.message)) throw error;
      console.error(`(poll failed, trying again: ${error.message})`);
    }
    if (view) {
      if (view.state === 'cancelled') { printChecklist(view, flags.json); throw new Exit(3); }
      if (view.state === 'submitted' || view.state === 'picked-up') { await checklistFinish(id, view, flags); return; }
      if (Date.now() >= deadline) {
        console.log(`${view.checklist.id}\t${view.state}\t${view.done} of ${view.total} done\t${view.checklist.project}\t(timed out after ${minutes} min)`);
        throw new Exit(4);
      }
    } else if (Date.now() >= deadline) {
      throw new Exit(4);
    }
    await delay(Math.max(0, Math.min(seconds * 1000, deadline - Date.now())));
  }
}

/** The agent has read the submission and acted on it: exit 2 when it was not submitted, 3 when already picked up. */
async function checklistPickup(id) {
  id = idSafe(id);
  const names = await checklistNames(id);
  const state = checklistState(names);
  if (state === 'picked-up') { console.error(`checklists/${id} was picked up already.`); throw new Exit(3); }
  if (state !== 'submitted') { console.error(`checklists/${id} is ${state}, not submitted: nothing to pick up.`); throw new Exit(2); }
  return claim('checklists', id, roundFile('pickup', checklistRevision(names)), { at: isoNow(), host: hostName(), ...(sessionEnv() ? { session: sessionEnv() } : {}) });
}

/** Withdraw a list that is still open: exit 3 when it was cancelled or submitted already. */
async function checklistCancel(id) {
  id = idSafe(id);
  const state = checklistState(await checklistNames(id));
  if (state !== 'open') { console.error(`checklists/${id} is ${state}, so it cannot be cancelled.`); throw new Exit(3); }
  return claim('checklists', id, 'cancel.json', { at: isoNow(), by: hostName() });
}

// --- requests ---

async function requestList(flags) {
  const folders = await listFolders('requests', flags.all);
  const ids = [...folders.keys()].filter(id => folders.get(id).has('request.json')).sort();
  const rows = await mapLimit(ids, 8, async id => {
    const names = folders.get(id);
    let state = names.has('taken.json') ? 'taken' : names.has('declined.json') ? 'declined' : 'open';
    if (flags.approved || flags.target) {
      // Only an approval the runner could still start: signed, not taken, not stopped, not declined, not finished, not expired.
      if (!names.has('approved.json') || ['taken.json', 'declined.json', 'stop.json', 'result.json'].some(name => names.has(name))) return null;
      const approved = await readJson(inboxPath('requests', id, 'approved.json'));
      if (!approved || !(Date.parse(approved.expires) > Date.now()) || (flags.target && approved.target !== flags.target)) return null;
      state = 'approved';
    }
    if (flags.open && state !== 'open') return null;
    const request = await readJson(inboxPath('requests', id, 'request.json'));
    return { id, state, request };
  });
  for (const row of rows) {
    if (!row || (flags.project && row.request?.project !== flags.project)) continue;
    console.log(`${row.id}\t${row.state}\t${row.request?.project ?? ''}\t${clip(row.request?.text, 80)}`);
  }
}

/** The preset ids a request may name. A copy of Object.keys(PRESETS) in site/api/presets.mjs; a test keeps them equal. */
const PRESET_IDS = ['code-task', 'research', 'market-research', 'game-teardown', 'playtest-build', 'sprite-set', 'agent-avatar', 'docs', 'question', 'mockup', 'projects-brief'];
const REQUEST_NEEDS = ['unity', 'gpu', 'comfyui', 'sprite-studio', 'lan', 'local-files'];
const REQUEST_TARGETS = ['pc', 'cloud', 'hermes', 'at-pc'];
const REQUEST_USAGE = 'Usage: request create --project <p> --text <t> [--title <t>] [--preset <id>] [--repo owner/name] [--needs a,b] [--target pc|cloud|hermes|at-pc] [--done-when <t>] [--origin-run <id>] [--when next-sprint|nightly|record] [--by <name>]';

async function requestCreate(flags) {
  if (!flags.project || !flags.text) throw new Error(REQUEST_USAGE);
  const preset = flags.preset;
  if (preset !== undefined && !PRESET_IDS.includes(preset)) throw new Error(`--preset is one of: ${PRESET_IDS.join(', ')}.`);
  if (preset === undefined && (flags.title || flags.repo || flags.needs || flags.target || flags['done-when'])) {
    throw new Error('--title, --repo, --needs, --target and --done-when need --preset.');
  }
  if (flags.text.length > 4000) throw new Error('--text is at most 4000 characters.');
  if (flags.title !== undefined && (!flags.title.trim() || flags.title.length > 120)) throw new Error('--title is 1 to 120 characters.');
  if (flags.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flags.repo)) throw new Error('--repo is owner/name.');
  if (flags['done-when'] !== undefined && flags['done-when'].length > 400) throw new Error('--done-when is at most 400 characters.');
  if (flags.target !== undefined && !REQUEST_TARGETS.includes(flags.target)) throw new Error(`--target is one of: ${REQUEST_TARGETS.join(', ')}.`);
  // A cloud run needs a repo. The card API does not show a section's tracked repo to a client, so this cannot fill it in: say so now rather than file a request that stops at Approve.
  if (flags.target === 'cloud' && !flags.repo) throw new Error('A cloud request needs --repo owner/name (the project\'s repo is not known here).');
  const needs = flags.needs === undefined ? undefined : [...new Set(flags.needs.split(',').map(item => item.trim()).filter(Boolean))];
  if (needs?.some(item => !REQUEST_NEEDS.includes(item))) throw new Error(`--needs is a comma list of: ${REQUEST_NEEDS.join(', ')}.`);
  const when = flags.when ?? 'next-sprint';
  if (!WHEN.includes(when)) throw new Error(`--when is one of: ${WHEN.join(', ')}.`);
  const by = flags.by || hostName();
  const originRun = flags['origin-run'] ?? process.env.BUW_REQUEST_ID?.trim();
  if (originRun && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(originRun)) throw new Error('--origin-run is a request id.');
  const id = newId(flags.project, flags.text);
  const request = {
    id, project: flags.project, createdAt: isoNow(), by, text: flags.text,
    ...(preset === undefined ? { when } : {
      ...(flags.title ? { title: flags.title } : {}),
      preset,
      ...(flags.repo ? { repo: flags.repo } : {}),
      needs: needs ?? [],
      ...(flags.target ? { target: flags.target } : {}),
      ...(flags['done-when'] ? { doneWhen: flags['done-when'] } : {}),
      origin: originRun ? { kind: 'run', name: originRun } : { kind: 'agent', name: by },
    }),
  };
  const file = inboxPath('requests', id, 'request.json');
  if (await mustPut(file, `${JSON.stringify(request, null, 2)}
`, { createOnly: true }) === 'exists') throw new Error(`${file} already exists; run it again.`);
  console.log(id);
  if (preset !== undefined) {
    await pingNeedsYou({ project: flags.project, text: request.title ?? flags.text, path: `/#/~hub/request/${id}` }).catch(() => {});
  }
}

// --- Runner commands: verify an approval, read its brief, claim it, report progress, finish ---
// What a runner trusts is the owner's Ed25519 signature on approved.json and nothing else: it checks that the signature,
// the request bytes, the target, the expiry, the limits and the nonce all hold, and refuses on the first that does not.

// --- signature check: a copy of canonical, parsePublicKey and verify in site/api/signing.mjs (a test keeps them equal) ---
function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).filter(name => value[name] !== undefined).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function parsePublicKey(text) {
  const body = String(text ?? '').split(/\r?\n/).filter(line => !line.startsWith('-----')).join('').replace(/\s+/g, '');
  return createPublicKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'spki' });
}
function verifySigned(doc, publicKey) {
  try {
    if (!doc || typeof doc !== 'object' || typeof doc.signature !== 'string') return false;
    const signature = Buffer.from(doc.signature, 'base64');
    if (signature.length !== 64) return false;
    const rest = Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'signature'));
    return edVerify(null, Buffer.from(canonical(rest), 'utf8'), publicKey, signature);
  } catch {
    return false;
  }
}
// --- end of the signature check ---

const MAX_RUN_MINUTES = 120;   // MAX_RUN_MINUTES in site/api/presets.mjs
const RUN_STATES = ['started', 'working', 'turn-ended', 'usage-limit'];
const FINISH_OUTCOMES = ['pr', 'card', 'failed'];

/** The public key a runner trusts: HUB_SIGNING_PUBKEY (base64 SPKI or PEM text), else the file BUW_APPROVAL_PUBKEY names, else ~/.buw/secrets/approval-signing-key.pub. Exit 5 without one. */
async function approvalPublicKey() {
  let text = process.env.HUB_SIGNING_PUBKEY?.trim();
  if (!text) {
    const file = process.env.BUW_APPROVAL_PUBKEY?.trim() || path.join(os.homedir(), '.buw', 'secrets', 'approval-signing-key.pub');
    text = await readFile(file, 'utf8').catch(() => '');
  }
  if (!text.trim()) { console.error('no public key: set HUB_SIGNING_PUBKEY or BUW_APPROVAL_PUBKEY, or put approval-signing-key.pub in ~/.buw/secrets.'); throw new Exit(5); }
  try {
    return parsePublicKey(text);
  } catch {
    console.error('no public key: the one given is not an Ed25519 SPKI key.');
    throw new Exit(5);
  }
}

const refuse = reason => { console.error(reason); throw new Exit(5); };

/** The approval for a request if every check holds; else exit 5 naming the first check that failed. */
async function verifyApproval(rawId, { target, repo } = {}) {
  const id = idSafe(rawId);
  if (!id) throw new Error('A request id is needed.');
  const publicKey = await approvalPublicKey();
  const [requestBytes, approvedText, takenBytes, stopText, declinedText, resultText] = await Promise.all([
    readInboxBytes(inboxPath('requests', id, 'request.json')),
    readInbox(inboxPath('requests', id, 'approved.json')),
    readInboxBytes(inboxPath('requests', id, 'taken.json')),
    readInbox(inboxPath('requests', id, 'stop.json')),
    readInbox(inboxPath('requests', id, 'declined.json')),
    readInbox(inboxPath('requests', id, 'result.json')),
  ]);
  // A taken.json that is there but cannot be read counts as taken by someone else.
  let takenDoc = null;
  let takenUnreadable = false;
  if (takenBytes !== null) {
    try { takenDoc = JSON.parse(takenBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { takenUnreadable = true; }
    if (!takenDoc || typeof takenDoc !== 'object') takenUnreadable = true;
  }
  let approved = null;
  try { approved = approvedText === null ? null : JSON.parse(approvedText); } catch { /* unsigned */ }
  if (!approved || typeof approved !== 'object' || Array.isArray(approved) || typeof approved.signature !== 'string') refuse('unsigned: there is no signed approval for this request.');
  if (!verifySigned(approved, publicKey)) refuse('bad-signature: the approval is not signed by the configured key.');
  if (approved.v !== 1 || approved.request !== id) refuse('wrong-request: the approval is for another request.');
  if (requestBytes === null || createHash('sha256').update(requestBytes).digest('hex') !== approved.requestSha256) refuse('hash-mismatch: request.json changed after it was approved.');
  let request = null;
  try { request = JSON.parse(requestBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { /* checked next */ }
  if (!request || request.id !== id || request.project !== approved.project) refuse('wrong-request: request.json does not match the approval.');
  const expires = typeof approved.expires === 'string' ? Date.parse(approved.expires) : NaN;
  if (!(expires > Date.now())) refuse('expired: the approval is past its expiry.');
  const minutes = approved.limits?.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_RUN_MINUTES) refuse(`bad-limits: limits.minutes must be 1 to ${MAX_RUN_MINUTES}.`);
  const run = approved.run;
  if (!run || typeof run !== 'object' || typeof run.brief !== 'string' || !run.brief || typeof run.preset !== 'string') refuse('no-run-block: the approval has no run block.');
  if (stopText !== null) refuse('stopped: the owner stopped this request.');
  if (declinedText !== null) refuse('declined: the owner declined this request.');
  if (resultText !== null) refuse('finished: this request already has a result.');
  if (typeof approved.nonce !== 'string' || !approved.nonce || takenUnreadable || (takenDoc && takenDoc.nonce !== approved.nonce)) refuse('nonce-used: another run took this approval.');
  // This CLI runs pc and cloud approvals only: a hermes one is started by the site API, never by a runner.
  if (!['pc', 'cloud'].includes(approved.target) || (target && approved.target !== target)) refuse(`wrong-target: the approval is for ${approved.target}.`);
  if (repo && approved.repo !== repo) refuse(`wrong-repo: the approval is for ${approved.repo ?? 'no repo'}.`);
  return { id, approved, request };
}

async function requestVerify(rawId, flags) {
  if (flags.target && !['pc', 'cloud'].includes(flags.target)) throw new Error('--target is pc or cloud.');
  const { id, approved } = await verifyApproval(rawId, flags);
  console.log(JSON.stringify({ id, project: approved.project, repo: approved.repo ?? null, target: approved.target, limits: approved.limits, nonce: approved.nonce, preset: approved.run.preset }));
}

async function requestBrief(rawId, flags) {
  if (flags.target && !['pc', 'cloud'].includes(flags.target)) throw new Error('--target is pc or cloud.');
  const { approved } = await verifyApproval(rawId, flags);
  process.stdout.write(approved.run.brief.endsWith('\n') ? approved.run.brief : `${approved.run.brief}\n`);
}

/** Secret-looking runs hidden before text goes to the Hub: sk-…, ghp_…, AKIA…, JWTs, and 32+ character hex or base64 runs. */
function maskSecrets(text) {
  return String(text ?? '')
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[masked]')
    .replace(/\bsk-[\w-]{10,}/g, '[masked]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[masked]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[masked]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[masked]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[masked]');
}

const runId = flags => idSafe(flags._[1] ?? process.env.BUW_REQUEST_ID);
const markStampNow = () => `${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}-${rand(2)}`;   // 20261029T100000123Z-ab12

async function requestTakeRunner(rawId, flags) {
  if (!['pc', 'cloud'].includes(flags.runner)) throw new Error('--runner is pc or cloud.');
  if (!flags.nonce) throw new Error('Usage: request take <id> --runner pc|cloud --nonce <n> [--session <id or link>]');
  const id = idSafe(rawId);
  const approved = await readJson(inboxPath('requests', id, 'approved.json'));
  if (!approved?.nonce) refuse('unsigned: there is no approval to take.');
  if (approved.nonce !== flags.nonce) refuse('nonce-used: that nonce is not this approval\'s.');
  // A signed stop, a decline or a result ends the request: a runner that verified earlier must not start it now.
  if (await readInbox(inboxPath('requests', id, 'stop.json')) !== null) refuse('stopped: the owner stopped this request.');
  if (await readInbox(inboxPath('requests', id, 'declined.json')) !== null) refuse('declined: the owner declined this request.');
  if (await readInbox(inboxPath('requests', id, 'result.json')) !== null) refuse('finished: this request already has a result.');
  const session = flags.session || sessionEnv();
  await claim('requests', id, 'taken.json', { runner: flags.runner, host: hostName(), nonce: approved.nonce, ...(session ? { session } : {}), at: isoNow() });
  // A stop written between the check and the claim: the request now shows "stopping", and the runner must not start. It runs
  // `request finish --outcome failed --reason stopped` to end it.
  if (await readInbox(inboxPath('requests', id, 'stop.json')) !== null) refuse('stopped: the owner stopped this request while it was being taken; do not start it (run request finish --outcome failed --reason stopped).');
}

async function requestRun(flags) {
  const id = runId(flags);
  if (!id) throw new Error('Usage: request run <id> --state started|working|turn-ended|usage-limit [--last <text>] [--link <url>]');
  if (!RUN_STATES.includes(flags.state)) throw new Error(`--state is one of: ${RUN_STATES.join(', ')}.`);
  if (flags.link && !/^https:\/\/\S+$/.test(flags.link)) throw new Error('--link is an https address.');
  const session = sessionEnv();
  const doc = {
    v: 1, request: id, state: flags.state,
    ...(flags.last ? { lastAction: clip(maskSecrets(flags.last), 200) } : {}),
    ...(session ? { session } : {}),
    ...(flags.link ? { sessionLink: flags.link } : {}),
    at: isoNow(),
  };
  const file = inboxPath('requests', id, `run-${markStampNow()}.json`);
  if (await mustPut(file, `${JSON.stringify(doc, null, 2)}\n`, { createOnly: true }) === 'exists') throw new Error(`${file} already exists; run it again.`);
  console.log(file);
}

async function requestFinish(rawId, flags) {
  const id = runId({ _: ['finish', rawId] });
  if (!id) throw new Error('Usage: request finish <id> --outcome pr|card|failed --summary <s> [--pr <url>] [--card <link>] [--reason <r>] [--report <file.md>]');
  if (!FINISH_OUTCOMES.includes(flags.outcome)) throw new Error(`--outcome is one of: ${FINISH_OUTCOMES.join(', ')}.`);
  if (!flags.summary?.trim()) throw new Error('--summary is needed.');
  if (flags.pr && !/^https:\/\/\S+$/.test(flags.pr)) throw new Error('--pr is an https address.');
  let report = null;
  if (flags.report) {
    report = await readFile(flags.report);
    if (report.length > 256 * 1024) throw new Error('--report is over 256 KB.');
  }
  const resultFile = inboxPath('requests', id, 'result.json');
  if (await readInbox(resultFile) !== null) { console.error(`requests/${id}/result.json was written already.`); throw new Exit(3); }
  if (report) await mustPut(inboxPath('requests', id, 'report.md'), report, { createOnly: true, contentType: 'text/markdown' });   // already there: a retry
  const result = {
    v: 1, outcome: flags.outcome,
    ...(flags.pr ? { pr: flags.pr } : {}),
    ...(flags.card ? { card: String(flags.card) } : {}),
    summary: clip(maskSecrets(flags.summary), 500),
    ...(flags.reason ? { reason: clip(maskSecrets(flags.reason), 80) } : {}),
    by: 'run', at: isoNow(),
  };
  if (await mustPut(resultFile, `${JSON.stringify(result, null, 2)}\n`, { createOnly: true }) === 'exists') { console.error(`requests/${id}/result.json was written already.`); throw new Exit(3); }
  console.log(`requests/${id}/result.json`);
  const project = (await readJson(inboxPath('requests', id, 'request.json')).catch(() => null))?.project;
  const quiet = () => {};
  if (flags.pr) await postEvent({ kind: 'pr-opened', title: `PR opened for ${id}`, url: flags.pr, summary: result.summary, source: 'cards-finish', ...(project ? { project } : {}) }, { out: quiet }).catch(() => {});
  if (flags.outcome === 'failed') await postEvent({ kind: 'alert', title: `Run failed: ${id}`, summary: result.summary, source: 'cards-finish', ...(project ? { project } : {}) }, { out: quiet }).catch(() => {});
}

const stampTime = name => {
  const match = /^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +match[7]) : 0;
};

/** The state of one request from its files (no PC report here): the table's rows, without `hermesLive`. */
async function requestStateOf(id, names) {
  const read = name => (names.has(name) ? readJson(inboxPath('requests', id, name)) : Promise.resolve(null));
  const [request, approved, taken, result] = await Promise.all([read('request.json'), read('approved.json'), read('taken.json'), read('result.json')]);
  const now = Date.now();
  if (names.has('declined.json')) return 'declined';
  if (names.has('stop.json')) return result || !taken ? 'stopped' : 'stopping';
  if (result) return result.outcome === 'failed' ? 'failed' : 'done';
  if (!request?.preset) return taken ? 'taken' : 'open';
  if (taken) {
    const newest = Math.max(0, ...[...names].map(stampTime));
    if (now - newest < 20 * 60000) return 'running';
    return now - Date.parse(taken.at) < 20 * 60000 ? 'taken' : 'lost';
  }
  if (approved) return Date.parse(approved.expires) <= now ? 'expired' : 'approved';
  return 'proposed';
}

async function requestState(rawId) {
  const id = idSafe(rawId);
  const names = new Set((await listInbox(`requests/${id}/`)).map(file => file.split('/').slice(2).join('/')));
  if (!names.has('request.json')) { console.error(`No request ${id}.`); throw new Exit(2); }
  console.log(await requestStateOf(id, names));
}

/** The card a finished job made, as <section>/<folder>: a job's card is in its project's section or in assistant, and `state` prints only a state. */
async function requestCard(rawId) {
  const id = idSafe(rawId);
  const result = await readJson(inboxPath('requests', id, 'result.json'));
  if (typeof result?.card !== 'string' || !result.card) {
    console.error('No card yet.');
    throw new Exit(3);
  }
  console.log(result.card);
}

// --- An avatar sheet (the sprite flow): team/<agent>/sheet-<stamp>.png and .json, written by the sheet run ---

const SHEET_STAMP_RE = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Uploads a finished sheet as the agent of the run's own request: the PNG, then the JSON (the Hub lists a sheet by its JSON, so it is
 * never listed before its picture). The agent comes from `requests/<id>/request.json` (preset agent-avatar-sheet), not from an argument.
 */
async function sheetPut(flags) {
  const usage = 'Usage: sheet put --request <id> --stamp <YYYYMMDDTHHMMSSZ-xxxx> --png <file> --meta <file>';
  const id = idSafe(flags.request ?? process.env.BUW_REQUEST_ID);
  if (!id || !flags.stamp || !flags.png || !flags.meta) throw new Error(usage);
  if (!SHEET_STAMP_RE.test(flags.stamp)) throw new Error('--stamp is <YYYYMMDDTHHMMSSZ>-<4 lower-case letters or digits>.');
  const request = await readJson(inboxPath('requests', id, 'request.json'));
  if (!request) { console.error(`No request ${id}.`); throw new Exit(2); }
  if (request.preset !== 'agent-avatar-sheet') throw new Error(`${id} is not an avatar sheet request.`);
  if (typeof request.agent !== 'string' || !AVATAR_SLUG_RE.test(request.agent)) throw new Error(`${id} names no agent.`);
  const png = await readFile(flags.png);
  if (png.length > MAX_INLINE) throw new Error('The sheet PNG is over 4 MB.');
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('The sheet PNG is not a PNG.');
  const jsonBytes = await readFile(flags.meta);
  if (jsonBytes.length > 16 * 1024) throw new Error('The sheet JSON is over 16 KB (the Hub would not list it).');
  let json;
  try { json = JSON.parse(jsonBytes.toString('utf8')); } catch { throw new Error('The sheet JSON is not JSON.'); }
  if (json?.source?.request !== id) throw new Error(`The sheet JSON needs source.request equal to ${id}.`);
  if (json.agent !== request.agent) throw new Error(`The sheet JSON names agent ${JSON.stringify(json.agent ?? null)}, but ${id} is for ${request.agent}; the Hub would not list it.`);
  const name = `sheet-${flags.stamp}`;
  const pngFile = inboxPath('team', request.agent, `${name}.png`);
  const jsonFile = inboxPath('team', request.agent, `${name}.json`);
  if (await mustPut(pngFile, png, { createOnly: true, contentType: 'image/png' }) === 'exists') throw new Error(`${pngFile} is there already; use a new stamp.`);
  if (await mustPut(jsonFile, jsonBytes.toString('utf8'), { createOnly: true }) === 'exists') throw new Error(`${jsonFile} is there already; use a new stamp.`);
  console.log(pngFile);
  console.log(jsonFile);
}

// --- Beads ---

/** A worktree root as it is hashed and stored: forward slashes, no trailing slash. */
const normalRoot = root => String(root ?? '').replace(/[\\]/g, '/').replace(/\/+$/, '');

/** `<host>-<first 10 hex of sha256(root, lower case)>`. The same rule as `copyIdOf` in site/api/hub-beads.mjs. */
const copyIdOf = (host, root) => `${host}-${sha256(normalRoot(root).toLowerCase()).slice(0, 10)}`;

const gitOut = (...args) => {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : '';
};

async function beadsPush(flags) {
  const project = flags.project;
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('Usage: beads push --project <p> [--from <file.jsonl>] [--copy <id>]');
  if (flags.copy !== undefined && (!/^[a-z0-9][a-z0-9-]*$/.test(flags.copy) || flags.copy === 'legacy' || /token|secret|password|credential/.test(flags.copy))) {
    throw new Error('--copy must be lower-case letters, digits and hyphens, not "legacy", and must not contain token, secret, password or credential.');
  }
  let content;
  if (flags.from) {
    content = await readFile(flags.from, 'utf8');
  } else {
    const run = spawnSync('bd export', { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const missing = run.error?.code === 'ENOENT' || run.status === 127 || /not recognized|not found/i.test(run.stderr ?? '');
    if (missing) throw new Error('bd is not installed.');
    if (run.status !== 0) throw new Error(`bd export failed (${run.status}): ${clip(run.stderr, 200)}`);
    content = run.stdout;
  }
  if (Buffer.byteLength(content) > MAX_INLINE) throw new Error('The Beads export is over 4 MB.');
  const root = normalRoot(gitOut('rev-parse', '--show-toplevel') || process.cwd());
  const gitDir = gitOut('rev-parse', '--path-format=absolute', '--git-dir');
  const copy = flags.copy ?? copyIdOf(hostName(), root);
  const meta = {
    v: 2, pushedAt: isoNow(), host: hostName(),
    count: content.split(/\r?\n/).filter(line => line.trim()).length,
    repo: gitOut('remote', 'get-url', 'origin'),
    worktree: root.split('/').pop() || '',
    main: !!gitDir && normalRoot(gitDir) === normalRoot(gitOut('rev-parse', '--path-format=absolute', '--git-common-dir')),
    root,
    branch: gitOut('rev-parse', '--abbrev-ref', 'HEAD'),
  };
  // The data first, then the meta that announces it.
  await mustPut(inboxPath('beads', project, `${copy}.jsonl`), content, { contentType: 'application/x-ndjson' });
  await mustPut(inboxPath('beads', project, `${copy}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`beads/${project}/${copy}.jsonl (${meta.count} issue(s))`);
}

// --- Plan Asks (ws-qdh.3): `beads show` reads the project's roadmap, `ask create --changes` files a change list, `plan apply` runs the approved rows ---

/** The "Workspace section:" of this repository's CLAUDE.md: where `card` changes put a copy of an assistant card. Undefined when there is none. */
function folderSection() {
  const roots = [gitOut('rev-parse', '--show-toplevel'), process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      const found = /Workspace section:\s*`([^`\s]+)`/i.exec(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'));
      return found ? found[1] : undefined;
    } catch { /* no CLAUDE.md here */ }
  }
  return undefined;
}

const BEADS_COPY_MAX = 30;

/** Every copy of a project's Beads export, merged as the Hub does: the Dolt server's copy alone when there is one, else per issue the greatest updated_at wins and a tie goes to the copy pushed later. */
async function mergedBeads(project) {
  const files = (await listInbox('beads/')).filter(file => file.startsWith(`beads/${project}/`) || file === `beads/${project}.jsonl` || file === `beads/${project}.meta.json`);
  const copies = new Map();
  for (const file of files) {
    const match = file.startsWith(`beads/${project}/`) ? /^beads\/[^/]+\/([a-z0-9][a-z0-9-]*)(\.jsonl|\.meta\.json)$/.exec(file) : /^beads\/[^/]+(\.jsonl|\.meta\.json)$/.exec(file);
    if (!match) continue;
    const copy = match.length === 3 ? match[1] : 'legacy';
    const kind = match[match.length - 1] === '.jsonl' ? 'data' : 'meta';
    if (copy !== 'legacy' && /token|secret|password|credential/.test(copy)) continue;
    copies.set(copy, { ...copies.get(copy), [kind]: file });
  }
  const time = value => { const at = new Date(value ?? '').getTime(); return Number.isNaN(at) ? -Infinity : at; };
  const rows = await mapLimit([...copies], 6, async ([copy, row]) => {
    if (!row.data) return null;
    const meta = row.meta ? await readJson(row.meta) : null;
    const text = await readInbox(row.data);
    const issues = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const issue = JSON.parse(line); if (issue && typeof issue === 'object' && (issue._type === undefined || issue._type === 'issue') && typeof issue.id === 'string') issues.push(issue); } catch { /* a bad line is skipped */ }
    }
    return { copy, pushed: time(meta?.pushedAt), issues };
  });
  const fromServer = rows.find(row => row?.copy === 'server');
  const kept = fromServer ? [fromServer] : rows.filter(Boolean).sort((a, b) => b.pushed - a.pushed).slice(0, BEADS_COPY_MAX);
  const best = new Map();
  for (const row of kept) {
    for (const issue of row.issues) {
      const at = time(issue.updated_at);
      const have = best.get(issue.id);
      if (!have || at > have.at || (at === have.at && row.pushed > have.pushed)) best.set(issue.id, { issue, at, pushed: row.pushed });
    }
  }
  return { copies: kept.length, issues: [...best.values()].map(entry => entry.issue) };
}

/** An issue as the Planner reads it: id, title, type, status, parent, labels and what it waits for. */
function compactIssue(issue) {
  const deps = Array.isArray(issue.dependencies) ? issue.dependencies.filter(dep => dep?.issue_id === issue.id) : [];
  return {
    id: issue.id, title: clip(issue.title, 160), type: issue.issue_type ?? 'task', status: issue.status ?? 'open',
    parent: deps.find(dep => dep.type === 'parent-child')?.depends_on_id ?? null,
    labels: Array.isArray(issue.labels) ? issue.labels.filter(label => typeof label === 'string') : [],
    blockers: deps.filter(dep => dep.type === 'blocks').map(dep => dep.depends_on_id),
  };
}

/** `beads show --project <p> [--open] [--json]`: the project's merged Beads copy, read-only and compact. Marks are not applied; this is what Beads says. */
async function beadsShow(flags) {
  const project = flags.project ?? folderProject();
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('Usage: beads show --project <p> [--open] [--json]');
  const { issues } = await mergedBeads(project);
  const rows = issues.map(compactIssue).filter(row => !flags.open || row.status !== 'closed')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(`(no Beads issues for ${project}${flags.open ? ' that are open' : ''})`);
  for (const row of rows) console.log([row.id, row.status, row.type, row.title, row.parent ? `parent=${row.parent}` : '', row.labels.length ? `labels=${row.labels.join(',')}` : '', row.blockers.length ? `blocked-by=${row.blockers.join(',')}` : ''].filter(Boolean).join('\t'));
}

/** How `bd` is run: BUW_BD names a node script (a test's stand-in); on Windows the npm shim is a .cmd, so its node script is run directly, never through a shell. */
function bdCommand() {
  if (process.env.BUW_BD) return { cmd: process.execPath, prefix: [process.env.BUW_BD] };
  if (process.platform === 'win32') {
    for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const script = path.join(dir, 'node_modules', '@beads', 'bd', 'bin', 'bd.js');
      try { readFileSync(script); return { cmd: process.execPath, prefix: [script] }; } catch { /* not in this folder */ }
    }
  }
  return { cmd: 'bd', prefix: [] };
}

/** Run bd with an argument array (no shell). → { ok, out, error } */
function runBd(args) {
  const { cmd, prefix } = bdCommand();
  const run = spawnSync(cmd, [...prefix, ...args], { encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  if (run.error) return { ok: false, out: '', error: run.error.code === 'ENOENT' ? 'bd is not installed.' : run.error.message };
  return { ok: run.status === 0, out: String(run.stdout ?? '').trim(), error: clip(String(run.stderr ?? '').split(/\r?\n/).find(line => line.trim()) ?? `bd exited ${run.status}`, 200) };
}

const showArgs = args => args.map(arg => (/^[\w.:@/=,#+-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ');

/** The bd calls for one change, `ref` mapping #n to the id that create made. Each is an argument array for bd. A `card` change has none. */
function bdCalls(change, text, ref) {
  const description = text ?? change.description;
  if (change.op === 'create') {
    return [['create', `--title=${change.title}`, `--type=${change.type ?? 'task'}`, ...(change.parent ? [`--parent=${ref(change.parent)}`] : []), ...(description ? [`--description=${description}`] : []), ...(change.labels?.length ? [`--labels=${change.labels.join(',')}`] : []), '--silent']];
  }
  if (change.op === 'update') return [['update', ref(change.bead), ...(change.title !== undefined ? [`--title=${change.title}`] : []), ...(description !== undefined ? [`--description=${description}`] : [])]];
  if (change.op === 'dep') return [['dep', 'add', ref(change.blocks), ref(change.bead)]];
  if (change.op === 'close') return [['close', ref(change.bead), `--reason=${text ?? change.reason}`]];
  if (change.op === 'label') return [...(change.add?.length ? [['label', 'add', ref(change.bead), change.add.join(',')]] : []), ...(change.remove?.length ? [['label', 'remove', ref(change.bead), change.remove.join(',')]] : [])];
  return [];
}

/** A `change` verdict on a row replaces the text the owner can edit: a create's or update's description, a close's reason. Other ops cannot take text. */
const takesText = change => ['create', 'update', 'close'].includes(change.op);

/** Copy `assistant/<card>` into the project's section, never over a card that is there already. */
async function copyPlanCard(change, section) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cards-plan-'));
  try {
    await get(change.card, tmp, { all: true });
    const entity = (await readRegistry(tmp)).entities?.[0];
    if (!entity?.id) throw new Error(`${change.card} has no card entry.`);
    let there = true;
    try { await call('GET', `/sections/${section}/cards/${encodeURIComponent(entity.id)}`); } catch (error) { if (error.status === 404) there = false; else throw error; }
    if (there) throw new Error(`${section} has a card ${entity.id} already; it is not overwritten.`);
    await put(tmp, section, entity.id, false);
    return `${section}/${entity.id}`;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * `plan apply <ask id> [--dry-run] [--again]`: runs the rows of an answered change-list Ask that the owner approved, in order
 * (a changed row with the owner's text), with bd called by argument arrays and no shell. Refuses an Ask that is not answered, has no
 * change list, belongs to another project than this repository's, or was picked up already (--again overrides that last one).
 * Stops at the first failure and says which rows are left.
 */
async function planApply(rawId, flags) {
  const id = idSafe(rawId);
  const ask = await readJson(inboxPath('asks', id, 'ask.json'));
  if (!ask) throw new Error(`No ask ${id}.`);
  const answer = await readJson(inboxPath('asks', id, 'answer.json'));
  if (!answer) throw new Error(`Ask ${id} is not answered yet; there is nothing to apply.`);
  if (ask.changes === undefined) throw new Error(`Ask ${id} has no change list.`);
  const problems = validateChanges(ask.changes);
  if (problems.length) throw new Error(`The change list of ask ${id} is not valid: ${problems.slice(0, 6).join('; ')}.`);
  const own = folderProject();
  if (!own) throw new Error('This repository has no "Beads project:" line in its CLAUDE.md, so it is not clear which project this plan is for. Run this in the project\'s own repository.');
  if (ask.project !== own) throw new Error(`Ask ${id} is for project ${ask.project}, and this repository is ${own}. Run it in ${ask.project}'s repository.`);
  if (!flags.again && await readInbox(inboxPath('asks', id, 'pickup.json')) !== null) throw new Error(`Ask ${id} was picked up already, so its plan was applied (or taken over). Use --again only when you are sure it was not.`);
  const dry = !!flags['dry-run'];
  const section = folderSection() ?? own;
  const made = new Map();          // #n -> the id bd gave it
  const left = [];
  let applied = 0;
  let skipped = 0;
  // --journal <file>: after each row { rows: { d1: 'done' }, made: { '#1': 'ws-abc' } } (temp file, then rename). A row in it is not run again and `made` is reloaded, so a crash resumes at the next row.
  const journal = flags.journal !== undefined && !dry ? await readJournal(flags.journal) : { rows: {}, made: {} };
  for (const [ref, bead] of Object.entries(journal.made)) made.set(ref, bead);
  for (const [index, change] of ask.changes.entries()) {
    const row = `d${index + 1}`;
    if (journal.rows[row] === 'done') { console.log(`${row} ${change.op}: already applied (journal)`); applied += 1; continue; }
    const given = answer.decisions?.[row];
    const verdict = given?.verdict;
    const note = typeof given?.note === 'string' ? given.note.replace(/\s+/g, ' ').trim() : '';
    if (verdict !== 'approve' && verdict !== 'change') { console.log(`${row} ${change.op}: skipped (${verdict ?? 'no verdict'})`); skipped += 1; continue; }
    if (verdict === 'change' && (!note || !takesText(change))) { console.log(`${row} ${change.op}: skipped (changed${note ? `, but a ${change.op} takes no text` : ' without text'}; do it by hand)`); skipped += 1; continue; }
    const missing = [change.parent, change.bead, change.blocks].find(value => typeof value === 'string' && /^#\d+$/.test(value) && !made.has(value) && !dry);
    if (missing) { console.log(`${row} ${change.op}: skipped (it needs change ${missing.slice(1)}, which was not applied)`); skipped += 1; continue; }
    const ref = value => (/^#\d+$/.test(value) ? made.get(value) ?? `<new item ${value.slice(1)}>` : value);
    const text = verdict === 'change' ? note : undefined;
    if (change.op === 'card') {
      if (dry) { console.log(`${row} card: would copy ${change.card} into ${section}`); applied += 1; continue; }
      try { console.log(`${row} card: copied to ${await copyPlanCard(change, section)}`); applied += 1; await journalRow(flags.journal, journal, row); } catch (error) { left.push(row, ...ask.changes.slice(index + 1).map((_, k) => `d${index + k + 2}`)); console.log(`${row} card: FAILED ${clip(error.message, 200)}`); return stopped(row, left); }
      continue;
    }
    for (const args of bdCalls(change, text, ref)) {
      if (dry) { console.log(`${row} ${change.op}: would run bd ${showArgs(args)}`); continue; }
      const run = runBd(args);
      if (!run.ok) {
        console.log(`${row} ${change.op}: FAILED bd ${showArgs(args.slice(0, 2))} ... ${run.error}`);
        return stopped(row, [row, ...ask.changes.slice(index + 1).map((_, k) => `d${index + k + 2}`)]);
      }
      if (change.op === 'create') {
        if (!BEAD_ID.test(run.out)) { console.log(`${row} create: FAILED bd printed no id (${clip(run.out, 80)})`); return stopped(row, [row, ...ask.changes.slice(index + 1).map((_, k) => `d${index + k + 2}`)]); }
        made.set(`#${index + 1}`, run.out);
        console.log(`${row} create: made ${run.out}`);
      } else console.log(`${row} ${change.op}: done`);
    }
    if (change.op === 'create' && dry) made.set(`#${index + 1}`, `<new item ${index + 1}>`);
    applied += 1;
    if (!dry) await journalRow(flags.journal, journal, row, change.op === 'create' ? { ref: `#${index + 1}`, bead: made.get(`#${index + 1}`) } : undefined);
  }
  if (!dry && made.size) await recordApplied(id, made);
  console.log(`${dry ? 'Would apply' : 'Applied'} ${applied} of ${ask.changes.length} row(s); ${skipped} skipped.${dry ? '' : ' Next: bd export -o .beads/issues.jsonl, commit it, then cards ask pickup ' + id}`);
}

async function readJournal(file) {
  if (typeof file !== 'string' || !file) throw new Error('--journal is a file to keep the applied rows in.');
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { rows: {}, made: {} }; throw error; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`The journal ${file} is not valid JSON; it is not guessed at. Look at it, or remove it only when no row of this plan was applied.`); }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.rows !== 'object' || !parsed.rows || typeof parsed.made !== 'object' || !parsed.made) throw new Error(`The journal ${file} has no rows and made maps.`);
  return { rows: { ...parsed.rows }, made: { ...parsed.made } };
}

/** Record one applied row (and the id a create made) in the journal, atomically: a temp file, then a rename. No journal flag: nothing. */
async function journalRow(file, journal, row, made) {
  if (file === undefined) return;
  journal.rows[row] = 'done';
  if (made?.bead) journal.made[made.ref] = made.bead;
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(journal, null, 2)}
`);
  await rename(tmp, file);
}

/**
 * The ids the creates of a finished plan made, as `asks/<id>/applied.json` (create-only): the Hub lists them as the tasks the job that filed the
 * Ask delivered. Only the apply job's token is let write it (the card API refuses everyone else), so for any other caller this is a warning and
 * nothing more: a record that cannot be written never fails an apply that already changed Beads.
 */
async function recordApplied(id, made) {
  const created = [...made].map(([ref, bead]) => ({ ref, id: bead })).filter(row => BEAD_ID.test(row.id));
  if (!created.length) return;
  const body = `${JSON.stringify({ v: 1, ask: id, at: isoNow(), by: hostName(), created }, null, 2)}
`;
  try {
    const state = await mustPut(inboxPath('asks', id, 'applied.json'), body, { createOnly: true });
    if (state !== 'ok' && state !== 'exists') console.log(`Note: applied.json was not recorded (${state}).`);
  } catch (error) {
    console.log(`Note: applied.json was not recorded (${clip(error.message, 160)}).`);
  }
}

/** The ending of a plan that stopped: what is left, and exit 1. */
function stopped(row, left) {
  console.log(`Stopped at ${row}. Not applied: ${left.join(', ')}. Fix the cause and apply those rows by hand. Run plan apply again only with --journal <file> (it skips the rows done) or after removing what is done; without a journal, rows already applied would be applied twice.`);
  throw new Exit(1);
}

// --- The owner's marks on the Roadmap: bead-marks/<project>/<bead>/<stamp>-<verdict>-<rand4>.json ---
// The Hub writes done, not-needed, unblock and undo; an agent that closed the issue in Beads (or took the
// needs-owner label off, for unblock) writes applied. A mark is active when the newest owner verdict is not undo
// and no applied note names its file. (The Hub's
// own copy of this rule is site/api/hub-marks.mjs; it also looks at who wrote each verdict file.)

const MARK_NAME = /^(\d{8}T\d{9}Z)-(done|not-needed|unblock|undo|applied)-([a-z0-9]{4})\.json$/;
const BEAD_ID = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]{0,60}$/;
const markProject = flags => {
  if (!flags.project || !/^[a-z0-9][a-z0-9-]*$/.test(flags.project)) throw new Error('Usage: mark list|apply|applied --project <p> [--bead <id>]');
  return flags.project;
};

/** The active marks of a project, oldest first: `{ bead, verdict, at, reason?, file }`. */
async function activeMarks(project, only) {
  const files = (await listInbox(`bead-marks/${project}/${only ? `${only}/` : ''}`)).map(file => file.split('/')).filter(parts => parts.length === 4 && MARK_NAME.test(parts[3]) && BEAD_ID.test(parts[2]));
  const byBead = new Map();
  for (const [, , bead, name] of files) {
    if (!byBead.has(bead)) byBead.set(bead, []);
    byBead.get(bead).push(name);
  }
  const rows = await mapLimit([...byBead], 8, async ([bead, names]) => {
    names.sort();
    // Only the Hub's own verdicts count (the card API tags everything put through it, as the Hub's own rule does): the newest untagged one is the current verdict.
    let owner = null;
    let body = null;
    for (const name of names.filter(item => !item.includes('-applied-')).reverse()) {
      const got = await readInboxWithWriter(`bead-marks/${project}/${bead}/${name}`);
      if (!got || got.writer !== 'none') continue;
      try { body = JSON.parse(got.text); } catch { body = null; }
      owner = name;
      break;
    }
    if (!owner || MARK_NAME.exec(owner)[2] === 'undo') return null;
    if (!body || body.verdict !== MARK_NAME.exec(owner)[2] || typeof body.at !== 'string') return null;
    for (const name of names.filter(item => item.includes('-applied-'))) {
      if ((await readJson(inboxPath('bead-marks', project, bead, name)))?.mark === owner) return null;
    }
    return { bead, verdict: body.verdict, at: body.at, ...(typeof body.reason === 'string' && body.reason ? { reason: clip(body.reason, 500) } : {}), file: owner };
  });
  return rows.filter(Boolean).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.bead < b.bead ? -1 : 1));
}

async function markList(flags) {
  const marks = await activeMarks(markProject(flags));
  if (flags.json) return console.log(JSON.stringify(marks.map(({ file, ...mark }) => mark), null, 2));
  for (const mark of marks) console.log(`${mark.bead}\t${mark.verdict}\t${mark.at}${mark.reason ? `\t${mark.reason}` : ''}`);
}

async function markApplied(flags) {
  const project = markProject(flags);
  if (!BEAD_ID.test(flags.bead ?? '')) throw new Error('Usage: mark applied --project <p> --bead <bead id> (after `bd close` for done and not-needed, or `bd label remove <id> needs-owner` for unblock)');
  const [mark] = await activeMarks(project, flags.bead);
  if (!mark) return console.log('nothing to apply');
  const body = { v: 1, project, bead: flags.bead, verdict: 'applied', at: isoNow(), by: hostName(), mark: mark.file, ...(sessionEnv() ? { session: sessionEnv() } : {}) };
  for (let attempt = 0; ; attempt += 1) {
    const file = inboxPath('bead-marks', project, flags.bead, `${new Date().toISOString().replace(/[-:.]/g, '')}-applied-${rand(2)}.json`);
    if (await mustPut(file, `${JSON.stringify(body, null, 2)}\n`, { createOnly: true }) === 'ok') return console.log(file);
    if (attempt >= 2) throw new Error('Could not find a free name for the applied note; run it again.');
  }
}

// --- The PC's step for the owner's marks and plans (ws-im1.2.3): no session, no model ---
// `mark apply` changes Beads (and withdraws what asked about the bead) and nothing else: it writes no verdict file and no applied
// note. The script that runs it exports Beads, pushes the copy to the Hub and only then writes the applied notes (`mark applied`)
// and the pickups (`ask pickup`). An agent never writes the owner's files (done, not-needed, unblock and undo verdicts).

const NOT_FOUND = /not found|no issues? found|no such issue/i;

/** `bd show <id> --json`: { found, issue? } or { error }. A bd that says the issue is not in this database is `found: false`. */
function bdShow(bead) {
  const run = runBd(['show', bead, '--json']);
  if (!run.ok) return NOT_FOUND.test(`${run.out}\n${run.error}`) ? { found: false } : { error: run.error };
  let rows;
  try { rows = JSON.parse(run.out); } catch { return { error: 'bd show printed no JSON.' }; }
  const issue = Array.isArray(rows) ? rows[0] : rows;
  if (!issue || typeof issue !== 'object' || issue.id !== bead) return { found: false };
  return { found: true, issue };
}

/** Withdraw the open Asks and checklists of a project that name these beads: create-only cancel.json, an existing one is fine. */
async function cancelAskedAbout(project, beads) {
  const wanted = new RegExp(`^\\d{8}-${project}-`);
  const [asks, lists] = await Promise.all([listFolders('asks'), listFolders('checklists')]);
  const open = (folders, file, skip) => [...folders].filter(([id, names]) => wanted.test(id) && names.has(file) && !skip.some(name => names.has(name))).map(([id]) => id);
  const targets = [
    ...open(asks, 'ask.json', ['cancel.json', 'pickup.json', 'answer.json']).map(id => ({ folder: 'asks', id, file: 'ask.json' })),
    ...open(lists, 'checklist.json', ['cancel.json', 'pickup.json', 'submit.json']).map(id => ({ folder: 'checklists', id, file: 'checklist.json' })),
  ];
  await mapLimit(targets, 8, async ({ folder, id, file }) => {
    const body = await readJson(inboxPath(folder, id, file));
    if (body?.project !== project || !beads.has(body.bead)) return;
    await mustPut(inboxPath(folder, id, 'cancel.json'), `${JSON.stringify({ at: isoNow(), by: hostName() }, null, 2)}\n`, { createOnly: true });
  });
}

/** The bd calls of one active mark on an open issue. Each is an argument array; the owner's reason stays one argument. */
function markCalls(mark, issue) {
  const date = String(mark.at).slice(0, 10);
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  if (mark.verdict === 'unblock') {
    return [...(labels.includes('needs-owner') ? [['label', 'remove', mark.bead, 'needs-owner']] : []), ...(issue.status === 'blocked' ? [['update', mark.bead, '--status=open']] : [])];
  }
  const why = mark.reason ? `: ${mark.reason}` : '';
  // --force on both closes: bd refuses to close a task with an open blocker or child, and the owner's tap is the decision; there is no one to ask.
  if (mark.verdict === 'done') return [['close', mark.bead, `--reason=Done (owner, Roadmap ${date})${why}`, '--force']];
  return [['close', mark.bead, `--reason=Not needed (owner, Roadmap ${date})${why}`, '--force'], ...(labels.includes('not-needed') ? [] : [['update', mark.bead, '--add-label=not-needed']])];
}

/**
 * `mark apply --project <p> [--json]`: for each active mark of the project, the steps of "Applying marks" that touch Beads:
 * `bd show` (not in this database: waiting), no bd call for an issue that is closed already, else the verdict's bd calls, then the
 * bead's open Asks and checklists are cancelled. Run it in the project's own checkout. It writes no applied note and no verdict file.
 * → { applied, waiting, failed: [{ bead, error }] }
 */
async function markApply(flags) {
  const project = markProject(flags);
  const marks = await activeMarks(project);
  const result = { applied: [], waiting: [], failed: [] };
  const done = [];
  for (const mark of marks) {
    const shown = bdShow(mark.bead);
    if (shown.error) { result.failed.push({ bead: mark.bead, error: shown.error }); continue; }
    if (!shown.found) { result.waiting.push(mark.bead); continue; }
    let error = '';
    if (shown.issue.status !== 'closed') {
      for (const args of markCalls(mark, shown.issue)) {
        const run = runBd(args);
        if (!run.ok) { error = `bd ${args[0]} failed: ${run.error}`; break; }
      }
    }
    if (error) result.failed.push({ bead: mark.bead, error });
    else done.push(mark.bead);
  }
  if (done.length) {
    try {
      await cancelAskedAbout(project, new Set(done));
      result.applied.push(...done);
    } catch (failure) {
      for (const bead of done) result.failed.push({ bead, error: `could not cancel the Asks on it: ${clip(failure.message, 160)}` });
    }
  }
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  for (const bead of result.applied) console.log(`${bead}\tapplied`);
  for (const bead of result.waiting) console.log(`${bead}\twaiting (not in this checkout's Beads yet)`);
  for (const { bead, error } of result.failed) console.log(`${bead}\tFAILED ${error}`);
  if (!marks.length) console.log('no active marks');
  if (result.failed.length) throw new Exit(1);
}

/**
 * `apply pending --project <p> --json`: what the PC has to apply for a project, read-only. Plans are the Asks of this and last month
 * that have `changes`, an answer.json and neither pickup.json nor cancel.json; marks is the number of active marks.
 * Only folder names are listed first; ask.json is read for an answered, unpicked Ask of the project.
 */
async function applyPending(flags) {
  const project = markProject(flags);
  const folders = await listFolders('asks');
  const wanted = new RegExp(`^\\d{8}-${project}-`);
  const candidates = [...folders].filter(([id, names]) => wanted.test(id) && names.has('ask.json') && names.has('answer.json') && !names.has('pickup.json') && !names.has('cancel.json')).map(([id]) => id).sort();
  const plans = (await mapLimit(candidates, 8, async id => {
    const ask = await readJson(inboxPath('asks', id, 'ask.json'));
    return ask?.project === project && Array.isArray(ask.changes) && !validateChanges(ask.changes).length ? id : null;
  })).filter(Boolean);
  const result = { plans, marks: (await activeMarks(project)).length };
  if (flags.json) return console.log(JSON.stringify(result));
  console.log(`${plans.length} plan(s), ${result.marks} mark(s)${plans.length ? `: ${plans.join(', ')}` : ''}`);
}

// --- The owner's "Not useful" records: feedback/<project>/<kind>/<id>/not-useful.json, filed-<stamp>-<rand4>.json ---
// The Hub writes not-useful.json with no writer mark; anything put through the card API carries `writer: card-api`, which the
// API sends back as x-card-writer. A record counts only when it is served with `none`. A session files the item as a bug in
// Beads and writes a filed note (create-only); a note counts when its bead id is valid and its `at` is not before the record's.

const FEEDBACK_FILE = /^feedback\/([a-z0-9][a-z0-9-]*)\/(ask|checklist|review|blocked)\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})\/(not-useful\.json|filed-\d{8}T\d{9}Z-[a-z0-9]{4}\.json)$/;
const feedbackProject = flags => {
  if (flags.project && !/^[a-z0-9][a-z0-9-]*$/.test(flags.project)) throw new Error('--project is a project id.');
  return flags.project;
};
const feedbackUsage = 'Usage: feedback list [--project <p>] [--unfiled] [--json] | show --project <p> --key <key> [--json] | body --project <p> --key <key> | filed --project <p> --key <key> --bead <id>';

/** The text of an inbox file and the card API's writer mark for it (`none` for the Hub's own write); null when it is not there. */
async function readInboxWithWriter(file) {
  const route = fileRoute(file);
  const response = await send('GET', route, { headers: {} });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure('GET', route, response);
  return { text: Buffer.from(await response.arrayBuffer()).toString('utf8'), writer: response.headers.get('x-card-writer') };
}

/**
 * The records under `feedback/<project>/` (every project when none): `{ records, ignored }`. A record is valid when the Hub wrote it
 * (writer `none`) and its body agrees with its folder. Each carries its valid filed notes, earliest first.
 */
async function feedbackRecords(project) {
  const groups = new Map();
  for (const file of await listInbox(`feedback/${project ? `${project}/` : ''}`)) {
    const match = FEEDBACK_FILE.exec(file);
    if (!match) continue;
    const [, owner, kind, id, name] = match;
    const folder = `${owner}/${kind}/${id}`;
    if (!groups.has(folder)) groups.set(folder, { project: owner, kind, id, filed: [], hasRecord: false });
    if (name === 'not-useful.json') groups.get(folder).hasRecord = true;
    else groups.get(folder).filed.push(name);
  }
  let ignored = 0;
  const rows = await mapLimit([...groups.values()].filter(group => group.hasRecord), 6, async group => {
    const got = await readInboxWithWriter(`feedback/${group.project}/${group.kind}/${group.id}/not-useful.json`);
    if (!got) return null;
    if (got.writer !== 'none') { ignored += 1; return null; }
    let body;
    try { body = JSON.parse(got.text); } catch { return null; }
    const fits = body?.v === 1 && body.project === group.project && body.item?.kind === group.kind && body.item?.id === group.id
      && /^[0-9a-f]{8}$/.test(body.key ?? '') && Number.isFinite(Date.parse(body.at));
    if (!fits) return null;
    const notes = [];
    for (const name of group.filed.sort()) {
      const note = await readJson(inboxPath('feedback', group.project, group.kind, group.id, name));
      if (note?.v === 1 && BEAD_ID.test(note.bead ?? '') && Date.parse(note.at) >= Date.parse(body.at)) notes.push({ bead: note.bead, at: note.at, name });
    }
    notes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.name < b.name ? -1 : 1));
    return { record: body, filed: notes };
  });
  return { records: rows.filter(Boolean).sort((a, b) => (a.record.at < b.record.at ? -1 : a.record.at > b.record.at ? 1 : a.record.key < b.record.key ? -1 : 1)), ignored };
}

async function feedbackFind(flags) {
  const project = feedbackProject(flags);
  if (!project || !/^[0-9a-f]{8}$/.test(flags.key ?? '')) throw new Error(feedbackUsage);
  const found = (await feedbackRecords(project)).records.find(row => row.record.key === flags.key);
  if (!found) throw new Error(`No Not useful record ${flags.key} written by the Hub in ${project}.`);
  return found;
}

async function feedbackList(flags) {
  const { records, ignored } = await feedbackRecords(feedbackProject(flags));
  const shown = records.filter(row => !flags.unfiled || row.filed.length === 0);
  if (flags.json) {
    console.log(JSON.stringify(shown.map(({ record, filed }) => ({ key: record.key, kind: record.item.kind, id: record.item.id, project: record.project, reasonText: record.reasonText ?? '', at: record.at, bead: filed[0]?.bead ?? null })), null, 2));
    if (ignored) console.error(`ignored (not written by the Hub): ${ignored}`);
    return;
  }
  for (const { record, filed } of shown) console.log([record.key, record.item.kind, record.item.id, record.project, clip(record.reasonText, 200) || '-', record.at, filed[0]?.bead ?? '-'].join('\t'));
  if (ignored) console.log(`ignored (not written by the Hub): ${ignored}`);
}

async function feedbackShow(flags) {
  const { record } = await feedbackFind(flags);
  if (flags.json) return console.log(JSON.stringify(record, null, 2));
  console.log(`${record.key}  ${record.item.kind} ${record.item.id}  ${record.project}  ${record.at}`);
  console.log(`Reason: ${record.reasonText || '(none given)'}`);
  console.log(`Title: ${clip(record.title, 200)}`);
  console.log(JSON.stringify({ source: record.source, copy: record.copy }, null, 2));
}

/** The bead description: a pointer and a short summary, never the copy (Beads files are committed, and some repos are public). */
async function feedbackBody(flags) {
  const { record } = await feedbackFind(flags);
  const source = record.source ?? {};
  const where = [source.by, source.host && `on ${clip(source.host, 80)}`, source.tool && `via ${clip(source.tool, 40)}`].filter(Boolean).join(' ');
  console.log([
    `The owner marked this inbox item Not useful: ${clip(record.reasonText, 200) || 'no reason given'}.`,
    '',
    `Item: ${record.item.kind} ${record.item.id}`,
    `Source: ${where || 'unknown'}`,
    `Title: ${clip(record.title, 120)}`,
    ...(typeof record.bead === 'string' && BEAD_ID.test(record.bead) ? [`Bead it named: ${record.bead}`] : []),
    `Marked: ${record.at}`,
    '',
    `Fix it at the source, and add a regression fixture made from the copy. Full copy: cards feedback show --project ${record.project} --key ${record.key}`,
  ].join('\n'));
}

async function feedbackFiled(flags) {
  if (!BEAD_ID.test(flags.bead ?? '')) throw new Error(feedbackUsage);
  const { record } = await feedbackFind(flags);
  // A clock behind the Hub's must not make the note predate the record, or it would never count.
  const at = new Date(Math.max(Date.now(), Date.parse(record.at))).toISOString();
  const body = { v: 1, bead: flags.bead, at, by: hostName(), ...(sessionEnv() ? { session: sessionEnv() } : {}) };
  let written = null;
  for (let attempt = 0; !written; attempt += 1) {
    const name = `filed-${at.replace(/[-:.]/g, '')}-${rand(2)}.json`;
    const file = inboxPath('feedback', record.project, record.item.kind, record.item.id, name);
    if (await mustPut(file, `${JSON.stringify(body, null, 2)}\n`, { createOnly: true }) === 'ok') written = file;
    else if (attempt >= 2) throw new Error('Could not find a free name for the filed note; run it again.');
  }
  const [first] = (await feedbackFind(flags)).filed;
  if (first && first.bead !== flags.bead) {
    console.log(`already filed as ${first.bead}: close yours with bd close ${flags.bead} --reason "duplicate of ${first.bead}"`);
  } else {
    console.log(written);
  }
}

// --- argument parsing for the inbox commands ---

const BOOLEAN_FLAGS = new Set(['dry-run', 'answered', 'open', 'submitted', 'all', 'json', 'require-passkey', 'playtest', 'approved', 'prose-ok', 'unfiled', 'again']);
function parseFlags(args) {
  const flags = { _: [] };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (!arg.startsWith('--')) { flags._.push(arg); continue; }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
    at += 1;
    if (name === 'image') (flags.image ??= []).push(value);
    else if (name === 'item') (flags.item ??= []).push(value);
    else if (name === 'command' || name === 'shell') {
      // These belong to the --item before them: kept by that item's position.
      if (!flags.item) throw new Error(`--${name} goes after the --item it belongs to.`);
      const key = name === 'command' ? 'itemCommand' : 'itemShell';
      const at = flags.item.length - 1;
      if ((flags[key] ??= {})[at] !== undefined) throw new Error(`One --${name} per --item; a second ${name === 'command' ? 'command is a second item' : 'shell would replace the first'}.`);
      flags[key][at] = value;
    }
    else if (name === 'option') (flags.option ??= []).push(value);
    else if (name === 'decision') (flags.decision ??= []).push(value);
    else flags[name] = value;
  }
  return flags;
}

async function inbox(command, args) {
  const flags = parseFlags(args);
  const [sub, id] = flags._;
  await replaySpool().catch(() => {});
  if (command === 'event') return postEvent({ ...flags, kind: sub });
  if (command === 'pr-sync') return prSync(flags);
  if (command === 'ask' && sub === 'create') return askCreate(flags);
  if (command === 'ask' && sub === 'list') return askList(flags);
  if (command === 'ask' && sub === 'get' && id) return askGet(id, flags);
  if (command === 'ask' && sub === 'wait' && id) return askWait(id, flags);
  if (command === 'ask' && sub === 'pickup' && id) return claim('asks', idSafe(id), 'pickup.json', pickupBody(flags));
  if (command === 'ask' && sub === 'cancel' && id) return claim('asks', idSafe(id), 'cancel.json', { at: isoNow(), by: hostName() });
  if (command === 'checklist' && sub === 'create') return checklistCreate(flags);
  if (command === 'checklist' && sub === 'list') return checklistList(flags);
  if (command === 'checklist' && sub === 'get' && id) return checklistGet(id, flags);
  if (command === 'checklist' && sub === 'wait' && id) return checklistWait(id, flags);
  if (command === 'checklist' && sub === 'pickup' && id) return checklistPickup(id);
  if (command === 'checklist' && sub === 'cancel' && id) return checklistCancel(id);
  if (command === 'request' && sub === 'list') return requestList(flags);
  if (command === 'request' && sub === 'create') return requestCreate(flags);
  if (command === 'request' && sub === 'verify' && id) return requestVerify(id, flags);
  if (command === 'request' && sub === 'brief' && id) return requestBrief(id, flags);
  if (command === 'request' && sub === 'run') return requestRun(flags);
  if (command === 'request' && sub === 'finish') return requestFinish(id ?? process.env.BUW_REQUEST_ID, flags);
  if (command === 'request' && sub === 'state' && id) return requestState(id);
  if (command === 'request' && sub === 'card' && id) return requestCard(id);
  if (command === 'request' && sub === 'take' && id && flags.runner !== undefined) return requestTakeRunner(id, flags);
  if (command === 'request' && sub === 'take' && id) {
    const wanted = await readJson(inboxPath('requests', idSafe(id), 'request.json'));
    if (wanted?.preset) {
      console.error('This request is for a dispatched run; it starts only from its approval.');
      throw new Exit(4);
    }
    if (!flags.bead) throw new Error('Usage: request take <id> --bead <bead id>');
    return claim('requests', idSafe(id), 'taken.json', pickupBody(flags));
  }
  if (command === 'sheet' && sub === 'put') return sheetPut(flags);
  if (command === 'beads' && sub === 'push') return beadsPush(flags);
  if (command === 'beads' && sub === 'show') return beadsShow(flags);
  if (command === 'plan' && sub === 'apply' && id) return planApply(id, flags);
  if (command === 'mark' && sub === 'list') return markList(flags);
  if (command === 'mark' && sub === 'apply') return markApply(flags);
  if (command === 'apply' && sub === 'pending') return applyPending(flags);
  if (command === 'mark' && sub === 'applied') return markApplied(flags);
  if (command === 'feedback' && sub === 'list') return feedbackList(flags);
  if (command === 'feedback' && sub === 'show') return feedbackShow(flags);
  if (command === 'feedback' && sub === 'body') return feedbackBody(flags);
  if (command === 'feedback' && sub === 'filed') return feedbackFiled(flags);
  console.error(USAGE);
  throw new Exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const [first] = args;
  if (['event', 'pr-sync', 'ask', 'checklist', 'request', 'sheet', 'beads', 'mark', 'feedback', 'plan', 'apply'].includes(first)) {
    const rest = args.slice(1);
    const at = rest.indexOf('--via');
    const via = (at >= 0 ? rest.splice(at, 2)[1] : undefined) ?? process.env.BUW_CARDS_VIA;
    transport = await pickTransport(via);
    console.error(`(via ${transport.label})`);
    return inbox(first, rest);
  }
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : undefined; };
  const flag = name => { const at = args.indexOf(name); return at >= 0 ? Boolean(args.splice(at, 1)) : false; };
  const into = option('--into') ?? '.';
  const section = option('--section');
  const card = option('--card');
  const dryRun = flag('--dry-run');
  const edit = flag('--edit');
  const removeGone = flag('--remove');
  const textOnly = flag('--text');
  const everything = flag('--all');
  const agent = option('--agent');
  const why = option('--why');
  const context = option('--context');
  const via = option('--via') ?? process.env.BUW_CARDS_VIA;
  const [command, target] = args;
  if (!['login', 'sections', 'list', 'get', 'link', 'put'].includes(command)) {
    console.error(USAGE);
    process.exit(1);
  }
  if (command === 'login') return login();
  transport = await pickTransport(via);
  console.error(`(via ${transport.label})`);

  if (command === 'sections') {
    for (const item of (await call('GET', '/sections')).sections) console.log(`${item.id}\t${item.cards} card(s)\t${item.name}${item.access ? `\t${ACCESS_WORDS[item.access] ?? item.access}` : ''}`);
  } else if (command === 'list' && target) {
    for (const item of (await call('GET', `/sections/${target}`)).cards) console.log(`${item.id}\t${item.updated ?? ''}\t${item.title}`);
  } else if (command === 'get' && target) {
    await get(target, into, { text: textOnly, all: everything });
  } else if (command === 'link' && target) {
    await link(target);
  } else if (command === 'put' && target && section && card) {
    await put(target, section, card, dryRun, { agent, why, context, edit, remove: removeGone });
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

main().catch(error => {
  if (error instanceof Exit) process.exit(error.code);
  // fetch says only "fetch failed"; the network error behind it is in its cause.
  console.error(error.cause ? `${error.message}: ${error.cause.code ?? ''} ${error.cause.message ?? error.cause}`.trim() : error.message);
  process.exit(1);
});
