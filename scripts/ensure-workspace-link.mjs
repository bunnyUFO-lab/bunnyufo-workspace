// The browser preview used to reach cards through a public/workspace junction into
// workspace/. A Vite plugin (scripts/vite-workspace.mjs) now serves the active workspace
// instead, so this removes a leftover link. Runs before `npm run dev` ("predev").
// Only the link itself is removed (rmdir on a junction or unlink on a symlink): never a
// recursive delete, which would follow the link and wipe the cards.
import { lstatSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const link = resolve(root, 'public', 'workspace')

let info = null
try { info = lstatSync(link) } catch { /* No leftover link. */ }
if (info?.isSymbolicLink()) {
  try {
    if (process.platform === 'win32') rmdirSync(link)
    else unlinkSync(link)
    console.log('[buw] removed the old public/workspace link; the dev server now serves the active workspace')
  } catch (error) {
    console.warn(`[buw] could not remove public/workspace (${error.message}); delete the link itself, not its contents`)
  }
} else if (info) {
  console.warn('[buw] public/workspace is a real folder, not a link; leaving it alone. The dev server serves /workspace from the active workspace.')
}
