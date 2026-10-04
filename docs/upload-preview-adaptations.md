# Platform upload previews

`scripts/bake-upload-previews.mjs` writes temporary preview media to `output/page-adaptation-20261004/media/<upload-id>/`. For baking, `DATAPACK_SOURCE_DIR` points to the local `arenaofbias-data` checkout and `GALLERY_DIR` points to the local Gallery checkout. These are source inputs; the backend runtime's `DATA_DIR` is a separate setting and is not used to bake previews. The browser-visible poster follows the task's `sceneProfile`; the extraction setting in `upload-preview-adaptations.mjs` may differ when the importer needs architecture-oriented clipping or filtering.

PowerShell example, with local checkout paths supplied by the operator:

```powershell
$env:DATAPACK_SOURCE_DIR = '<path-to-arenaofbias-data>'
$env:GALLERY_DIR = '<path-to-ArenaGalleri>'
node scripts/bake-upload-previews.mjs `
  --id=up-<upload-id> `
  --bootstrap='<path-to-ArenaGalleri>\output\page-adaptation-20261004\bootstrap.json' `
  --source-dir='<path-to-ArenaGalleri>\output\page-adaptation-20261004\sources'
```

To install a reviewed preview, copy only that upload's manifest and media files into the backend data directory's `media/<upload-id>/` folder. The backend runtime's `DATA_DIR` selects that data directory and defaults to the server's `.data`. Keep the names declared in `preview.json` unchanged:

- Model preview: `preview.json`, `preview.sbox`, and `preview.webp`.
- Screenshot preview: `preview.json` and `preview.jpg`.

Before copying, resolve the current upload record's `entry` beneath `DATA_DIR/works/<upload-id>/` and compare the SHA-256 of those exact, unmodified HTML bytes with `sourceDigest` in the manifest. For example, PowerShell can calculate it with `Get-FileHash -Algorithm SHA256 -LiteralPath <entry-path>`. Stop if the values differ; regenerate from the current entry instead of editing or reusing the digest. The backend exposes a preview only when this digest and the manifest's media hashes match.

Do not copy the generated `extract/` files into backend media. They are temporary local preview-baking copies, not the submitted work source.
