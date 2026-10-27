import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Files } from '../files.mjs';

await mkdir(path.resolve('.cache'), { recursive: true });

test('Markdown saves preserve Unicode, keep a recovery copy, and reject stale or concurrent writes', async () => {
  const repo = await mkdtemp(path.resolve('.cache/markdown-'));
  const file = path.join(repo, 'notes.md'), files = new Files(repo);
  await writeFile(file, '# Notes\n\nРусский текст 🐽\n');
  const preview = await files.preview(file);
  const changed = await files.saveMarkdown({ path: file, text: '# New notes\n\n**Текст** 🐽\n', revision: preview.revision });
  assert.match(changed.text, /\*\*Текст\*\* 🐽/);
  assert.notEqual(preview.revision, changed.revision);
  const backups = await readdir(path.join(repo, '.buw/markdown-backups'));
  assert.equal(await readFile(path.join(repo, '.buw/markdown-backups', backups.find(name => name.endsWith('.md'))), 'utf8'), preview.text);
  await assert.rejects(files.saveMarkdown({ path: file, text: 'stale', revision: preview.revision }), /changed on disk/);
  assert.equal(await readFile(file, 'utf8'), changed.text);
  const racing = await Promise.allSettled(['first', 'second'].map(text => files.saveMarkdown({ path: file, text, revision: changed.revision })));
  assert.equal(racing.filter(value => value.status === 'fulfilled').length, 1);
  await writeFile(path.join(repo, 'script.js'), 'original');
  await assert.rejects(files.saveMarkdown({ path: path.join(repo, 'script.js'), text: 'changed', revision: changed.revision }), /Markdown/);
  await assert.rejects(files.saveMarkdown({ path: file, text: 'a'.repeat(2 * 1024 * 1024 + 1), revision: changed.revision }), /2 MB/);
  assert.equal(await readFile(path.join(repo, 'script.js'), 'utf8'), 'original');
});

test('HTML pages save through the same guarded write, with their own recovery copy', async () => {
  const repo = await mkdtemp(path.resolve('.cache/html-'));
  const file = path.join(repo, 'report.html'), files = new Files(repo);
  await writeFile(file, '<!doctype html><html><body><h1>Old</h1></body></html>');
  const source = await files.source(file);
  assert.match(source.text, /<h1>Old<\/h1>/);
  const saved = await files.saveMarkdown({ path: file, text: '<!doctype html><html><body><h1>New</h1></body></html>', revision: source.revision });
  assert.match(saved.text, /<h1>New<\/h1>/);
  const backups = await readdir(path.join(repo, '.buw/html-backups'));
  assert.equal(await readFile(path.join(repo, '.buw/html-backups', backups.find(name => name.endsWith('.html'))), 'utf8'), source.text);
  await assert.rejects(files.saveMarkdown({ path: file, text: 'stale', revision: source.revision }), /changed on disk/);
  await writeFile(path.join(repo, 'app.js'), 'x');
  await assert.rejects(files.source(path.join(repo, 'app.js')), /Markdown and HTML/);
});

test('Main folders expose local Claude and Codex skills alongside knowledge and processes', async () => {
  const repo = await mkdtemp(path.resolve('.cache/skill-folders-'));
  for (const folder of ['.claude/skills', '.agents/skills', 'knowledge', 'processes', 'context', 'inbox', 'projects', 'workspace', 'node_modules']) await mkdir(path.join(repo, folder), { recursive: true });
  const result = await new Files(repo).list();
  assert.deepEqual(result.entries.map(item => item.name).sort(), ['Claude skills', 'Codex skills', 'context', 'inbox', 'knowledge', 'processes', 'projects', 'workspace']);
  assert.ok(result.entries.every(entry => entry.directory && path.isAbsolute(entry.path)));
});
