// Manage the workspace registry (~/.buw/workspaces.json or BUW_REGISTRY): which folders of cards
// exist and which one the app, scripts and skills use. See server/workspaces.mjs.
//   npm run workspace                      list (* marks the active one)
//   npm run -s workspace path              print the active workspace folder (for scripts and agents)
//   npm run workspace add <folder> [--name <name>] [--bucket s3://…] [--repo <url>] [--site <url>] [--use]
//   npm run workspace set <id> [--bucket s3://…] [--repo <url>] [--site <url>] [--name <name>]
//                                          change where it publishes; an empty value ("") removes the field
//   npm run workspace use <id|template>    make it the active workspace
//   npm run workspace remove <id>          unregister only; files stay
//   npm run workspace update-shared [<id>] copy the app's workspace/_shared into a workspace
//   npm run workspace migrate <bucket>     give every registered workspace without a bucket
//                                          s3://<bucket>/sections/<id> (the one-time move off git)
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWorkspace, defaultRegistryFile, listWorkspaces, removeWorkspace, resolveWorkspace, setWorkspaceFields, useWorkspace } from '../server/workspaces.mjs';

const appRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryFile = defaultRegistryFile();
const [command = 'list', ...rest] = process.argv.slice(2);
const option = name => { const index = rest.indexOf(`--${name}`); return index < 0 ? undefined : rest[index + 1]; };
const positional = rest.filter((value, index) => !value.startsWith('--') && !rest[index - 1]?.startsWith('--'));

try {
  if (command === 'list') {
    const active = await resolveWorkspace({ appRepo, registryFile });
    for (const item of await listWorkspaces({ appRepo, registryFile })) {
      const mark = item.root === active.root ? '*' : ' ';
      console.log(`${mark} ${item.id.padEnd(24)} ${item.name}${item.exists ? '' : ' (missing)'}\n    ${item.root}${item.bucket ? `\n    bucket: ${item.bucket}` : item.builtin ? '' : '\n    bucket: none  <- npm run workspace set <id> --bucket s3://…'}${item.site ? `\n    site: ${item.site}` : ''}`);
    }
    if (active.pinned) console.log(`\nActive workspace fixed by ${active.source}.`);
    console.log(`\nRegistry: ${registryFile}`);
  } else if (command === 'path') {
    console.log((await resolveWorkspace({ appRepo, registryFile })).root);
  } else if (command === 'add') {
    if (!positional[0]) throw new Error('Usage: npm run workspace add <folder> [--name <name>] [--bucket s3://bucket/sections/id] [--repo <url>] [--site <url>] [--use]');
    const entry = await addWorkspace({ registryFile, path: positional[0], name: option('name'), repo: option('repo'), site: option('site'), bucket: option('bucket'), activate: rest.includes('--use') });
    console.log(`Added ${entry.id} (${entry.path})${rest.includes('--use') ? ' and made it active' : ''}.`);
  } else if (command === 'set') {
    if (!positional[0]) throw new Error('Usage: npm run workspace set <id> [--bucket s3://…] [--repo <url>] [--site <url>] [--name <name>]');
    const fields = {};
    for (const name of ['bucket', 'repo', 'site', 'name']) if (rest.includes(`--${name}`)) fields[name] = option(name) ?? '';
    if (fields.bucket && !/^s3:\/\/[^/]+\/.+/.test(fields.bucket)) throw new Error('--bucket is s3://<bucket>/<prefix>, for example s3://my-cards/sections/magic-loops');
    const entry = await setWorkspaceFields({ registryFile, id: positional[0], fields });
    console.log(`${entry.id}: ${['bucket', 'repo', 'site'].map(name => `${name}=${entry[name] ?? '(none)'}`).join('  ')}`);
  } else if (command === 'migrate') {
    if (!positional[0]) throw new Error('Usage: npm run workspace migrate <bucket>  (gives every workspace without one s3://<bucket>/sections/<id>)');
    for (const item of await listWorkspaces({ appRepo, registryFile })) {
      if (item.builtin || item.bucket) continue;
      const entry = await setWorkspaceFields({ registryFile, id: item.id, fields: { bucket: `s3://${positional[0]}/sections/${item.id}` } });
      console.log(`${entry.id}: ${entry.bucket}`);
    }
    console.log('Now upload everything once: npm run publish -- --all');
  } else if (command === 'use') {
    if (!positional[0]) throw new Error('Usage: npm run workspace use <id|template>');
    console.log(`Active workspace: ${await useWorkspace({ registryFile, id: positional[0] })}. Restart the local app or switch in Settings to see it.`);
  } else if (command === 'remove') {
    if (!positional[0]) throw new Error('Usage: npm run workspace remove <id>');
    console.log(`Unregistered ${positional[0]}; its files are untouched. Active: ${await removeWorkspace({ registryFile, id: positional[0] })}.`);
  } else if (command === 'update-shared') {
    const target = await resolveWorkspace({ appRepo, registryFile, content: positional[0] });
    if (target.builtin) throw new Error('The starter examples already use the app\'s _shared folder.');
    await cp(path.join(appRepo, 'workspace', '_shared'), path.join(target.root, '_shared'), { recursive: true });
    console.log(`Copied workspace/_shared into ${target.root}/_shared. Publish it with npm run publish.`);
  } else {
    throw new Error(`Unknown command "${command}". Use list, path, add, set, migrate, use, remove or update-shared.`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
