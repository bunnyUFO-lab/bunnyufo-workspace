# bunnyUFO Workspace as a web app.
#
# One Node service serves the UI and does the work, so the app runs in a browser against this
# container. Nothing here is Windows-specific, so this image also runs on the server.
#
# The service still listens on loopback by default, which is wrong inside a container — see
# BUW_HOST below. Behind a reverse proxy, set BUW_PUBLIC_ORIGIN to the address the browser
# uses, or every Host, Origin and CSP check will reject the page it just served.

FROM node:22-bookworm-slim AS ui
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: the root postinstall builds server, which this stage does not
# have. Optional dependencies stay: the bundler's native binding is one of them.
RUN npm ci --ignore-scripts
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
# The UI imports the report theme straight out of the service (ReportFrame), and
# vite.config.ts loads a plugin from scripts/, so the build needs both here.
COPY server ./server
COPY scripts ./scripts
# The report stylesheet is imported by the UI's own CSS, so it is a build input too.
COPY workspace/_shared ./workspace/_shared
# `cp -r public/assets dist/assets` would nest them, because Vite has already made dist/assets.
RUN npm run build && cp -r public/assets/. dist/assets/

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# The service's own dependencies (ws). The UI build above is not needed again.
COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev --ignore-scripts
COPY server ./server
# The service imports card state and the S3 client from site/api, shared with the site's API.
COPY site/api ./site/api
COPY scripts ./scripts
COPY tools ./tools
COPY workspace ./workspace
COPY --from=ui /app/dist ./dist

# Loopback inside a container is reachable only from inside it. 0.0.0.0 with a published
# port is the equivalent of the shell's private loopback: bind it to 127.0.0.1 on the host
# (see docker-compose.yml) so it is no more exposed than the local app was.
ENV BUW_HOST=0.0.0.0 \
    BUW_PORT=8300 \
    BUW_CONTENT_PORT=8301
EXPOSE 8300 8301

# Cards live outside the image, mounted at /workspace; the registry and settings at /state.
ENV BUW_CONTENT=/workspace \
    BUW_REGISTRY=/state/workspaces.json
VOLUME ["/workspace", "/state"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BUW_PORT||8300)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/main.mjs", "--repo", "/app", "--ui", "/app/dist", "--state", "/state"]
