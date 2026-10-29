// Beads copies: every worktree pushes its own export, and the site keeps the newest version of each
// issue. Pure functions; the S3 reads stay in hub.mjs.
//
//   beads/<project>/<copy>.jsonl + .meta.json   one per worktree (<copy> = <host>-<first 10 hex of sha256(root)>)
//   beads/<project>.jsonl + .meta.json          the legacy single copy, still read, never written again

import { createHash } from 'node:crypto';

export const MAX_COPIES = 30;
export const LEGACY_COPY = 'legacy';

/** A copy name the client could have written: what `--copy` accepts. Anything else in the folder is ignored. */
export const validCopyName = name => /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== LEGACY_COPY && !/token|secret|password|credential/.test(name);

/** A worktree root, in the form that is hashed and stored: forward slashes, no trailing slash. */
export const normalizeRoot = root => String(root ?? '').replace(/[\\]/g, '/').replace(/\/+$/, '');

/** `<host>-<h10>`: h10 is the first 10 hex of sha256 of the root, lower case. */
export function copyIdOf(host, root) {
  const slug = String(host ?? 'host').toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'host';
  return `${slug}-${createHash('sha256').update(normalizeRoot(root).toLowerCase()).digest('hex').slice(0, 10)}`;
}

/** The issues of a `bd export` file; a bad line, or a line that is not an issue, is skipped. */
export function parseJsonl(text) {
  const issues = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const issue = JSON.parse(line);
      if (issue && typeof issue === 'object' && (issue._type === undefined || issue._type === 'issue') && typeof issue.id === 'string') issues.push(issue);
    } catch { /* a bad line is skipped */ }
  }
  return issues;
}

const time = value => {
  const at = new Date(value ?? '').getTime();
  return Number.isNaN(at) ? -Infinity : at;
};

/**
 * Merge copies: `[{ copy, meta, issues }]`. Per issue id the greatest `updated_at` wins (a missing or
 * bad date is oldest); on a tie the copy pushed later wins. At most MAX_COPIES copies are read, the
 * newest by `pushedAt`, and the legacy copy always counts. The meta keeps the newest copy's `host`
 * and `repo` beside `pushedAt`, `count` and the copy list.
 */
export function mergeCopies(copies) {
  const rows = (copies ?? []).filter(row => row && Array.isArray(row.issues));
  const legacy = rows.filter(row => row.copy === LEGACY_COPY);
  const others = rows.filter(row => row.copy !== LEGACY_COPY).sort((a, b) => time(b.meta?.pushedAt) - time(a.meta?.pushedAt)).slice(0, MAX_COPIES);
  const kept = [...others, ...legacy];
  if (!kept.length) return { meta: null, issues: [] };
  // A project with only the legacy file answers exactly as it did before copies existed.
  if (!others.length) return { meta: legacy[0].meta && Object.keys(legacy[0].meta).length ? legacy[0].meta : null, issues: legacy[0].issues };
  const best = new Map();
  for (const row of kept) {
    const pushed = time(row.meta?.pushedAt);
    for (const issue of row.issues) {
      const have = best.get(issue.id);
      const at = time(issue.updated_at);
      if (!have || at > have.at || (at === have.at && pushed > have.pushed)) best.set(issue.id, { issue, at, pushed });
    }
  }
  const newest = kept.reduce((a, b) => (time(b.meta?.pushedAt) > time(a.meta?.pushedAt) ? b : a));
  const meta = {
    ...(newest.meta?.pushedAt ? { pushedAt: newest.meta.pushedAt } : {}),
    ...(newest.meta?.host ? { host: newest.meta.host } : {}),
    ...(newest.meta?.repo ? { repo: newest.meta.repo } : {}),
    count: best.size,
    copies: kept.map(row => ({
      copy: row.copy, host: row.meta?.host ?? '', worktree: row.meta?.worktree ?? '', main: row.meta?.main === true,
      pushedAt: row.meta?.pushedAt ?? null, count: row.issues.length,
    })),
  };
  return { meta, issues: [...best.values()].map(entry => entry.issue) };
}

