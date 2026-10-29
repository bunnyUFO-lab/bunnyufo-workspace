import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newRequestId } from '../site/api/hub-model.mjs';
import { DOC, END, START, extractPrompt } from './routine-prompt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(DOC, 'utf8');
const prompt = extractPrompt(doc);
const cardsSource = readFileSync(join(ROOT, 'site', 'card-api', 'cards.mjs'), 'utf8');
const FIRST_LINE = 'You are a dispatched cloud run for Hermes mission control.';

/** Every `node /tmp/cards.mjs request <sub> ...` command in the prompt, with the flags that follow it on its line. */
function commands(text) {
  const found = [];
  for (const line of text.split('\n')) {
    const m = /node \/tmp\/cards\.mjs request (\S+)(.*)$/.exec(line);
    if (m) found.push({ sub: m[1], flags: [...m[2].matchAll(/(?:^|\s)(--[a-z-]+)/g)].map(f => f[1]), line: line.trim() });
  }
  return found;
}

/** The usage text of one `cards request <sub>`: the lines of cards.mjs that name it. */
const usageOf = sub => cardsSource.split('\n').filter(l => new RegExp(`(?:cards )?request ${sub}\\b`).test(l)).join('\n');

test('the prompt is found between its markers; a missing marker gives null', () => {
  assert.ok(prompt && prompt.length > 500);
  assert.equal(extractPrompt('no markers'), null);
  assert.equal(extractPrompt(`${END}\n${START}`), null);
  assert.equal(extractPrompt(`${START}\nhello\n${END}`), 'hello\n');
});

test('the CLI prints the prompt text and nothing else', () => {
  const r = spawnSync('node', [join(ROOT, 'scripts', 'routine-prompt.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, prompt);
});

test('it opens with the fixed line and carries its own text, not a command that prints one', () => {
  assert.equal(prompt.split('\n')[0], FIRST_LINE);
  assert.ok(!prompt.includes('`'), 'no backtick command');
  assert.ok(!prompt.includes('$('), 'no command substitution');
  assert.ok(!/\b(sed|cat|head|tail|less|type)\s+\S*(\.md|\.txt|prompt)/i.test(prompt), 'no command that prints a file');
  assert.ok(!/^\s*(cat|sed)\s/m.test(prompt));
});

test('it is under 6000 characters', () => {
  assert.ok(prompt.length < 6000, `${prompt.length} characters`);
});

test('every cards request command and flag in the prompt exists in the card client', () => {
  const cmds = commands(prompt);
  const subs = new Set(cmds.map(c => c.sub));
  assert.deepEqual([...subs].sort(), ['brief', 'finish', 'run', 'state', 'take', 'verify']);
  for (const { sub, flags, line } of cmds) {
    const usage = usageOf(sub);
    assert.ok(usage, `cards.mjs has no usage for request ${sub} (${line})`);
    for (const flag of flags) assert.ok(usage.includes(flag), `request ${sub} has no ${flag} in cards.mjs (${line})`);
  }
  // Every --flag anywhere in the prompt is a flag of some request command.
  const allUsage = [...subs].map(usageOf).join('\n');
  for (const [, flag] of prompt.matchAll(/(--[a-z-]+)/g)) assert.ok(allUsage.includes(flag), `${flag} is not in the request usage`);
});

test('every flag value the prompt passes is one the client accepts', () => {
  const accepts = (sub, flag, value) => {
    const m = new RegExp(`request ${sub}\\b[^\\n]*?${flag} ([a-z|-]+)`).exec(cardsSource);
    return m && m[1].split('|').includes(value);
  };
  assert.ok(accepts('take', '--runner', 'cloud'));
  assert.ok(accepts('verify', '--target', 'cloud'));
  assert.ok(accepts('brief', '--target', 'cloud'));
  assert.ok(accepts('run', '--state', 'started'));
  assert.ok(accepts('run', '--state', 'working'));
  assert.ok(accepts('finish', '--outcome', 'pr'));
  assert.ok(accepts('finish', '--outcome', 'failed'));
  for (const c of commands(prompt)) {
    for (const [, flag, value] of c.line.matchAll(/(--(?:runner|target|state|outcome)) ([a-z]+)/g)) {
      assert.ok(accepts(c.sub, flag, value), `request ${c.sub} does not take ${flag} ${value}`);
    }
  }
});

test('the prompt follows verify, take, brief in that order, and refuses anything else', () => {
  const order = commands(prompt).map(c => c.sub);
  assert.ok(order.indexOf('verify') < order.indexOf('take') && order.indexOf('take') < order.indexOf('brief'));
  assert.match(prompt, /exits? with 5/);
  assert.match(prompt, /exits? with 3/);
  assert.match(prompt, /never merge/i);
  assert.match(prompt, /never write any inbox file except through/i);
  assert.match(prompt, /claude\/run-ID/);
});

test('its request id pattern accepts real ids and rejects the others', () => {
  const [, source] = /matching (\^\S+\$)/.exec(prompt);
  assert.equal(source, String.raw`^\d{8}-[a-z0-9-]+-[a-z0-9]{4}$`);
  const re = new RegExp(source);
  const id = newRequestId('workspace-app', 'Fix the sort order', new Date('2026-10-29T10:00:00Z'));
  assert.ok(re.test(id), id);
  assert.ok(re.test('20261029-workspace-app-fix-the-sort-order-ab12'));
  for (const bad of ['../x', '20261029-a b-ab12', 'x'.repeat(200), '', '20261029-app-ab', '2026-10-29-app-ab12']) assert.ok(!re.test(bad), bad);
  assert.match(prompt, /at most 120 characters/);
});

test('the doc names variables only: no hosts, addresses, emails or container names', () => {
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(doc), 'an IP address');
  assert.ok(!/\bCT ?\d{3}\b/i.test(doc), 'a container name');
  assert.ok(!/[\w.-]+@[\w-]+\.\w+/.test(doc), 'an email address');
  const hosts = [...doc.matchAll(/https?:\/\/([^\s/)`]+)/g)].map(m => m[1]);
  assert.deepEqual(hosts.filter(h => !['claude.ai', 'github.com'].includes(h)), []);
  assert.ok(doc.includes('BUW_CARD_API') && doc.includes('HUB_SIGNING_PUBKEY') && doc.includes('BUW_CARDS_VIA'));
});

test('the owner leak patterns find nothing in the doc or the prompt script', { skip: !existsSync(join(homedir(), '.buw', 'leak-patterns.txt')) && !process.env.BUW_LEAK_PATTERNS }, () => {
  const r = spawnSync('node', [join(ROOT, 'scripts', 'check-leaks.mjs'), '--root', ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
