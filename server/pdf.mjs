// PDF submission validation and blind-safe PDF.js viewer page generation:
// ensures the upload is a single valid, unencrypted .pdf file and pairs it with
// a sandbox-compatible viewer supporting slide/scroll modes, HiDPI canvas, and text parsing.
import { createHash } from 'node:crypto';
import { fail } from './http.mjs';

function isImageMagic(buffer) {
  if (!buffer || buffer.length < 3) return false;
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) return true;
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return true;
  return false;
}

function parsePageCount(raw) {
  let maxPagesCount = 0;
  for (const match of raw.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)) {
    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count > maxPagesCount) maxPagesCount = count;
  }
  if (!maxPagesCount) {
    for (const match of raw.matchAll(/\/Count\s+(\d+)[\s\S]{0,400}?\/Type\s*\/Pages\b/g)) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count) && count > maxPagesCount) maxPagesCount = count;
    }
  }
  if (maxPagesCount > 0) return maxPagesCount;
  const pageMatches = raw.match(/\/Type\s*\/Page(?![a-zA-Z0-9_])/g);
  return pageMatches?.length ? pageMatches.length : null;
}

function parseOrientation(raw) {
  const box = /\/MediaBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/.exec(raw);
  if (!box) return 'portrait';
  const width = Math.abs(Number(box[3]) - Number(box[1]));
  const height = Math.abs(Number(box[4]) - Number(box[2]));
  if (!(width > 0) || !(height > 0)) return 'portrait';
  return width > height ? 'landscape' : 'portrait';
}

export function validatePdfBuffer(buffer, filename) {
  if (!buffer || !buffer.length) fail(400, 'PDF 文件不能为空');

  const name = String(filename ?? '').trim();
  const headText = buffer.subarray(0, 512).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (/\.html?$/i.test(name) || /^(?:<!doctype\b|<html\b|<head\b|<body\b|<script\b|<svg\b)/i.test(headText)) {
    fail(400, 'PDF 题目不接受 HTML 文件，请上传单个 .pdf 文件');
  }

  const le32 = buffer.length >= 4 ? buffer.readUInt32LE(0) : 0;
  if ([0x04034b50, 0x06054b50, 0x02014b50].includes(le32) || isImageMagic(buffer) || !/\.pdf$/i.test(name)) {
    fail(400, 'PDF 题目只接受单个 .pdf 文件');
  }

  const head = buffer.subarray(0, 1024).toString('latin1');
  const versionMatch = /%PDF-(\d\.\d)/.exec(head);
  if (!versionMatch) {
    fail(400, '文件不是有效的 PDF 文档（缺少 %PDF 文件头）');
  }

  const tailStart = Math.max(0, buffer.length - 4096);
  const tail = buffer.subarray(tailStart).toString('latin1');
  if (!tail.includes('%%EOF')) {
    fail(400, 'PDF 文件不完整或已损坏（缺少 %%EOF 结束标记）');
  }

  const raw = buffer.toString('latin1');
  if (/\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/.test(raw)) {
    fail(400, '不支持加密或受密码保护的 PDF 文件，请先解密后再上传');
  }

  return {
    version: versionMatch[1],
    pageCount: parsePageCount(raw),
    orientation: parseOrientation(raw),
  };
}

