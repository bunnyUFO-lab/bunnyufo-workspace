// Splits the sorted list of UI test files across parallel CI jobs. With a timings map (file name to
// seconds, scripts/ui-timings.json, measured on a CI runner) the files go greedily, slowest first, to the
// lightest shard; a file not in the map counts as the median. Without timings, shard i of n takes every
// n-th file. Every shard computes the same split, so each file runs in exactly one shard.
import { readFileSync } from 'node:fs';

/** The timings map next to this script, or null when it is missing or unreadable. */
export function readTimings(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Reads `--shard i/n` (or `--shard=i/n`) out of an argument list. Returns the rest and the shard, or null. */
export function parseShard(args) {
  const rest = [];
  let shard = null;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    let value = null;
    if (arg === '--shard') value = args[++at];
    else if (arg.startsWith('--shard=')) value = arg.slice('--shard='.length);
    else { rest.push(arg); continue; }
    const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
    const index = match ? Number(match[1]) : 0;
    const count = match ? Number(match[2]) : 0;
    if (!match || index < 1 || index > count) throw new Error(`--shard wants i/n with 1 <= i <= n, got "${value ?? ''}".`);
    shard = { index, count };
  }
  return { rest, shard };
}

/** The files of one shard, in their original (sorted) order. */
export function pickShard(files, shard, timings = null) {
  if (!shard) return files;
  const known = Object.values(timings ?? {}).filter(Number.isFinite).sort((a, b) => a - b);
  if (!known.length) return files.filter((_, at) => at % shard.count === shard.index - 1);
  const median = known[Math.floor(known.length / 2)];
  const seconds = file => (Number.isFinite(timings[file]) ? timings[file] : median);
  const load = Array(shard.count).fill(0);
  const mine = new Set();
  for (const file of [...files].sort((a, b) => seconds(b) - seconds(a) || (a < b ? -1 : 1))) {
    const lightest = load.indexOf(Math.min(...load));
    load[lightest] += seconds(file);
    if (lightest === shard.index - 1) mine.add(file);
  }
  return files.filter(file => mine.has(file));
}
