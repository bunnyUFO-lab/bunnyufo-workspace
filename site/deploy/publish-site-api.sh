#!/usr/bin/env bash
# Deploys the published site's data service (site/api) and its Caddyfile to the server that hosts the
# workspaces. Run it from the repository root on the server (from any CI on your own runner, or by
# hand). Ported from the old "Publish site API" workflow.
#
#   BUW_DOCS_ROOT=/srv/buw-docs CADDY_DIR=/opt/buw-docs site/deploy/publish-site-api.sh
#
#   BUW_DOCS_ROOT       required. The server's site folder; the service goes to $BUW_DOCS_ROOT/_app/api.
#   CADDY_DIR           required. The Caddy stack's folder: its docker-compose.yml and the Caddyfile.
#   BUW_DOCKER_NETWORK  default buw-docs_default: the network Caddy and the service share.
#   BUW_SITE_API        default buw-site-api:8099: the service, as Caddy reaches it.
#   CADDY_PORT          default 4000: the port the health check calls.
#   BUW_COMPOSE_PROJECT   default api: the compose project name. The development copy deploys from a folder
#                         with the same name, so it must set its own or it would replace the real container.
#   BUW_SITE_API_CONTAINER  default buw-site-api: the container's name.
#
# The service is what serves the site: it streams every section out of the cards bucket and keeps pins,
# archives and tags in state.json there. The bucket name and its key are NOT deployed from here: they
# live on the server in $BUW_DOCS_ROOT/_app/api.env, which this script never writes or reads. Without
# that file the service runs, says it has no bucket, and serves nothing.
#
# The Caddy in front of it (site/caddy/Caddyfile) travels with it: validated, copied to
# $CADDY_DIR/Caddyfile and restarted when it changed. Its compose file must set NPM_IP.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${BUW_DOCS_ROOT:?BUW_DOCS_ROOT is required: the site folder on the server}"
: "${CADDY_DIR:?CADDY_DIR is required: the folder of the Caddy stack}"
BUW_DOCKER_NETWORK="${BUW_DOCKER_NETWORK:-buw-docs_default}"
BUW_SITE_API="${BUW_SITE_API:-buw-site-api:8099}"
CADDY_PORT="${CADDY_PORT:-4000}"
# site/api/docker-compose.yml reads the first and the network name from here.
export BUW_DOCS_ROOT
export BUW_COMPOSE_PROJECT="${BUW_COMPOSE_PROJECT:-api}"
export BUW_SITE_API_CONTAINER="${BUW_SITE_API_CONTAINER:-buw-site-api}"
export BUW_DOCKER_NETWORK

echo "::group::Check it starts and its tests pass"
docker run --rm -v "$PWD:/app" -w /app node:22-bookworm-slim \
  node --test site/api/test/api.test.mjs site/api/test/hub.test.mjs site/api/test/hub-map.test.mjs site/api/test/hub-chat.test.mjs
echo "::endgroup::"

echo "::group::Check the Caddyfile parses"
# A Caddyfile that does not parse takes the whole site down on restart: refuse it here.
docker run --rm -v "$PWD/site/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
echo "::endgroup::"

echo "::group::Deploy"
target="$BUW_DOCS_ROOT/_app/api"
mkdir -p "$target"
# What a new section starts as: the app's own workspace template, carried with the
# service so creating one needs nothing from GitHub but a commit.
rsync -a --delete --exclude _site/ --exclude .jekyll-cache/ --exclude '/sample-*/' --exclude /categories/ --exclude /index.md workspace/ site/api/template/
# The bucket key sits in $BUW_DOCS_ROOT/_app/api.env, one level up: nothing here touches it.
rsync -a --delete site/api/ "$target/"
# Written by mark_deployed once the service and Caddy are healthy, so a failed deploy is retried.
sha="$(git rev-parse HEAD)"
mark_deployed() { echo "$sha" > "$target/.deployed-sha"; }   # after the rsync, whose --delete would remove it
cd "$target"
docker compose up -d --force-recreate
# A container that cannot answer is worse than none: say so here rather than on a phone.
healthy=""
for attempt in $(seq 1 15); do
  if docker run --rm --network "$BUW_DOCKER_NETWORK" curlimages/curl:latest \
       -fsS "http://$BUW_SITE_API/api/capabilities"; then healthy=1; break; fi
  sleep 2
done
if [ -z "$healthy" ]; then
  echo "site-api did not answer /api/capabilities" >&2
  docker compose logs --tail 50
  exit 1
fi
echo "::endgroup::"
cd - >/dev/null

echo "::group::Deploy the Caddyfile"
# $CADDY_DIR is the Caddy stack's folder (its compose file is set up separately); the runner owns it.
# Only a changed file restarts Caddy, so an API-only push leaves it be.
if cmp -s site/caddy/Caddyfile "$CADDY_DIR/Caddyfile"; then
  mark_deployed; echo "Caddyfile unchanged"; exit 0
fi
# Without NPM_IP in Caddy's environment the new Caddyfile refuses every write from everywhere.
caddy_config="$(docker compose -f "$CADDY_DIR/docker-compose.yml" config)"
if ! grep -q 'NPM_IP' <<<"$caddy_config"; then
  echo "Caddy has no NPM_IP: set it in its compose file first, or writes are refused everywhere." >&2
  exit 1
fi
install -m 644 site/caddy/Caddyfile "$CADDY_DIR/Caddyfile"
cd "$CADDY_DIR"
docker compose restart
for attempt in $(seq 1 15); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$CADDY_PORT/sites.json" >/dev/null; then
    mark_deployed; echo "Caddy restarted and answers"; exit 0
  fi
  sleep 2
done
echo "Caddy did not answer on :$CADDY_PORT after the restart" >&2
docker compose logs --tail 30
exit 1
