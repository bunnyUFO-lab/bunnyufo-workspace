// Which links in a chat reply become an "Open card" button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardLinkOf } from '../../src/hub/cardLink.ts';

const PAGE = 'https://hub.example.com/chat';

test('a card on this site is a button target, always as a relative address', () => {
  assert.deepEqual(cardLinkOf('/assistant#/some-card', PAGE), { href: '/assistant#/some-card', card: 'some-card' });
  assert.deepEqual(cardLinkOf('https://hub.example.com/assistant#/some-card', PAGE), { href: '/assistant#/some-card', card: 'some-card' });
  assert.deepEqual(cardLinkOf('/assistant#/some-card/2', PAGE), { href: '/assistant#/some-card/2', card: 'some-card' });
  assert.deepEqual(cardLinkOf('/assistant#/a%20b', PAGE), { href: '/assistant#/a%20b', card: 'a b' });
});

test('anything else is not', () => {
  for (const href of [
    'https://example.com/assistant#/x', '//example.com/assistant#/x', '/\example.com#/x',
    '/assistant', '/assistant?a=1#/x', 'https://u:p@hub.example.com/assistant#/x',
    '/#/~hub/chat', '/assistant#/~hub', '/assistant#/x/~o', '/assistant#/%zz',
    '/w#/x', '/api#/x', '/assets#/x', '/a/b#/x',
    'javascript:alert(1)', undefined,
  ]) assert.equal(cardLinkOf(href, PAGE), null, String(href));
});
