// Stop hook: say when a workspace folder still holds card work that is not in the bucket.
//
// Cards reach the site by being uploaded; the site serves the bucket. Nothing on the server can see
// work that never left this machine, which is how a finished card can sit in a folder for hours
// while the site reads as fine. This is the one check in that chain that runs locally, so it is the
// only one that can notice. It compares each registered card folder with the bucket (a listing and
// local md5s, no uploads) and says how many files differ.
//
// Prints {"systemMessage": ...} for the user and exits 0: it never blocks stopping, and says nothing
// when there is nothing to say — including when there is no bucket or no network.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRegistryFile, listWorkspaces } from '../../server/workspaces.mjs';
import { bucketFor } from '../../scripts/publish.mjs';
import { defaultScope, syncUp } from '../../scripts/shared/s3-sync.mjs';

const appRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const workspaces = await listWorkspaces({ appRepo, registryFile: defaultRegistryFile() });
  const notes = [];
  await Promise.all(workspaces.map(async workspace => {
    if (workspace.builtin || workspace.exists === false) return;   // starter examples, or a folder that moved
    try {
      const { client, prefix } = bucketFor(workspace);
      const { uploads, downloads, conflicts, deletes } = await syncUp({ root: workspace.root, bucket: client, prefix, scope: await defaultScope(workspace.root), dryRun: true });
      const parts = [];
      if (uploads.length) parts.push(`${uploads.length} file(s) not uploaded`);
      if (downloads.length) parts.push(`${downloads.length} file(s) changed on the site, not brought down`);
      if (conflicts.length) parts.push(`${conflicts.length} file(s) changed in both places`);
      if (deletes.length) parts.push(`${deletes.length} removed file(s) still in the bucket`);
      if (parts.length) notes.push(`${workspace.name}: ${parts.join(', ')}`);
    } catch { /* no bucket, no credentials, no network, a secret in the tree: not this hook's business */ }
  }));
  if (notes.length) {
    process.stdout.write(JSON.stringify({
      systemMessage: `Card work not yet on the site — ${notes.join('; ')}. Cards reach the published site when they are uploaded: npm run publish -- --all (from the app repo) publishes every workspace at once.`,
    }));
  }
} catch { /* never let this hook be the reason a session cannot stop */ }
