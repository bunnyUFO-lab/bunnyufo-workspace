import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { isBadPort, listenOnGoodPort } from '../listen.mjs';

// A server that hands out the given ports in turn, as the OS would for port 0.
function stubServer(ports) {
  const server = new EventEmitter();
  let current = 0;
  server.closed = 0;
  server.listen = (port, host, done) => { assert.equal(port, 0); current = ports.shift(); setImmediate(done); return server; };
  server.address = () => ({ port: current });
  server.close = done => { server.closed++; setImmediate(done); return server; };
  return server;
}

test('the bad-port list is the Fetch standard list', () => {
  for (const port of [1, 22, 25, 4190, 5060, 5061, 6000, 6566, 6665, 6669, 6697, 10080]) assert.ok(isBadPort(port), String(port));
  for (const port of [80, 443, 3000, 5173, 8080, 49152]) assert.ok(!isBadPort(port), String(port));
});

test('a bad port is closed and the server listens again', async () => {
  const server = stubServer([5060, 6000, 41234]);
  const got = await listenOnGoodPort(server, '127.0.0.1');
  assert.deepEqual(got, { server, port: 41234 });
  assert.equal(server.closed, 2);
});

test('a good port is kept at once', async () => {
  const server = stubServer([41235]);
  const got = await listenOnGoodPort(server);
  assert.equal(got.port, 41235);
  assert.equal(server.closed, 0);
});

test('it gives up when every try lands on a bad port', async () => {
  const server = stubServer([5060, 5061, 6000]);
  await assert.rejects(listenOnGoodPort(server, '127.0.0.1', { tries: 3 }), /browser refuses 3 times/);
});

test('a real server ends up listening on a port a browser accepts', async () => {
  const server = createServer((request, response) => response.end('ok'));
  const { port } = await listenOnGoodPort(server, '127.0.0.1');
  try {
    assert.ok(!isBadPort(port));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
