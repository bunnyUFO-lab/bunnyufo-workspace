// Distribution checks: the site template, local skills and safe defaults.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');
// The app repo ships the site template and two sample cards that show the formats (one Markdown,
// one HTML); personal cards live in separate workspace repos (docs/workspaces.md), each
// registered with `npm run workspace`.
const { entities } = JSON.parse(await read('workspace/workspace.json'));
assert.deepEqual(entities.map(card => card.id).sort(), ['sample-html', 'sample-markdown'], 'The app repo keeps only the two sample cards; register personal cards in a workspace repo (npm run workspace).');
assert.ok(entities.every(card => card.sample), 'Cards here must be marked "sample": true.');
// What a new workspace repo copies from here. Missing one of these breaks its published site.
const TEMPLATE = ['_config.yml', 'index.md', 'Gemfile', 'docker-compose.yml', '_sass/custom/custom.scss',
  '_shared/report.css', '_shared/report.js', '_shared/examples.css'];
for (const file of TEMPLATE) assert.ok((await read(`workspace/${file}`)).trim(), `workspace/${file} is missing or empty`);
// One prefix. The `gdw-` names reports carried before the rename were renamed in every
// published card on 2026-10-11, and the stylesheet and theme override no longer match them —
// so a new one must not reintroduce the old prefix and quietly depend on nothing.
const reportCss = await read('workspace/_shared/report.css');
for (const file of ['workspace/_shared/report.css', 'workspace/_shared/examples.css',
  'workspace/_shared/report.js', 'server/report-theme.mjs'])
  assert.ok(!(await read(file)).includes('gdw-'), `${file} still carries the old gdw- prefix`);
for (const current of ['[data-buw-report=document]', '[data-buw-report]', '.buw-card', '--buw-bg'])
  assert.ok(reportCss.includes(current), `workspace/_shared/report.css must match ${current}`);
// The light theme the app injects into a local report is also in the shared stylesheet, for the content host,
// where the app cannot write into the frame.
const { reportThemeCSS } = await import('../server/report-theme.mjs');
assert.ok(reportCss.replace(/\r\n/g, '\n').includes(reportThemeCSS.trim()), 'workspace/_shared/report.css must carry server/report-theme.mjs (the light theme rules).');
// No skills or agent configuration live here: each user keeps them in their own settings, and a
// committed copy would only drift from them.
const tracked = execFileSync('git', ['ls-files', '.agents', '.claude', '.codex', '.opencode', 'opencode.json', '.mcp.json', 'apm.yml'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(tracked, '', 'Commit no agent configuration or skills here; they live in your own user settings.');
assert.doesNotMatch(await read('.env.example'), /^\w+=(?!\s*$)\S+/m, 'The example env must contain no assigned values.');
console.log(`Template passed: only the sample cards, ${TEMPLATE.length} site template files, one report prefix, no agent configuration and account placeholders.`);
