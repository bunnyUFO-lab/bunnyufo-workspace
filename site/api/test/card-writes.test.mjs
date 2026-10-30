// Making cards by hand against a folder: what the local service does with card-writes.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { png } from './png.mjs';
import { capRetired, cardWriter, folderStore, md5, slug } from '../card-writes.mjs';

async function workspace(entities = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-card-writes-'));
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify({ name: 'Mine', entities }, null, 2));
  const writer = cardWriter(folderStore(root), { now: () => new Date('2026-10-23T10:00:00Z') });
  const list = async () => JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8'));
  const read = file => readFile(path.join(root, ...file.split('/')), 'utf8');
  return { root, writer, list, read };
}

test('a title becomes an id and a folder name', () => {
  assert.equal(slug('Combat Notes!'), 'combat-notes');
  assert.equal(slug('  Café  Ideas '), 'cafe-ideas');
  assert.equal(slug('???'), '');
});

test('a new card is a dated folder with one Markdown section, and the card list names it', async () => {
  const { writer, list, read } = await workspace([{ id: 'notes', folder: 'old_notes', title: 'Notes', steps: [] }]);
  const card = await writer.createCard({ title: 'Notes', description: 'Ideas for the boss fight.' });
  assert.equal(card.id, 'notes-2', 'An id already taken gets a number.');
  assert.equal(card.folder, '2026-10-23_notes-2');
  assert.deepEqual(card.steps, [{ name: 'Overview', path: 'index.md' }]);
  assert.equal(card.created, '2026-10-23');
  assert.equal(await read('2026-10-23_notes-2/index.md'), '# Notes\n\nIdeas for the boss fight.\n');
  const stored = await list();
  assert.equal(stored.name, 'Mine', 'The rest of the card list is kept.');
  assert.deepEqual(stored.entities.map(item => item.id), ['notes', 'notes-2']);
  await assert.rejects(writer.createCard({ title: '   ' }), /needs a title/);
});

test('a section is a new Markdown file and a tab; renaming changes only the tab', async () => {
  const { writer, list, read } = await workspace();
  const card = await writer.createCard({ title: 'Level ideas' });
  const first = await writer.addSection({ id: card.id, name: 'Enemies' });
  const second = await writer.addSection({ id: card.id, name: 'Enemies' });
  assert.equal(first.path, 'enemies.md');
  assert.equal(second.path, 'enemies-2.md', 'Two sections of one name get two files.');
  assert.equal(await read(`${card.folder}/enemies.md`), '# Enemies\n\n');
  await writer.renameSection({ id: card.id, index: 1, name: 'Bosses' });
  const steps = (await list()).entities[0].steps;
  assert.deepEqual(steps.map(step => [step.name, step.path]), [['Overview', 'index.md'], ['Bosses', 'enemies.md'], ['Enemies', 'enemies-2.md']]);
  await assert.rejects(writer.addSection({ id: 'nope', name: 'x' }), /No card/);
});

test('a save names the version it started from, and one made over a newer version is refused with it', async () => {
  const { writer, read } = await workspace();
  const card = await writer.createCard({ title: 'Plan' });
  const opened = await writer.readMarkdown({ id: card.id, path: 'index.md' });
  assert.equal(opened.etag, md5('# Plan\n\n'));
  const saved = await writer.saveMarkdown({ id: card.id, path: 'index.md', text: '# Plan\n\nStep one.\n', base: opened.etag });
  assert.equal(await read(`${card.folder}/index.md`), '# Plan\n\nStep one.\n');
  // A second editor still holding the first version.
  await assert.rejects(writer.saveMarkdown({ id: card.id, path: 'index.md', text: '# Mine\n', base: opened.etag }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.current.text, '# Plan\n\nStep one.\n', 'The refusal carries what is there now.');
    assert.equal(error.current.etag, saved.etag);
    return true;
  });
  assert.equal(await read(`${card.folder}/index.md`), '# Plan\n\nStep one.\n', 'Nothing was overwritten.');
  await assert.rejects(writer.saveMarkdown({ id: card.id, path: 'other.md', text: 'x', base: null }), /no section/);
});

test('the title and description of a card can be changed; its id and folder stay', async () => {
  const { writer, list } = await workspace();
  const card = await writer.createCard({ title: 'Draft', description: 'Old line' });
  await writer.updateCard({ id: card.id, title: 'Final', description: '' });
  const stored = (await list()).entities[0];
  assert.equal(stored.title, 'Final');
  assert.equal(stored.description, undefined);
  assert.equal(stored.id, card.id);
  assert.equal(stored.folder, card.folder);
});

