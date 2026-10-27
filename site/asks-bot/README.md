# Workspace Asks bot

Sends each simple multiple-choice Ask to the owner as a Discord direct message with one button per option.
A click records the choice in the Ask's `answer.json` with `via: "discord"`. Notes, drawings and Asks that
require a passkey stay in the web app. The trust model, the kill switches and what reaches Discord are in
`docs/workspaces.md` ("Answers from Discord").

## Files

| File | Does |
|---|---|
| `bot.mjs` | The core: polling, posting, clicks, the alarm and the state file. No Discord and no network of its own. |
| `hub-client.mjs` | The two calls the narrow token may make, and one open read. |
| `discord-js.mjs` | The only file that imports `discord.js` (pinned to an exact version in `package.json`). |
| `main.mjs` | Reads the settings and starts it. |
| `new-token.mjs` | Makes the narrow token and its hash. |

## Settings

From `BUW_ENV_FILE` (KEY=VALUE lines) and the environment. There is no default for `HUB_URL` or `SITE_URL`;
the bot refuses to start without them. It never logs a token or a user id.

| Key | |
|---|---|
| `DISCORD_TOKEN` | The bot token of the application. |
| `HUB_TOKEN` | The narrow token. The site API holds only its sha256 (`HUB_DISCORD_TOKEN_SHA256`). |
| `OWNER_ID` | The Discord user id that may click. The API checks it too (`HUB_DISCORD_OWNER_ID`). |
| `HUB_URL` | The site API, for example `http://site-api:8099` (the compose file sets the container name). |
| `SITE_URL` | The Hub's address, for the "Open in the Hub" link. |
| `POLL_SECONDS` | Default 60. |
| `BACKFILL` | `1` also posts Asks made before the first start. Off by default. |
| `STATE_DIR` | Where `state.json` lives; the compose file mounts a volume at `/state`. |

## Run it

```
node site/asks-bot/new-token.mjs --out <file>      # the narrow token and <file>.sha256, once
cd site/asks-bot && npm ci --omit=dev
BUW_ENV_FILE=<env file> HUB_URL=<site api> STATE_DIR=<dir> node main.mjs
```

On a server it is deployed by `site/deploy/publish-asks-bot.sh`. Nothing starts it by itself. Tests:
`node --test site/asks-bot/test/*.test.mjs` (they need neither Discord nor `discord.js`).

## Discord setup

One application named "Workspace Asks", with "Public Bot" off and every privileged intent off. Invite it with
scope `bot` and permissions `0`. A bot can DM a user only when they share a server, and the user must allow
direct messages from server members (otherwise Discord answers error 50007, which the bot logs once per Ask).
