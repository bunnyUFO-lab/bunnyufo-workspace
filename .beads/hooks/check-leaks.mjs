#!/usr/bin/env node
// Leak check: scans the tracked tree (and optionally the git history) for the owner's
// private patterns, which live outside the repository.
//
//   node scripts/check-leaks.mjs [--patterns <file>] [--history [<rev-range>]] [--show] [--root <dir>]
//
// Patterns file: --patterns, else BUW_LEAK_PATTERNS, else ~/.buw/leak-patterns.txt.
// One JavaScript regex per line (flag i); '#' lines and blank lines are ignored.
// Exit 0 clean, 1 on any match, 2 when no patterns file is found or a line will not compile.
// Matched text is printed only with --show, so logs never repeat a leak.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, openSync, readFileSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const MAX_BUFFER = 1024 * 1024 * 1024

function parseArgs(argv) {
  const opts = { patterns: null, history: null, show: false, root: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--patterns') opts.patterns = argv[++i]
    else if (a === '--root') opts.root = argv[++i]
    else if (a === '--show') opts.show = true
    else if (a === '--history') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { opts.history = next; i++ } else opts.history = 'HEAD'
    } else {
      console.error(`Unknown argument: ${a}`)
      process.exit(2)
    }
  }
  return opts
}

function git(root, args) {
  const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: root, maxBuffer: MAX_BUFFER, encoding: 'buffer',
  })
  if (r.error || r.status !== 0) {
    console.error(`git ${args[0]} failed${r.stderr ? `: ${r.stderr.toString().trim().split('\n')[0]}` : ''}`)
    process.exit(2)
  }
  return r.stdout
}

function loadPatterns(file) {
  const path = file || process.env.BUW_LEAK_PATTERNS || join(homedir(), '.buw', 'leak-patterns.txt')
  if (!existsSync(path)) {
    console.error('No leak patterns file found: pass --patterns, set BUW_LEAK_PATTERNS, or create ~/.buw/leak-patterns.txt.')
    process.exit(2)
  }
  const patterns = []
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  let bad = false
  lines.forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return
    try {
      patterns.push(new RegExp(line.trim(), 'i'))
    } catch {
      console.error(`Patterns file: line ${i + 1} is not a valid regex.`)
      bad = true
    }
  })
  if (bad) process.exit(2)
  return patterns
}

function isBinary(path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(8000)
    const n = readSync(fd, buf, 0, 8000, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

const clip = (s) => s.trim().slice(0, 160)

function scanLine(patterns, text, report) {
  patterns.forEach((re, n) => { if (re.test(text)) report(n + 1, text) })
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const patterns = loadPatterns(opts.patterns)
  const root = resolve(opts.root)
  let matches = 0
  const out = (msg, text) => {
    console.log(opts.show ? `${msg}  ${clip(text)}` : msg)
    matches++
  }

  const files = git(root, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean)
  let scanned = 0
  for (const rel of files) {
    const full = join(root, rel)
    let st
    try { st = lstatSync(full) } catch { continue }
    if (st.isSymbolicLink() || !st.isFile()) continue
    if (isBinary(full)) continue
    scanned++
    readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
      scanLine(patterns, line, (n, text) => out(`${rel}:${i + 1}: pattern #${n}`, text))
    })
  }

  if (opts.history) {
    const log = git(root, ['log', '-p', '--no-color', '--no-ext-diff', '--format=%x00%H%n%B', opts.history]).toString('utf8')
    for (const chunk of log.split('\0').slice(1)) {
      const nl = chunk.indexOf('\n')
      const sha = chunk.slice(0, nl).slice(0, 10)
      const rest = chunk.slice(nl + 1).split('\n')
      let path = '(message)'
      let inDiff = false
      for (const line of rest) {
        if (line.startsWith('diff --git ')) { inDiff = true; path = line.split(' b/').pop(); continue }
        if (!inDiff) { scanLine(patterns, line, (n, t) => out(`${sha} ${path}: pattern #${n}`, t)); continue }
        if (line.startsWith('+++') || !line.startsWith('+')) continue
        scanLine(patterns, line.slice(1), (n, t) => out(`${sha} ${path}: pattern #${n}`, t))
      }
    }
  }

  console.log(`${scanned} files, ${patterns.length} patterns, ${matches} matches`)
  process.exit(matches ? 1 : 0)
}

main()
