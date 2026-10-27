#!/usr/bin/env bash
# Deploys the Workspace Asks bot (site/asks-bot) to the server that hosts the workspaces. Run it from the
# repository root on the server, by hand or from CI on your own runner. It is never run on a schedule: the
# bot starts only when someone runs this.
#
#   BUW_DOCS_ROOT=/srv/buw-docs site/deploy/publish-asks-bot.sh
#
#   BUW_DOCS_ROOT  required. The server's site folder; the bot goes to $BUW_DOCS_ROOT/_app/asks-bot.
#
# The bot's settings are NOT deployed from here: they live in $BUW_DOCS_ROOT/_app/asks-bot.env (root only),
# written by scripts/gamedev-tools/asks-bot-env.sh in the homelab repo. Without that file this refuses to start
# the bot. The site API must already know the bot's token (HUB_DISCORD_TOKEN_SHA256 in api.env).
# The compose file mounts only that one env file into the container, never the folder that holds api.env.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${BUW_DOCS_ROOT:?BUW_DOCS_ROOT is required: the site folder on the server}"
export BUW_DOCS_ROOT
sha="$(git rev-parse HEAD)"
target="$BUW_DOCS_ROOT/_app/asks-bot"
env_file="$BUW_DOCS_ROOT/_app/asks-bot.env"

echo "::group::Check the bot's tests pass"
docker run --rm -v "$PWD:/app" -w /app node:22-bookworm-slim \
  node --test site/asks-bot/test/bot.test.mjs
echo "::endgroup::"

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Write it from the PC with scripts/gamedev-tools/asks-bot-env.sh (proxmox-bunnylink); this deploy does not make it." >&2
  exit 1
fi

echo "::group::Deploy"
mkdir -p "$target"
# node_modules is installed on the server and kept; the env file sits one folder up, out of the rsync's reach.
rsync -a --delete --exclude node_modules/ --exclude .deployed-sha site/asks-bot/ "$target/"
# Dependencies in a throwaway container, from the lock file, with no install scripts.
docker run --rm -v "$target:/app" -w /app node:22-bookworm-slim npm ci --omit=dev --ignore-scripts
cd "$target"
docker compose up -d --force-recreate
# Healthy is: running after 10 s, and the log says ready.
sleep 10
if [ "$(docker inspect -f '{{.State.Running}}' buw-asks-bot 2>/dev/null)" != "true" ] || ! docker logs buw-asks-bot 2>&1 | grep -q '\[asks-bot\] ready'; then
  echo "The Asks bot is not running, or never said ready." >&2
  docker compose logs --tail 50
  exit 1
fi
echo "$sha" > "$target/.deployed-sha"
echo "::endgroup::"
echo "Asks bot deployed"
