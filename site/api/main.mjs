// Runs the site's data service on the server that fronts the published sections.
// Caddy proxies /api/*, /w/* and /sites.json here; nothing else should reach it.
//
//   BUW_S3_BUCKET           the cards bucket (required for anything but a read-only "no bucket" answer)
//   BUW_S3_REGION           its region; default from ~/.aws/config, else us-east-1
//   BUW_S3_PREFIX           where the sections are in it; default `sections`
//   AWS_ACCESS_KEY_ID       a key limited to that bucket (see tools/workspace/setup-bucket.sh)
//   AWS_SECRET_ACCESS_KEY
//   BUW_ENV_FILE            a KEY=VALUE file holding any of the above instead, which is how the
//                           server does it: /srv/buw-docs/_app/api.env is readable by root alone,
//                           and this process is the root that needs it. Compose never opens it,
//                           because compose runs as whoever deploys and would only fail.
//   REQUIRE_REMOTE_USER     `1` refuses writes that carry no Remote-User header (401) and reports the
//                           site read-only to visitors without one. Set it once Nginx Proxy Manager
//                           forwards that header; Caddy strips it from anyone but NPM.
//   HUB                     `1` turns on the Hub routes (/api/hub/…): Asks, requests, events, the progress map.
//                           Reads are open on the LAN, writes need Remote-User like every other write.
//   HERMES_URL, HERMES_API_KEY, HERMES_MODEL   the Hub's chat (Hermes's API server, no /v1; model default hermes-agent)
//   STT_URL, STT_API_KEY, STT_MODEL            push-to-talk (an OpenAI-compatible …/audio/transcriptions)
//                           Chat and speech stay off, and hidden in the UI, until their keys are here.
//   BUW_SITE_URL            the public address people sign in at; named in the read-only message
//   BUW_CARD_API            the card API's address, told to pages in /api/capabilities (`cardApi`)
//   PORT                    default 8099
//
// With no bucket at all the service answers /api/capabilities with write: false and a reason,
// and serves nothing — there is nothing to serve.
import { readFileSync } from 'node:fs';
import { createSiteApi } from './server.mjs';
import { createHub } from './hub.mjs';
import { createBucket } from './s3.mjs';

/** KEY=VALUE lines; blanks and # comments ignored, surrounding quotes dropped. */
export function readEnvFile(file) {
  const values = {};
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // Not there, or not ours to read: the service runs without it and says so.
  }
  return values;
}

const fromFile = process.env.BUW_ENV_FILE ? readEnvFile(process.env.BUW_ENV_FILE) : {};
const env = { ...fromFile, ...process.env };
const port = Number(env.PORT || 8099);
const name = env.BUW_S3_BUCKET || '';
const bucket = name
  ? createBucket({
    bucket: name,
    region: env.BUW_S3_REGION || undefined,
    credentials: env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined }
      : undefined,
  })
  : null;

const requireRemoteUser = env.REQUIRE_REMOTE_USER === '1';
const prefix = env.BUW_S3_PREFIX || 'sections';
const siteUrl = env.BUW_SITE_URL || '';
const cardApi = env.BUW_CARD_API || '';
const hub = createHub({ bucket, prefix, enabled: env.HUB === '1', env });
const server = bucket
  ? createSiteApi({ bucket, prefix, requireRemoteUser, hub, siteUrl, cardApi })
  : createSiteApi({ requireRemoteUser, siteUrl, cardApi });
server.listen(port, '0.0.0.0', () => {
  console.log(`[site-api] ${bucket ? `s3://${name}/${env.BUW_S3_PREFIX || 'sections'}` : 'no bucket (read-only, nothing to serve)'} on :${port}${requireRemoteUser ? ', writes need Remote-User' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
