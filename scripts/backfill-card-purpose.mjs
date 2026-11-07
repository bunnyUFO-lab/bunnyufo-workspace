// One-time: mark the cards that only report agent work with `purpose: "report"`, so the Library files them
// in the Archive 7 days after their last change. It works on the cards bucket, not on the local folders:
// `assistant` is never a local folder, and pins and hand-archived status live in state.json.
//
//   node scripts/backfill-card-purpose.mjs                     dry run: per-section counts, nothing written
//   node scripts/backfill-card-purpose.mjs --out list.md       also write the list, by section, as Markdown
//   node scripts/backfill-card-purpose.mjs --apply             write it
//
// The bucket is BUW_S3_BUCKET, else the bucket of any registered workspace (as the local service chooses it).
//
// It writes the entry (where a writer's value sits), never state.json (where the owner's choice sits), so the
// row menu can still beat it. Per section: read workspace.json and a fresh state.json, add only `purpose` to the
// cards that match, and put the list back with If-Match on the ETag it read; on a lost race it reads again and
// decides again, up to 5 times. A section with nothing to mark is not written. It changes nothing else
// (`updated`, `pinned` and the rest stay), and a second run marks nothing. The bucket is versioned: the new
// version id of each section it wrote is printed, and the one before it is the undo.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyCardState, archiveCutoff, isArchivedCard } from '../site/api/card-liveness.mjs';
import { createBucket, loadCredentials, parseS3Url } from '../site/api/s3.mjs';
import { defaultRegistryFile, loadRegistry } from '../server/workspaces.mjs';

const TRIES = 5;
/** Sections this never touches: the development copy's, and the inboxes. */
const SKIPPED_SECTION = /^(dev-|inbox)/;

const stepNames = card => (Array.isArray(card?.steps) ? card.steps : []).map(step => String(step?.name ?? step?.title ?? ''));

/**
 * Why a card is a report, or null. The first match wins. Pure: it reads the section id and the entry only.
 * @returns {string|null}
 */
export function classify(section, card) {
  const id = String(card?.id ?? '');
  const names = stepNames(card);
  if (/^brief-/.test(id)) return 'id starts with brief-';
  if (section === 'agent-plans' && !names.some(name => /guide|how-?to/i.test(name))) return 'plan card in agent-plans';
  if (/(^|-)qa(-[a-z0-9]+)?$/.test(id)) return 'QA report';
  if (section === 'assistant' && /-\d{4}-\d{2}-\d{2}$/.test(id) && !names.some(name => /research/i.test(name))) return 'dated card in assistant';
  return null;
}

/** The cards of one section to mark, given its list and the state object's cards: `{ card, reason, ... }` per match. */
export function plan(section, entities, stateCards = {}, now = new Date()) {
  const found = [];
  for (const card of entities) {
    if (!card || typeof card !== 'object') continue;
    const state = stateCards[`${section}/${card.id}`];
    const shown = applyCardState(card, state);
    if (shown.pinned || shown.sample) continue;
    if (card.purpose !== undefined || state?.purpose !== undefined) continue;
    const reason = classify(section, card);
    if (!reason) continue;
    found.push({ card, reason, effect: effectOf(shown, now), status: shown.status, touched: shown.updated ?? shown.created });
  }
  return found;
}

// A card goes by date when it was last touched before today minus 7 days, so touched + 8 is the first day it is gone.
const ARCHIVE_STEP = 8;

const addDays = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** What marking this card does today, in words: nothing (and why), it goes to the Archive now, or it goes on a day. */
function effectOf(shown, now) {
  if (shown.status === 'archived') return 'none: archived by hand';
  if (isArchivedCard(shown, now)) return 'none: done and old, already in the Archive';
  if (isArchivedCard({ ...shown, purpose: 'report' }, now)) return 'goes to the Archive now';
  const touched = String(shown.updated ?? shown.created ?? '');
  return touched ? `goes to the Archive on ${addDays(touched, ARCHIVE_STEP)}` : 'none: no date';
}

const readList = async (bucket, section) => bucket.getJson(`sections/${section}/workspace.json`);
const readState = async bucket => (await bucket.getJson('state.json'))?.value?.cards ?? {};

/**
 * The sections of the bucket that this looks at, with what each would mark.
 * @returns {Promise<Array<{ id: string, cards: number, found: ReturnType<typeof plan> }>>}
 */
