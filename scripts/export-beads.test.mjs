import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { foreignEmails, scrubExport } from './export-beads.mjs'

const NOREPLY = '1+me@users.noreply.github.com'

test('person fields get the replacement, free text and nested text get [email], noreply and placeholders stay', () => {
  const dirty = JSON.stringify({
    id: 'b', owner: 'someone@example.com.evil.org', created_by: 'x@host.test.org', assignee: 'bob@host.org', closed_by: NOREPLY, merged_by: 'm@host.org',
    description: 'ask me@host.org or someone@example.com', notes: 'x@sub.example.net, y@localhost.invalid, z@box.test',
    comments: [{ author: 'x@host.net', text: 'mail x@host.net' }], dependencies: [{ created_by: 'd@host.org', metadata: '{"k":"v@host.org"}' }],
  })
  const row = JSON.parse(scrubExport(dirty, NOREPLY))
  assert.equal(row.owner, NOREPLY)
  assert.equal(row.created_by, NOREPLY)
  assert.equal(row.assignee, NOREPLY)
  assert.equal(row.closed_by, NOREPLY)
  assert.equal(row.merged_by, NOREPLY) // any *_by
  assert.equal(row.description, 'ask [email] or someone@example.com')
  assert.equal(row.notes, 'x@sub.example.net, y@localhost.invalid, z@box.test')
  assert.deepEqual(row.comments[0], { author: NOREPLY, text: 'mail [email]' })
  assert.deepEqual(row.dependencies[0], { created_by: NOREPLY, metadata: '{"k":"[email]"}' })
})

test('with no repo noreply email the person field becomes an empty string', () => {
  assert.deepEqual(JSON.parse(scrubExport('{"id":"a","owner":"someone@host.org","created_by":"bunny"}', '')), { id: 'a', owner: '', created_by: 'bunny' })
})

test('a row with nothing to scrub is returned byte for byte, Go escapes included', () => {
  const clean = '{"id":"a","owner":"1+me@users.noreply.github.com","description":"a \\u003cb\\u003e \\u0026 mail someone@example.com"}'
  const dirty = '{"id":"b","description":"\\u003c x@host.org \\u0026","owner":"x@host.org"}'
  const out = scrubExport(`${clean}\n${dirty}\n`, NOREPLY).split('\n')
  assert.equal(out[0], clean)
  assert.ok(!out[1].includes('host.org'))
  assert.equal(out[2], '')
})

test('a line that is not JSON passes through', () => {
  assert.equal(scrubExport('not json @', ''), 'not json @')
})

test('foreignEmails: noreply and placeholder domains pass, a lookalike does not', () => {
  assert.deepEqual(foreignEmails(`${NOREPLY} a@example.org b@x.test c@y.invalid d@localhost e@z.example`), [])
  assert.deepEqual(foreignEmails('me@users.noreply.github.com.evil.org someone@gmail.com'), ['me@users.noreply.github.com.evil.org', 'someone@gmail.com'])
})

test('the committed .beads/issues.jsonl holds no forbidden email (runs in CI through npm test)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.beads', 'issues.jsonl')
  if (!existsSync(file)) return
  assert.equal(foreignEmails(readFileSync(file, 'utf8')).length, 0)
})