const scene = (elements = []) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} });

test('a drawing section starts empty, and its name skips a picture already in the folder', async () => {
  const { writer, list, read, root } = await workspace();
  const card = await writer.createCard({ title: 'Sketches' });
  await writeFile(path.join(root, card.folder, 'drawing.png'), png(10, 10));
  const first = await writer.addSection({ id: card.id, name: 'Drawing', kind: 'drawing' });
  assert.equal(first.path, 'drawing-2.excalidraw', 'drawing.png is in the folder, so drawing.excalidraw would pair with it.');
  assert.deepEqual(JSON.parse(await read(`${card.folder}/drawing-2.excalidraw`)), {
    type: 'excalidraw', version: 2, source: 'bunnyufo-workspace', elements: [], appState: {}, files: {},
  });
  const second = await writer.addSection({ id: card.id, name: 'Drawing', kind: 'drawing' });
  assert.equal(second.path, 'drawing-3.excalidraw');
  assert.deepEqual((await list()).entities[0].steps.map(step => step.path), ['index.md', 'drawing-2.excalidraw', 'drawing-3.excalidraw']);
  const note = await writer.addSection({ id: card.id, name: 'Drawing 2' });
  assert.equal(note.path, 'drawing-2-2.md', 'A Markdown section of a taken name still gets a free name.');
  await assert.rejects(writer.addSection({ id: card.id, name: 'x', kind: 'video' }), /Markdown or a drawing/);
});

test('a drawing is saved with its picture beside it, and a stale save is refused with what is there', async () => {
  const { writer, read, root } = await workspace();
  const card = await writer.createCard({ title: 'Sketches' });
  const { path: file } = await writer.addSection({ id: card.id, name: 'Door', kind: 'drawing' });
  const opened = await writer.readDrawing({ id: card.id, path: file });
  const first = scene([{ type: 'rectangle', id: 'a' }]);
  const saved = await writer.saveDrawing({ id: card.id, path: file, scene: first, png: png(100, 50, 20).toString('base64'), base: opened.etag });
  assert.equal(saved.etag, md5(first));
  assert.equal(await read(`${card.folder}/door.excalidraw`), first);
  const picture = await readFile(path.join(root, card.folder, 'door.png'));
  assert.equal(saved.png, md5(picture));
  assert.equal(picture.readUInt32BE(16), 100);
  assert.equal((await writer.readDrawing({ id: card.id, path: file })).etag, saved.etag, 'Reading again gives the etag the next save names.');

  await assert.rejects(writer.saveDrawing({ id: card.id, path: file, scene: scene(), png: png(5, 5).toString('base64'), base: opened.etag }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.current.text, first);
    assert.equal(error.current.etag, saved.etag);
    return true;
  });
  assert.equal(await read(`${card.folder}/door.excalidraw`), first, 'The refused scene was not written.');
  assert.equal((await readFile(path.join(root, card.folder, 'door.png'))).readUInt32BE(16), 100, 'Nor was its picture.');
});

test('a drawing save refuses what is not a drawing, not a PNG, or too big', async () => {
  const { writer } = await workspace();
  const card = await writer.createCard({ title: 'Sketches' });
  const { path: file } = await writer.addSection({ id: card.id, name: 'Door', kind: 'drawing' });
  const save = (extra = {}) => writer.saveDrawing({ id: card.id, path: file, scene: scene(), png: png(10, 10).toString('base64'), base: null, ...extra });
  await assert.rejects(save({ png: png(2049, 10).toString('base64') }), /larger than 2048 px/);
  await assert.rejects(save({ png: png(10, 2049).toString('base64') }), /larger than 2048 px/);
  await assert.rejects(save({ png: png(0, 10).toString('base64') }), /larger than 2048 px/);
  await assert.rejects(save({ png: Buffer.from('GIF89a not a picture at all').toString('base64') }), /not a PNG/);
  await assert.rejects(save({ png: png(10, 10, 6 * 1024 * 1024).toString('base64') }), error => error.status === 413);
  await assert.rejects(save({ scene: 'nope' }), /not valid JSON/);
  await assert.rejects(save({ scene: JSON.stringify({ type: 'other', elements: [] }) }), /not an Excalidraw/);
  await assert.rejects(save({ scene: JSON.stringify({ type: 'excalidraw', elements: {} }) }), /not an Excalidraw/);
  await assert.rejects(save({ scene: ' '.repeat(2 * 1024 * 1024 + 1) }), error => error.status === 413 && /2 MB/.test(error.message));
  await assert.rejects(writer.saveDrawing({ id: card.id, path: 'other.excalidraw', scene: scene(), png: png(1, 1).toString('base64') }), /no section/);
  await assert.rejects(writer.saveDrawing({ id: card.id, path: 'index.md', scene: scene(), png: png(1, 1).toString('base64') }), /Only drawing sections/);
});

