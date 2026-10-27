// The Asks bot's core: poll the site API for the Asks that may have buttons, post each to the owner
// as a Discord DM, and turn a click into one answer. It talks only to an injected `discord` adapter
// (discord-js.mjs holds the only import of discord.js) and an injected `hub` client (hub-client.mjs),
// so the tests run it with neither network nor Discord.
//
// What the bot is trusted with is decided on the server (docs/workspaces.md, "Answers from Discord"):
// the bot lists, posts, and sends the owner's click back with the `rev` it was given. It decides nothing
// about which Asks qualify, and it never logs a token or a user id.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CHANGED = 'This Ask changed since it was posted.';
const SENT_CAP = 500;
const QUESTION_CAP = 1500;
const ALARM_CAP = 80;

const clip = (text, length) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1)}…` : one;
};
const titleCase = id => String(id).split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

/**
 * The bot's settings, from a merged environment. There is no default for HUB_URL or SITE_URL: a bot
 * pointed at the wrong place is worse than one that does not start.
 */
export function readConfig(env) {
  const missing = ['DISCORD_TOKEN', 'HUB_TOKEN', 'OWNER_ID', 'HUB_URL', 'SITE_URL'].filter(name => !String(env[name] ?? '').trim());
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Set them in the env file (BUW_ENV_FILE) or the environment; there are no defaults for HUB_URL and SITE_URL.`);
  const url = name => {
    try {
      const parsed = new URL(String(env[name]).trim());
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme');
      return String(env[name]).trim().replace(/\/+$/, '');
    } catch {
      throw new Error(`${name} is not an http(s) address.`);
    }
  };
  if (!/^\d{17,20}$/.test(String(env.OWNER_ID).trim())) throw new Error('OWNER_ID is a Discord user id (17 to 20 digits).');
  const poll = Number(env.POLL_SECONDS || 60);
  if (!Number.isFinite(poll) || poll < 5) throw new Error('POLL_SECONDS is a number of seconds, at least 5.');
  return {
    discordToken: String(env.DISCORD_TOKEN).trim(), hubToken: String(env.HUB_TOKEN).trim(), ownerId: String(env.OWNER_ID).trim(),
    hubUrl: url('HUB_URL'), siteUrl: url('SITE_URL'), pollSeconds: poll, backfill: env.BACKFILL === '1',
    stateDir: String(env.STATE_DIR || './state'),
  };
}

/** state.json: { since, posted: { askId: { channel, message, rev, ... } }, sent: [interactionId…] }, written atomically. */
export function createStateFile(dir) {
  const file = path.join(dir, 'state.json');
  return {
    file,
    load() {
      try {
        const state = JSON.parse(readFileSync(file, 'utf8'));
        return { since: typeof state.since === 'string' ? state.since : null, posted: state.posted && typeof state.posted === 'object' ? state.posted : {}, sent: Array.isArray(state.sent) ? state.sent.map(String) : [] };
      } catch {
        return null;
      }
    },
    save(state) {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    },
  };
}

/**
 * @param hub      { listAsks() → { asks }, getAsk(id) → detail | null, answer(body) → { status, body } }
 * @param discord  { sendDM(userId, message) → { channel, message }, editMessage({ channel, message }, message),
 *                   onClick(handler), start(), stop() }; a message is { content, components }, where
 *                   components is null (no buttons) or { options: [{ customId, label }], link: { label, url } | null }
 *                   and a click is { id, user, customId, message, channel, deferUpdate(), ephemeral(text) }
 * @param store    createStateFile(dir), or anything with load() and save(state)
 */
