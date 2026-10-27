#!/usr/bin/env bash
# Builds the app's UI and swaps it into the server's site folder. Run it from the repository root
# on the server (from any CI on your own runner, or by hand). Ported from the old "Publish UI"
# workflow; the Hub notice and the "anything changed?" check belong to the caller.
#
#   BUW_DOCS_ROOT=/srv/buw-docs [SHA=<commit>] site/deploy/publish-ui.sh
#
#   BUW_DOCS_ROOT  required. The server's site folder: the UI goes to $BUW_DOCS_ROOT/_app/ui
#                  (a symlink to the newest of five kept builds in $BUW_DOCS_ROOT/_app/releases).
#   SHA            the commit the release is named after; default `git rev-parse HEAD`.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${BUW_DOCS_ROOT:?BUW_DOCS_ROOT is required: the site folder on the server}"
SHA="${SHA:-$(git rev-parse HEAD)}"

echo "::group::Build (Docker, Node 22)"
docker run --rm -v "$PWD:/app" -v buw-ui-npm:/root/.npm -w /app node:22-bookworm \
  sh -c "npm ci --ignore-scripts --no-audit --no-fund && npm run build && cp -r public/assets/. dist/assets/ && chown -R $(id -u):$(id -g) dist node_modules"
# The phone app needs both: the build emits them next to index.html (vite.config.ts).
[ -f dist/sw.js ] && [ -f dist/manifest.webmanifest ] || { echo "The build lacks sw.js or manifest.webmanifest." >&2; exit 1; }
echo "::endgroup::"

app="$BUW_DOCS_ROOT/_app"
release="$app/releases/$SHA"
mkdir -p "$app/releases"
rm -rf "$release"
cp -a dist "$release"
# Swap the live UI in one step, so the web server never serves a half-copied build.
ln -sfn "releases/$SHA" "$app/ui.new"
mv -Tf "$app/ui.new" "$app/ui"
# Keep the five newest builds.
ls -1dt "$app"/releases/* | tail -n +6 | xargs -r rm -rf
echo "Published UI $(du -sh "$release" | cut -f1) to $app/ui"
