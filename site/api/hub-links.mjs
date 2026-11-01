// Links on a Working now row: the Beads items and Library cards a session is about. Pure; hub.mjs
// loads the inputs (events, Beads copies, the card index).
//
// A session's own plugin posts `session-items` events (hub-hooks 0.1.18) whose `touched` is the
// whole set so far: `{ beads: [{ project, id }], cards: [{ card, section? }] }`, newest last.
// Nothing is linked from text a session wrote about itself: a Beads chip comes from a bd write the
// session made, the bead named in its branch, or an id in its title that the project's Beads copy has.
import { beadOfBranch } from './hub-pc.mjs';

export const BEAD_CHIPS = 3;
export const CARD_CHIPS = 2;
export const SESSION_ITEMS = 'session-items';

const BEAD_ID = /^[a-z][a-z0-9]{0,7}-[a-z0-9]{2,8}(?:\.\d{1,4})*$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SECTION = /^[a-z0-9][a-z0-9-]{0,59}$/;
const CARD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TITLE_ID = /(?<![a-z0-9.-])([a-z][a-z0-9]{0,7}-[a-z0-9]{3,8}(?:\.\d{1,4})*)(?![a-z0-9-])/g;

/** The `touched` of an event, cleaned to the exact shape; anything else is dropped. Oldest first, as sent. */
export function cleanTouched(value) {
  const beads = Array.isArray(value?.beads)
    ? value.beads.filter(row => row && PROJECT.test(String(row.project)) && BEAD_ID.test(String(row.id))).map(row => ({ project: row.project, id: row.id })).slice(-10)
    : [];
  const cards = Array.isArray(value?.cards)
    ? value.cards.filter(row => row && CARD.test(String(row.card)) && (row.section === undefined || SECTION.test(String(row.section))))
      .map(row => ({ card: row.card, ...(row.section ? { section: row.section } : {}) })).slice(-6)
    : [];
  return { beads, cards };
}

/** The newest `session-items` event of each session in a window of events (any order), as `session -> touched`. */
export function touchedBySession(events) {
  const newest = new Map();
  for (const event of events) {
    if (event.kind !== SESSION_ITEMS || typeof event.session !== 'string' || !event.touched) continue;
    if (!newest.has(event.session) || event.ts > newest.get(event.session).ts) newest.set(event.session, event);
  }
  return new Map([...newest].map(([session, event]) => [session, cleanTouched(event.touched)]));
}

/** The Beads id prefixes a project is known by: its default prefix and those of its Beads copy. */
export function prefixesOf(defaultPrefix, issues) {
  const found = new Set(defaultPrefix ? [defaultPrefix] : []);
  for (const issue of issues ?? []) {
    const prefix = String(issue.id ?? '').split('-')[0];
    if (/^[a-z0-9]{1,8}$/.test(prefix)) found.add(prefix);
  }
  return [...found];
}

/**
 * The Beads ids a row is about, in the order of the evidence, each once:
 * 1. what the session wrote with bd (newest first);
 * 2. the id in its branch name (for a prefix the project is known by);
 * 3. ids in its title, only when the project's Beads copy has them (`known(project, id)`).
 * Returns `[{ project, id }]`.
 */
export function beadRefs({ touched, project, branch, title, prefixes = [], known = () => false }) {
  const out = [];
  const add = (refProject, id) => { if (refProject && !out.some(row => row.project === refProject && row.id === id)) out.push({ project: refProject, id }); };
  for (const row of [...(touched?.beads ?? [])].reverse()) add(row.project, row.id);
  if (project && typeof branch === 'string') {
    for (const prefix of prefixes) {
      const id = beadOfBranch(branch, prefix);
      if (id) { add(project, id); break; }
    }
  }
  if (project && typeof title === 'string') {
    for (const match of title.toLowerCase().matchAll(TITLE_ID)) if (known(project, match[1])) add(project, match[1]);
  }
  return out;
}

/**
 * The links of one row: at most BEAD_CHIPS Beads chips and CARD_CHIPS card chips, with the number left out.
 * `titleOf(project, id)` is the item's title (for the hover); `resolveCard(section, card)` is `{ title, href }` or null.
 * A card the site does not list is not linked: it would open nothing.
 */
export function rowLinks({ touched, project, branch, title, prefixes, known, titleOf = () => undefined, resolveCard = () => null }) {
  const beads = beadRefs({ touched, project, branch, title, prefixes, known });
  const cards = [];
  for (const row of [...(touched?.cards ?? [])].reverse()) {
    const found = resolveCard(row.section, row.card);
    if (found && !cards.some(other => other.href === found.href)) cards.push({ ...(row.section ? { section: row.section } : {}), card: row.card, title: found.title, href: found.href });
  }
  const shownBeads = beads.slice(0, BEAD_CHIPS).map(row => ({ ...row, ...(titleOf(row.project, row.id) ? { title: titleOf(row.project, row.id) } : {}) }));
  const shownCards = cards.slice(0, CARD_CHIPS);
  if (!shownBeads.length && !shownCards.length) return null;
  return {
    ...(shownBeads.length ? { beads: shownBeads } : {}), ...(beads.length > BEAD_CHIPS ? { moreBeads: beads.length - BEAD_CHIPS } : {}),
    ...(shownCards.length ? { cards: shownCards } : {}), ...(cards.length > CARD_CHIPS ? { moreCards: cards.length - CARD_CHIPS } : {}),
  };
}

/** Every project a set of rows could link into: their own and those a session wrote to. */
export function projectsToLoad(items, touchedMap, max = 6) {
  const ids = new Set();
  for (const item of items) {
    if (item.project) ids.add(item.project);
    for (const row of touchedMap.get(item.id)?.beads ?? []) ids.add(row.project);
  }
  return [...ids].slice(0, max);
}

/**
 * Working now rows with their `links`. `issuesOf(project)` is that project's Beads issues (merged copies),
 * `defaultPrefixOf(project)` its Issue prefix, `resolveCard` as for rowLinks. Rows keep every other field.
 */
export function withLinks(items, { events, issuesOf, defaultPrefixOf = () => undefined, resolveCard }) {
  const touchedMap = touchedBySession(events);
  const byProject = new Map();
  const issues = project => { if (!byProject.has(project)) byProject.set(project, new Map((issuesOf(project) ?? []).map(issue => [issue.id, issue]))); return byProject.get(project); };
  return items.map(item => {
    const links = rowLinks({
      touched: touchedMap.get(item.id), project: item.project, branch: item.branch, title: item.title,
      prefixes: item.project ? prefixesOf(defaultPrefixOf(item.project), [...issues(item.project).values()]) : [],
      known: (project, id) => issues(project).has(id),
      titleOf: (project, id) => issues(project).get(id)?.title,
      resolveCard,
    });
    return links ? { ...item, links } : item;
  });
}
