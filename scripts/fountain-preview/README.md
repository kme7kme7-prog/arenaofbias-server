# Classical garden fountain preview

Open `index.html` through any local HTTP server. It imports pinned Three.js 0.169.0 from jsDelivr and uses standard WebGL, with no server npm dependencies.

- Default: drag to rotate, scroll to zoom, reset the three-quarter view, or download `classical-garden-fountain.glb`.
- `?capture=1`: hide the heading and controls for a clean cover image, retaining a small “简化模型预览” label in the corner.
- The static GLB includes the courtyard, trees, stone fountain, water surfaces and curved water jets. It does not include the preview lights, camera or shadow plane.
- Browser automation can wait for `document.documentElement.dataset.previewReady === 'true'`; `window.fountainPreview.exportGLB()` returns an ArrayBuffer.

The source is a simplified model made from the supplied desktop reference. It does not change the submitted work itself.
