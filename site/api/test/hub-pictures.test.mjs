// Pictures on inbox items: an Ask's answer and a checklist's note. Fake data only, over the stand-in S3; nothing here touches the real inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { ANSWER_PICTURE_RE, NOTE_SHOT_RE, checkAnswer, checklistEvidence, takesPictures } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { jpeg, solidPng } from './png.mjs';
import { askJson, checklistJson, seeder, threeOptions } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const askId = (slug, n = 'a1b2') => `${day}-probe-${slug}-${n}`;
const b64 = buffer => buffer.toString('base64');
const picture = (buffer = solidPng(8, 6), type = 'image/png') => ({ type, data: b64(buffer) });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-pictures-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, data) => fetch(`${origin}/api${route}`, {
    method, headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Remote-User': 'owner' }), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const get = async route => { const answer = await call('GET', route); return { status: answer.status, body: await answer.json().catch(() => null), response: answer }; };
  const post = async (route, data) => { const answer = await call('POST', route, data ?? {}); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  return { fake, seed: seeder(fake), get, post, call, close: async () => { server.close(); await fake.close(); } };
}

const names = (fake, id, folder = 'asks') => [...fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/${folder}/${id}/`)).map(key => key.split('/').pop());

test('an Ask takes pictures only when nothing in the Hub acts on its answer', () => {
  assert.equal(takesPictures({ allowNote: true }), true);
  assert.equal(takesPictures({ allowDrawing: true }), true);
  assert.equal(takesPictures({ allowNote: false }), false);
  for (const field of ['rerun', 'agentEdit', 'avatar', 'changes']) assert.equal(takesPictures({ allowNote: true, [field]: {} }), false, field);
  assert.match('answer.pic-20261106T101112123Z-ab12.jpg', ANSWER_PICTURE_RE);
  assert.doesNotMatch('answer.png', ANSWER_PICTURE_RE);
  assert.doesNotMatch('answer.pic-x.jpg', ANSWER_PICTURE_RE);
  assert.match('shot-note-20261106T101112123Z-ab12.png', NOTE_SHOT_RE);
  assert.equal(checklistEvidence(['shot-note-20261106T101112123Z-ab12.png']).shots.length, 0, 'A note picture is not a playtest screenshot.');
});

test('checkAnswer: a picture alone answers an Ask with no options, an Ask with options still needs one picked', () => {
  const plain = { allowNote: true };
  const name = 'answer.pic-20261106T101112123Z-ab12.jpg';
  assert.doesNotThrow(() => checkAnswer(plain, { pictures: [name] }));
  assert.throws(() => checkAnswer(plain, {}), /Choose an option/);
  assert.throws(() => checkAnswer({ ...plain, options: [{ id: 'A' }] }, { pictures: [name] }), /Pick one/);
  assert.throws(() => checkAnswer(plain, { pictures: ['../x.jpg'] }), /picture names/);
  assert.throws(() => checkAnswer(plain, { pictures: [name, name] }), /picture names/);
  assert.throws(() => checkAnswer(plain, { pictures: Array.from({ length: 5 }, (_, i) => `answer.pic-20261106T10111212${i}Z-ab12.jpg`) }), /picture names/);
  assert.throws(() => checkAnswer({ allowNote: true, rerun: { request: 'r' } }, { note: 'x', pictures: [name] }), /no pictures/);
});

test('an Ask: save pictures, see them pending, take one back, answer naming the kept ones, and the rest are deleted', async () => {
  const { fake, seed, get, post, close } = await fixture();
  try {
    const ask = askJson({ id: askId('pics'), now: NOW });
    seed.ask(ask);
    const first = await post(`/hub/asks/${ask.id}/files`, { image: picture() });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.match(first.body.file, ANSWER_PICTURE_RE);
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await post(`/hub/asks/${ask.id}/files`, { image: picture(jpeg(8, 6, { exif: false }), 'image/jpeg') });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(fake.objects.get(`sections/inbox/asks/${ask.id}/${second.body.file}`).contentType, 'image/jpeg');
    await new Promise(resolve => setTimeout(resolve, 5));
    const third = await post(`/hub/asks/${ask.id}/files`, { image: picture() });
    assert.deepEqual((await get(`/hub/asks/${ask.id}`)).body.pendingPictures, [first.body.file, second.body.file, third.body.file].sort());

    const gone = await post(`/hub/asks/${ask.id}/files/${encodeURIComponent(first.body.file)}/delete`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.ok(!names(fake, ask.id).includes(first.body.file));
    // A picture named in the answer must exist: nothing is written when one is gone.
    const missing = await post(`/hub/asks/${ask.id}/answer`, { note: 'see', pictures: [first.body.file, second.body.file] });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /A picture is gone/);
    assert.equal(fake.text(`sections/inbox/asks/${ask.id}/answer.json`), null, 'A refused answer writes nothing.');

    const answered = await post(`/hub/asks/${ask.id}/answer`, { note: 'see', pictures: [second.body.file] });
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    assert.deepEqual(answered.body.answer.pictures, [second.body.file]);
    assert.deepEqual(JSON.parse(fake.text(`sections/inbox/asks/${ask.id}/answer.json`)).pictures, [second.body.file]);
    assert.deepEqual(names(fake, ask.id).filter(name => ANSWER_PICTURE_RE.test(name)), [second.body.file], 'The picture the answer does not name is deleted.');
    const detail = (await get(`/hub/asks/${ask.id}`)).body;
    assert.equal(detail.pendingPictures, undefined, 'Nothing is pending once answered.');
    // Answered: no more files in, none out.
    assert.equal((await post(`/hub/asks/${ask.id}/files`, { image: picture() })).status, 409);
    assert.equal((await post(`/hub/asks/${ask.id}/files/${encodeURIComponent(second.body.file)}/delete`)).status, 409);
    // The file is served to the signed-in app.
    const served = await get(`/hub/file?path=${encodeURIComponent(`asks/${ask.id}/${second.body.file}`)}`);
    assert.equal(served.status, 200);
  } finally { await close(); }
});

test('an Ask: the fifth picture is refused, a non-picture is refused, and an Ask that cannot take pictures refuses them', async () => {
  const { seed, post, close } = await fixture();
  try {
    const ask = askJson({ id: askId('limit', 'b1c2'), now: NOW });
    seed.ask(ask);
    for (let at = 0; at < 4; at += 1) {
      assert.equal((await post(`/hub/asks/${ask.id}/files`, { image: picture() })).status, 201);
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    const fifth = await post(`/hub/asks/${ask.id}/files`, { image: picture() });
    assert.equal(fifth.status, 409);
    assert.match(fifth.body.error, /at most 4 pictures/);
    const text = await post(`/hub/asks/${ask.id}/files`, { image: { type: 'image/png', data: b64(Buffer.from('not a picture')) } });
    assert.equal(text.status, 415);
    const rerun = askJson({ id: askId('rerun', 'c2d3'), now: NOW });
    seed.ask({ ...rerun, rerun: { request: 'r', kind: 'continue' } });
    const refused = await post(`/hub/asks/${rerun.id}/files`, { image: picture() });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /takes no pictures/);
    assert.equal((await post(`/hub/asks/nope/files`, { image: picture() })).status, 404);
    assert.equal((await post(`/hub/asks/${ask.id}/files/${encodeURIComponent('answer.json')}/delete`)).status, 400, 'Only a picture name can be deleted.');
  } finally { await close(); }
});

test('an answer names only pictures of the answer: an evidence file is refused', async () => {
  const { seed, post, close } = await fixture();
  try {
    const ask = askJson({ id: askId('names', 'd3e4'), now: NOW, options: threeOptions() });
    seed.ask(ask);
    const bad = await post(`/hub/asks/${ask.id}/answer`, { choice: 'A', pictures: ['evidence-01-20261106T101112123Z-ab12.jpg'] });
    assert.equal(bad.status, 400);
  } finally { await close(); }
});

test('a checklist: note pictures are stored apart from the steps and the screenshots, named by the submission, and the rest deleted', async () => {
  const { fake, seed, get, post, close } = await fixture();
  try {
    const list = checklistJson({ id: askId('note', 'e4f5'), now: NOW });
    seed.checklist(list);
    const step = await post(`/hub/checklists/${list.id}/files`, { for: '01', image: picture() });
    assert.equal(step.status, 201);
    await new Promise(resolve => setTimeout(resolve, 5));
    const note1 = await post(`/hub/checklists/${list.id}/files`, { for: 'note', image: picture() });
    assert.equal(note1.status, 201, JSON.stringify(note1.body));
    assert.match(note1.body.file, NOTE_SHOT_RE);
    await new Promise(resolve => setTimeout(resolve, 5));
    const note2 = await post(`/hub/checklists/${list.id}/files`, { for: 'note', image: picture() });
    const detail = (await get(`/hub/checklists/${list.id}`)).body;
    assert.deepEqual(detail.notePictures, [note1.body.file, note2.body.file].sort());
    assert.deepEqual(detail.shots, [], 'Note pictures are not playtest screenshots.');
    assert.deepEqual(detail.evidenceFiles, { '01': [step.body.file] });
    assert.equal((await get(`/hub/file?path=${encodeURIComponent(`checklists/${list.id}/${note1.body.file}`)}`)).status, 200);

    // Take one back, then submit with the other named; a picture named but gone is a 400 with nothing written.
    assert.equal((await post(`/hub/checklists/${list.id}/files/${encodeURIComponent(note2.body.file)}/delete`)).status, 200);
    const missing = await post(`/hub/checklists/${list.id}/submit`, { note: 'x', pictures: [note2.body.file] });
    assert.equal(missing.status, 400);
    assert.equal(fake.text(`sections/inbox/checklists/${list.id}/submit.json`), null);
    const stray = await post(`/hub/checklists/${list.id}/files`, { for: 'note', image: picture() });
    const sent = await post(`/hub/checklists/${list.id}/submit`, { note: 'x', pictures: [note1.body.file] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.submit.pictures, [note1.body.file]);
    assert.deepEqual(names(fake, list.id, 'checklists').filter(name => NOTE_SHOT_RE.test(name)), [note1.body.file], `The stray ${stray.body.file} is deleted.`);
    assert.equal((await post(`/hub/checklists/${list.id}/files/${encodeURIComponent(note1.body.file)}/delete`)).status, 409, 'A submitted list cannot lose a picture.');
    assert.equal((await post(`/hub/checklists/${list.id}/files`, { for: 'note', image: picture() })).status, 409);
  } finally { await close(); }
});

test('a checklist: a note takes at most 4 pictures, and a delete takes only a picture name', async () => {
  const { seed, post, close } = await fixture();
  try {
    const list = checklistJson({ id: askId('notemax', 'f5a6'), now: NOW });
    seed.checklist(list);
    for (let at = 0; at < 4; at += 1) {
      assert.equal((await post(`/hub/checklists/${list.id}/files`, { for: 'note', image: picture() })).status, 201);
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    assert.equal((await post(`/hub/checklists/${list.id}/files`, { for: 'note', image: picture() })).status, 409);
    assert.equal((await post(`/hub/checklists/${list.id}/files/${encodeURIComponent('checklist.json')}/delete`)).status, 400);
    assert.equal((await post(`/hub/checklists/${list.id}/files`, { for: 'other', image: picture() })).status, 400);
  } finally { await close(); }
});
