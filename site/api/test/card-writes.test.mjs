// Making cards by hand against a folder: what the local service does with card-writes.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { png } from './png.mjs';
import { cardWriter, folderStore, md5, slug } from '../card-writes.mjs';

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
