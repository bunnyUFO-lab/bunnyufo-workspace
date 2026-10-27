// Serve or build the active workspace's Just the Docs site with its own docker-compose.yml
// (each workspace repo carries one), after refreshing its pages with docs-sync.
//   npm run docs            serve with live reload (BUW_DOCS_PORT, default 4000)
//   npm run docs:build      one build into <workspace>/_site
// Add -- --content <folder|id> or -- --template to choose another workspace.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveSite, sync } from './docs-sync.mjs';

const args = process.argv.slice(2);
const mode = args[0] === 'build' ? 'build' : 'serve';
const contentAt = args.indexOf('--content');
const site = await resolveSite({ content: contentAt >= 0 ? args[contentAt + 1] : undefined, template: args.includes('--template') });
const changed = await sync({ site });
if (changed.length) console.log(`Updated docs pages:\n  ${changed.join('\n  ')}`);
const project = `buw-docs-${path.basename(site).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
const compose = ['compose', '-f', path.join(site, 'docker-compose.yml'), '-p', project];
const command = mode === 'build'
  ? [...compose, 'run', '--rm', 'docs', 'sh', '-c', 'bundle install --quiet && bundle exec jekyll build']
  : [...compose, 'up'];
console.log(`${mode === 'build' ? 'Building' : 'Serving'} ${site}${mode === 'serve' ? ` on http://localhost:${process.env.BUW_DOCS_PORT || 4000}` : ''}`);
const result = spawnSync('docker', command, { stdio: 'inherit', env: { ...process.env, BUW_DOCS_PORT: process.env.BUW_DOCS_PORT || '4000' } });
process.exit(result.status ?? 1);
