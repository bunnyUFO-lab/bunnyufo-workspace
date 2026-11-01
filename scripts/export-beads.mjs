#!/usr/bin/env node
// Export the Beads database to .beads/issues.jsonl without publishing anyone's email.
//
//   node scripts/export-beads.mjs [--out <file>] [--from <file>] [-- <extra bd export flags>]
//
// Runs `bd export` (extra flags after `--` go to it, e.g. `-- --all`; bd's stderr and exit code pass
// through), then scrubs every string value of every row (person fields, free text, comments,
// nested objects): an email that is not a @users.noreply.github.com address and not on a
// placeholder domain (example.com/.org/.net, .test, .example, .invalid, localhost) is replaced.
// A person field (owner, assignee, author, actor, reporter, creator, *_by) gets this repository's
// local `git config --local user.email` when that is a noreply address, else an empty string;
// free text gets "[email]". A row with nothing to scrub is written exactly as bd wrote it.
// The same rule as hub-hooks' Beads push (workspace-skills, mods/hub-hooks/hooks/beads.ts).
// --from reads an export from a file instead of running bd (tests). No address is ever printed.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const NOREPLY = /@users\.noreply\.github\.com$/i
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PLACEHOLDER = /(?:^|\.)(?:example\.(?:com|org|net)|localhost)$|\.(?:test|example|invalid)$/i
const PERSON_KEY = /^(?:owner|assignee|author|actor|reporter|creator)$|_by$/

/** True for an email that may be committed: a GitHub noreply address or a placeholder domain. */
export const allowedEmail = (email) => NOREPLY.test(email) || PLACEHOLDER.test(email.slice(email.lastIndexOf('@') + 1))

/** The emails in `text` that may not be committed. */
export const foreignEmails = (text) => [...text.matchAll(EMAIL)].map((m) => m[0]).filter((e) => !allowedEmail(e))

function scrub(value, replacement, person, changed) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, replacement, person, changed))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, replacement, PERSON_KEY.test(k), changed)
    return out
  }
  if (typeof value === 'string') {
    return value.replace(EMAIL, (m) => {
      if (allowedEmail(m)) return m
      changed.yes = true
      return person ? replacement : '[email]'
    })
  }
  return value
}

/** The export's text with every forbidden email replaced; a row that needs no change is returned as it was. */
export function scrubExport(text, replacement) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('@')) return line
      try {
        const changed = { yes: false }
        const row = scrub(JSON.parse(line), replacement, false, changed)
        return changed.yes ? JSON.stringify(row) : line
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
  const dash = argv.indexOf('--')
  const mine = dash < 0 ? argv : argv.slice(0, dash)
  const extra = dash < 0 ? [] : argv.slice(dash + 1)
  const arg = (name) => (mine.includes(name) ? mine[mine.indexOf(name) + 1] : undefined)
  const out = arg('--out') ?? '.beads/issues.jsonl'
  const from = arg('--from')
  let text
  if (from) text = readFileSync(from, 'utf8')
  else {
    const r = spawnSync('bd', ['export', ...extra], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'],
    })
    if (r.error || r.status !== 0) {
      if (r.error) console.error(`bd export could not run: ${r.error.code ?? 'error'}`)
      process.exit(r.status || 1)
    }
    text = r.stdout
  }
  writeFileSync(out, scrubExport(text, repoNoreply()))
  console.log(`wrote ${out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
