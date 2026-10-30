// What the Roadmap sheet says about one Beads issue, with no I/O: a short summary from its
// description, the pull requests and commits its text records, and the Library cards it names.
// `buildMap` (hub-map.mjs) calls these; the browser only shows what they return.

/** Markdown to the plain words it shows: links and images keep their text, emphasis and code marks go. */
export const plainText = text => String(text)
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`~]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export const SUMMARY_MAX = 240;
const HASH = '[0-9a-f]{7,40}';
const HASH_LINE = new RegExp(`^${HASH}([\\s,;]+(${HASH}|\\d{4}-\\d{2}-\\d{2}))*\\.?$`, 'i');
// Lines that are evidence for the next reader, not words about the work.
const BOILERPLATE = [/^Backfilled \d{4}-\d{2}-\d{2}\b/, /^PRs?:\s*#\d+/, /^#{1,6}\s/, HASH_LINE];
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"(])/;

/**
 * One or two sentences saying what an issue is, from its description: the first paragraph left after
 * the backfill boilerplate, headings and hash-only lines are dropped, as plain text, at most two
 * sentences and 240 characters (`…` when clipped). Null when fewer than four words remain.
 */
export function summaryOf(description) {
  const paragraphs = String(description ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  for (const paragraph of paragraphs) {
    const kept = paragraph.split('\n').map(line => line.trim()).filter(line => line && !BOILERPLATE.some(rule => rule.test(line)));
    if (!kept.length) continue;
    const text = plainText(kept.map(line => line.replace(/^[-*+]\s+/, '')).join(' '));
    if (text.split(' ').filter(word => /\p{L}{2}/u.test(word)).length < 4) return null;
    const two = text.split(SENTENCE_BREAK).slice(0, 2).join(' ');
    return two.length > SUMMARY_MAX ? `${two.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : two;
  }
  return null;
}

/** `owner/name` of a GitHub repository, from `git@github.com:o/n(.git)`, `https://github.com/o/n(.git)` or a bare `o/n`; null for any other host. */
export function githubSlug(repo) {
  const text = String(repo ?? '').trim();
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(text) ?? /^([\w.-]+\/[\w.-]+)$/.exec(text);
  return match ? match[1] : null;
}

const PR_STATES = new Set(['open', 'merged', 'closed']);

/** `[{ number, url?, state?, source: 'beads' }]` from `external_ref: gh-<n>` and `PR: #<n> <state>` lines, once per number. */
export function prsFromIssue(issue, repo) {
  const rows = new Map();
  const add = (number, state) => {
    const have = rows.get(number);
    if (!have) rows.set(number, { number, ...(state ? { state } : {}) });
    else if (state && !have.state) have.state = state;
  };
  const ref = /^gh-(\d+)$/.exec(String(issue?.external_ref ?? '').trim());
  if (ref) add(Number(ref[1]));
  for (const line of String(issue?.description ?? '').split(/\r?\n/)) {
    const head = /^PRs?:\s*(#\d.*)$/.exec(line.trim());
    if (!head) continue;
    for (const match of head[1].matchAll(/#(\d+)(?:\s+([A-Za-z]+))?/g)) {
      const state = match[2]?.toLowerCase();
      add(Number(match[1]), state && PR_STATES.has(state) ? state : undefined);
    }
  }
  const slug = githubSlug(repo);
  return [...rows.values()].map(row => ({ number: row.number, ...(slug ? { url: `https://github.com/${slug}/pull/${row.number}` } : {}), ...(row.state ? { state: row.state } : {}), source: 'beads' }));
}

/** Up to 5 `{ sha, url? }` from the lines of a description that hold only commit hashes (and dates). */
export function commitsFromIssue(issue, repo) {
  const slug = githubSlug(repo);
  const seen = new Set();
  const out = [];
  for (const line of String(issue?.description ?? '').split(/\r?\n/)) {
    if (!HASH_LINE.test(line.trim())) continue;
    for (const sha of line.trim().toLowerCase().match(new RegExp(HASH, 'g')) ?? []) {
      if (seen.has(sha) || out.length >= 5) continue;
      seen.add(sha);
      out.push({ sha, ...(slug ? { url: `https://github.com/${slug}/commit/${sha}` } : {}) });
    }
  }
  return out;
}

const safeDecode = text => { try { return decodeURIComponent(text); } catch { return text; } };
const FOLDER_REF = /^[a-z0-9][a-z0-9-]{0,63}\/[^/\s]+$/;
const ID_REF = /^[a-z0-9][a-z0-9-]{0,63}#[^/\s#]+$/;

/**
 * The Library cards an issue names, as `section/folder` (or `section#id` for a link): from
 * `metadata.cards` (an array, or a string split on commas and spaces) and from Library links and
 * `sections/<section>/<folder>` paths in the description. Order kept, junk dropped, once each.
 */
export function cardRefsOf(issue) {
  const found = [];
  const meta = issue?.metadata?.cards;
  const listed = Array.isArray(meta) ? meta : typeof meta === 'string' ? meta.split(/[\s,]+/) : [];
  for (const ref of listed) if (typeof ref === 'string') found.push(ref.trim());
  const text = String(issue?.description ?? '');
  // A Library link: any site host, path `/<section>`, fragment `#/<card id>`.
  for (const match of text.matchAll(/https?:\/\/[^\s/)]+\/([a-z0-9][a-z0-9-]{0,63})#\/([^\s)\]>"']+)/g)) found.push(`${match[1]}#${safeDecode(match[2]).replace(/[.,;:]+$/, '')}`);
  for (const match of text.matchAll(/(?<![\w/])sections\/([a-z0-9][a-z0-9-]{0,63})\/([^/\s)\]>"'`]+)/g)) found.push(`${match[1]}/${match[2].replace(/[.,;:]+$/, '')}`);
  return [...new Set(found.filter(ref => ref && !ref.includes('..') && (FOLDER_REF.test(ref) || ID_REF.test(ref))))];
}
