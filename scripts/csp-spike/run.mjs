// Local spike: do sandboxed card pages still load behind a sign-in that sets a SameSite=Lax cookie?
//
//   node scripts/csp-spike/run.mjs --data <sections dir> --out <result dir> [--only brief,opaque]
//
// A forward-auth stand-in (a 302 to a sign-in URL unless the session cookie is present) fronts a
// card server that answers /w/<section>/<file> from disk with the site API's headers. The CSP
// `sandbox` header varies per variant. Headless Chrome (Playwright, channel chrome) opens a probe
// card and some real cards top-level and inside a frame, in light and dark, and the gate logs, for
// every request, whether the cookie came with it. Hosts are *.lab.test, mapped to loopback inside
// the browser only.
import http from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(arg('data', ''));
const outDir = path.resolve(arg('out', path.join(here, 'out')));
const only = arg('only', '');
const BROWSER_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';
const VARIANTS = {
  none:    { host: 'mc',    csp: '' },
  opaque:  { host: 'mc',    csp: 'sandbox allow-scripts' },
  brief:   { host: 'mc',    csp: `sandbox ${BROWSER_SANDBOX}` },
  optionB: { host: 'cards', csp: `sandbox ${BROWSER_SANDBOX} allow-same-origin` },
};
const REAL = [
  ['sprite-studio', '2026-10-05_pixel-art-studio/gallery.html'],
  ['agent-plans', '2026-10-27_hermes-dispatch/decisions.html'],
  ['agent-plans', '2026-10-27_hermes-mission-control/mockup.html'],
  ['agent-plans', '2026-10-27_hermes-dispatch/architecture.html'],
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.md': 'text/markdown; charset=utf-8' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const COOKIE = 'buw_session';

let variant = VARIANTS.brief;
let log = [];
let gatePort;
const originOf = host => `http://${host}.lab.test:${gatePort}`;

async function fileFor(url) {
  const m = /^\/w\/([^/]+)\/(.+)$/.exec(decodeURIComponent(url.pathname));
  if (!m || m[2].split('/').includes('..')) return null;
  const sandbox = m[1] === 'dev-sandbox';
  const roots = sandbox ? [path.join(here, 'fixtures'), path.join(outDir, '.runtime')] : [path.join(dataDir, m[1])];
  const rel = sandbox ? m[2].replace(/^csp-test\//, '') : m[2];
  for (const root of roots) { const file = path.join(root, rel); try { if ((await stat(file)).isFile()) return file; } catch { /* next root */ } }
  return null;
}

// The Authelia stand-in and the card server in one process, told apart by Host.
const gate = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split('.')[0];
  const url = new URL(req.url, originOf(host));
  const hasCookie = (req.headers.cookie || '').includes(`${COOKIE}=1`);
  const entry = { host, method: req.method, path: url.pathname, cookie: hasCookie, site: req.headers['sec-fetch-site'], dest: req.headers['sec-fetch-dest'], origin: req.headers.origin };
  const done = (status, headers, body) => { entry.status = status; log.push(entry); res.writeHead(status, headers); res.end(body); };
  if (host === 'auth') {
    if (url.pathname === '/login') {
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=1; Domain=lab.test; Path=/; HttpOnly; SameSite=Lax`, Location: url.searchParams.get('rd') || '/' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<h1>sign in</h1>');
  }
  if (!hasCookie) return done(302, { Location: `${originOf('auth')}/?rd=${encodeURIComponent(originOf(host) + req.url)}` });
  if (url.pathname === '/frame') {
    const sandbox = url.searchParams.get('attr');
    const cardHost = url.searchParams.get('cardHost') || host;
    return done(200, { 'Content-Type': 'text/html' }, `<!doctype html><title>app</title><body style="margin:0"><iframe id="card" src="${originOf(cardHost)}${url.searchParams.get('src')}" ${sandbox ? `sandbox="${sandbox}"` : ''} style="width:100%;height:700px;border:0"></iframe>`);
  }
  if (url.pathname === '/api/echo') return done(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, origin: req.headers.origin ?? null }));
  if (host === 'cards' && !url.pathname.startsWith('/w/')) return done(404, {}, 'not here');
  const csp = variant.csp ? { 'Content-Security-Policy': variant.csp } : {};
  if (url.pathname === '/w/dev-sandbox/csp-test/pic.png') return done(200, { 'Content-Type': 'image/png' }, PNG);
  if (url.pathname === '/w/dev-sandbox/csp-test/form') return done(200, { 'Content-Type': 'text/html', ...csp }, '<p id="formed">form target</p>');
  if (url.pathname === '/w/dev-sandbox/csp-test/inline.html') {
    // The probe with its script inline, so the script runs even when the sandbox keeps the sign-in cookie from probe.js.
    const html = (await readFile(path.join(here, 'fixtures', 'probe.html'), 'utf8')).replace('<script src="probe.js"></script>', `<script>${await readFile(path.join(here, 'fixtures', 'probe.js'), 'utf8')}</script>`);
    return done(200, { 'Content-Type': 'text/html', ...csp }, html);
  }
  const file = await fileFor(url);
  if (!file) return done(404, {}, 'Not found');
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (variant.csp && (type.startsWith('text/html') || type.startsWith('image/svg'))) Object.assign(headers, csp);
  return done(200, headers, await readFile(file));
});

const summarize = entries => {
  const by = {};
  for (const e of entries) {
    if (e.host === 'auth' || e.marker) continue;
    const kind = e.status === 302 ? 'REDIRECTED to sign-in' : e.status === 200 ? 'served' : `status ${e.status}`;
    (by[`${e.method} ${e.host}:${e.path.split('/').pop() || e.path}`] ??= []).push(`${kind}, cookie ${e.cookie ? 'sent' : 'absent'} [${e.dest}/${e.site}]${e.origin ? ` Origin=${e.origin.replace(/:\d+$/, '')}` : ''}`);
  }
  return by;
};

async function run() {
  await new Promise(ok => gate.listen(0, '127.0.0.1', ok));
  gatePort = gate.address().port;
  await mkdir(path.join(outDir, '.runtime'), { recursive: true });
  let fontBytes = Buffer.alloc(0);
  try { fontBytes = await readFile('C:/Windows/Fonts/arial.ttf'); } catch { /* the font check then reports not loaded */ }
  await writeFile(path.join(outDir, '.runtime', 'font.ttf'), fontBytes);

  // The hosts are plain http, so Chrome would leave out the Sec-Fetch-* headers: treat them as secure.
  const secure = ['mc', 'cards', 'auth'].map(h => originOf(h)).join(',');
  const browser = await chromium.launch({ channel: 'chrome', args: ['--host-resolver-rules=MAP *.lab.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${secure}`] });
  const results = [];
  for (const [name, v] of Object.entries(VARIANTS)) {
    if (only && !only.split(',').includes(name)) continue;
    variant = v;
    const attrOf = name === 'none' ? '' : BROWSER_SANDBOX + (name === 'optionB' ? ' allow-same-origin' : '');
    const cards = [['dev-sandbox', 'csp-test/probe.html'], ['dev-sandbox', 'csp-test/inline.html'], ...REAL];
    for (const [section, file] of cards) {
      const probeCard = section === 'dev-sandbox';
      for (const [mode, attr] of [['top', null], ['frame-attr', attrOf], ['frame-noattr', '']]) {
        if (name === 'none' && mode === 'frame-attr') continue;
        if (!probeCard && mode === 'frame-noattr') continue;
        for (const scheme of ['light', 'dark']) {
          const context = await browser.newContext({ colorScheme: scheme, acceptDownloads: true, viewport: { width: 1100, height: 800 } });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', e => errors.push(e.message.slice(0, 100)));
          page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });
          const cardUrl = `/w/${section}/${file}`;
          await page.goto(`${originOf('auth')}/login?rd=${encodeURIComponent(originOf('mc') + '/')}`); // sign in
          log = [];
          if (mode === 'top') await page.goto(originOf(v.host) + cardUrl, { waitUntil: 'load' });
          else await page.goto(`${originOf('mc')}/frame?src=${encodeURIComponent(cardUrl)}&cardHost=${v.host}&attr=${encodeURIComponent(attr)}`, { waitUntil: 'load' });
          await page.waitForTimeout(1500);
          const target = mode === 'top' ? page : page.frames().find(f => f !== page.mainFrame()) ?? page;
          const probe = await target.evaluate(() => window.__probe ?? null).catch(() => null);
          const dom = await target.evaluate(() => ({
            images: document.images.length, imagesLoaded: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length,
            sheets: document.querySelectorAll('link[rel=stylesheet]').length, reportJs: !!window.__buwReportViewer, text: document.body?.innerText.length ?? 0,
            bg: getComputedStyle(document.body).backgroundColor, signInPage: /sign in/i.test(document.title),
          })).catch(e => ({ error: e.message.slice(0, 80) }));
          const tag = `${name}__${mode}__${section}__${path.basename(file, '.html')}__${scheme}`;
          await page.screenshot({ path: path.join(outDir, `${tag}.png`) });
          const extra = {};
          const loadRequests = summarize(log);
          if (probeCard) {
            let mark = log.length;
            const tryDownload = async (sel) => {
              if (!(await target.locator(sel).count().catch(() => 0))) return 'no link (script did not run)';
              return Promise.all([page.waitForEvent('download', { timeout: 3000 }), target.locator(sel).click({ timeout: 3000 })]).then(([d]) => `downloaded ${d.suggestedFilename()}`).catch(() => 'no download (navigated or blocked)');
            };
            extra.downloadBlob = await tryDownload('#dlblob'); // first: the file link navigates the page away when the download is refused
            extra.download = await tryDownload('#dl');
            extra.downloadRequests = summarize(log.slice(mark));
            if (mode === 'top') await page.goto(originOf(v.host) + cardUrl, { waitUntil: 'load' }); else await page.goto(`${originOf('mc')}/frame?src=${encodeURIComponent(cardUrl)}&cardHost=${v.host}&attr=${encodeURIComponent(attr)}`, { waitUntil: 'load' });
            extra.nestedIframe = (loadRequests[`GET ${v.host}:inner.html`] ?? ['not requested']).join(' ');
            // Back to the card page, then submit the POST form.
            if (mode === 'top') await page.goto(originOf(v.host) + cardUrl, { waitUntil: 'load' });
            else await page.goto(`${originOf('mc')}/frame?src=${encodeURIComponent(cardUrl)}&cardHost=${v.host}&attr=${encodeURIComponent(attr)}`, { waitUntil: 'load' });
            await page.waitForTimeout(800);
            const post = mode === 'top' ? page : page.frames().find(f => f !== page.mainFrame()) ?? page;
            const before = log.length;
            await post.locator('#postform button').click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1200);
            extra.postForm = summarize(log.slice(before))[`POST ${v.host}:echo`] ?? 'no request seen';
            extra.postFormLanded = (await post.evaluate(() => document.body.innerText.slice(0, 40)).catch(() => '?')) + ' | top: ' + (await page.evaluate(() => document.body.innerText.slice(0, 40)).catch(() => '?'));
          }
          results.push({ tag, variant: name, mode, section, file, scheme, probe, dom, errors: [...new Set(errors)].slice(0, 4), requests: loadRequests, ...extra });
          await context.close();
        }
      }
    }
  }
  await browser.close();
  gate.close();
  await writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  return results;
}

run().then(r => { console.log(`wrote ${r.length} results to ${path.join(outDir, 'results.json')}`); process.exit(0); }, e => { console.error(e); process.exit(1); });
