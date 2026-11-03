// Decides what CI runs for a change, from the list of changed files (ws-qdh.11). Private repos bill their minutes
// and public ones cost runner time either way, so a PR runs only what its files can affect; the nightly run
// (only when main changed) and workflow_dispatch run everything.
//   node scripts/ci-affected.mjs [--github-output] < changed-files.txt     one path per line
// Prints JSON { check, ui, fragments }:
//   check   'none' (nothing to test), 'docs' (docs tests and the template check only) or 'all' (lint, tests, build)
//   ui      'none', 'some' (only the UI test files in `fragments`, full file names) or 'all'
// Unclear means more: a file this table does not know runs everything, so a miss costs minutes, never coverage.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTHING = /^(\.github\/workflows\/(hub-events|release)\.yml$|workspace\/|knowledge\/|processes\/|projects\/|\.beads\/|\.claude\/|CHANGELOG\.md$|LICENSE$|SECURITY\.md$|THIRD_PARTY_NOTICES\.md$|AGENTS\.md$|CLAUDE\.md$|README\.md$)/;
const DOCS = /^(docs\/|scripts\/docs[-.][^/]*$)/;
const UI_FILE = /^server\/test\/(ui|[^/]+-ui)\.mjs$/;
const UNIT_TEST = /^server\/test\/[^/]+\.test\.mjs$/;
// Shared by every screen: a change here can break any UI test.
const SHARED = /^(src\/styles\/|src\/[^/]+$|index\.html$|vite\.config\.|tsconfig|package(-lock)?\.json$|server\/(package(-lock)?\.json|[^/]+\.mjs|integrations\/|project-adapters\/|knowledge\/)|server\/test\/ui-timeouts\.mjs$|public\/|scripts\/(run-ui-tests|ui-shard|ui-timings)|\.github\/)/;

const kebab = stem => stem.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** @param {string[]} files changed paths  @param {{uiTests: string[], read: (name: string) => string}} tests */
export function classify(files, { uiTests, read }) {
  let check = 'none';
  let ui = new Set();
  let all = false;
  const lower = text => text.toLowerCase();
  const hubTests = uiTests.filter(name => name.startsWith('hub-'));
  for (const file of files.map(name => name.trim().split('\\').join('/')).filter(Boolean)) {
    if (NOTHING.test(file)) continue;
    if (DOCS.test(file)) { if (check === 'none') check = 'docs'; continue; }
    check = 'all';
    if (UI_FILE.test(file)) {
      const name = path.posix.basename(file);
      if (name === 'ui.mjs' || !uiTests.includes(name)) all = true; else ui.add(name);
      continue;
    }
    if (file === 'server/test/hub-fixture.mjs') { hubTests.forEach(name => ui.add(name)); continue; }
    if (UNIT_TEST.test(file)) continue; // a unit test runs in `check` only
    // site/api is the hub's backend: the service serves it to the UI tests. The hub files affect the hub tests, the
    // rest of it (store, S3, card writes) every test. The other site/ folders run on the home server, not in the UI tests.
    if (/^site\/api\/test\//.test(file)) {
      if (/^site\/api\/test\/(hub-fixtures|fake-(?!.*\.test\.)[^/]+)\.mjs$/.test(file)) all = true; // seeds the UI fixtures
      continue;
    }
    if (/^site\/api\/hub[^/]*\.mjs$/.test(file)) { hubTests.forEach(name => ui.add(name)); continue; }
    if (/^site\/api\//.test(file)) { all = true; continue; }
    if (/^(site|tools)\//.test(file)) continue;
    if (SHARED.test(file) && !/^src\/(lib|hub|components|local)\//.test(file)) { all = true; continue; }
    if (/^src\/(hub|components|local|lib)\//.test(file)) {
      const stem = path.posix.basename(file).replace(/\.[^.]+$/, '');
      const words = [lower(stem), kebab(stem)].filter(word => word.length >= 5);
      const hits = uiTests.filter(name => words.some(word => lower(name).includes(word) || lower(read(name)).includes(word)));
      if (hits.length) hits.forEach(name => ui.add(name));
      else if (file.startsWith('src/hub/') || /^hub/i.test(stem)) hubTests.forEach(name => ui.add(name));
      else all = true;
      continue;
    }
    if (/^(scripts\/|server\/test\/)/.test(file)) continue; // other scripts have unit tests in `check`
    all = true; // unknown
  }
  if (all) return { check, ui: 'all', fragments: [] };
  if (!ui.size) return { check, ui: 'none', fragments: [] };
  return { check, ui: 'some', fragments: [...ui].sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const testDir = path.join(root, 'server', 'test');
  const uiTests = readdirSync(testDir).filter(name => name === 'ui.mjs' || name.endsWith('-ui.mjs')).sort();
  const input = readFileSync(0, 'utf8').split('\n');
  const result = classify(input, { uiTests, read: name => readFileSync(path.join(testDir, name), 'utf8') });
  if (process.argv.includes('--github-output')) {
    console.log(`check=${result.check}\nui=${result.ui}\nfragments=${result.fragments.join(' ')}`);
  } else console.log(JSON.stringify(result));
}
