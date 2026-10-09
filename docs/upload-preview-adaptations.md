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

A model manifest can additionally declare `capture: "preview.jpg"` and its `captureSha` for screenshot mode. Generate that image with the capture baker from a matching source snapshot; merge those two fields into the reviewed model manifest and install the JPEG alongside it. The reader verifies this optional capture independently. A stale capture is omitted while the valid model remains available; changed source bytes invalidate both modes. The submitted `first.jpg` remains untouched.

Before copying, resolve the current upload record's `root` and `entry` beneath `DATA_DIR/works/<upload-id>/` and compare the SHA-256 of those exact, unmodified HTML bytes with `sourceDigest` in the manifest. For example, PowerShell can calculate it with `Get-FileHash -Algorithm SHA256 -LiteralPath <entry-path>`. Stop if the values differ; regenerate from the current entry instead of editing or reusing the digest. The backend exposes a preview only when this digest and the manifest's media hashes match.

Do not copy the generated `extract/` files into backend media. They are temporary local preview-baking copies, not the submitted work source.


## Batch production and review

Pass `--output-dir=<server/output/job>` explicitly for a new round. The model baker accepts an optional `--adaptations=<json>` map keyed by `task/upload-id`; entries override `scripts/upload-preview-adaptations.mjs` for that run. Scene child names, mesh counts and bounds are written to `diagnostics/<upload-id>.json` for selecting the authored subject. Successful reusable model settings belong in the tracked adaptation map; media and diagnostic output remain ignored. For multi-file uploads, hash the exact entry bytes and do not compare the entry length with the whole upload's byte count.

Models use the private data extractor and current Gallery renderer: sbox v2 gzip, texture size 256/WebP q0.90, normalized longest dimension 88, and transparent WebP posters with a longest edge of 720/q0.86. Review the original default frame beside the poster, then render the packed model at desktop and phone card sizes. Use a real screenshot when extraction fails, shaders are unsupported, the subject disappears, or the packed model is unsuitable for automatic card loading. Do not invent geometry or click a start overlay to replace the default state.

Build screenshot previews from existing first frames, or separately captured unmodified public default frames. Keep the exact source snapshot paired with that frame. The capture baker opens only the JPEG, scales the complete frame to at most 720 pixels, and encodes JPEG q0.86:

```powershell
$env:DATAPACK_SOURCE_DIR = '<local-private-data-checkout>'
node scripts/bake-upload-captures.mjs `
  --bootstrap='<public-bootstrap-snapshot.json>' `
  --source-dir='<exact-entry-snapshots>' `
  --capture-dir='<default-frames>' `
  --output-dir='<server-checkout>/output/<job>' `
  --id=up-<upload-id>
```

Inputs are `<source-dir>/<id>/index.html` (or `source.html` / `<id>.html`) and `<capture-dir>/<id>/first.jpg`. Outputs are `preview.jpg`, `preview.json`, and a summary binding the original frame hash and dimensions. Install only the declared media for the reviewed mode, replacing `preview.json` last. Preserve the submitted sources and `first.jpg`/`mobile.jpg`.

The reader still checks the source and declared media SHA-256 before exposing a preview. On POSIX, quiet files reuse a bounded digest cache keyed by inode, size, mtime and ctime; newly written files are rehashed until they have been quiet for one second. Windows always rehashes because ctime is creation time there. A process restart clears the cache. This reduces repeated verification work without bypassing the manifest or public-read checks; it does not measure total page or bootstrap latency.

## Extraction-only material and timing fixes

Some originals build their subject across multiple animation frames. Set `captureWaitMs` for the specific upload when the default 1800 ms pause interrupts that build; review a naturally loaded default screenshot alongside the extracted subject. This wait changes only the served extraction bridge, not the submitted source or shared data tools.

Use `excludedNames` or `excludeChildIndices` for explicitly inspected sky or particle layers. `fallbackMaterials` matches exact mesh names; `fallbackMaterialNames` matches exact source material names. `fallbackSurfaces` applies only to Node/Shader materials with the declared `geometryType`, minimum horizontal span and maximum height. Each fallback specifies a static `color`; `stripVertexColors` removes incompatible source color attributes from a geometry copy. Record whether that color comes from the original palette or a sampled default frame. These static previews preserve authored geometry but do not reproduce animated GPU shading.

For sailboats retaining cropped source water, set `authoredSea:true` to skip the importer's additional sea plane. Two coincident sea planes cause stripes and should not be accepted as a finished preview. Derive `previewYaw` from the original boat's forward axis and world transform; inspect complete hull, sails, rigging and surrounding water at both card sizes. Tune `focusedBounds` and `crop` to remove distant scenery while retaining the subject. Prefer this bounded crop to a smaller export that loses buildings or islands. Remove obsolete model adapters when their approved replacement is a screenshot.
