// The address of an annotation's background picture, from the name the scene holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundUrl } from '../../src/lib/annotate.ts';

const scene = new URL('http://localhost/w/card/takes/take.annotated.excalidraw');

test('a picture name with # ? or % still resolves to that file beside the scene', () => {
  assert.equal(backgroundUrl('take 2#b?.png', scene).href, 'http://localhost/w/card/takes/take%202%23b%3F.png');
  assert.equal(backgroundUrl('100%.png', scene).href, 'http://localhost/w/card/takes/100%25.png');
  assert.equal(backgroundUrl('plain.png', scene).href, 'http://localhost/w/card/takes/plain.png');
  assert.equal(backgroundUrl('shots/a b.png', scene).href, 'http://localhost/w/card/takes/shots/a%20b.png');
});
