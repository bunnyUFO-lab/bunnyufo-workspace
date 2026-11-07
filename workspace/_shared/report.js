/* Shared report theme: the app says light or dark in ?buw-theme= and later in buw:theme messages from its frame.
   A page that sets data-buw-theme="custom" keeps its own colours. */
(() => {
  const root = document.documentElement;
  if (root.dataset.buwThemeListening) return;
  root.dataset.buwThemeListening = 'true';
  const custom = root.dataset.buwTheme === 'custom';
  const set = theme => { if (!custom && (theme === 'dark' || theme === 'light')) root.dataset.buwTheme = theme; };
  try { set(new URLSearchParams(location.search).get('buw-theme')); } catch { /* No query: the page keeps its own theme. */ }
  window.addEventListener('message', event => { if (event.source === parent && event.data?.type === 'buw:theme') set(event.data.theme); });
})();
/* Shared report image viewer: no dependencies, network calls or content rewriting. In the Workspace app's frame it sends one message
   (buw:image) asking the app to open its own viewer on the picture; the app answers, and this page shows its own viewer only when it
   does not (no answer in 400 ms, or ok: false). The message names a picture and never an action: only a person's press in the app starts anything. */
(() => {
  if (window.__buwReportViewer) return;
  window.__buwReportViewer = true;
  // The app's origin, learned from its theme message (it sends one on every load); nothing is posted before that, or outside a frame.
  let appOrigin = null;
  window.addEventListener('message', event => { if (!appOrigin && parent !== window && event.source === parent && event.data?.type === 'buw:theme' && /^https?:/.test(event.origin)) appOrigin = event.origin; });
  const ready = () => {
    const images = () => [...document.querySelectorAll('img')].filter(image => !image.closest('.buw-lightbox'));
    let dialog, stage, display, caption, counter, download, original, note, zoom, current = 0, restoreFocus;
    const button = (label, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', action); return node; };
    const show = image => {
      if (!dialog) {
        dialog = document.createElement('dialog'); dialog.className = 'buw-lightbox'; dialog.setAttribute('aria-label', 'Image preview');
        const toolbar = document.createElement('div'); toolbar.className = 'buw-lightbox-toolbar';
        caption = document.createElement('span'); caption.className = 'buw-lightbox-caption';
        counter = document.createElement('span');
        original = document.createElement('a'); original.target = '_blank'; original.rel = 'noreferrer'; original.textContent = 'Open original';
        download = document.createElement('a'); download.textContent = 'Download';
        zoom = button('100%', () => { stage.classList.toggle('actual'); zoom.textContent = stage.classList.contains('actual') ? 'Fit' : '100%'; });
        toolbar.append(caption, counter, button('Previous', () => change(-1)), button('Next', () => change(1)), zoom, original, download, button('Close', () => dialog.close()));
        stage = document.createElement('div'); stage.className = 'buw-lightbox-stage'; display = document.createElement('img'); stage.append(display);
        display.addEventListener('click', () => zoom.click());
        note = document.createElement('p'); note.className = 'buw-lightbox-note'; note.setAttribute('role', 'status');
        display.addEventListener('error', () => { note.textContent = 'Image unavailable. Try Open original.'; });
        dialog.append(toolbar, stage, note); document.body.append(dialog);
        dialog.addEventListener('close', () => restoreFocus?.focus({ preventScroll: true }));
        dialog.addEventListener('keydown', event => { if (event.key === 'ArrowRight') { event.preventDefault(); change(1); } if (event.key === 'ArrowLeft') { event.preventDefault(); change(-1); } });
        dialog.addEventListener('click', event => { if (event.target === stage) dialog.close(); });
      }
      const collection = images(); current = collection.indexOf(image);
      const url = image.currentSrc || image.src;
      let filename = 'image'; try { filename = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()) || filename; } catch { /* Data URLs use the fallback. */ }
      caption.textContent = image.alt || filename; counter.textContent = `${current + 1} / ${collection.length}`;
      display.src = url; display.alt = image.alt || filename; original.href = url; download.href = url; download.download = filename;
      stage.classList.remove('actual'); zoom.textContent = '100%'; note.textContent = 'Arrow keys to browse · Esc to close';
      if (!dialog.open) { restoreFocus = image; dialog.showModal(); }
    };
    // Ask the app to show the picture; fall back to this page's own viewer when it will not.
    const open = image => {
      const url = image.currentSrc || image.src;
      if (!appOrigin || !/^https?:/i.test(url) || url.length > 2048) { show(image); return; }
      const id = Math.random().toString(36).slice(2, 14);
      const all = images().map(item => item.currentSrc || item.src).filter(src => /^https?:/i.test(src) && src.length <= 2048).slice(0, 100);
      let timer;
      const done = ok => { clearTimeout(timer); window.removeEventListener('message', onReply); if (!ok) show(image); };
      const onReply = event => { const data = event.data; if (event.source === parent && event.origin === appOrigin && data?.type === 'buw:image' && data.v === 1 && data.id === id) done(data.ok === true); };
      window.addEventListener('message', onReply);
      timer = setTimeout(() => done(false), 400);
      try { parent.postMessage({ type: 'buw:image', v: 1, id, src: url, all }, appOrigin); } catch { done(false); }
    };
    const change = delta => { const all = images(); if (all.length) show(all[(current + delta + all.length) % all.length]); };
    const prepare = root => { for (const image of root.querySelectorAll('img:not([data-buw-zoom])')) { if (image.closest('.buw-lightbox')) continue; image.dataset.buwZoom = 'true'; if (!image.hasAttribute('tabindex')) image.tabIndex = 0; if (!image.title) image.title = 'Open image · download available in preview'; } };
    prepare(document);
    new MutationObserver(records => { if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && !node.closest?.('.buw-lightbox')))) prepare(document); }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', event => { const image = event.target.closest?.('img[data-buw-zoom]'); if (!image || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); event.stopImmediatePropagation(); open(image); }, true);
    document.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('img[data-buw-zoom]')) { event.preventDefault(); event.stopImmediatePropagation(); open(event.target); } }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