test('annotating starts a drawing over a picture, beside it, and never touches the picture', async () => {
  const { writer, list, read, root } = await workspace();
  const card = await writer.createCard({ title: 'Takes' });
  await writer.addSection({ id: card.id, name: 'Notes' });
  await mkdir(path.join(root, card.folder, 'shots'), { recursive: true });
  const original = png(640, 480, 100);
  await writeFile(path.join(root, card.folder, 'shots', 'take-2b.png'), original);
  const before = md5(original);

  const first = await writer.annotate({ id: card.id, image: 'shots/take-2b.png', after: 0, width: 640, height: 480 });
  assert.equal(first.path, 'shots/take-2b.annotated.excalidraw');
  assert.equal(first.step, 1, 'The tab sits right after the one named.');
  const made = JSON.parse(await read(`${card.folder}/shots/take-2b.annotated.excalidraw`));
  assert.deepEqual(made.files, {});
  assert.deepEqual(made.elements[0], {
    type: 'image', id: 'buw-bg', x: 0, y: 0, width: 640, height: 480, locked: true,
    status: 'saved', fileId: 'buw:take-2b.png', scale: [1, 1], customData: { buwSrc: 'take-2b.png' },
  });
  assert.deepEqual((await list()).entities[0].steps.map(step => [step.name, step.path]), [
    ['Overview', 'index.md'], ['take-2b (annotated)', 'shots/take-2b.annotated.excalidraw'], ['Notes', 'notes.md'],
  ]);

  const second = await writer.annotate({ id: card.id, image: 'shots/take-2b.png', after: 99 });
  assert.equal(second.path, 'shots/take-2b.annotated-2.excalidraw', 'A second annotation does not replace the first.');
  assert.equal(second.step, 3, 'An index past the end appends.');
  assert.equal(JSON.parse(await read(`${card.folder}/shots/take-2b.annotated-2.excalidraw`)).elements[0].width, 1024, 'Missing sizes fall back.');

  await writeFile(path.join(root, card.folder, 'shots', 'take-2b.annotated-3.png'), png(1, 1));
  const third = await writer.annotate({ id: card.id, image: 'shots/take-2b.png', after: 0 });
  assert.equal(third.path, 'shots/take-2b.annotated-4.excalidraw', 'A picture already named -3 is skipped too.');

  assert.equal(md5(await readFile(path.join(root, card.folder, 'shots', 'take-2b.png'))), before, 'The original is untouched.');
  for (const image of ['../x.png', '/x.png', 'shots\\take-2b.png', 'shots/../shots/take-2b.png', 'notes.md']) {
    await assert.rejects(writer.annotate({ id: card.id, image }), error => error.status === 400, image);
  }
  await assert.rejects(writer.annotate({ id: card.id, image: 'missing.png' }), error => error.status === 404);
});

test('annotating again after the card list changed meanwhile leaves no scene without a tab', async () => {
  const { root, list } = await workspace();
  const inner = folderStore(root);
  let refused = 0;
  const store = { ...inner, write: async (file, text, options) => {
    if (file === 'workspace.json' && options?.ifMatch && refused-- > 0) throw Object.assign(new Error('changed'), { status: 412 });
    return inner.write(file, text, options);
  } };
  const writer = cardWriter(store, { now: () => new Date('2026-10-23T10:00:00Z') });
  const card = await writer.createCard({ title: 'Takes' });
  await writeFile(path.join(root, card.folder, 'take.png'), png(64, 48));
  refused = 1;
  const made = await writer.annotate({ id: card.id, image: 'take.png' });
  assert.equal(made.path, 'take.annotated.excalidraw', 'The retry reuses the scene it wrote, not a -2.');
  assert.deepEqual((await list()).entities[0].steps.map(step => step.path), ['index.md', 'take.annotated.excalidraw']);
  assert.equal(await store.exists(`${card.folder}/take.annotated-2.excalidraw`), false);
});

