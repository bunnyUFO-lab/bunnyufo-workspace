# Asset library

The bought game assets (Humble, Synty, Animpic, Ovani and the rest) live in Google Drive as one zip
per pack, not on a local disk. A project takes only the packs it uses, so the library can outgrow any
one drive and a NAS later is a copy of one folder.

- **Library:** a synced cloud-drive folder (`ASSET_LIB`), mirroring
  `Humble Bundle/<Bundle>/<pack>.zip`, `Synty/<pack>.zip` and so on.
- **Index:** `_manifest.jsonl` in the library, one line per pack with its source, size and file count.
  A local `manifest.jsonl` here (gitignored) can hold a snapshot of it for searching offline; the
  library's copy is authoritative.

## Take a pack into a project

```bash
python tools/asset-library/get_pack.py list nature          # search the library
python tools/asset-library/get_pack.py get POLYGON_NatureBiomes_TropicalJungle ./Assets/Imported
```

`get` copies that one zip out of Drive and unzips it, with Windows-safe names. It refuses an ambiguous
search unless you pass `--first`, and does nothing when the folder is already in place, so it is safe
to re-run from a setup script.

## Add new purchases to the library

```bash
python tools/asset-library/pack_to_drive.py --dry "G:/Game Assets"    # what it would do
python tools/asset-library/pack_to_drive.py "G:/Game Assets"
```

Per pack: zip (stored, no compression) on a local drive, check the zip's file count and bytes against
the folder, copy it into Drive, confirm the size there, then delete the local copy and append to the
manifest. Nothing local is removed before its Drive copy is verified, re-running skips finished packs,
and a pack over `MAX_PACK_GB` (8) is uploaded as its subfolders so one download stays useful. Drive for
desktop stages uploads on C:, so work pauses while C: has less than `MIN_C_FREE_GB` (60) free.
