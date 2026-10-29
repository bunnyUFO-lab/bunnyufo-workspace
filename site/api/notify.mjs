// The `#needs-you` Discord ping from the site API, in the same shape `cards request create` and `cards ask create`
// send (site/card-api/cards.mjs `pingNeedsYou`): a bold "Agent needs you · <Project>", the text clipped to 200
// characters, and a link. Silent without `HUB_DISCORD_NEEDS_YOU`. Never throws, and never logs the webhook URL.
import { titleCase } from './hub-model.mjs';

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

export function createNotify({ env = {}, fetchImpl = fetch, log = () => {} } = {}) {
  const webhook = String(env.HUB_DISCORD_NEEDS_YOU ?? '').trim();
  const site = String(env.BUW_SITE_URL ?? '').trim().replace(/\/+$/, '');
  return {
    configured: !!webhook,
    /** Ping once. `link` is a path such as `/#/~hub/needs/all`; it gets the site URL in front. Resolves true when Discord took it. */
    async needsYou({ project, text, link }) {
      if (!webhook) return false;
      const content = [`**Agent needs you · ${project ? titleCase(project) : 'Hermes'}**`, clip(text, 200), ...(site && link ? [`${site}${link}`] : [])].join('\n');
      try {
        const response = await fetchImpl(webhook, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`Discord answered ${response.status}`);
        return true;
      } catch (error) {
        log(`[hub] the #needs-you ping failed: ${String(error.name === 'TimeoutError' ? 'timed out' : error.message).replace(/https?:[^\s)]+/g, '')}`);
        return false;
      }
    },
  };
}
