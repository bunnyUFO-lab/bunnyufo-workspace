import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-leaks.mjs')

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'leaks-'))
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'T')
  sh(dir, 'config', 'user.email', 't@example.org')
  sh(dir, 'config', 'commit.gpgsign', 'false')
  const patterns = join(dir, '.leak-patterns.txt') // untracked, so the scan ignores it
  writeFileSync(patterns, '# comment\n\nleak\\.example\\.org\n')
  return { dir, patterns, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function commit(dir, files, msg = 'c') {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
    sh(dir, 'add', name)
  }
  sh(dir, 'commit', '-q', '-m', msg)
}

function run(dir, args, env = {}) {
  return spawnSync('node', [SCRIPT, '--root', dir, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  })
}

test('a clean tree exits 0', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'nothing here\n' })
  const o = run(r.dir, ['--patterns', r.patterns])
  assert.equal(o.status, 0, o.stdout + o.stderr)
  assert.match(o.stdout, /1 files, 1 patterns, 0 matches/)
})

test('a match exits 1 with path:line and without the text', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'src/a.txt': 'ok\nsee https://leak.example.org/x\n' })
  const o = run(r.dir, ['--patterns', r.patterns])
  assert.equal(o.status, 1)
  assert.match(o.stdout, /src\/a\.txt:2: pattern #1/)
  assert.ok(!o.stdout.includes('leak.example.org'))
})

test('--show prints the text', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'see leak.example.org\n' })
  const o = run(r.dir, ['--patterns', r.patterns, '--show'])
  assert.equal(o.status, 1)
  assert.ok(o.stdout.includes('see leak.example.org'))
})

test('a deleted file is clean in the tree and found by --history', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'leak.example.org\n' })
  sh(r.dir, 'rm', '-q', 'a.txt')
  sh(r.dir, 'commit', '-q', '-m', 'drop')
  assert.equal(run(r.dir, ['--patterns', r.patterns]).status, 0)
  const o = run(r.dir, ['--patterns', r.patterns, '--history'])
  assert.equal(o.status, 1)
  assert.match(o.stdout, /^[0-9a-f]{10} a\.txt: pattern #1/m)
  assert.ok(!o.stdout.includes('leak.example.org'))
})

test('a commit message match is found by --history', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'fine\n' }, 'deploy to leak.example.org')
  const o = run(r.dir, ['--patterns', r.patterns, '--history', 'HEAD'])
  assert.equal(o.status, 1)
  assert.match(o.stdout, /\(message\): pattern #1/)
})

test('comments and blank lines in the patterns file are ignored', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'a comment mark # and nothing else\n\n' })
  const o = run(r.dir, ['--patterns', r.patterns])
  assert.equal(o.status, 0)
  assert.match(o.stdout, /1 patterns/)
})

test('a bad regex exits 2 and names only the line number', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'x\n' })
  writeFileSync(r.patterns, 'fine\n(unclosed-secret\n')
  const o = run(r.dir, ['--patterns', r.patterns])
  assert.equal(o.status, 2)
  assert.match(o.stderr, /line 2/)
  assert.ok(!o.stderr.includes('unclosed-secret'))
})

test('a missing patterns file exits 2', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'x\n' })
  const o = run(r.dir, ['--patterns', join(r.dir, 'nope.txt')])
  assert.equal(o.status, 2)
})

test('a binary file is skipped', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'b.bin': Buffer.concat([Buffer.from('leak.example.org'), Buffer.from([0, 1, 2])]).toString('latin1') })
  assert.equal(run(r.dir, ['--patterns', r.patterns]).status, 0)
})

test('an untracked file is ignored', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'x\n' })
  writeFileSync(join(r.dir, 'untracked.txt'), 'leak.example.org\n')
  assert.equal(run(r.dir, ['--patterns', r.patterns]).status, 0)
})

test('BUW_LEAK_PATTERNS selects the patterns file', (t) => {
  const r = makeRepo()
  t.after(r.done)
  commit(r.dir, { 'a.txt': 'leak.example.org\n' })
  const o = run(r.dir, [], { BUW_LEAK_PATTERNS: r.patterns })
  assert.equal(o.status, 1)
  assert.match(o.stdout, /a\.txt:1: pattern #1/)
})
