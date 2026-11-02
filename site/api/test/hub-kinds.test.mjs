// The sub-type of an Ask or a list of steps (ws-qg1.7): the file's own `kind`, else a guess from its words that is marked as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { askItem, askSubtype, checkChecklist, checklistItem, cleanAsk, inboxCounts, inboxFilter, subCounts, inferAskSubtype, inferStepsSubtype, stepsSubtype } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, checklistJson, designAskJson, minutesAgo, plainOptions, threeOptions } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');

test('inferAskSubtype: the table', () => {
  const plain = { question: 'Which name do you like?', options: plainOptions() };
  const rows = [
    [{ ...plain, requirePasskey: true }, 'approval'],
    [{ ...plain, rerun: { request: 'r1', kind: 'denied' } }, 'approval'],
    [{ ...plain, options: threeOptions() }, 'design'],
    [{ question: 'Review the frame', decisions: [{ id: 'd1', text: 'x' }] }, 'design'],
    [{ question: 'Did the deploy land?' }, 'verify'],
    [{ question: 'Does the menu open on a phone?' }, 'verify'],
    [{ question: 'Is the bot working now?' }, 'verify'],
    [{ question: 'Live check: is the site up?' }, 'verify'],
    [{ question: 'Is it a good idea to rename?' }, 'decision'],
    [{ question: 'Didactic or plain tone for the docs?' }, 'decision'],
    [{ question: 'Doesnt-matter naming: which one?' }, 'decision'],
    [{ question: 'Did' }, 'verify'],
    [{ question: 'Should the jump be floatier?' }, 'decision'],
    [{ question: 'Which of these?', requirePasskey: false }, 'decision'],
    [{ question: 'Did you see it?', requirePasskey: true }, 'approval'],
    [null, 'decision'],
  ];
  for (const [ask, expected] of rows) assert.equal(inferAskSubtype(ask), expected, JSON.stringify(ask));
});

test('inferStepsSubtype: the table', () => {
  const rows = [
    ['Live check the Discord bot', 'verify'], ['Test the new menu', 'verify'], ['Try the build', 'verify'], ['Play-test the wall jump', 'verify'], ['Check the badges', 'verify'], ['Verify the deploy', 'verify'],
    ['Set up the Discord bot', 'setup'], ['Install the plugin', 'setup'], ['Paste the API key', 'setup'], ['Run the Windows installer', 'setup'], ['Sign the release', 'setup'],
    ['Investigate the crash', 'investigate'], ['Find out why it hangs', 'investigate'], ['Look into the slow save', 'investigate'],
    ['Build the level', 'develop'], ['Make a menu', 'develop'], ['Add the tooltip', 'develop'], ['Fix the typo', 'develop'],
    ['Finish the Discord bot setup', 'setup'], ['Something else entirely', 'setup'], ['', 'setup'], ['Testing times', 'setup'],
  ];
  for (const [title, expected] of rows) assert.equal(inferStepsSubtype(title), expected, title);
});

test('a valid kind is used as written, an invalid one is dropped and guessed, a playtest has none', () => {
  assert.deepEqual(askSubtype({ question: 'Did it work?', kind: 'design' }), { subtype: 'design', inferred: false });
  assert.deepEqual(askSubtype({ question: 'Did it work?', kind: 'nonsense' }), { subtype: 'verify', inferred: true });
  assert.deepEqual(askSubtype({ question: 'Pick', kind: 'approval' }), { subtype: 'approval', inferred: false });
  assert.deepEqual(stepsSubtype({ title: 'Test it', kind: 'develop' }), { subtype: 'develop', inferred: false });
  assert.deepEqual(stepsSubtype({ title: 'Test it' }), { subtype: 'verify', inferred: true });
  assert.equal(stepsSubtype({ title: 'Try it', kind: 'playtest' }), null);
  const cleaned = cleanAsk({ question: 'x', kind: 'nonsense' });
  assert.equal(cleaned.ask.kind, undefined);
  assert.deepEqual(cleaned.bad, ['kind']);
  assert.equal(cleanAsk({ question: 'x', kind: 'verify' }).ask.kind, 'verify');
});

test('items carry subtype, and kindInferred only for a guess', () => {
  const written = askItem({ id: 'a', question: 'Pick one', kind: 'verify', createdAt: NOW.toISOString() }, { state: 'open' });
  assert.equal(written.subtype, 'verify');
  assert.equal(written.kindInferred, undefined);
  const guessed = askItem({ id: 'a', question: 'Did it work?', createdAt: NOW.toISOString() }, { state: 'open' });
  assert.equal(guessed.subtype, 'verify');
  assert.equal(guessed.kindInferred, true);
  const list = checklistItem({ id: 'c', title: 'Fix the typo', createdAt: NOW.toISOString(), items: [] }, new Set());
  assert.equal(list.subtype, 'develop');
  assert.equal(list.kindInferred, true);
  const play = checklistItem({ id: 'p', title: 'Try it', kind: 'playtest', build: 'https://x.test/b', createdAt: NOW.toISOString(), items: [] }, new Set());
  assert.equal(play.subtype, undefined);
});

test('checkChecklist takes the four kinds, steps and playtest, and refuses the rest', () => {
  const base = { title: 'T', items: [{ text: 'one' }] };
  for (const kind of ['verify', 'setup', 'investigate', 'develop', 'steps']) assert.deepEqual(checkChecklist({ ...base, kind }), [], kind);
  assert.match(checkChecklist({ ...base, kind: 'design' })[0], /kind is/);
  assert.match(checkChecklist({ ...base, kind: 'verify', build: 'https://x.test' }).join(), /belongs to a playtest/);
});