export async function survey(bucket, now = new Date()) {
  const { prefixes } = await bucket.list('sections/', { delimiter: '/' });
  const ids = prefixes.map(item => item.slice('sections/'.length).replace(/\/$/, '')).filter(id => id && !SKIPPED_SECTION.test(id)).sort();
  const state = await readState(bucket);
  const sections = [];
  for (const id of ids) {
    const got = await readList(bucket, id);
    const entities = Array.isArray(got?.value?.entities) ? got.value.entities : null;
    if (!entities) continue;
    sections.push({ id, cards: entities.length, found: plan(id, entities, state, now) });
  }
  return sections;
}

/**
 * Write the marks of one section. Reads again and decides again after a lost race.
 * @returns {Promise<{ marked: string[], versionId: string|null }>}
 */
export async function applySection(bucket, section, now = new Date()) {
  for (let attempt = 1; ; attempt += 1) {
    const got = await readList(bucket, section);
    if (!Array.isArray(got?.value?.entities)) return { marked: [], versionId: null };
    const found = plan(section, got.value.entities, await readState(bucket), now);
    if (!found.length) return { marked: [], versionId: null };
    const ids = new Set(found.map(item => item.card.id));
    const entities = got.value.entities.map(card => (ids.has(card?.id) ? { ...card, purpose: 'report' } : card));
    try {
      const put = await bucket.putJson(`sections/${section}/workspace.json`, { ...got.value, entities }, { ifMatch: got.etag });
      return { marked: [...ids], versionId: put.versionId ?? null };
    } catch (error) {
      if ((error.status !== 412 && error.status !== 409) || attempt >= TRIES) throw error;
    }
  }
}

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The list by section as Markdown: id, title, reason, status, last touched, effect now. */
export function listMarkdown(sections, now = new Date()) {
  const total = sections.reduce((sum, section) => sum + section.found.length, 0);
  const lines = [
    '# Purpose backfill', '',
    `Read ${now.toISOString().slice(0, 10)}, cutoff ${archiveCutoff(now)}. ${total} cards would be marked \`purpose: "report"\` in their entry. The row menu beats it, and a pinned, sample or already-marked card is skipped.`,
    '',
  ];
  for (const section of sections.filter(item => item.found.length)) {
    lines.push(`## ${section.id} (${section.found.length} of ${section.cards})`, '', '| Id | Title | Reason | Status | Last touched | Effect now |', '|---|---|---|---|---|---|');
    for (const { card, reason, effect, status, touched } of section.found) {
      lines.push(`| ${cell(card.id)} | ${cell(card.title)} | ${reason} | ${cell(status)} | ${cell(touched)} | ${effect} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The whole run. Dry by default.
 * @returns {Promise<{ sections: Awaited<ReturnType<typeof survey>>, applied: Array<{ id: string, marked: string[], versionId: string|null }> }>}
 */
export async function run({ bucket, apply = false, out = null, now = new Date(), log = () => {} }) {
  const sections = await survey(bucket, now);
  for (const section of sections) log(`${section.id}: ${section.found.length} of ${section.cards} cards ${apply ? 'to mark' : 'would be marked'}`);
  log(`total: ${sections.reduce((sum, section) => sum + section.found.length, 0)} of ${sections.reduce((sum, section) => sum + section.cards, 0)} cards`);
  if (out) await writeFile(out, listMarkdown(sections, now), 'utf8');
  const applied = [];
  if (apply) {
    for (const section of sections.filter(item => item.found.length)) {
      const result = await applySection(bucket, section.id, now);
      applied.push({ id: section.id, ...result });
      log(`${section.id}: marked ${result.marked.length}${result.versionId ? `, new version ${result.versionId}` : ''}`);
    }
  } else {
    log('dry run: nothing was written. Add --apply to write.');
  }
  return { sections, applied };
}

/** BUW_S3_BUCKET, else the bucket of any registered workspace, as the local service chooses it. No name lives in this file. */
export async function chooseBucket({ registryFile = defaultRegistryFile(), env = process.env, bucketOptions = {} } = {}) {
  let name = env.BUW_S3_BUCKET || null;
  if (!name) {
    try { name = (await loadRegistry(registryFile)).workspaces.map(item => parseS3Url(item.bucket)?.bucket).find(Boolean) || null; } catch { name = null; }
  }
  if (!name) throw new Error('No bucket: set BUW_S3_BUCKET or register a workspace with a bucket.');
  if (!bucketOptions.credentials && !await loadCredentials(env)) throw new Error('No AWS credentials for the cards bucket.');
  return createBucket({ bucket: name, region: env.BUW_S3_REGION || undefined, ...bucketOptions });
}

export function parseArgs(argv) {
  const options = { apply: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--out') { options.out = argv[i += 1]; if (!options.out) throw new Error('--out needs a file.'); }
    else throw new Error(`Unknown option ${argv[i]}. Use --apply and --out <file>.`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await run({ bucket: await chooseBucket(), ...options, log: line => console.log(line) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
