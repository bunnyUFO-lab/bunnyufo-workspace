// Runs every browser test in server/test (ui.mjs and *-ui.mjs), one after another, and fails at
// the end if any failed: one broken test no longer hides the ones after it.
//   node scripts/run-ui-tests.mjs [name-fragment ...]   only the tests whose file name contains a fragment
// Run after npm run build.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'server', 'test');
const filters = process.argv.slice(2);

const files = (await readdir(testDir))
  .filter(name => name === 'ui.mjs' || name.endsWith('-ui.mjs'))
  .filter(name => !filters.length || filters.some(fragment => name.includes(fragment)))
  .sort();
if (!files.length) {
  console.error('No UI tests match.');
  process.exit(1);
}

const run = file => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join('server', 'test', file)], { cwd: root, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); resolve({ file, code: 1, ms: Date.now() - started }); });
  child.on('close', (code, signal) => resolve({ file, code: code ?? (signal ? 1 : 0), signal, ms: Date.now() - started }));
});

const results = [];
for (const file of files) {
  console.log(`\n=== ${file}`);
  results.push(await run(file));
}

const failed = results.filter(result => result.code !== 0);
console.log(`\nUI tests: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} run.`);
for (const result of results) {
  console.log(`  ${result.code === 0 ? 'ok  ' : 'FAIL'} ${result.file} (${(result.ms / 1000).toFixed(1)}s${result.code === 0 ? '' : `, exit ${result.code}${result.signal ? ` ${result.signal}` : ''}`})`);
}
process.exit(failed.length ? 1 : 0);
