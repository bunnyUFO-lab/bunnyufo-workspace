"""Find packs in the Google Drive asset library and copy one into a project.

python get_pack.py list [TEXT]            search the library (matches path, case-insensitive)
python get_pack.py get TEXT DEST_DIR      copy the matching pack's zip from Drive and unzip it
python get_pack.py get TEXT DEST_DIR --keep-zip    also leave the .zip beside the extracted folder

TEXT must match exactly one pack unless --first is given. The library lives in Drive as one zip per
pack (see pack_to_drive.py); this reads the same `_manifest.jsonl`, falling back to walking the tree.
Extracted files use Windows-safe names, and an existing folder of the right size is left alone.
"""
import os, re, sys, json, shutil, zipfile

LIB = os.environ.get('ASSET_LIB', 'E:/My Drive/Game Assets')
MANIFEST = os.path.join(LIB, '_manifest.jsonl')

def entries():
    """Every pack in the library as (zip path, size); the manifest when present, else a tree walk."""
    out = {}
    if os.path.exists(MANIFEST):
        for l in open(MANIFEST, encoding='utf-8'):
            try:
                r = json.loads(l)
                if os.path.exists(r['zip']): out[r['zip']] = r.get('size', 0)
            except Exception: pass
    if not out:
        for root, dirs, files in os.walk(LIB):
            for f in files:
                if f.lower().endswith('.zip'):
                    p = os.path.join(root, f).replace('\\', '/')
                    out[p] = os.path.getsize(p)
    return sorted(out.items())

def match(text):
    t = text.lower()
    return [(p, s) for p, s in entries() if t in p.lower()]

def safe(p):
    return re.sub(r'[<>:"|?*\r\n\t]', '_', p).rstrip(' .') or '_'

def extract(zp, out):
    with zipfile.ZipFile(zp) as z:
        for m in z.infolist():
            parts = [x for x in m.filename.replace('\\', '/').split('/') if x and x != '..']
            if not parts or '__MACOSX' in parts or parts[-1] in ('.DS_Store', 'Icon\r'): continue
            t = os.path.join(out, *[safe(x) for x in parts])
            if m.is_dir(): os.makedirs(t, exist_ok=True); continue
            os.makedirs(os.path.dirname(t), exist_ok=True)
            with z.open(m) as s, open(t, 'wb') as d: shutil.copyfileobj(s, d, 8 << 20)

cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
args = [a for a in sys.argv[2:] if not a.startswith('--')]
flags = {a for a in sys.argv[2:] if a.startswith('--')}

if cmd == 'list':
    hits = match(args[0]) if args else entries()
    for p, s in hits: print(f'{s/1e9:8.2f} GB  {os.path.relpath(p, LIB)}')
    print(f'-- {len(hits)} pack(s), {sum(s for _, s in hits)/1e9:.1f} GB')

elif cmd == 'get':
    if len(args) < 2: sys.exit('usage: get_pack.py get TEXT DEST_DIR')
    text, dest = args[0], args[1]
    hits = match(text)
    if not hits: sys.exit(f'no pack matches {text!r}')
    if len(hits) > 1 and '--first' not in flags:
        for p, s in hits[:20]: print(f'{s/1e9:8.2f} GB  {os.path.relpath(p, LIB)}')
        sys.exit(f'{len(hits)} packs match {text!r}; narrow it or pass --first')
    zp, size = hits[0]
    name = os.path.basename(zp)[:-4]
    out = os.path.join(dest, name)
    if os.path.isdir(out) and sum(os.path.getsize(os.path.join(r, f))
                                  for r, _, fs in os.walk(out) for f in fs):
        print('already there:', out); sys.exit(0)
    os.makedirs(dest, exist_ok=True)
    local = os.path.join(dest, name + '.zip')
    print(f'fetching {size/1e9:.2f} GB  {os.path.relpath(zp, LIB)}')
    shutil.copyfile(zp, local)                      # pull out of Drive first: unzipping in place is slow
    if os.path.getsize(local) != size: sys.exit('copy size mismatch, try again')
    extract(local, out)
    if '--keep-zip' not in flags: os.remove(local)
    print('ready:', out)

else:
    sys.exit(__doc__)
