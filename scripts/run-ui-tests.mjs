// Runs every browser test in server/test (ui.mjs and *-ui.mjs), one after another, and fails at
// the end if any failed: one broken test no longer hides the ones after it.
//   node scripts/run-ui-tests.mjs [name-fragment ...]   only the tests whose file name contains a fragment
//   node scripts/run-ui-tests.mjs --shard 2/4           the 2nd of 4 time-balanced shards (CI runs them in parallel)
//   a fragment ending in .mjs is a whole file name (hub-ui.mjs does not pick hub-work-ui.mjs); --allow-empty exits 0 when nothing is left to run
// Each file has a time limit (5 minutes; BUW_UI_FILE_TIMEOUT_MS or --timeout-ms=N changes it). A file that
// goes over is killed with its whole process tree and fails by name, so a hang never hangs the run.
// Runs one file at a time on purpose; do not start several runners (the owner's PC is shared: one heavy job at a time).
// Ctrl+C, SIGTERM, SIGHUP and a normal exit stop the file that is running and its browser (a hard kill of this runner cannot be caught).
// Run after npm run build.
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, pickShard, readTimings } from './ui-shard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// BUW_UI_TEST_DIR is a seam for scripts/run-ui-tests.test.mjs only.
const testDir = process.env.BUW_UI_TEST_DIR ? path.resolve(process.env.BUW_UI_TEST_DIR) : path.join(root, 'server', 'test');
const { rest, shard } = parseShard(process.argv.slice(2));
const limitArg = rest.find(arg => arg.startsWith('--timeout-ms='));
const limitMs = Number(limitArg?.slice('--timeout-ms='.length) || process.env.BUW_UI_FILE_TIMEOUT_MS) || 5 * 60_000;
const filters = rest.filter(arg => !arg.startsWith('--'));

const files = pickShard((await readdir(testDir))
  .filter(name => name === 'ui.mjs' || name.endsWith('-ui.mjs'))
  .filter(name => !filters.length || filters.some(fragment => (fragment.endsWith('.mjs') ? name === fragment : name.includes(fragment))))
  .sort(), shard, readTimings(path.join(root, 'scripts', 'ui-timings.json')));
if (!files.length) {
  console.error('No UI tests match.');
  process.exit(process.argv.includes('--allow-empty') ? 0 : 1);
}

const killTree = child => new Promise(resolve => {
  // Only the process this runner started, and the browser it started in turn: taskkill /T follows the tree of that PID.
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', resolve).on('error', resolve);
  else { child.kill('SIGKILL'); resolve(); }
});

// The file that is running now, so a signal or the exit can stop it. Synchronous: an exit handler cannot wait.
let current = null;
const killTreeSync = child => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
};
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => { killTreeSync(current); process.exit(code); });
}
process.on('exit', () => killTreeSync(current));

const run = file => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(path.relative(root, testDir), file)], { cwd: root, stdio: 'inherit', windowsHide: true });
  current = child;
  // Test seam: --self-test-signal=SIGTERM raises that signal in this process once the first file has started (no real signal needed).
  const selfSignal = process.argv.find(arg => arg.startsWith('--self-test-signal='))?.split('=')[1];
  if (selfSignal) setTimeout(() => process.emit(selfSignal), 300);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`\nTIMEOUT: ${file} ran longer than ${(limitMs / 1000).toFixed(0)} s and was stopped.`);
    killTree(child);
  }, limitMs);
  child.on('error', error => { clearTimeout(timer); console.error(error.message); resolve({ file, code: 1, ms: Date.now() - started }); });
  child.on('close', (code, signal) => { clearTimeout(timer); resolve({ file, code: timedOut ? 1 : code ?? (signal ? 1 : 0), signal, timedOut, ms: Date.now() - started }); });
});

const results = [];
for (const file of files) {
  console.log(`\n=== ${file}`);
  results.push(await run(file));
}

const failed = results.filter(result => result.code !== 0);
console.log(`\nUI tests: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} run.`);
for (const result of results) {
  console.log(`  ${result.code === 0 ? 'ok  ' : 'FAIL'} ${result.file} (${(result.ms / 1000).toFixed(1)}s${result.code === 0 ? '' : result.timedOut ? ', TIMED OUT' : `, exit ${result.code}${result.signal ? ` ${result.signal}` : ''}`})`);
}
process.exit(failed.length ? 1 : 0);
