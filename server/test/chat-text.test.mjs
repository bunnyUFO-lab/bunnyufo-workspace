// How a chat shows text: fenced blocks in the owner's message, and line breaks kept in a reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { remarkBreaks, splitFences } from '../../src/hub/chatText.ts';

test('an owner message with a fenced block is text, code, text', () => {
  const text = 'Step 01 failed.\n\nIs this right?\n```\nPS C:\\x> git pull\nYou are not currently on a branch.\n```\nThanks';
  assert.deepEqual(splitFences(text), [
    { kind: 'text', text: 'Step 01 failed.\n\nIs this right?' },
    { kind: 'code', lang: '', code: 'PS C:\\x> git pull\nYou are not currently on a branch.' },
    { kind: 'text', text: 'Thanks' },
  ]);
});

test('the fence language is kept, CRLF is read, ~~~ fences and two blocks work', () => {
  assert.deepEqual(splitFences('```powershell\r\ncd C:\\x\r\ngit fetch\r\n```'), [{ kind: 'code', lang: 'powershell', code: 'cd C:\\x\ngit fetch' }]);
  assert.deepEqual(splitFences('a\n~~~bash\nls\n~~~\nb\n```\npwd\n```'), [
    { kind: 'text', text: 'a' }, { kind: 'code', lang: 'bash', code: 'ls' }, { kind: 'text', text: 'b' }, { kind: 'code', lang: '', code: 'pwd' },
  ]);
});

test('plain text, an unclosed fence and inline backticks stay text', () => {
  assert.deepEqual(splitFences('just words\non two lines'), [{ kind: 'text', text: 'just words\non two lines' }]);
  assert.deepEqual(splitFences('```\nnever closed'), [{ kind: 'text', text: '```\nnever closed' }]);
  assert.deepEqual(splitFences('run `git pull` here'), [{ kind: 'text', text: 'run `git pull` here' }]);
  assert.deepEqual(splitFences(''), [{ kind: 'text', text: '' }]);
});

test('remarkBreaks turns newlines in text into breaks and leaves code alone', () => {
  const tree = { type: 'root', children: [
    { type: 'paragraph', children: [{ type: 'text', value: 'For step 01, run:\ncd C:\\x\nclaude plugin list' }, { type: 'inlineCode', value: 'a\nb' }] },
    { type: 'code', value: 'one\ntwo' },
  ] };
  remarkBreaks()(tree);
  assert.deepEqual(tree.children[0].children, [
    { type: 'text', value: 'For step 01, run:' }, { type: 'break' }, { type: 'text', value: 'cd C:\\x' }, { type: 'break' }, { type: 'text', value: 'claude plugin list' },
    { type: 'inlineCode', value: 'a\nb' },
  ]);
  assert.deepEqual(tree.children[1], { type: 'code', value: 'one\ntwo' });
});
