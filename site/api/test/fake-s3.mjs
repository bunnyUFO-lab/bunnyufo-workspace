// A stand-in S3 for the tests: one bucket in memory, path-style (/<bucket>/<key>), speaking
// just enough of the REST API for s3.mjs — GET, HEAD, PUT (with If-Match / If-None-Match),
// DELETE and ListObjectsV2 with prefix, delimiter and continuation. Signatures are not checked.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function startFakeS3({ bucket = 'test-bucket', maxKeys = 1000 } = {}) {
  /** key -> { body: Buffer, etag, contentType, lastModified } */
  const objects = new Map();
  const log = [];
  const error = (response, status, code, message = code) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`;
    response.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(xml) });
    response.end(xml);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake');
    const [, name, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    log.push({ method: request.method, key, headers: request.headers });
    if (name !== bucket) return error(response, 404, 'NoSuchBucket');

    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const delimiter = url.searchParams.get('delimiter') || '';
      const after = url.searchParams.get('continuation-token') || '';
      const limit = Number(url.searchParams.get('max-keys')) || maxKeys;
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && k > after).sort();
      const contents = [];
      const prefixes = new Set();
      let last = '';
      let truncated = false;
      for (const k of keys) {
        if (contents.length + prefixes.size >= limit) { truncated = true; break; }
        const restOfKey = k.slice(prefix.length);
        const cut = delimiter ? restOfKey.indexOf(delimiter) : -1;
        if (cut >= 0) prefixes.add(prefix + restOfKey.slice(0, cut + delimiter.length));
        else contents.push(k);
        last = k;
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${escapeXml(last)}</NextContinuationToken>` : ''}${contents.map(k => { const o = objects.get(k); return `<Contents><Key>${escapeXml(k)}</Key><LastModified>${o.lastModified}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size></Contents>`; }).join('')}${[...prefixes].map(p => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`;
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      return response.end(xml);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = objects.get(key);
      if (!object) return error(response, 404, 'NoSuchKey', 'The specified key does not exist.');
      const headers = { 'Content-Type': object.contentType, 'Content-Length': object.body.length, ETag: `"${object.etag}"`, 'Last-Modified': object.lastModified };
      if (request.headers['if-none-match'] === `"${object.etag}"`) { response.writeHead(304, headers); return response.end(); }
      response.writeHead(200, headers);
      return response.end(request.method === 'HEAD' ? undefined : object.body);
    }

    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const existing = objects.get(key);
      const ifMatch = request.headers['if-match'];
      const ifNoneMatch = request.headers['if-none-match'];
      if (ifMatch && (!existing || `"${existing.etag}"` !== ifMatch)) return error(response, 412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
      if (ifNoneMatch === '*' && existing) return error(response, 412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
      const etag = createHash('md5').update(body).digest('hex');
      objects.set(key, { body, etag, contentType: request.headers['content-type'] || 'binary/octet-stream', lastModified: new Date().toUTCString() });
      response.writeHead(200, { ETag: `"${etag}"`, 'Content-Length': 0 });
      return response.end();
    }

    if (request.method === 'DELETE') {
      objects.delete(key);
      response.writeHead(204);
      return response.end();
    }
    error(response, 405, 'MethodNotAllowed');
  });
  // Longer than the client's pool keeps an idle connection, so a test that pauses never reuses one this end just closed.
  server.keepAliveTimeout = 30_000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    bucket, endpoint, objects, log,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    /** The text of one object, or null. */
    text: key => objects.get(key)?.body.toString('utf8') ?? null,
    json: key => { const text = objects.get(key)?.body.toString('utf8'); return text === undefined ? null : JSON.parse(text); },
    /** Seed an object straight into the store. */
    seed(key, body, contentType = 'application/octet-stream') {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      objects.set(key, { body: buffer, etag: createHash('md5').update(buffer).digest('hex'), contentType, lastModified: new Date().toUTCString() });
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
