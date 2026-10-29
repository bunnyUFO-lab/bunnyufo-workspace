// A stand-in for Hermes's OpenAI-compatible API server.
//   const hermes = await startFakeHermes({ key: 'k', onTurn: async body => { …make Hermes file a request… } })
//   hermes.url, hermes.requests (the chat bodies it saw), hermes.state.closedEarly, hermes.close()
// `refuseImages: true` answers 400 with an OpenAI-style error body when any message has an image_url part.
// `fail: true` answers 500 on both routes; `hold: true` stalls after the first chunk (for an abort test).
import { createServer } from 'node:http';

export async function startFakeHermes({ key = 'test-key', chunks = ['Hel', 'lo ', 'there'], delayMs = 20, onTurn, fail = false, hold = false, refuseImages = false } = {}) {
  const requests = [];
  const state = { closedEarly: 0 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const server = createServer(async (request, response) => {
    const incoming = [];
    for await (const chunk of request) incoming.push(chunk);
    const raw = Buffer.concat(incoming);
    if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401); return response.end('{"error":"bad key"}'); }
    if (fail) { response.writeHead(500); return response.end('{"error":"boom"}'); }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const body = JSON.parse(raw.toString('utf8'));
      if (body.stream !== true) { response.writeHead(400); return response.end('{"error":"stream must be true"}'); }
      requests.push(body);
      if (refuseImages && body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'This model does not accept images.', code: 'unsupported_content_type' } }));
      }
      response.on('close', () => { if (!response.writableFinished) state.closedEarly += 1; });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = data => response.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      for (const [index, text] of chunks.entries()) {
        if (index === chunks.length - 1) await onTurn?.(body);
        if (response.destroyed) return undefined;
        send({ choices: [{ delta: { content: text } }] });
        await sleep(delayMs);
        if (hold && index === 0) await sleep(30_000);
      }
      send('[DONE]');
      return response.end();
    }
    response.writeHead(404);
    return response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, state,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