const three = async () => {
  const w = await workspace();
  const card = await w.writer.createCard({ title: 'Plan' });
  await w.writer.addSection({ id: card.id, name: 'B' });
  await w.writer.addSection({ id: card.id, name: 'C' });
  return { ...w, card };
};
const names = async list => (await list()).entities[0].steps.map(step => step.name);

test('a card can be given another category; an empty one becomes notes', async () => {
  const { writer, list } = await workspace([{ id: 'a', folder: 'a', title: 'A', category: 'brief', steps: [] }]);
  await writer.updateCard({ id: 'a', category: 'Game Ideas' });
  assert.equal((await list()).entities[0].category, 'game-ideas');
  await writer.updateCard({ id: 'a', category: '' });
  assert.equal((await list()).entities[0].category, 'notes');
});

test('renaming a category rewrites every card in it, counts a merge, and refuses a no-op or an empty one', async () => {
  const entities = [
    { id: 'a', folder: 'a', category: 'brief', steps: [] }, { id: 'b', folder: 'b', category: 'brief', steps: [] },
    { id: 'c', folder: 'c', category: 'spend', steps: [] }, { id: 'd', folder: 'd', steps: [] },
  ];
  const { writer, list } = await workspace(entities);
  assert.deepEqual(await writer.renameCategory({ from: 'brief', to: 'Briefs' }), { from: 'brief', to: 'briefs', count: 2, merged: false });
  assert.deepEqual((await list()).entities.map(item => item.category), ['briefs', 'briefs', 'spend', undefined]);
  assert.deepEqual(await writer.renameCategory({ from: 'briefs', to: 'spend' }), { from: 'briefs', to: 'spend', count: 2, merged: true });
  assert.deepEqual(await writer.renameCategory({ from: 'other', to: 'misc' }), { from: 'other', to: 'misc', count: 1, merged: false });
  await assert.rejects(writer.renameCategory({ from: 'spend', to: 'spend' }), { status: 400 });
  await assert.rejects(writer.renameCategory({ from: 'spend', to: '??' }), { status: 400 });
  await assert.rejects(writer.renameCategory({ from: 'nothing', to: 'x' }), { status: 404 });
});

test('a tab moves, defaultStep follows its tab, and a bad index is a 404', async () => {
  const { writer, list, card, root } = await three();
  await writer.moveSection({ id: card.id, from: 0, to: 2 });
  assert.deepEqual(await names(list), ['B', 'C', 'Overview']);
  const stored = await list();
  stored.entities[0].defaultStep = 2;
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify(stored));
  await writer.moveSection({ id: card.id, from: 2, to: 0 });
  assert.deepEqual(await names(list), ['Overview', 'B', 'C']);
  assert.equal((await list()).entities[0].defaultStep, 0, 'The default tab is still Overview.');
  await assert.rejects(writer.moveSection({ id: card.id, from: 0, to: 9 }), { status: 404 });
});

test('a deleted tab keeps its file, goes to removedTabs, fixes defaultStep, and comes back where it was', async () => {
  const { writer, list, read, card, root } = await three();
  const stored = await list();
  stored.entities[0].defaultStep = 2;
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify(stored));
  const gone = await writer.deleteSection({ id: card.id, index: 1, path: 'b.md' });
  assert.equal(gone.removed.name, 'B');
  assert.deepEqual(await names(list), ['Overview', 'C']);
  const after = (await list()).entities[0];
  assert.equal(after.defaultStep, 1, 'The default tab is still C.');
  assert.equal(after.removedTabs.length, 1);
  assert.equal(await read(`${card.folder}/b.md`), '# B\n\n', 'The file stays.');
  const back = await writer.restoreSection({ id: card.id, path: 'b.md' });
  assert.equal(back.step, 1);
  assert.deepEqual(await names(list), ['Overview', 'B', 'C']);
  const restored = (await list()).entities[0];
  assert.equal(restored.defaultStep, 2);
  assert.equal(restored.removedTabs, undefined);
  await assert.rejects(writer.restoreSection({ id: card.id, path: 'b.md' }), { status: 404 });
});

