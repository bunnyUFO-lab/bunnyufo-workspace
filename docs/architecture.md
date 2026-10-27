# Service architecture

One Node service does all the work: it serves the built React UI, the card registry, the files
under the active workspace, Markdown saves and the MCP inspector, over HTTP and a WebSocket on
the same origin. Card files (images, reports, models) are served from a second, separate
origin. The app is whatever browser you point at it. Agents run in your own terminal, not in
the app.

| Path | Responsibility |
| --- | --- |
| `src/` | React UI: cards, document previews, live web tabs, files, skills and MCP panels |
| `server/` | HTTP/WebSocket service: card registry, files, Markdown saves, MCP inspector, workspace registry |
| `site/api/` | The published site's data service; the local service also imports its S3 client and card-state store |
| `workspace/workspace.json` | The sample cards' registry; your own workspaces are registered in `~/.buw/workspaces.json` (see [workspaces](workspaces.md)) |
| `workspace/_shared/` | Report CSS and scripts, image viewer and `card-data.js` |
| `.buw/` | Local runtime state; ignored by Git |

## Running it

`docker compose build` and `docker compose up -d` are the whole deployment. The `Dockerfile`
builds the UI, installs the service's production dependencies and runs `server/main.mjs`. The
cards are a mounted folder (`WORKSPACE`, at `/workspace`), not part of the image; settings and
the registry are a volume at `/state`.

Outside a container the service binds `127.0.0.1` on a random port and prints the address on
startup. `BUW_HOST`, `BUW_PORT` and `BUW_PUBLIC_ORIGIN` move it (and `BUW_CONTENT_PORT`,
`BUW_CONTENT_ORIGIN` the card-file origin), which is how it runs in the container: on 8300 and
8301, published on `127.0.0.1`. Do not expose it as a public web server: its token is a
per-launch secret, not a login, so a LAN or public name needs an authenticating proxy in front.

## Checks

```bash
npm ci
npm run lint
npm test
npm run test:template
npm run build
npm run test:service:ui
npm run test:preview
```

On Windows, use `npm ci --os=win32` if a global `.npmrc` pins another platform. The root install
also installs the locked `server` dependencies. If you use `npm ci --ignore-scripts`, run
`npm --prefix server ci` before tests or the service.
