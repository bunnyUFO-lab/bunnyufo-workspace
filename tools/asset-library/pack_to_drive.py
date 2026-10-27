"""Move local game asset folders into Google Drive as one zip per pack, then free the local copy.

python pack_to_drive.py [--dry] SRC_ROOT [SRC_ROOT ...]
Each SRC_ROOT (e.g. "G:/Game Assets") maps to DEST ("E:/My Drive/Game Assets"), keeping the tree. A pack
  <root>/Humble Bundle/<Bundle>/<pack>  ->  DEST/Humble Bundle/<Bundle>/<pack>.zip
  <root>/<Library>/<pack>               ->  DEST/<Library>/<pack>.zip   (Synty, Itch, ...)
Loose files are copied as they are. A pack is zipped without compression on a local drive, the zip's
file count and byte total are checked against the folder, the zip is copied into Drive and its size
confirmed there, and only then are the local zip and the source deleted. Every pack is appended to
DEST/_manifest.jsonl, which is also how a re-run skips finished packs. Humble's .done/.partial
marker folders are removed with their bundle. Drive for desktop stages uploads on C:, so work pauses
while C: has less than MIN_C_FREE_GB (default 60) free.
"""
import os, sys, json, time, shutil, zipfile

DEST = os.environ.get('ASSET_LIB', 'E:/My Drive/Game Assets')
MANIFEST = os.path.join(DEST, '_manifest.jsonl')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, 'pack_to_drive.log')
MIN_C_FREE = float(os.environ.get('MIN_C_FREE_GB', '60')) * 1e9
MAX_PACK = float(os.environ.get('MAX_PACK_GB', '8')) * 1e9   # bigger packs upload as their subfolders
DRY = '--dry' in sys.argv
ROOTS = [a for a in sys.argv[1:] if a != '--dry']
MARKERS = ('.done', '.partial')

def log(*a):
    line = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(line, flush=True); open(LOG, 'a', encoding='utf-8').write(line + '\n')

def done_set():
    if not os.path.exists(MANIFEST): return {}
    out = {}
    for l in open(MANIFEST, encoding='utf-8'):
        try: r = json.loads(l); out[r['source']] = r
        except Exception: pass
    return out

def tree_stats(folder):
    n = b = 0
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in MARKERS]
        for f in files: n += 1; b += os.path.getsize(os.path.join(root, f))
    return n, b

def same_size(t, size, wait):
    end = time.time() + wait
    while True:
        if os.path.exists(t) and os.path.getsize(t) == size: return True
        if time.time() >= end: return False
        time.sleep(2)

def wait_for_c():
    while shutil.disk_usage('C:/').free < MIN_C_FREE:
        log('C: low, waiting for Drive to upload'); time.sleep(120)

def tmp_dir_for(size):
    for drive in ('G:/', 'D:/'):                       # zip on whichever local drive has room
        if shutil.disk_usage(drive).free > size + 10e9:
            d = os.path.join(drive, '_ziptmp'); os.makedirs(d, exist_ok=True); return d
    return None

def upload(local, dest):
    size = os.path.getsize(local)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(5):
        try:
            wait_for_c()
            if not same_size(dest, size, 0): shutil.copyfile(local, dest)
            if same_size(dest, size, 90): return True       # Drive reports a new file's size a little late
            log('size differs, copying again', dest)
        except OSError as e:                                # Drive sometimes drops E: for a moment
            log('retry', dest, e); time.sleep(30)
    return False

def record(rec):
    open(MANIFEST, 'a', encoding='utf-8').write(json.dumps(rec, ensure_ascii=False) + '\n')
    open(os.path.join(HERE, 'pack_manifest_local.jsonl'), 'a', encoding='utf-8').write(json.dumps(rec, ensure_ascii=False) + '\n')

