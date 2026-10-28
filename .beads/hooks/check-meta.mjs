// Checks the metadata of commits about to be pushed to the public remote. Called by pre-push.
//   node check-meta.mjs <rev-range> <tip-sha>
// 1. Every commit's author and committer email must be a GitHub noreply address.
// 2. No author or committer name or email may match ~/.buw/leak-patterns.txt.
// 3. Every root commit reachable from the tip must be listed in allowed-roots (next to this file):
//    the public repo's own root and the clean pr-assets root. Old private history has other roots.
// Matched text is never printed; only the rule and the commit id.
// Exit 0 clean, 1 blocked, 2 setup error.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [range, tip] = process.argv.slice(2)
if (!range || !tip) { console.error('usage: check-meta.mjs <rev-range> <tip-sha>'); process.exit(2) }
const here = path.dirname(fileURLToPath(import.meta.url))
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim()

const patternsFile = process.env.BUW_LEAK_PATTERNS || path.join(os.homedir(), '.buw', 'leak-patterns.txt')
if (!existsSync(patternsFile)) { console.error('check-meta: no leak patterns file'); process.exit(2) }
const patterns = readFileSync(patternsFile, 'utf8').split(/\r?\n/)
  .filter(line => line.trim() && !line.startsWith('#')).map(line => new RegExp(line.trim(), 'i'))
const rootsFile = path.join(here, 'allowed-roots')
if (!existsSync(rootsFile)) { console.error('check-meta: no allowed-roots file'); process.exit(2) }
const allowedRoots = new Set(readFileSync(rootsFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => /^[0-9a-f]{40}$/.test(s)))

const noreply = /^(\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@github\.com$/i
let blocked = false
const block = (sha, why) => { blocked = true; console.error(`check-meta: ${sha.slice(0, 7)} ${why}`) }

for (const root of git('rev-list', '--max-parents=0', tip).split('\n').filter(Boolean)) {
  if (!allowedRoots.has(root)) block(root, 'is a root commit that is not in allowed-roots (history from outside the public repo)')
}
const log = git('log', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce', range)
for (const line of log.split('\n').filter(Boolean)) {
  const [sha, an, ae, cn, ce] = line.split('\0')
  if (!noreply.test(ae)) block(sha, 'author email is not a GitHub noreply address')
  if (!noreply.test(ce)) block(sha, 'committer email is not a GitHub noreply address')
  if ([an, ae, cn, ce].some(value => patterns.some(p => p.test(value)))) block(sha, 'author or committer matches a leak pattern')
}
process.exit(blocked ? 1 : 0)