const PDF_VIEWER_TEMPLATE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="aob-pdf-sha256" content="__SHA__">
<title>PDF 作品</title>
<style>
:root{color-scheme:light dark;--bg:#f5f4ef;--surface:#ffffff;--surface-2:#eceae2;--ink:#1b1a17;--ink-2:#4f4c45;--muted:#767268;--line:rgba(27,26,23,.12);--accent:#d14124;--accent-soft:rgba(209,65,36,.12);--shadow:0 8px 24px rgba(0,0,0,.1);--mono:ui-monospace,SFMono-Regular,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141412;--surface:#1e1d1a;--surface-2:#282723;--ink:#eceae4;--ink-2:#bdb8ae;--muted:#8c877d;--line:rgba(236,234,228,.12);--accent:#e56548;--accent-soft:rgba(229,101,72,.18);--shadow:0 8px 28px rgba(0,0,0,.42)}}
:root[data-theme="dark"]{--bg:#141412;--surface:#1e1d1a;--surface-2:#282723;--ink:#eceae4;--ink-2:#bdb8ae;--muted:#8c877d;--line:rgba(236,234,228,.12);--accent:#e56548;--accent-soft:rgba(229,101,72,.18);--shadow:0 8px 28px rgba(0,0,0,.42)}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;background:var(--bg);color:var(--ink);font:13px/1.5 var(--sans);overflow:hidden}
.app{display:grid;grid-template-rows:auto minmax(0,1fr);width:100%;height:100%}
.bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:wrap;z-index:2}
:root[data-fold="1"] .bar{padding:4px 8px;gap:5px}
:root[data-fold="1"] .brand{display:none}
.group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--ink-2);padding-right:4px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.btn{height:28px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--ink);font:500 12px/1 var(--sans);cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.btn:hover:not(:disabled){background:var(--surface-2);border-color:var(--muted)}
.btn:disabled{opacity:.42;cursor:not-allowed}
.btn.is-active{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.page-ctl{display:inline-flex;align-items:center;gap:4px;font:500 12px/1 var(--mono);color:var(--ink-2)}
.page-input{width:44px;height:28px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);text-align:center;font:500 12px/1 var(--mono);padding:0 4px}
.zoom-val{min-width:44px;text-align:center;font:500 12px/1 var(--mono);color:var(--ink-2)}
.workspace{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 0;min-height:0}
.workspace.is-drawer-open{grid-template-columns:minmax(0,1fr) minmax(280px,36%)}
.stage{position:relative;overflow:auto;padding:16px;display:flex;flex-direction:column;align-items:center;gap:14px;min-height:0}
:root[data-fold="1"] .stage{padding:8px;gap:8px}
.stage.is-single{justify-content:center}
.page-slot{position:relative;background:#fff;border-radius:4px;box-shadow:var(--shadow);flex:none;display:grid;place-items:center;overflow:hidden}
.page-slot canvas{display:block}
.page-badge{position:absolute;right:8px;bottom:8px;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font:500 11px/1.3 var(--mono);pointer-events:none}
.stage.is-single .page-badge{display:none}
.state-overlay{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:var(--muted);background:var(--bg);z-index:3}
.state-overlay.is-hidden{display:none}
.state-overlay.is-error{color:var(--accent)}
.drawer{border-left:1px solid var(--line);background:var(--surface);display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;overflow:hidden}
.drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink-2)}
.drawer-body{overflow:auto;padding:12px}
.drawer-text{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.65 var(--sans);color:var(--ink);user-select:text}
.drawer-empty{color:var(--muted);font-size:12px}
@media(max-width:760px){
  .workspace.is-drawer-open{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) 44%}
  .drawer{border-left:0;border-top:1px solid var(--line)}
  .stage{padding:10px}
}
</style></head>
<body>
<div class="app">
  <header class="bar">
    <div class="group">
      <span class="brand"><span class="dot" aria-hidden="true"></span>PDF 文档</span>
      <button class="btn" id="modeBtn" type="button" title="切换逐页 / 连续滚动">连续</button>
      <button class="btn" id="prevBtn" type="button" disabled>上一页</button>
      <span class="page-ctl"><input class="page-input" id="pageInput" type="number" min="1" value="1" aria-label="页码" disabled><span>/</span><span id="pageTotal">-</span></span>
      <button class="btn" id="nextBtn" type="button" disabled>下一页</button>
    </div>
    <div class="group">
      <button class="btn" id="zoomOutBtn" type="button" title="缩小" disabled>−</button>
      <span class="zoom-val" id="zoomVal">适应</span>
      <button class="btn" id="zoomInBtn" type="button" title="放大" disabled>+</button>
      <button class="btn is-active" id="fitBtn" type="button" disabled>适应</button>
      <button class="btn" id="textBtn" type="button" disabled>文本解析</button>
    </div>
  </header>
  <div class="workspace" id="workspace">
    <main class="stage" id="stage" tabindex="0">
      <div class="state-overlay" id="overlay">正在加载 PDF 文档…</div>
    </main>
    <aside class="drawer" id="drawer" aria-hidden="true">
      <div class="drawer-head">
        <span id="drawerTitle">第 1 页文本</span>
        <div class="group">
          <button class="btn" id="allTextBtn" type="button">提取全文</button>
          <button class="btn" id="copyTextBtn" type="button">复制</button>
        </div>
      </div>
      <div class="drawer-body"><pre class="drawer-text" id="drawerText"></pre></div>
    </aside>
  </div>
