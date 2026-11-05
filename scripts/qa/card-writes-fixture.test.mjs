// The QA fixture for agent cards, run over the stand-in S3 (never a real bucket): seed, check and reset work, and the guard
// refuses any key outside the dev section and the dev inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBucket } from '../../site/api/s3.mjs';
import { startFakeS3 } from '../../site/api/test/fake-s3.mjs';
import { SECTION, guarded, run } from './card-writes-fixture.mjs';

async function world() {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  let at = 1_800_000_000_000;
  const clock = () => (at += 1000);
  return { fake, bucket, clock };
}

test('seed makes the section, the owner card and an agent batch; reset adds another and deletes nothing; check passes', async () => {
  const w = await world();
  try {
    const lines = [];
    const log = line => lines.push(line);
    await run('seed', w.bucket, { clock: w.clock, log });
    const list = w.fake.json(`sections/${SECTION}/workspace.json`);
    assert.deepEqual(list.entities.map(card => card.id), ['qa-owner', 'qa-agent']);
    const owner = list.entities[0];
    assert.equal(owner.steps.length, 2, 'the agent added a tab to the owner card');
    assert.equal(owner.steps[1].agentTab, true);
    assert.deepEqual(list.entities[1].steps.map(step => step.path), ['index.html']);
    assert.equal(w.fake.text(`sections/${SECTION}/${owner.folder}/index.md`).includes('An agent added a line'), true);
    const records = [...w.fake.objects.keys()].filter(key => key.startsWith('sections/inbox-dev/card-writes/'));
    assert.equal(records.length, 5, 'each agent write has a record in the dev inbox: two for the tab, one for the edit, two for the card (the owner has none)');
    assert.equal([...w.fake.objects.keys()].some(key => key.startsWith('sections/inbox/')), false, 'the real inbox is never touched');
    assert.ok(w.fake.objects.has(`sections/inbox-dev/beads/${SECTION}.jsonl`) && w.fake.objects.has(`sections/inbox-dev/beads/${SECTION}.meta.json`));
    await run('reset', w.bucket, { clock: w.clock, log });
    assert.equal(w.fake.json(`sections/${SECTION}/workspace.json`).entities.length, 3);
    await run('check', w.bucket, { clock: w.clock, log });
    assert.match(lines.join('\n'), /check passed/);
    assert.ok(![...w.fake.objects.keys()].some(key => !(key.startsWith(`sections/${SECTION}/`) || key.startsWith('sections/inbox-dev/'))), 'only the two prefixes were written');
    assert.equal(w.fake.log.some(entry => entry.method === 'DELETE'), false, 'nothing is deleted');
    // A second seed does not make the owner card again.
    await run('seed', w.bucket, { clock: w.clock, log });
    assert.equal(w.fake.json(`sections/${SECTION}/workspace.json`).entities.filter(card => card.id === 'qa-owner').length, 1);
  } finally { await w.fake.close(); }
});

test('the guard refuses any key outside the dev section and the dev inbox, and every delete', async () => {
  const w = await world();
  try {
    const bucket = guarded(w.bucket);
    for (const key of ['sections/magic-loops/workspace.json', 'sections/inbox/library-writes.json', 'sections/inbox/x', 'sections/dev-project-writes-two/x', 'state.json', 'sections/assistant/workspace.json']) {
      await assert.rejects(bucket.getText(key), /refuses getText/, key);
      await assert.rejects(bucket.put(key, 'x'), /refuses put/, key);
    }
    await assert.rejects(bucket.list('sections/'), /refuses list/);
    await assert.rejects(bucket.del(`sections/${SECTION}/x`), /never deletes/);
    await assert.rejects(bucket.copy(`sections/${SECTION}/a`, 'sections/inbox/b'), /refuses copy/);
    assert.equal(await bucket.getText(`sections/${SECTION}/nothing`), null);
    assert.equal(w.fake.log.filter(entry => !entry.key.startsWith(`sections/${SECTION}/`)).length, 0, 'a refused call never reached the bucket');
  } finally { await w.fake.close(); }
});

test('an unknown command and a missing bucket are usage errors', async () => {
  const w = await world();
  try {
    await assert.rejects(run('wipe', w.bucket), /Usage/);
  } finally { await w.fake.close(); }
});