def do_folder(src, dest_zip, done):
    if src in done:
        if os.path.exists(src): shutil.rmtree(src); log('already uploaded, removed local', src)
        return
    n, b = tree_stats(src)
    if n == 0:
        log('empty, removing', src)
        if not DRY: shutil.rmtree(src)
        return
    if DRY: log(f'would zip {n} files, {b/1e9:.2f} GB', src); return
    tmp = tmp_dir_for(b)
    if not tmp: log('FAILED no local room to zip', src); return
    z = os.path.join(tmp, os.path.basename(dest_zip))
    try:
        with zipfile.ZipFile(z, 'w', zipfile.ZIP_STORED, allowZip64=True) as zf:
            for root, dirs, files in os.walk(src):
                dirs[:] = [d for d in dirs if d not in MARKERS]
                for f in files:
                    p = os.path.join(root, f)
                    zf.write(p, os.path.relpath(p, os.path.dirname(src)))
        with zipfile.ZipFile(z) as zf:
            zn = len(zf.infolist()); zb = sum(i.file_size for i in zf.infolist())
        if (zn, zb) != (n, b):
            log('FAILED zip check', src, (zn, zb), (n, b)); os.remove(z); return
        if not upload(z, dest_zip):
            log('FAILED upload', src); os.remove(z); return
        rec = {'source': src, 'zip': dest_zip, 'size': os.path.getsize(z), 'files': n, 'bytes': b, 'at': time.strftime('%Y-%m-%d %H:%M:%S')}
        record(rec); os.remove(z); shutil.rmtree(src)
        log(f'done {n} files {b/1e9:.2f} GB ->', dest_zip)
    except Exception as e:
        log('FAILED', src, repr(e))
        if os.path.exists(z): os.remove(z)

def do_file(src, dest, done):
    if src in done:
        if os.path.exists(src): os.remove(src)
        return
    size = os.path.getsize(src)
    if DRY: log(f'would copy {size/1e9:.2f} GB', src); return
    if upload(src, dest):
        record({'source': src, 'zip': dest, 'size': size, 'files': 1, 'bytes': size, 'at': time.strftime('%Y-%m-%d %H:%M:%S')})
        os.remove(src); log('copied', src)
    else:
        log('FAILED upload', src)

def split(src, dest):
    """One pack, or its subfolders when it is too big to be a useful download on its own."""
    if os.path.isfile(src): yield src, dest; return
    subs = [d for d in sorted(os.listdir(src)) if d not in MARKERS]
    if (tree_stats(src)[1] <= MAX_PACK or not any(os.path.isdir(os.path.join(src, d)) for d in subs)):
        yield src, dest + '.zip'; return
    base = dest                                       # dest has no .zip yet: use it as a folder
    for d in subs:
        yield from split(os.path.join(src, d), os.path.join(base, d))

def units(root):
    """Yield (local path, destination path) for every pack under a source root."""
    for top in sorted(os.listdir(root)):
        tp = os.path.join(root, top)
        if os.path.isfile(tp): yield tp, os.path.join(DEST, top); continue
        for c in sorted(os.listdir(tp)):
            cp = os.path.join(tp, c)
            if top == 'Humble Bundle' and os.path.isdir(cp):      # Humble: <Bundle>/<pack>
                for p in sorted(os.listdir(cp)):
                    if p in MARKERS: continue
                    yield from split(os.path.join(cp, p), os.path.join(DEST, top, c, p))
            else:
                yield from split(cp, os.path.join(DEST, top, c))

done = done_set()
for root in ROOTS:
    log('root', root, '(dry run)' if DRY else '')
    for src, dest in units(root):
        src = src.replace('\\', '/'); dest = dest.replace('\\', '/')
        if os.path.isdir(src): do_folder(src, dest, done)
        else: do_file(src, dest, done)
    if not DRY:                                               # clear marker folders and empty dirs
        for r, dirs, files in os.walk(root, topdown=False):
            if os.path.basename(r) in MARKERS: shutil.rmtree(r, ignore_errors=True); continue
            try:
                if not os.listdir(r) and r.rstrip('/\\') != root.rstrip('/\\'): os.rmdir(r)
            except OSError: pass
log('finished')