</div>
<script>
(() => {
  'use strict';
  document.documentElement.dataset.pdfViewer = '1';
  if (new URLSearchParams(location.search).get('aob') === 'fold') {
    document.documentElement.dataset.fold = '1';
  }

  const CDN_SOURCES = [
    {
      lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
      worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
      standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/standard_fonts/',
    },
    {
      lib: 'https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.min.mjs',
      worker: 'https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
      cMapUrl: 'https://unpkg.com/pdfjs-dist@4.10.38/cmaps/',
      standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@4.10.38/standard_fonts/',
    },
    {
      lib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs',
      worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs',
      cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/cmaps/',
      standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/standard_fonts/',
    },
  ];

  const workspace = document.getElementById('workspace');
  const stage = document.getElementById('stage');
  const overlay = document.getElementById('overlay');
  const modeBtn = document.getElementById('modeBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const pageInput = document.getElementById('pageInput');
  const pageTotal = document.getElementById('pageTotal');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomVal = document.getElementById('zoomVal');
  const fitBtn = document.getElementById('fitBtn');
  const textBtn = document.getElementById('textBtn');
  const drawer = document.getElementById('drawer');
  const drawerTitle = document.getElementById('drawerTitle');
  const drawerText = document.getElementById('drawerText');
  const allTextBtn = document.getElementById('allTextBtn');
  const copyTextBtn = document.getElementById('copyTextBtn');

  let pdfDoc = null;
  let numPages = 0;
  let currentPage = 1;
  let mode = '__INITIAL_ORIENTATION__' === 'landscape' ? 'single' : 'scroll';
  let zoomMode = 'fit';
  let manualScale = 1;
  let readySent = false;
  let observer = null;
  let renderSeq = 0;
  let drawerOpen = false;
  let showingAllText = false;
  const slots = new Map();
  const activeTasks = new Map();
  const renderedScale = new Map();
  const pageTextCache = new Map();

  function setError(msg) {
    overlay.textContent = msg;
    overlay.classList.remove('is-hidden');
    overlay.classList.add('is-error');
  }

  function updateControls() {
    modeBtn.textContent = mode === 'single' ? '逐页' : '连续';
    modeBtn.classList.toggle('is-active', mode === 'single');
    stage.classList.toggle('is-single', mode === 'single');
    prevBtn.disabled = !pdfDoc || currentPage <= 1;
    nextBtn.disabled = !pdfDoc || currentPage >= numPages;
    pageInput.disabled = !pdfDoc;
    pageInput.max = String(Math.max(1, numPages));
    pageInput.value = String(currentPage);
    pageTotal.textContent = numPages ? String(numPages) : '-';
    zoomOutBtn.disabled = !pdfDoc;
    zoomInBtn.disabled = !pdfDoc;
    fitBtn.disabled = !pdfDoc;
    textBtn.disabled = !pdfDoc;
    fitBtn.classList.toggle('is-active', zoomMode === 'fit');
    zoomVal.textContent = zoomMode === 'fit' ? '适应' : Math.round(manualScale * 100) + '%';
  }

  function formatTextContent(content) {
    const items = content?.items ?? [];
    if (!items.length) return '';
    const lines = [];
    let currentLine = [];
    let lastY = null;
    for (const item of items) {
      if (!item || typeof item.str !== 'string') continue;
      const y = Array.isArray(item.transform) ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        const text = currentLine.join('').trim();
        if (text) lines.push(text);
        currentLine = [];
      }
      if (item.str) currentLine.push(item.str);
      if (item.hasEOL) {
        const text = currentLine.join('').trim();
        if (text) lines.push(text);
        currentLine = [];
        lastY = null;
      } else if (y !== null) {
        lastY = y;
      }
    }
    const tail = currentLine.join('').trim();
    if (tail) lines.push(tail);
    return lines.join('\\n');
  }

  async function extractPageText(pageNum) {
    if (pageTextCache.has(pageNum)) return pageTextCache.get(pageNum);
    const page = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    const text = formatTextContent(content);
    pageTextCache.set(pageNum, text);
    return text;
  }

  async function refreshDrawerText() {
    if (!drawerOpen || !pdfDoc) return;
    drawerText.classList.remove('drawer-empty');
    if (showingAllText) {
      drawerTitle.textContent = '全文解析（共 ' + numPages + ' 页）';
      drawerText.textContent = '正在提取全文文本…';
      const parts = [];
      for (let i = 1; i <= numPages; i++) {
        const txt = await extractPageText(i);
        parts.push('--- 第 ' + i + ' 页 ---\\n' + (txt || '（无可选中文本）'));
      }
      const joined = parts.join('\\n\\n');
      drawerText.textContent = joined;
      return;
    }
    drawerTitle.textContent = '第 ' + currentPage + ' 页文本';
    drawerText.textContent = '正在解析本页文本…';
    const txt = await extractPageText(currentPage);
    if (txt) {
      drawerText.textContent = txt;
    } else {
      drawerText.textContent = '本页未检测到可提取文本（可能为纯扫描图像或矢量路径）。';
      drawerText.classList.add('drawer-empty');
    }
  }

  function computeScale(viewport1) {
    const padX = document.documentElement.dataset.fold === '1' ? 20 : 36;
    const padY = document.documentElement.dataset.fold === '1' ? 20 : 36;
    const availW = Math.max(200, stage.clientWidth - padX);
    const availH = Math.max(200, stage.clientHeight - padY);
    if (zoomMode === 'manual') return manualScale;
    const fitW = availW / viewport1.width;
    if (mode === 'single') {
      const fitH = availH / viewport1.height;
      return Math.max(0.2, Math.min(3, Math.min(fitW, fitH)));
    }
    return Math.max(0.2, Math.min(3, fitW));
  }

  async function renderPage(pageNum, seq) {
    if (!pdfDoc || seq !== renderSeq) return;
    const slot = slots.get(pageNum);
    if (!slot) return;
    const page = await pdfDoc.getPage(pageNum);
    if (seq !== renderSeq) return;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = computeScale(baseViewport);
    if (renderedScale.get(pageNum) === scale && slot.dataset.rendered === '1') return;

    const prevTask = activeTasks.get(pageNum);
    if (prevTask) {
      try { prevTask.cancel(); } catch {}
    }

    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    slot.style.width = Math.ceil(viewport.width) + 'px';
    slot.style.height = Math.ceil(viewport.height) + 'px';

    let canvas = slot.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      slot.prepend(canvas);
    }
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = Math.ceil(viewport.width) + 'px';
    canvas.style.height = Math.ceil(viewport.height) + 'px';

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    const task = page.render({ canvasContext: ctx, viewport });
    activeTasks.set(pageNum, task);
    try {
      await task.promise;
      if (seq !== renderSeq) return;
      renderedScale.set(pageNum, scale);
      slot.dataset.rendered = '1';
      if (pageNum === 1 && !readySent) {
        readySent = true;
        document.documentElement.dataset.pdfReady = '1';
        try { parent.postMessage('aob:work-ready', '*'); } catch {}
      }
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') throw err;
    } finally {
      if (activeTasks.get(pageNum) === task) activeTasks.delete(pageNum);
    }
  }

  async function buildStage() {
    if (!pdfDoc) return;
    const seq = ++renderSeq;
    observer?.disconnect();
    observer = null;
    for (const task of activeTasks.values()) {
      try { task.cancel(); } catch {}
    }
    activeTasks.clear();
    renderedScale.clear();
    slots.clear();
    stage.querySelectorAll('.page-slot').forEach((el) => el.remove());

    const page1 = await pdfDoc.getPage(1);
    if (seq !== renderSeq) return;
    const base1 = page1.getViewport({ scale: 1 });
    const initialScale = computeScale(base1);
    const estW = Math.ceil(base1.width * initialScale);
    const estH = Math.ceil(base1.height * initialScale);

    const pagesToBuild = mode === 'single' ? [currentPage] : Array.from({ length: numPages }, (_, i) => i + 1);
    for (const n of pagesToBuild) {
      const slot = document.createElement('div');
      slot.className = 'page-slot';
      slot.dataset.page = String(n);
      slot.style.width = estW + 'px';
      slot.style.height = estH + 'px';
      const badge = document.createElement('span');
      badge.className = 'page-badge';
      badge.textContent = n + ' / ' + numPages;
      slot.appendChild(badge);
      stage.appendChild(slot);
      slots.set(n, slot);
    }

    if (mode === 'single') {
      await renderPage(currentPage, seq);
      if (currentPage !== 1 && !readySent) {
        await renderPage(1, seq);
      }
    } else {
      await renderPage(1, seq);
      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver((entries) => {
          let topVisible = null;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const n = Number(entry.target.dataset.page);
            void renderPage(n, seq);
            if (n + 1 <= numPages) void renderPage(n + 1, seq);
            if (topVisible === null || n < topVisible) topVisible = n;
          }
          if (topVisible !== null && topVisible !== currentPage) {
            currentPage = topVisible;
            updateControls();
            if (drawerOpen && !showingAllText) void refreshDrawerText();
          }
        }, { root: stage, rootMargin: '320px 0px' });
        for (const slot of slots.values()) observer.observe(slot);
      } else {
        for (let n = 2; n <= numPages; n++) void renderPage(n, seq);
      }
    }
    updateControls();
  }

  function goToPage(next) {
    if (!pdfDoc) return;
    const clamped = Math.max(1, Math.min(numPages, Math.floor(Number(next) || 1)));
    currentPage = clamped;
    updateControls();
    if (mode === 'single') {
      void buildStage();
    } else {
      const slot = slots.get(clamped);
      if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (drawerOpen && !showingAllText) void refreshDrawerText();
  }

  modeBtn.addEventListener('click', () => {
    mode = mode === 'single' ? 'scroll' : 'single';
    void buildStage();
  });
  prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
  nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
  pageInput.addEventListener('change', () => goToPage(pageInput.value));
  pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goToPage(pageInput.value); });

  zoomOutBtn.addEventListener('click', async () => {
    if (!pdfDoc) return;
    if (zoomMode === 'fit') {
      const page = await pdfDoc.getPage(currentPage);
      manualScale = computeScale(page.getViewport({ scale: 1 }));
    }
    zoomMode = 'manual';
    manualScale = Math.max(0.25, Math.round((manualScale - 0.15) * 100) / 100);
    void buildStage();
  });
  zoomInBtn.addEventListener('click', async () => {
    if (!pdfDoc) return;
    if (zoomMode === 'fit') {
      const page = await pdfDoc.getPage(currentPage);
      manualScale = computeScale(page.getViewport({ scale: 1 }));
    }
    zoomMode = 'manual';
    manualScale = Math.min(3.5, Math.round((manualScale + 0.15) * 100) / 100);
    void buildStage();
  });
  fitBtn.addEventListener('click', () => {
    if (!pdfDoc) return;
    zoomMode = 'fit';
    void buildStage();
  });

  textBtn.addEventListener('click', () => {
    drawerOpen = !drawerOpen;
    workspace.classList.toggle('is-drawer-open', drawerOpen);
    textBtn.classList.toggle('is-active', drawerOpen);
    drawer.setAttribute('aria-hidden', String(!drawerOpen));
    if (drawerOpen) void refreshDrawerText();
  });
  allTextBtn.addEventListener('click', () => {
    showingAllText = !showingAllText;
    allTextBtn.classList.toggle('is-active', showingAllText);
    allTextBtn.textContent = showingAllText ? '仅看本页' : '提取全文';
    void refreshDrawerText();
  });
  copyTextBtn.addEventListener('click', async () => {
    const txt = drawerText.textContent || '';
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    copyTextBtn.textContent = '已复制';
    setTimeout(() => { copyTextBtn.textContent = '复制'; }, 1200);
  });

  addEventListener('keydown', (e) => {
    if (!pdfDoc || e.target.closest('input, textarea, button')) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      goToPage(currentPage - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      goToPage(currentPage + 1);
    }
  });

  addEventListener('message', (e) => {
    if (e.data?.source === 'sp-arena-theme' && ['light', 'dark'].includes(e.data.theme)) {
      document.documentElement.dataset.theme = e.data.theme;
    } else if (e.data?.source === 'sp-arena' && typeof e.data.fold === 'boolean') {
      document.documentElement.dataset.fold = e.data.fold ? '1' : '0';
      if (pdfDoc && zoomMode === 'fit') void buildStage();
    }
  });

  let lastW = stage.clientWidth;
  let lastH = stage.clientHeight;
  let resizeRaf = 0;
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      if (!pdfDoc || zoomMode !== 'fit') return;
      if (stage.clientWidth === lastW && stage.clientHeight === lastH) return;
      lastW = stage.clientWidth;
      lastH = stage.clientHeight;
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => { void buildStage(); });
    }).observe(stage);
  }

  async function loadPdfJs() {
    let lastError = null;
    for (const cdn of CDN_SOURCES) {
      try {
        const pdfjsLib = await import(cdn.lib);
        const workerResp = await fetch(cdn.worker);
        if (!workerResp.ok) throw new Error('worker HTTP ' + workerResp.status);
        const workerCode = await workerResp.text();
        const workerBlobUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
        try {
          const probe = new Worker(workerBlobUrl, { type: 'module' });
          probe.terminate();
          pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;
        } catch {
          const workerMod = await import(workerBlobUrl);
          globalThis.pdfjsWorker = workerMod;
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
        }
        return { pdfjsLib, cdn, workerBlobUrl };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('无法加载 PDF 渲染组件');
  }

  async function init() {
    updateControls();
    try {
      const [{ pdfjsLib, cdn, workerBlobUrl }, pdfResp] = await Promise.all([loadPdfJs(), fetch('document.pdf')]);
      if (!pdfResp.ok) throw new Error('PDF HTTP ' + pdfResp.status);
      const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer());
      const openDoc = () => pdfjsLib.getDocument({
        data: pdfBytes,
        cMapUrl: cdn.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: cdn.standardFontDataUrl,
      }).promise;
      try {
        pdfDoc = await openDoc();
      } catch (err) {
        if (!globalThis.pdfjsWorker && workerBlobUrl) {
          const workerMod = await import(workerBlobUrl);
          globalThis.pdfjsWorker = workerMod;
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
          pdfDoc = await openDoc();
        } else {
          throw err;
        }
      }
      numPages = pdfDoc.numPages || 1;
      overlay.classList.add('is-hidden');
      await buildStage();
    } catch (err) {
      console.error('PDF 加载失败：' + (err?.message || err));
      setError('PDF 渲染失败，请确认网络或 PDF 文件未损坏');
    }
  }

  void init();
})();
</script>
</body></html>
`;

export function renderPdfUpload(buffer, filename) {
  const info = validatePdfBuffer(buffer, filename);
  const sha = createHash('sha256').update(buffer).digest('hex');
  const html = PDF_VIEWER_TEMPLATE
    .replace('__SHA__', sha)
    .replace('__INITIAL_ORIENTATION__', info.orientation);
  return {
    files: new Map([['index.html', Buffer.from(html, 'utf8')], ['document.pdf', buffer]]),
    bytes: buffer.length,
    ...info,
  };
}