test('the sub filter: question:verify is kept, an unknown sub is dropped, counts carry the sub-types', () => {
  assert.equal(inboxFilter('question:verify'), 'question:verify');
  assert.equal(inboxFilter('steps:setup'), 'steps:setup');
  assert.equal(inboxFilter('asks:decision'), 'question:decision', 'An old name keeps its sub-type.');
  assert.equal(inboxFilter('question:setup'), 'question', 'A sub-type of another kind is dropped.');
  assert.equal(inboxFilter('playtest:verify'), 'playtest');
  assert.equal(inboxFilter('nonsense:verify'), 'all');
  const counts = subCounts([
    { kind: 'ask', subtype: 'verify' }, { kind: 'ask', subtype: 'verify' }, { kind: 'ask', subtype: 'decision' },
    { kind: 'checklist', subtype: 'setup' }, { kind: 'checklist', playtest: true }, { kind: 'review' },
  ]);
  assert.equal(counts['question:verify'], 2);
  assert.equal(counts['question:decision'], 1);
  assert.equal(counts['question:design'], 0);
  assert.equal(counts['steps:setup'], 1);
  assert.equal(inboxCounts([{ kind: 'ask', subtype: 'verify' }]).question, 1, 'The kind counts are unchanged.');
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-kinds-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env: {}, log: () => {} });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: ['https://site.example'] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => (await fetch(`${origin}/api${route}`, { headers: { Origin: 'https://site.example', 'Remote-User': 'owner' } })).json();
  return { fake, get, close: async () => { await hub.close(); server.close(); await fake.close(); } };
}

test('/inbox passes kind through and infers it; the item pages carry it; the sub filter narrows', async () => {
  const f = await fixture();
  try {
    let n = 0;
    const ids = {};
    const putAsk = (slug, minutes, extra) => {
      n += 1;
      ids[slug] = `${day}-probe-${slug}-a${String(n).padStart(3, '0')}`;
      f.fake.seed(`sections/inbox/asks/${ids[slug]}/ask.json`, JSON.stringify(askJson({ id: ids[slug], now: minutesAgo(NOW, minutes), question: `Q ${slug}`, options: plainOptions().slice(0, 2), allowDrawing: false, ...extra })), 'application/json');
    };
    const putList = (slug, minutes, title, kind) => {
      n += 1;
      ids[slug] = `${day}-probe-${slug}-c${String(n).padStart(3, '0')}`;
      f.fake.seed(`sections/inbox/checklists/${ids[slug]}/checklist.json`, JSON.stringify(checklistJson({ id: ids[slug], now: minutesAgo(NOW, minutes), title, ...(kind ? { kind } : {}) })), 'application/json');
    };
    putAsk('written', 10, { kind: 'approval' });
    putAsk('passkey', 11, { requirePasskey: true });
    putAsk('did', 12, { question: 'Did the deploy land?' });
    putAsk('plain', 13, {});
    putAsk('junk', 14, { kind: 'bogus' });
    putList('listwritten', 20, 'Anything at all', 'investigate');
    putList('listguess', 21, 'Install the plugin');
    const design = designAskJson({ id: `${day}-probe-frame-a999` });
    f.fake.seed(`sections/inbox/asks/${design.id}/ask.json`, JSON.stringify(design), 'application/json');

    const all = await f.get('/hub/inbox?filter=all');
    const by = title => all.items.find(item => item.title === title);
    assert.deepEqual([by('Q written').subtype, by('Q written').kindInferred], ['approval', undefined]);
    assert.deepEqual([by('Q passkey').subtype, by('Q passkey').kindInferred], ['approval', true]);
    assert.deepEqual([by('Did the deploy land?').subtype, by('Did the deploy land?').kindInferred], ['verify', true]);
    assert.deepEqual([by('Q plain').subtype, by('Q plain').kindInferred], ['decision', true]);
    assert.deepEqual([by('Q junk').subtype, by('Q junk').kindInferred], ['decision', true], 'A bad kind is a guess.');
    assert.deepEqual([by('Anything at all').subtype, by('Anything at all').kindInferred], ['investigate', undefined]);
    assert.deepEqual([by('Install the plugin').subtype, by('Install the plugin').kindInferred], ['setup', true]);
    assert.equal(all.items.find(item => item.id === design.id).subtype, 'design');

    const verify = await f.get('/hub/inbox?filter=question%3Averify');
    assert.deepEqual(verify.items.map(item => item.title), ['Did the deploy land?']);
    const steps = await f.get('/hub/inbox?filter=steps:investigate');
    assert.deepEqual(steps.items.map(item => item.title), ['Anything at all']);
    assert.equal(all.subCounts['question:decision'], 2);
    assert.equal(all.subCounts['question:approval'], 2);
    assert.equal(all.subCounts['steps:setup'], 1);
    assert.equal(all.counts['question:decision'], undefined, 'The chip counts keep their shape.');

    const page = await f.get(`/hub/asks/${ids.passkey}`);
    assert.deepEqual([page.subtype, page.kindInferred], ['approval', true]);
    const written = await f.get(`/hub/asks/${ids.written}`);
    assert.deepEqual([written.kind, written.subtype, written.kindInferred], ['approval', 'approval', undefined]);
    const listPage = await f.get(`/hub/checklists/${ids.listguess}`);
    assert.deepEqual([listPage.subtype, listPage.kindInferred], ['setup', true]);
  } finally { await f.close(); }
});
