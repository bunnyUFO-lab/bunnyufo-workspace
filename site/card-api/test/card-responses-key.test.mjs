// The card API still takes the card-responses key (the card bridge writes the same key through the site API)
// and refuses a path whose first segment starts with an underscore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBucket } from '../../api/s3.mjs';
import { startFakeS3 } from '../../api/test/fake-s3.mjs';
import { createCardApi, parseTokens } from '../handler.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');

test('the card API takes the card-responses key and refuses a leading underscore', async () => {
  const fake = await startFakeS3();
  try {
    fake.seed('sections/games/workspace.json', JSON.stringify({ entities: [{ id: 'sounds', folder: 'sounds', steps: [] }] }), 'application/json');
    const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
    const api = createCardApi({ bucket, tokens: parseTokens(`owner=${sha('p')}`) });
    const call = (method, rawPath, body) => api({ requestContext: { http: { method } }, rawPath, headers: { authorization: 'Bearer p' }, body });
    assert.equal((await call('PUT', '/sections/games/files/card-responses/sounds/t.json', '{}')).statusCode, 200);
    assert.equal((await call('GET', '/sections/games/files/card-responses/sounds/t.json')).statusCode, 200);
    assert.equal((await call('DELETE', '/sections/games/files/card-responses/sounds/t.json')).statusCode, 200);
    assert.equal((await call('PUT', '/sections/games/files/_responses/sounds/t.json', '{}')).statusCode, 400);
  } finally { await fake.close(); }
});
