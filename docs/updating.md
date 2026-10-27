# Update the Workspace

The application and your workspace folders are separate. Rebuilding and restarting the app
does not touch your cards, context, credentials or agent conversations.

## What needs redeploying

```bash
npm run redeploy
```

It reports the app (whether the container image is older than the app sources, and whether it
is running) and each workspace (what its folder holds that the bucket lacks, and whether the
published site lists the section).

## Rebuild the application

```bash
git pull
npm run redeploy -- --app
```

That is `docker compose build` followed by `docker compose up -d`: the image is rebuilt from
this repository and the container restarts on it, at <http://127.0.0.1:8300>. Cards, settings
and credentials live outside the image and are untouched. An agent should prepare and verify a
rebuild, then ask before restarting the app.

After an update, `npm run workspace update-shared` copies the new `workspace/_shared` report
styles into the active workspace; publish it afterwards.

## Redeploy the published site

The site serves the cards bucket, so `npm run publish` is the whole deployment for cards: it
uploads what differs and the section is live at once. `npm run publish -- --all` publishes every
registered workspace. The site's interface and data service are deployed from this repository's
`main` by `site/deploy/publish-ui.sh` and `site/deploy/publish-site-api.sh`, run from a private repository's CI on your own runner (see [workspaces](workspaces.md)).

## Skills

Update the `bunnyufo` plugin from Claude Code (`/plugin marketplace update workspace-skills`),
or run `apm install --update` in a project that deploys the packages. See [skills](skills.md).
