import assert from 'node:assert/strict'
import test from 'node:test'
import { scrubExport } from './export-beads.mjs'

const NOREPLY = '1+me@users.noreply.github.com'
const row = (o) => JSON.stringify(o)

test('a foreign email in a person field is replaced; noreply and other text stay', () => {
  const text = [
    row({ id: 'a', owner: 'someone@example.com', created_by: 'someone@example.com', assignee: NOREPLY, description: 'mail someone@example.com' }),
    row({ id: 'b', owner: NOREPLY, comments: [{ author: 'x@example.org', text: 'hi' }] }),
  ].join('\n') + '\n'
  const out = scrubExport(text, NOREPLY).split('\n')
  const a = JSON.parse(out[0])
  assert.equal(a.owner, NOREPLY)
  assert.equal(a.created_by, NOREPLY)
  assert.equal(a.assignee, NOREPLY)
  assert.equal(a.description, 'mail someone@example.com') // only person fields
  assert.equal(JSON.parse(out[1]).comments[0].author, NOREPLY)
  assert.equal(out[2], '')
})

test('with no repo noreply email the field becomes an empty string', () => {
  const out = scrubExport(row({ id: 'a', owner: 'someone@example.com', created_by: 'bunny' }), '')
  assert.deepEqual(JSON.parse(out), { id: 'a', owner: '', created_by: 'bunny' })
})

test('a line that is not JSON passes through', () => {
  assert.equal(scrubExport('not json', ''), 'not json')
})
