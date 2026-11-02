// Splits the sorted list of UI test files across parallel CI jobs: shard i of n takes every n-th file.

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

/** Every n-th file of the (already sorted) list, starting at the i-th. */
export function pickShard(files, shard) {
  if (!shard) return files;
  return files.filter((_, at) => at % shard.count === shard.index - 1);
}
