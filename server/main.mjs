import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from './server.mjs';
import { defaultRegistryFile } from './workspaces.mjs';
import { saveJson } from './util.mjs';
import { createInterface } from 'node:readline';

const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const repo = path.resolve(option('--repo') || process.env.BUW_REPO || path.join(directory, '..'));
const uiDir = path.resolve(option('--ui') || path.join(directory, '../dist'));
const stateDir = path.resolve(option('--state') || path.join(repo, '.buw'));
// One JSON line per startup event, on stdout: the address to open, for a launcher,
// `docker logs`, or a person reading the terminal.
const announce = value => process.stdout.write(JSON.stringify(value) + '\n');
// Workspaces: --content <folder|id> pins one for this session; otherwise the user's registry decides.
const registryFile = path.resolve(option('--registry') || defaultRegistryFile());
const content = option('--content') || undefined;
const service = await createService({ repo, uiDir, stateDir, registryFile, content });
// Diagnostics are readable project state. The token travels only on the startup
// line below, never through this file.
await saveJson(path.join(stateDir, 'runtime.json'), { pid: process.pid, origin: service.origin });
announce({ type: 'ready', ...service.urls });
let exiting = false;
async function stop() {
  if (exiting) return; exiting = true;
  const deadline = setTimeout(() => process.exit(1), 8000); deadline.unref();
  await service.close(); process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// `quit` on stdin is the orderly shutdown a wrapper or a test can ask for; a
// container gets the same through SIGTERM.
createInterface({ input: process.stdin }).on('line', line => { if (line.trim() === 'quit') void stop(); });
process.on('uncaughtException', error => { process.stderr.write(`Service error: ${error.message}\n`); stop(); });
