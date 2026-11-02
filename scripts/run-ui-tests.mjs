// Runs every browser test in server/test (ui.mjs and *-ui.mjs), one after another, and fails at
// the end if any failed: one broken test no longer hides the ones after it.
//   node scripts/run-ui-tests.mjs [name-fragment ...]   only the tests whose file name contains a fragment
// Each file has a time limit (5 minutes; BUW_UI_FILE_TIMEOUT_MS or --timeout-ms=N changes it). A file that
// goes over is killed with its whole process tree and fails by name, so a hang never hangs the run.
// Run after npm run build.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'server', 'test');
const args = process.argv.slice(2);
const limitArg = args.find(arg => arg.startsWith('--timeout-ms='));
const limitMs = Number(limitArg?.slice('--timeout-ms='.length) || process.env.BUW_UI_FILE_TIMEOUT_MS) || 5 * 60_000;
const filters = args.filter(arg => !arg.startsWith('--'));

const files = (await readdir(testDir))
  .filter(name => name === 'ui.mjs' || name.endsWith('-ui.mjs'))
  .filter(name => !filters.length || filters.some(fragment => name.includes(fragment)))
  .sort();
if (!files.length) {
  console.error('No UI tests match.');
  process.exit(1);
}

const killTree = child => new Promise(resolve => {
  // Only the process this runner started, and the browser it started in turn: taskkill /T follows the tree of that PID.
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', resolve).on('error', resolve);
  else { child.kill('SIGKILL'); resolve(); }
});

const run = file => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join('server', 'test', file)], { cwd: root, stdio: 'inherit' });
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
