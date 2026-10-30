// A small S3 client: the five calls the Workspace needs, signed with SigV4 on node:crypto and
// sent with fetch. No SDK, because the site API container runs the files as they are rsynced
// (no npm install), the local service imports from here the way it imports card-state.mjs,
// and the publish script wants the same code path the server uses.
//
//   const bucket = createBucket({ bucket: 'my-cards', region: 'us-east-1' })
//   await bucket.put('sections/x/workspace.json', text, { contentType: 'application/json' })
//   const { body, etag, contentType } = await bucket.get('sections/x/index.md')   // body: a web stream
//   await bucket.list('sections/', { delimiter: '/' })   // { objects: [{ key, etag, size, lastModified }], prefixes }
//
// Credentials come from the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, with an
// optional AWS_SESSION_TOKEN), else from the profile in ~/.aws/credentials (AWS_PROFILE or
// default) — the same file the aws CLI reads, so a machine set up for one is set up for this.
//
// `endpoint` is for the tests' stand-in server (path-style, http://127.0.0.1:port). Against AWS
// the bucket is addressed virtual-hosted, https://<bucket>.s3.<region>.amazonaws.com.
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REGION = 'us-east-1';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
export const md5 = data => createHash('md5').update(data).digest('hex');

/** RFC 3986 encoding, which is what SigV4 wants: `encodeURIComponent` plus the characters it leaves. */
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = key => key.split('/').map(encode).join('/');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.excalidraw': 'application/json', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.pdf': 'application/pdf', '.py': 'text/x-python; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.xml': 'application/xml', '.zip': 'application/zip',
};
export const contentTypeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

/** Parse "s3://bucket/some/prefix" into { bucket, prefix } (prefix without a trailing slash). */
export function parseS3Url(value) {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { bucket: match[1], prefix: match[2].replace(/^\/+|\/+$/g, '') };
}

/**
 * A bucket client and the prefix inside it from a registry entry's `bucket` ("s3://name/sections/id").
 * Null when the value is not an s3:// URL.
 */
export function bucketFromUrl(value, options = {}) {
  const parsed = parseS3Url(value);
  if (!parsed) return null;
  return { client: createBucket({ bucket: parsed.bucket, ...options }), prefix: parsed.prefix, bucket: parsed.bucket };
}

/**
 * The credentials the aws CLI would use, or null. Read once per process: the file does not
 * change under a running service, and every publish is a fresh process anyway.
 */
let credentialsCache;
export async function loadCredentials(env = process.env) {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
  }
  if (credentialsCache !== undefined) return credentialsCache;
  const profile = env.AWS_PROFILE || 'default';
  const file = env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
  credentialsCache = null;
  try {
    let current = '';
    const values = {};
    for (const raw of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const section = /^\[(.+)\]$/.exec(line);
      if (section) { current = section[1].trim(); continue; }
      if (current !== profile) continue;
      const pair = /^([^=]+)=(.*)$/.exec(line);
      if (pair) values[pair[1].trim().toLowerCase()] = pair[2].trim();
    }
    if (values.aws_access_key_id && values.aws_secret_access_key) {
      credentialsCache = { accessKeyId: values.aws_access_key_id, secretAccessKey: values.aws_secret_access_key, sessionToken: values.aws_session_token || undefined };
    }
  } catch { /* no file: no credentials */ }
  return credentialsCache;
}

/** Which region the CLI would use, so a machine set up for `aws` needs nothing more. */
export async function loadRegion(env = process.env) {
  if (env.AWS_REGION || env.AWS_DEFAULT_REGION) return env.AWS_REGION || env.AWS_DEFAULT_REGION;
  const profile = env.AWS_PROFILE || 'default';
  const file = env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
  try {
    let current = '';
    for (const raw of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      const line = raw.trim();
      const section = /^\[(?:profile )?(.+)\]$/.exec(line);
      if (section) { current = section[1].trim(); continue; }
      const pair = /^region\s*=\s*(.+)$/.exec(line);
      if (pair && current === profile) return pair[1].trim();
    }
  } catch { /* no file */ }
  return DEFAULT_REGION;
}

