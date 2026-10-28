// Runs inside the sandboxed card page and reports what it could do into #out and window.__probe.
(async () => {
  const r = { script: true, origin: location.origin };
  const img = document.getElementById('img');
  r.img = img.complete ? img.naturalWidth > 0 : await new Promise(ok => { img.onload = () => ok(true); img.onerror = () => ok(false); });
  r.css = getComputedStyle(document.querySelector('.styled')).borderTopColor === 'rgb(0, 128, 0)';
  try { await document.fonts.load('16px ProbeFont'); r.font = [...document.fonts].some(f => f.family === 'ProbeFont' && f.status === 'loaded'); } catch { r.font = false; }
  for (const [name, init] of [['fetchSibling', {}], ['fetchSiblingCreds', { credentials: 'include' }]]) {
    try { const res = await fetch('data.json', init); r[name] = res.ok ? (await res.json()).ok === true : 'status ' + res.status; }
    catch (e) { r[name] = 'error: ' + e.message; }
  }
  try { const res = await fetch('/api/echo', { method: 'POST', credentials: 'include', body: 'x' }); r.fetchPost = res.status; }
  catch (e) { r.fetchPost = 'error: ' + e.message; }
  // A no-cors POST to the app's own host: the response is opaque, but the gate logs the Origin and cookie it arrived with.
  try { await fetch(location.origin.replace('//cards.', '//mc.') + '/api/echo', { method: 'POST', mode: 'no-cors', credentials: 'include', body: 'x' }); r.postToApp = 'sent'; } catch (e) { r.postToApp = 'error: ' + e.message; }
  try { localStorage.setItem('probe', '1'); r.localStorage = 'ok'; } catch (e) { r.localStorage = 'throws ' + e.name; }
  try { r.cookieVisible = document.cookie === '' ? 'empty' : 'readable'; } catch (e) { r.cookieVisible = 'throws ' + e.name; }
  const a = document.createElement('a'); a.id = 'dlblob'; a.textContent = 'download blob'; a.download = 'blob.txt'; a.href = URL.createObjectURL(new Blob(['hello']));
  document.body.append(a);
  window.__probe = r;
  document.getElementById('out').textContent = JSON.stringify(r);
})();
