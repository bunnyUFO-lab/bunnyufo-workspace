// The #needs-you ping from the site API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotify } from '../notify.mjs';

test('without HUB_DISCORD_NEEDS_YOU nothing is fetched', async () => {
  let calls = 0;
  const notify = createNotify({ env: {}, fetchImpl: async () => { calls += 1; return { ok: true }; } });
  assert.equal(notify.configured, false);
  assert.equal(await notify.needsYou({ project: 'probe', text: 'x', link: '/#/x' }), false);
  assert.equal(calls, 0);
});

test('the message matches the card CLI\'s ping: bold project, clipped text, link, no mentions', async () => {
  const seen = [];
  const notify = createNotify({ env: { HUB_DISCORD_NEEDS_YOU: 'https://hooks.example/secret-token', BUW_SITE_URL: 'https://site.example/' }, fetchImpl: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return { ok: true }; } });
  assert.equal(await notify.needsYou({ project: 'magic-loops', text: `${'a'.repeat(250)}`, link: '/#/~hub/needs/approval' }), true);
  const [url, body] = seen[0];
  assert.equal(url, 'https://hooks.example/secret-token');
  assert.equal(body.content, `**Agent needs you · Magic Loops**\n${'a'.repeat(200)}\nhttps://site.example/#/~hub/needs/approval`);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test('with HUB_DISCORD_OWNER_ID the ping @mentions the owner, and only the owner can be pinged', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true }; };
  const owner = '123456789012345678';
  const notify = createNotify({ env: { HUB_DISCORD_NEEDS_YOU: 'https://hooks.example/t', HUB_DISCORD_OWNER_ID: owner }, fetchImpl });
  await notify.needsYou({ project: 'magic-loops', text: 'Ping <@999999999999999999> and @everyone', link: '' });
  assert.ok(seen[0].content.startsWith(`<@${owner}> **Agent needs you · Magic Loops**`), seen[0].content);
  assert.deepEqual(seen[0].allowed_mentions, { parse: [], users: [owner] });
  // A malformed id is ignored: no mention.
  await createNotify({ env: { HUB_DISCORD_NEEDS_YOU: 'https://hooks.example/t', HUB_DISCORD_OWNER_ID: '<@here>' }, fetchImpl }).needsYou({ project: 'p', text: 'x', link: '' });
  assert.ok(seen[1].content.startsWith('**Agent needs you'), seen[1].content);
  assert.deepEqual(seen[1].allowed_mentions, { parse: [] });
});

test('a failed post logs without the URL and never throws', async () => {
  const lines = [];
  const notify = createNotify({
    env: { HUB_DISCORD_NEEDS_YOU: 'https://hooks.example/secret-token' }, log: line => lines.push(line),
    fetchImpl: async () => { throw new Error('connect failed for https://hooks.example/secret-token'); },
  });
  assert.equal(await notify.needsYou({ project: 'p', text: 'x', link: '/' }), false);
  const bad = createNotify({ env: { HUB_DISCORD_NEEDS_YOU: 'https://hooks.example/secret-token' }, log: line => lines.push(line), fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(await bad.needsYou({ project: 'p', text: 'x', link: '/' }), false);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => !line.includes('secret-token') && !line.includes('hooks.example')), lines.join('|'));
});