test('a tab delete with a stale index or path is a 409, the last tab is refused, a restore over a returned file is a 409', async () => {
  const { writer, list, card, root } = await three();
  await assert.rejects(writer.deleteSection({ id: card.id, index: 1, path: 'c.md' }), { status: 409 });
  await assert.rejects(writer.deleteSection({ id: card.id, index: 7, path: 'c.md' }), { status: 404 });
  assert.deepEqual(await names(list), ['Overview', 'B', 'C']);
  await writer.deleteSection({ id: card.id, index: 2, path: 'c.md' });
  await writer.deleteSection({ id: card.id, index: 1, path: 'b.md' });
  await assert.rejects(writer.deleteSection({ id: card.id, index: 0, path: 'index.md' }), { status: 409, message: /Delete the card instead/ });
  const stored = await list();
  stored.entities[0].steps.push({ name: 'C again', path: 'c.md' });
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify(stored));
  await assert.rejects(writer.restoreSection({ id: card.id, path: 'c.md' }), { status: 409 });
});

test('removedTabs keeps the newest 50', async () => {
  const steps = [{ name: 'Keep', path: 'keep.md' }, ...Array.from({ length: 55 }, (_, n) => ({ name: `T${n}`, path: `t${n}.md` }))];
  const { writer, list } = await workspace([{ id: 'x', folder: 'x', title: 'X', steps }]);
  for (let n = 0; n < 55; n += 1) await writer.deleteSection({ id: 'x', index: 1, path: `t${n}.md` });
  const kept = (await list()).entities[0].removedTabs;
  assert.equal(kept.length, 50);
  assert.equal(kept[0].path, 't5.md');
  assert.equal(kept.at(-1).path, 't54.md');
});

test('a deleted card goes to the Trash with its whole entity, and Restore puts it back', async () => {
  const { writer, list, read } = await workspace();
  const card = await writer.createCard({ title: 'Old brief', category: 'brief' });
  await writer.createCard({ title: 'Other' });
  const gone = await writer.deleteCard({ id: card.id });
  assert.equal(gone.retired.kind, 'deleted');
  const stored = await list();
  assert.deepEqual(stored.entities.map(item => item.id), ['other']);
  assert.deepEqual(stored.retired[card.id].entity, card);
  assert.equal(stored.retired[card.id].at, '2026-10-23');
  assert.equal(await read(`${card.folder}/index.md`), '# Old brief\n\n', 'The files stay.');
  const back = await writer.restoreCard({ id: card.id });
  assert.deepEqual(back.card.steps, card.steps);
  const after = await list();
  assert.deepEqual(after.entities.map(item => item.id), ['other', 'old-brief']);
  assert.equal(after.retired, undefined);
  await assert.rejects(writer.restoreCard({ id: card.id }), { status: 404 });
  await assert.rejects(writer.deleteCard({ id: 'nope' }), { status: 404 });
});

test('Restore is refused when the id or the folder came back meanwhile', async () => {
  const { writer, list, root } = await workspace();
  const card = await writer.createCard({ title: 'Plan' });
  await writer.deleteCard({ id: card.id });
  const put = async entity => {
    const stored = await list();
    stored.entities = [entity];
    await writeFile(path.join(root, 'workspace.json'), JSON.stringify(stored));
  };
  await put({ id: 'plan', folder: 'elsewhere', steps: [] });
  await assert.rejects(writer.restoreCard({ id: card.id }), { status: 409, message: /id or folder/ });
  await put({ id: 'renamed', folder: card.folder, steps: [] });
  await assert.rejects(writer.restoreCard({ id: card.id }), { status: 409 });
  await put({ id: 'free', folder: 'free', steps: [] });
  assert.equal((await writer.restoreCard({ id: card.id })).card.id, 'plan');
});

test('retired is capped at 500: moved records go first, deleted ones never', () => {
  const retired = {};
  for (let n = 0; n < 3; n += 1) retired[`d${n}`] = { kind: 'deleted' };
  for (let n = 0; n < 501; n += 1) retired[`m${n}`] = { kind: 'moved' };
  capRetired(retired);
  assert.equal(Object.keys(retired).length, 500);
  assert.ok(retired.d0 && retired.d2);
  assert.equal(retired.m3, undefined);
  assert.ok(retired.m4);
  const onlyDeleted = Object.fromEntries(Array.from({ length: 502 }, (_, n) => [`d${n}`, { kind: 'deleted' }]));
  assert.equal(Object.keys(capRetired(onlyDeleted)).length, 502);
});
