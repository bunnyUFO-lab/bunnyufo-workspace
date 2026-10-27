// Runs the Asks bot. Settings come from BUW_ENV_FILE (KEY=VALUE lines, root-only on the server) and the
// environment; see README.md. It refuses to start without HUB_URL and SITE_URL.
import { readFileSync } from 'node:fs';
import { createBot, createStateFile, readConfig } from './bot.mjs';
import { createDiscordAdapter } from './discord-js.mjs';
import { createHubClient } from './hub-client.mjs';

/** KEY=VALUE lines; blanks and # comments ignored, surrounding quotes dropped. */
function readEnvFile(file) {
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

let config;
try {
  const fromFile = process.env.BUW_ENV_FILE ? readEnvFile(process.env.BUW_ENV_FILE) : {};
  config = readConfig({ ...fromFile, ...process.env });
} catch (error) {
  console.error(`[asks-bot] ${error.code === 'ENOENT' ? `Cannot read the env file ${process.env.BUW_ENV_FILE}.` : error.message}`);
  process.exit(1);
}

const bot = createBot({
  hub: createHubClient({ baseUrl: config.hubUrl, token: config.hubToken }),
  discord: createDiscordAdapter({ token: config.discordToken }),
  store: createStateFile(config.stateDir),
  ownerId: config.ownerId, siteUrl: config.siteUrl, pollSeconds: config.pollSeconds, backfill: config.backfill,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => bot.stop().finally(() => process.exit(0)));
bot.start().catch(error => {
  console.error(`[asks-bot] could not start: ${error?.code ?? error?.message ?? error}`);
  process.exit(1);
});
