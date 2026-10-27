// Redeploy the Workspace: the container on this machine, and the published sites.
//
//   node tools/workspace/redeploy.mjs            what is out of date
//   node tools/workspace/redeploy.mjs --app      rebuild the container image and restart it
//   node tools/workspace/redeploy.mjs --site     whether each workspace's site serves its main
//
// The two travel separately. The app is an image: changing src/ or server/ needs a rebuild and a
// restart. The sites are served straight from the cards bucket, so uploading (npm run publish) is
// the whole deployment: this compares each workspace folder with its place in the bucket, and asks
// the site which sections it is serving.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRegistryFile, listWorkspaces } from '../../server/workspaces.mjs';
import { bucketFor } from '../../scripts/publish.mjs';
import { defaultScope, syncUp } from '../../scripts/shared/s3-sync.mjs';

const appRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SOURCES = ['src', 'server', 'scripts', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'Dockerfile', 'docker-compose.yml'];
// docker compose names an image <project>-<service>; both come from docker-compose.yml.
const IMAGE = 'bunnyufo-workspace-workspace';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** When the image was built and whether it is running, against the newest commit that changes it. */
function appState() {
  let built = null, running = null;
  try { built = new Date(docker('image', 'inspect', IMAGE, '--format', '{{.Created}}')).getTime() || null; }
  catch { /* no image yet, or no Docker on this machine */ }
  try { running = docker('ps', '--filter', `ancestor=${IMAGE}`, '--format', '{{.Status}}') || null; } catch { /* same */ }
  const lastSource = git(appRepo, 'log', '-1', '--format=%H %cI', '--', ...APP_SOURCES);
  return { built, running, lastSource };
}

async function status() {
  const branch = git(appRepo, 'rev-parse', '--abbrev-ref', 'HEAD');
  let behind = 0;
  try { git(appRepo, 'fetch', '-q', 'origin'); behind = Number(git(appRepo, 'rev-list', '--count', 'HEAD..origin/main')) || 0; } catch { /* offline */ }
  const { built, running, lastSource } = appState();
  const [sourceSha, sourceWhen] = lastSource.split(' ');

  console.log('Workspace app');
  console.log(`  checkout: ${branch}${behind ? ` (${behind} commit(s) behind origin/main)` : ' (up to date)'}`);
  console.log(`  app sources last changed: ${sourceSha?.slice(0, 8)} ${sourceWhen || ''}`);
  if (!built) console.log(`  no ${IMAGE} image built yet  <- docker compose build`);
  else {
    const stale = new Date(sourceWhen).getTime() > built;
    console.log(`  image: built ${new Date(built).toISOString()}${stale ? '  <- older than the sources; rebuild' : '  (newer than the sources)'}`);
  }
  console.log(`  container: ${running || 'not running  <- docker compose up -d'}`);

  console.log('\nPublished sites');
  const workspaces = await listWorkspaces({ appRepo, registryFile: defaultRegistryFile() });
  let behindSite = false;
  for (const workspace of workspaces) {
    if (workspace.builtin || workspace.exists === false || !workspace.site) continue;
    // What the bucket lacks: the same diff a publish would upload, without uploading it.
    let local = '';
    let where = '';
    try {
      const { client, prefix } = bucketFor(workspace);
      where = `s3://${client.bucket}/${prefix}`;
      const { uploads, downloads, conflicts, deletes } = await syncUp({ root: workspace.root, bucket: client, prefix, scope: await defaultScope(workspace.root), dryRun: true });
      local = [uploads.length && `${uploads.length} file(s) not uploaded`, downloads.length && `${downloads.length} file(s) changed on the site, not brought down`,
        conflicts.length && `${conflicts.length} file(s) changed in both places`, deletes.length && `${deletes.length} removed file(s) still in the bucket`].filter(Boolean).join(', ');
    } catch (error) { local = `cannot compare with the bucket: ${error.message}`; }
    // And whether the site lists this section: it reads the bucket, so "listed" means "serving".
    let live = null;
    try {
      const base = new URL(workspace.site).origin;
      const response = await fetch(`${base}/sites.json`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (response.ok) live = (await response.json()).find(site => site.id === workspace.id) ?? false;
    } catch { /* site unreachable */ }
    const state = live === null ? 'no answer from the site'
      : live === false ? 'not listed by the site  <- is the section in the bucket the site reads?'
      : `serving ${where}${live.publishedAt ? ` (card list uploaded ${live.publishedAt})` : ''}`;
    console.log(`  ${workspace.name}: ${state}${local ? `\n    here: ${local}  <- publish` : ''}`);
    if (local) behindSite = true;
  }
  if (behindSite) console.log('\n  Publish everything that is waiting: npm run publish -- --all');
  console.log('\n  --app rebuilds the container. A site is up to date as soon as its workspace is uploaded (npm run publish).');
}

function buildApp() {
  // The image builds from a clean copy of this repository, so nvm, a global .npmrc and whichever
  // Node is on PATH cannot change what ends up inside it — which is what the old PowerShell
  // build had to work around.
  const run = args => execFileSync('docker', args, { cwd: appRepo, stdio: 'inherit' });
  run(['compose', 'build']);
  run(['compose', 'up', '-d']);
  const { built, running } = appState();
  console.log(`\nImage built ${built ? new Date(built).toISOString() : '(unknown)'}; container ${running || 'not running'}.`);
  console.log('Open http://127.0.0.1:8300. Cards, settings and credentials live outside the image and are untouched.');
}

const args = process.argv.slice(2);
try {
  if (args.includes('--app')) buildApp();
  else await status();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
