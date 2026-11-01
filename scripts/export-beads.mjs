#!/usr/bin/env node
// Export the Beads database to .beads/issues.jsonl without publishing anyone's email.
//
//   node scripts/export-beads.mjs [--out <file>] [--from <file>]
//
// Runs `bd export`, then replaces any email address in a person field (owner, created_by, assignee,
// ...) that is not a @users.noreply.github.com address with this repository's local
// `git config --local user.email` when that is a noreply address, else with an empty string.
// --from reads an export from a file instead of running bd (tests). Nothing is ever printed
// about the address itself.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const NOREPLY = /@users\.noreply\.github\.com$/i
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PERSON_FIELDS = new Set([
  'owner', 'created_by', 'assignee', 'closed_by', 'updated_by', 'author', 'actor', 'reporter', 'claimed_by', 'creator',
])

export const isForeignEmail = (s) => [...s.matchAll(EMAIL)].some((m) => !NOREPLY.test(m[0]))

function scrub(value, replacement, person) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, replacement, person))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, replacement, PERSON_FIELDS.has(k))
    return out
  }
  if (person && typeof value === 'string') return value.replace(EMAIL, (m) => (NOREPLY.test(m) ? m : replacement))
  return value
}

/** The export's text with every non-noreply email in a person field replaced. */
export function scrubExport(text, replacement) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      try {
        return JSON.stringify(scrub(JSON.parse(line), replacement, false))
      } catch {
        return line
      }
    })
    .join('\n')
}

export function repoNoreply(cwd = process.cwd()) {
  const r = spawnSync('git', ['config', '--local', 'user.email'], { cwd, encoding: 'utf8' })
  const email = r.status === 0 ? r.stdout.trim() : ''
  return NOREPLY.test(email) ? email : ''
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const out = arg('--out') ?? '.beads/issues.jsonl'
  const from = arg('--from')
  let text
  if (from) text = readFileSync(from, 'utf8')
  else {
    const r = spawnSync('bd', ['export'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' })
    if (r.status !== 0) {
      console.error('bd export failed')
      process.exit(1)
    }
    text = r.stdout
  }
  writeFileSync(out, scrubExport(text, repoNoreply()))
  console.log(`wrote ${out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
