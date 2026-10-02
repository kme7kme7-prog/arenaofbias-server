# Original fountain extraction preview

This adapter extracts the actual uploaded work up-ccnksbcp, rather than rebuilding its design. It preserves original geometry, world transforms, textures and material colors through the existing data baker, then reads the native WebGPU particle positions and wave heights for a static frame. Water mesh formulas and colors follow the authored WGSL. The original finite 24×24 courtyard sets the footprint.

Required same-origin local HTTP routes:

- /original/index.html: instrumented temporary copy in output/fountain-faithful-20261002/original (untouched source saved beside it).
- /__bake/datapack-bridge.js: data/scripts/datapack-bridge.js.
- /__bake/*: data/scripts/baker/*.
- /__gallery/*: ArenaGalleri/site/*.
- /vendor/three.module.js and /vendor/three.core.js: data/node_modules/three/build/*.
- /vendor/addons/*: data/node_modules/three/examples/jsm/*.

Click “提取原作” to run extraction, pack the same gzip .sbox format as the catalog, reload that package with the Gallery loader and render through its card renderer. Download uses a visible link. ?capture=1 runs extraction and hides controls while retaining “原作静态小模型”. Browser automation may wait for data-preview-ready=true in the DOM.

WebGPU is needed only to extract this original; the resulting package renders with standard WebGL. Source instrumentation exposes its existing scene/water renderer and permits particle-buffer GPU readback. It changes only the ignored local copy. No server npm dependency or production write is introduced.

Start the local server with the existing data and Gallery checkouts:

```powershell
node scripts/fountain-preview/serve.mjs --port=5363 --source=output/fountain-faithful-20261002/original --data=../arenaofbias-data --gallery=../ArenaGalleri --output=output/fountain-faithful-20261002
```

It provides POST /__save/model.sbox to save the package as output/fountain-faithful-20261002/classical-garden-fountain.sbox. Extraction saves automatically. Open ?model=1&capture=1 to render that already saved package, including on mobile without repeating GPU extraction.

The extraction copy is made from the uploaded self-contained HTML by three substitutions, only in the temporary copy:

1. Inject the existing bridge script `/__bake/datapack-bridge.js` after `<head>`.
2. Immediately after `r.preroll(Js,t,i.sunDirection),`, expose `window.__fountainSource={scene:e,water:r,renderer:o,camera:t,state:Js},window.__galleryCaptureScene?.(e),`.
3. Add `GPUBufferUsage.COPY_SRC` to the existing particleBuffer STORAGE | COPY_DST usage. The height buffer already permits COPY_SRC.

The unchanged downloaded source is retained as source-untouched.html. Freeze occurs after the existing bridge reports a stable scene. The adapter pauses the authored animation loop, waits for submitted GPU work, and reads back those buffers. A stable block hash selects one real particle per four-particle block, retaining visible particle billboards with alpha at least 0.004. It does not enlarge particles or compensate their opacity. Water vertex/color formulas use the same authored 92×92 surface grid. The native water overlay has no depth attachment; static water retains that behavior rather than altering its authored heights. The water is frozen at this frame; original animation and interactive controls remain in the original work.