const unescapeXml = text => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tag = (xml, name) => { const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return match ? unescapeXml(match[1]) : null; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(match => match[1]);

export class S3Error extends Error {
  constructor(message, { status, code, key } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.key = key;
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * @param bucket      the bucket name
 * @param region      default from the CLI config, else us-east-1
 * @param endpoint    tests only: a path-style base such as http://127.0.0.1:4566
 * @param credentials { accessKeyId, secretAccessKey, sessionToken? }; loaded from the CLI's files when absent
 * @param fetchImpl   injected by tests
 */
export function createBucket({ bucket, region, endpoint, credentials, fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!bucket) throw new Error('A bucket name is needed.');
  let ready;
  const setup = () => (ready ??= (async () => {
    const creds = credentials || await loadCredentials();
    if (!creds) throw new S3Error(`No AWS credentials for bucket ${bucket}: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or a [default] profile in ~/.aws/credentials.`, { status: 503, code: 'NoCredentials' });
    const where = region || await loadRegion();
    const base = endpoint ? `${endpoint.replace(/\/+$/, '')}/${bucket}` : `https://${bucket}.s3.${where}.amazonaws.com`;
    return { creds, region: where, base, host: new URL(base).host };
  })());

  async function send(method, key, { query = {}, headers = {}, body, stream = false, retried = false } = {}) {
    const { creds, region: where, base, host } = await setup();
    const date = now();
    const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const payloadHash = sha256(payload);
    const canonicalQuery = Object.keys(query).sort().map(name => `${encode(name)}=${encode(String(query[name]))}`).join('&');
    const all = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
      ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined).map(([name, value]) => [name.toLowerCase(), String(value).trim()])),
    };
    const signedNames = Object.keys(all).sort();
    const canonicalHeaders = signedNames.map(name => `${name}:${all[name]}\n`).join('');
    const signedHeaders = signedNames.join(';');
    const pathPart = `${new URL(base).pathname.replace(/\/+$/, '')}/${encodeKey(key)}`;
    const canonical = [method, pathPart, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${day}/${where}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), where), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `${base}/${encodeKey(key)}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    const { host: _host, ...sendHeaders } = all;
    const init = { method, headers: { ...sendHeaders, Authorization: authorization }, body: method === 'GET' || method === 'HEAD' ? undefined : payload,
      // A stalled socket must fail the call, not hang the server or a test for ever.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      // A pooled connection the other end had just closed: nothing was sent, so a read is safe to
      // send once more. A write is not retried; it may have gone through.
      if (retried || (method !== 'GET' && method !== 'HEAD') || !(error instanceof TypeError)) throw error;
      return send(method, key, { query, headers, body, stream, retried: true });
    }
    // The wrong region: S3 answers 301 (or 400 AuthorizationHeaderMalformed) and names the right
    // one in a header. A machine whose CLI defaults to another region should not have to be told,
    // so switch to it and send once more; the fix sticks for the rest of this client's life.
    const actual = response.headers.get('x-amz-bucket-region');
    if (!endpoint && !retried && actual && actual !== where && (response.status === 301 || response.status === 400)) {
      await response.text().catch(() => {});
      const next = `https://${bucket}.s3.${actual}.amazonaws.com`;
      ready = Promise.resolve({ creds, region: actual, base: next, host: new URL(next).host });
      return send(method, key, { query, headers, body, stream, retried: true });
    }
    if (!response.ok && response.status !== 304) {
      const text = method === 'HEAD' ? '' : await response.text().catch(() => '');
      const code = tag(text, 'Code') || (response.status === 404 ? 'NoSuchKey' : response.status === 412 ? 'PreconditionFailed' : `HTTP${response.status}`);
      const message = tag(text, 'Message') || `${method} ${key || '/'}: S3 said ${response.status}`;
      throw new S3Error(message, { status: response.status, code, key });
    }
    if (stream) return response;
    return { response, text: method === 'HEAD' ? '' : await response.text() };
  }

  /**
   * A URL that lets whoever holds it make one kind of request on one key, without credentials,
   * for `expires` seconds. Only the host is signed, so a PUT may carry any Content-Type.
   */
  async function presign(method, key, { expires = 900 } = {}) {
    const { creds, region: where, base, host } = await setup();
    const amzDate = now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const scope = `${amzDate.slice(0, 8)}/${where}/s3/aws4_request`;
    const query = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
      ...(creds.sessionToken ? { 'X-Amz-Security-Token': creds.sessionToken } : {}),
    };
    const canonicalQuery = Object.keys(query).sort().map(name => `${encode(name)}=${encode(query[name])}`).join('&');
    const pathPart = `${new URL(base).pathname.replace(/\/+$/, '')}/${encodeKey(key)}`;
    const canonical = [method, pathPart, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, amzDate.slice(0, 8)), where), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    return `${base}/${encodeKey(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  const meta = response => ({
    etag: (response.headers.get('etag') || '').replace(/^"|"$/g, '') || null,
    contentType: response.headers.get('content-type') || null,
    size: Number(response.headers.get('content-length')) || 0,
    lastModified: response.headers.get('last-modified') || null,
    // User metadata (`x-amz-meta-*`), by name: who wrote an object is recorded here, never in its body.
    metadata: Object.fromEntries([...response.headers.entries()].filter(([name]) => name.startsWith('x-amz-meta-')).map(([name, value]) => [name.slice('x-amz-meta-'.length), value])),
  });

  return {
    bucket,
    presign,
    /** The object as a web stream plus its headers; `NoSuchKey` surfaces as an S3Error with status 404. */
    async get(key, { ifNoneMatch } = {}) {
      const response = await send('GET', key, { stream: true, headers: { 'if-none-match': ifNoneMatch ? `"${ifNoneMatch}"` : undefined } });
      return { ...meta(response), status: response.status, body: response.body };
    },
    async head(key) {
      const response = await send('HEAD', key, { stream: true });
      return meta(response);
    },
    /** Whole object as text; null when it is not there. */
    async getText(key) {
      try {
        const response = await send('GET', key, { stream: true });
        return { ...meta(response), text: await response.text() };
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    /** Whole object as bytes, exactly as stored (a Buffer); null when it is not there. */
    async getBytes(key) {
      try {
        const response = await send('GET', key, { stream: true });
        return { ...meta(response), buffer: Buffer.from(await response.arrayBuffer()) };
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    async getJson(key) {
      const got = await this.getText(key);
      return got ? { ...got, value: JSON.parse(got.text) } : null;
    },
    /**
     * Write an object. `ifMatch` (an ETag) refuses the write when someone else wrote since
     * (412), and `ifNoneMatch: '*'` refuses it when the key already exists.
     */
    async put(key, body, { contentType, ifMatch, ifNoneMatch, cacheControl, metadata } = {}) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const { response } = await send('PUT', key, {
        body: buffer,
        headers: {
          'content-type': contentType || contentTypeOf(key),
          'content-length': String(buffer.length),
          'content-md5': createHash('md5').update(buffer).digest('base64'),
          'cache-control': cacheControl,
          'if-match': ifMatch ? `"${ifMatch}"` : undefined,
          'if-none-match': ifNoneMatch,
          ...Object.fromEntries(Object.entries(metadata ?? {}).map(([name, value]) => [`x-amz-meta-${name}`, String(value)])),
        },
      });
      return meta(response);
    },
    putJson(key, value, options = {}) {
      return this.put(key, `${JSON.stringify(value, null, 2)}\n`, { contentType: 'application/json', ...options });
    },
    /**
     * Copy one object inside this bucket (S3 CopyObject): the bytes never leave S3. Content type and
     * user metadata come along. Answers the new object's ETag, read from the XML body.
     */
    async copy(fromKey, toKey) {
      const { text } = await send('PUT', toKey, { headers: { 'x-amz-copy-source': `/${bucket}/${encodeKey(fromKey)}` } });
      // S3 can answer 200 with an error in the body for a copy that failed halfway.
      if (tag(text, 'Code')) throw new S3Error(tag(text, 'Message') || 'Copy failed', { status: 502, code: tag(text, 'Code'), key: toKey });
      return { etag: (tag(text, 'ETag') || '').replace(/^"|"$/g, '') || null };
    },
    async del(key) {
      await send('DELETE', key);
    },
    /**
     * Every object under a prefix (paginated through), and with a delimiter the "folders" too.
     * ETags are the md5 of the body for anything uploaded in one piece, which is how the publish
     * script tells a changed file from an unchanged one without downloading it.
     */
    async list(prefix = '', { delimiter } = {}) {
      const objects = [];
      const prefixes = [];
      let token;
      do {
        const { text } = await send('GET', '', { query: { 'list-type': '2', prefix, ...(delimiter ? { delimiter } : {}), ...(token ? { 'continuation-token': token } : {}) } });
        for (const item of tags(text, 'Contents')) {
          objects.push({
            key: tag(item, 'Key'),
            etag: (tag(item, 'ETag') || '').replace(/^"|"$/g, ''),
            size: Number(tag(item, 'Size')) || 0,
            lastModified: tag(item, 'LastModified'),
          });
        }
        for (const item of tags(text, 'CommonPrefixes')) prefixes.push(tag(item, 'Prefix'));
        token = tag(text, 'IsTruncated') === 'true' ? tag(text, 'NextContinuationToken') : null;
      } while (token);
      return { objects, prefixes };
    },
  };
}