export function createBot({ hub, discord, store, ownerId, siteUrl, pollSeconds = 60, backfill = false, now = () => new Date(), log = console.log, setTimer = setInterval, clearTimer = clearInterval }) {
  if (!hub || !discord || !store) throw new Error('The bot needs a hub client, a Discord adapter and a state store.');
  if (!siteUrl) throw new Error('SITE_URL is required.');
  let state = null;
  let timer = null;
  let polling = false;
  const refused = new Set();          // Asks Discord would not take (50007: DMs off), logged once

  const askLink = id => `${siteUrl}/#/~hub/ask/${encodeURIComponent(id)}`;
  const linkOnly = id => ({ options: [], link: { label: 'Open in the Hub', url: askLink(id) } });
  const save = () => store.save({ ...state, sent: state.sent.slice(-SENT_CAP) });

  function load() {
    const loaded = store.load();
    if (loaded) {
      state = loaded;
      if (!state.since) state.since = backfill ? new Date(0).toISOString() : now().toISOString();
    } else {
      state = { since: backfill ? new Date(0).toISOString() : now().toISOString(), posted: {}, sent: [] };
    }
    save();
  }

  const labelOf = (entry, choice) => (entry.options ?? []).find(option => option.id === choice)?.label;
  const answeredText = (entry, answer) => {
    const label = labelOf(entry, answer?.choice);
    const how = answer?.via === 'discord' ? 'via Discord' : 'in the Hub';
    return `Answered: ${answer?.choice ?? '?'}${label ? ` · ${label}` : ''}, ${how}`;
  };

  /** Edit a posted DM to its last state and stop tracking it. A failed edit is logged and does not block the rest. */
  async function finish(id, status, components = null) {
    const entry = state.posted[id];
    if (!entry) return;
    delete state.posted[id];
    save();
    try {
      await discord.editMessage({ channel: entry.channel, message: entry.message }, { content: `${entry.content}\n\n${status}`, components });
    } catch (error) {
      log(`[asks-bot] could not edit the message for ${id}: ${error.code ?? error.message}`);
    }
  }

  async function post(ask) {
    const question = clip(ask.question, QUESTION_CAP);
    const content = `**Agent needs you · ${titleCase(ask.project || 'unknown')}**\n${question}`;
    const options = ask.options.map(option => ({ id: option.id, label: option.label }));
    const components = {
      options: options.map(option => ({ customId: `a:${ask.id}:${option.id}`, label: option.label })),
      link: { label: 'Open in the Hub', url: askLink(ask.id) },
    };
    try {
      const sent = await discord.sendDM(ownerId, { content, components });
      state.posted[ask.id] = { channel: sent.channel, message: sent.message, rev: ask.rev, content, question: clip(ask.question, 200), options };
      save();
    } catch (error) {
      if (error?.code === 50007) {
        if (!refused.has(ask.id)) { refused.add(ask.id); log(`[asks-bot] Discord refused the DM for ${ask.id} (50007): allow direct messages from server members`); }
      } else {
        log(`[asks-bot] could not post ${ask.id}: ${error?.code ?? error?.message ?? error}`);
      }
    }
  }

  async function alarm(id, entry, detail) {
    const question = clip(detail?.question ?? entry.question, ALARM_CAP);
    log(`[asks-bot] ALARM ${id}: answered through the Discord path with an interaction this bot did not send`);
    try {
      await discord.sendDM(ownerId, { content: `${question} was answered through the Discord path, but not from this bot. Check the token.`, components: null });
    } catch (error) {
      log(`[asks-bot] could not send the alarm: ${error?.code ?? error?.message}`);
    }
  }

  /** A posted Ask the list no longer shows: read it once, say what became of it, stop tracking it. */
  async function settle(id) {
    const entry = state.posted[id];
    let detail;
    try {
      detail = await hub.getAsk(id);
    } catch (error) {
      log(`[asks-bot] could not read ${id}: ${error.message}`);
      return;                                  // try again on the next poll
    }
    if (!detail) return finish(id, 'This Ask is no longer there.');
    if (detail.answer) {
      const answer = detail.answer;
      if (answer.via === 'discord' && !state.sent.includes(String(answer.discord?.interaction ?? ''))) await alarm(id, entry, detail);
      return finish(id, answeredText(entry, answer));
    }
    switch (detail.state) {
      case 'cancelled': return finish(id, 'This Ask was cancelled.');
      case 'picked-up': return finish(id, 'An agent picked this up.');
      case 'expired': return finish(id, 'This Ask expired.');
      case 'snoozed': return undefined;        // still answerable: keep the buttons
      default: return finish(id, 'Answer this one in the Hub.', linkOnly(id));
    }
  }

  async function poll() {
    if (!state) load();
    if (polling) return;
    polling = true;
    try {
      const { asks } = await hub.listAsks();
      const listed = new Map(asks.map(ask => [ask.id, ask]));
      for (const ask of [...asks].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
        const posted = state.posted[ask.id];
        if (posted) {
          if (posted.rev !== ask.rev) await finish(ask.id, 'This Ask changed. Open it in the Hub.', linkOnly(ask.id));
          continue;
        }
        if (ask.requirePasskey === true) continue;                       // the server leaves these out; checked again here
        if (!(Date.parse(ask.createdAt) > Date.parse(state.since))) continue;
        if (refused.has(ask.id)) continue;
        await post(ask);
      }
      for (const id of Object.keys(state.posted)) if (!listed.has(id)) await settle(id);
    } catch (error) {
      log(`[asks-bot] poll failed: ${error.message}`);
    } finally {
      polling = false;
    }
  }

  async function handleClick(click) {
    if (!state) load();
    if (click.user !== ownerId) {
      await click.ephemeral('Only the owner can answer this.');
      return;                                  // nothing is called and no id is logged
    }
    const match = /^a:([^:]+):(.+)$/.exec(String(click.customId));
    const askId = match?.[1];
    const entry = askId ? state.posted[askId] : undefined;
    if (!match || !entry || entry.message !== click.message) {
      await click.ephemeral(`Open it in the Hub: ${askId ? askLink(askId) : siteUrl}`);
      return;
    }
    await click.deferUpdate();                 // Discord gives three seconds
    state.sent.push(String(click.id));
    save();
    let reply;
    try {
      reply = await hub.answer({ ask: askId, choice: match[2], rev: entry.rev, user: click.user, interaction: String(click.id), message: String(click.message) });
    } catch {
      await click.ephemeral('Could not reach the Hub; try again.');
      return;
    }
    const { status, body } = reply;
    if (status === 201) return finish(askId, answeredText(entry, { ...body?.answer, choice: body?.answer?.choice ?? match[2], via: 'discord' }));
    if (status === 409) {
      if (body?.answer) return finish(askId, answeredText(entry, body.answer));
      if (body?.error === CHANGED) return finish(askId, 'This Ask changed. Open it in the Hub.', linkOnly(askId));
      return finish(askId, String(body?.error ?? 'This Ask can no longer be answered.'));
    }
    if (status === 403) return finish(askId, 'Answer this one in the Hub.', linkOnly(askId));
    if (status === 400) return click.ephemeral(String(body?.error ?? 'The Hub did not accept that.'));
    return click.ephemeral('The Hub did not take that answer; try again.');
  }

  return {
    poll, handleClick,
    /** For tests and for logs: what is tracked. */
    snapshot: () => structuredClone(state ?? { since: null, posted: {}, sent: [] }),
    async start() {
      load();
      discord.onClick(click => handleClick(click).catch(error => log(`[asks-bot] click failed: ${error?.message ?? error}`)));
      await discord.start();
      await poll();
      timer = setTimer(() => { poll(); }, pollSeconds * 1000);
      timer?.unref?.();
      log('[asks-bot] ready');
    },
    async stop() {
      if (timer) clearTimer(timer);
      timer = null;
      await discord.stop?.();
    },
  };
}