/**
 * The reader over the bucket. `key(rel)` makes a full key, `base` is the beads folder key
 * (`<inbox>/beads`). Parsed files are cached by key and etag, so a poll re-reads only what changed.
 */
export function createBeadsReader({ bucket, key }) {
  const base = key('beads/x').slice(0, -1);
  const cache = new Map();    // object key -> { etag, value }

  async function read(object, parse) {
    const hit = cache.get(object.key);
    if (hit && object.etag && hit.etag === object.etag) return hit.value;
    const got = await bucket.getText(object.key);
    if (!got) return null;
    const value = parse(got.text);
    cache.set(object.key, { etag: object.etag || got.etag, value });
    return value;
  }
  const readMeta = object => read(object, text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; } catch { return {}; } });
  const readIssues = object => read(object, parseJsonl);

  /** The objects of a project: its copies by name, and the legacy pair. */
  function sort(objects, project) {
    const copies = new Map();
    let legacy = null;
    for (const object of objects) {
      const rel = object.key.slice(base.length);
      let match;
      if ((match = new RegExp(`^${project}/([^/]+?)(\\.meta\\.json|\\.jsonl)$`).exec(rel))) {
        if (!validCopyName(match[1])) continue;
        const row = copies.get(match[1]) ?? {};
        row[match[2] === '.jsonl' ? 'data' : 'meta'] = object;
        copies.set(match[1], row);
      } else if (rel === `${project}.jsonl` || rel === `${project}.meta.json`) {
        legacy ??= {};
        legacy[rel.endsWith('.jsonl') ? 'data' : 'meta'] = object;
      }
    }
    return { copies, legacy };
  }

  return {
    /** Every copy of `project`, merged: `{ meta, issues }` (meta null and no issues when there is none). */
    async load(project) {
      const { objects } = await bucket.list(`${base}${project}`);
      const { copies, legacy } = sort(objects, project);
      const rows = [];
      if (legacy?.data) rows.push({ copy: LEGACY_COPY, ...legacy });
      for (const [copy, row] of copies) if (row.data) rows.push({ copy, ...row });
      const loaded = await Promise.all(rows.map(async row => {
        const meta = row.meta ? await readMeta(row.meta) : null;
        return { copy: row.copy, row, meta: { ...(meta ?? {}), ...(meta?.pushedAt || row.copy === LEGACY_COPY ? {} : row.data.lastModified ? { pushedAt: new Date(row.data.lastModified).toISOString() } : {}) } };
      }));
      // Only the newest MAX_COPIES (and the legacy file) are downloaded.
      const chosen = loaded.filter(item => item.copy !== LEGACY_COPY).sort((a, b) => time(b.meta.pushedAt) - time(a.meta.pushedAt)).slice(0, MAX_COPIES)
        .concat(loaded.filter(item => item.copy === LEGACY_COPY));
      const full = await Promise.all(chosen.map(async item => ({ copy: item.copy, meta: item.meta, issues: (await readIssues(item.row.data)) ?? [] })));
      return mergeCopies(full);
    },

    /** From the listing of the whole beads folder: Map of project id to its newest `pushedAt` (or undefined). */
    async projects(objects) {
      const found = new Map();
      const metas = [];
      for (const object of objects) {
        const rel = object.key.slice(base.length);
        const match = /^([^/]+?)(?:\/([^/]+))?\.meta\.json$/.exec(rel);
        if (match && (match[2] === undefined || validCopyName(match[2]))) metas.push({ id: match[1], object });
      }
      await Promise.all(metas.map(async ({ id, object }) => {
        const meta = await readMeta(object);
        const pushedAt = meta?.pushedAt;
        const have = found.get(id);
        found.set(id, time(pushedAt) > time(have) ? pushedAt : have);
      }));
      return found;
    },
  };
}
