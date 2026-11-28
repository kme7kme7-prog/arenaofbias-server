// Music submission validation and studio player generation: ensures the upload is a single
// valid MP3 stream and pairs it with a blind-safe full-track spectrogram player page.
import { createHash } from 'node:crypto';
import { fail } from './http.mjs';

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

function parseMpegL3Header(buffer, offset) {
  if (offset + 4 > buffer.length) return null;
  const b0 = buffer[offset];
  const b1 = buffer[offset + 1];
  const b2 = buffer[offset + 2];
  const b3 = buffer[offset + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (version === 1 || layer !== 1) return null;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) return null;
  const bitrateKbps = (version === 3 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[bitrateIdx];
  const sampleRate = SAMPLE_RATES[version][sampleIdx];
  if (!bitrateKbps || !sampleRate) return null;
  const frameLen = Math.floor(((version === 3 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLen < 16) return null;
  const mode = (b3 >> 6) & 0x03;
  return { version, bitrateKbps, sampleRate, channels: mode === 3 ? 1 : 2, frameLen };
}

function skipId3v2(buffer) {
  let offset = 0;
  while (offset + 10 <= buffer.length && buffer.toString('ascii', offset, offset + 3) === 'ID3') {
    const flags = buffer[offset + 5];
    const size =
      ((buffer[offset + 6] & 0x7f) << 21)
      | ((buffer[offset + 7] & 0x7f) << 14)
      | ((buffer[offset + 8] & 0x7f) << 7)
      | (buffer[offset + 9] & 0x7f);
    const footer = flags & 0x10 ? 10 : 0;
    const next = offset + 10 + size + footer;
    if (next <= offset || next >= buffer.length) break;
    offset = next;
  }
  return offset;
}

export function validateMp3Buffer(buffer, filename) {
  if (!/\.mp3$/i.test(String(filename ?? ''))) {
    fail(400, '音乐作品必须只上传一个 .mp3 文件（不接受其他格式）');
  }
  if (!buffer || buffer.length < 128) fail(400, 'MP3 音频文件过小或为空');

  const le32 = buffer.readUInt32LE(0);
  if ([0x04034b50, 0x06054b50, 0x02014b50].includes(le32)) {
    fail(400, '音乐作品必须只上传一个 .mp3 文件，不接受 ZIP 压缩包');
  }
  const head4 = buffer.toString('ascii', 0, 4);
  if (head4 === 'RIFF' || head4 === 'OggS' || head4 === 'fLaC' || head4 === 'MThd' || (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp')) {
    fail(400, '音乐作品请导出并上传单个 .mp3 文件，不接受 WAV、OGG、FLAC、MIDI 或 M4A 等其他格式');
  }
  if ((buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) || (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) || head4 === 'GIF8') {
    fail(400, '图片不能当作音乐作品上传，请上传单个 .mp3 文件');
  }
  const snippet = buffer.subarray(0, 256).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (/^(?:<!doctype html|<html|<head|<body|<script|<svg\b)/i.test(snippet)) {
    fail(400, '网页或文本文件不能当作音乐作品上传，请上传单个 .mp3 文件');
  }

  const audioStart = skipId3v2(buffer);
  const scanEnd = Math.min(buffer.length - 4, audioStart + 131072);
  let matched = null;
  for (let i = audioStart; i <= scanEnd; i++) {
    const first = parseMpegL3Header(buffer, i);
    if (!first) continue;
    const nextOffset = i + first.frameLen;
    if (nextOffset + 4 <= buffer.length) {
      const second = parseMpegL3Header(buffer, nextOffset);
      if (second && second.sampleRate === first.sampleRate) {
        matched = { ...first, offset: i };
        break;
      }
    } else if (nextOffset <= buffer.length && buffer.length - i <= first.frameLen + 256) {
      matched = { ...first, offset: i };
      break;
    }
  }
  if (!matched) {
    fail(400, '文件不是有效的 MP3 音频编码，请导出标准 .mp3 文件');
  }
  return matched;
}

const STUDIO_HTML_TEMPLATE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="aob-audio-sha256" content="__SHA__">
<title>音乐作品</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f6;--surface:#ffffff;--surface-2:#f1efe9;--ink:#1b1a17;--ink-2:#4f4c45;--muted:#767268;--line:rgba(27,26,23,.12);--accent:#d14124;--accent-soft:rgba(209,65,36,.16);--bar-off:rgba(27,26,23,.22);--mono:ui-monospace,SFMono-Regular,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161614;--surface:#1f1e1b;--surface-2:#282723;--ink:#eceae4;--ink-2:#bdb8ae;--muted:#8c877d;--line:rgba(236,234,228,.12);--accent:#e56548;--accent-soft:rgba(229,101,72,.20);--bar-off:rgba(236,234,228,.22)}}
:root[data-theme="dark"]{--bg:#161614;--surface:#1f1e1b;--surface-2:#282723;--ink:#eceae4;--ink-2:#bdb8ae;--muted:#8c877d;--line:rgba(236,234,228,.12);--accent:#e56548;--accent-soft:rgba(229,101,72,.20);--bar-off:rgba(236,234,228,.22)}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);overflow-x:hidden;overflow-y:auto}
body{display:flex;align-items:center;justify-content:center;padding:16px}
.studio{width:100%;max-width:740px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px 18px;display:grid;gap:12px;box-shadow:0 8px 28px rgba(0,0,0,.06)}
.meta{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.tag{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--ink-2)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);opacity:.45;transition:opacity .2s,transform .2s}
.studio.is-playing .dot{opacity:1;transform:scale(1.18)}
.tech{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.spec-box{position:relative;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);overflow:hidden;user-select:none;touch-action:none}
canvas{display:block;width:100%;height:190px;cursor:pointer}
.spec-state{position:absolute;inset:0;display:grid;place-items:center;font-size:12.5px;color:var(--muted);background:color-mix(in srgb,var(--surface-2) 86%,transparent);pointer-events:none;transition:opacity .2s}
.spec-state.is-done{opacity:0}
.spec-state.is-error{opacity:1;color:var(--accent);padding:12px;text-align:center}
.spec-hover{position:absolute;top:8px;padding:2px 7px;border-radius:5px;background:var(--ink);color:var(--bg);font:500 11px/1.4 var(--mono);transform:translateX(-50%);pointer-events:none;opacity:0;transition:opacity .12s}
.spec-hover.is-on{opacity:.92}
.controls{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:10px}
.play-btn{width:40px;height:40px;border:0;border-radius:50%;background:var(--accent);color:#fff;display:inline-grid;place-items:center;cursor:pointer;flex:none;transition:transform .12s,filter .15s}
.play-btn:hover:not(:disabled){filter:brightness(1.06)}
.play-btn:active:not(:disabled){transform:scale(.95)}
.play-btn:disabled{opacity:.45;cursor:not-allowed}
.play-btn svg{width:17px;height:17px;fill:currentColor}
.icon-btn{width:32px;height:32px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink-2);display:inline-grid;place-items:center;cursor:pointer;flex:none}
.icon-btn:hover:not(:disabled){color:var(--ink);border-color:var(--muted);background:var(--surface-2)}
.icon-btn:disabled{opacity:.4;cursor:not-allowed}
.icon-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.progress-wrap{display:grid;gap:4px;min-width:0}
.times{display:flex;justify-content:space-between;font:500 11.5px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--ink-2)}
.times small{color:var(--muted);font-size:11.5px}
.scrub{position:relative;height:20px;display:flex;align-items:center}
.scrub-track{position:relative;width:100%;height:6px;border-radius:999px;background:var(--bar-off);overflow:hidden}
.scrub-fill{position:absolute;inset:0 auto 0 0;width:0%;background:var(--accent);border-radius:999px}
.scrub input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.vol{display:flex;align-items:center;gap:6px}
.vol input{width:64px;accent-color:var(--accent);cursor:pointer}
.foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--muted);flex-wrap:wrap}
@media(max-width:460px){body{padding:10px}.studio{padding:12px 13px 14px;gap:10px}canvas{height:155px}.vol input{display:none}}
</style></head>
<body>
<main class="studio" id="studio">
  <div class="meta">
    <span class="tag"><span class="dot" aria-hidden="true"></span>MP3 音频与全程频谱</span>
    <span class="tech" id="tech">正在解码音频…</span>
  </div>
  <div class="spec-box" id="specBox">
    <canvas id="spec" aria-label="音频全程频谱，点击或拖动可跳转进度"></canvas>
    <div class="spec-state" id="specState">正在解析全程频谱…</div>
    <span class="spec-hover" id="specHover" aria-hidden="true">0:00</span>
  </div>
  <div class="controls">
    <button class="play-btn" id="playBtn" type="button" aria-label="播放" title="播放 / 暂停（空格）" disabled>
      <svg id="playIcon" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>
    </button>
    <button class="icon-btn" id="replayBtn" type="button" aria-label="从头播放" title="从头播放" disabled>
      <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
    </button>
    <div class="progress-wrap">
      <div class="scrub">
        <div class="scrub-track"><div class="scrub-fill" id="scrubFill"></div></div>
        <input id="seekInput" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度" disabled>
      </div>
      <div class="times"><span id="curTime">00:00</span><small id="durTime">--:--</small></div>
    </div>
    <div class="vol">
      <button class="icon-btn" id="muteBtn" type="button" aria-label="静音" title="静音">
        <svg id="volIcon" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.8a8.5 8.5 0 0 1 0 12.4"/></svg>
      </button>
      <input id="volInput" type="range" min="0" max="1" step="0.02" value="1" aria-label="音量">
    </div>
  </div>
  <div class="foot"><span>横轴：0:00 至全程结束 · 纵轴：60Hz – 16kHz（点击频谱可跳转）</span><span id="statusText">准备就绪后可播放</span></div>
</main>
<audio id="player" preload="auto"></audio>
<script>
(() => {
  'use strict';
  const studio = document.getElementById('studio');
  const canvas = document.getElementById('spec');
  const specBox = document.getElementById('specBox');
  const specState = document.getElementById('specState');
  const specHover = document.getElementById('specHover');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const replayBtn = document.getElementById('replayBtn');
  const seekInput = document.getElementById('seekInput');
  const scrubFill = document.getElementById('scrubFill');
  const curTimeEl = document.getElementById('curTime');
  const durTimeEl = document.getElementById('durTime');
  const muteBtn = document.getElementById('muteBtn');
  const volIcon = document.getElementById('volIcon');
  const volInput = document.getElementById('volInput');
  const techEl = document.getElementById('tech');
  const statusEl = document.getElementById('statusText');
  const audio = document.getElementById('player');

  let duration = 0;
  let specGrid = null;
  let specSampleRate = 44100;
  const cols = 360;
  const bands = 72;
  const padL = 36, padR = 8, padT = 8, padB = 22;
  let rafId = 0;
  let scrubbing = false;
  let lastPct = 0;

  const fmtTime = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const whole = Math.floor(sec);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };

  const notifyParent = (playing) => {
    try { parent.postMessage({ source: 'sp-audio', playing }, '*'); } catch {}
  };

  function setPlayUI(playing) {
    studio.classList.toggle('is-playing', playing);
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
    playIcon.innerHTML = playing
      ? '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>'
      : '<path d="M8 5.5v13l11-6.5z"/>';
    statusEl.textContent = playing ? '正在播放' : (duration ? '已暂停' : statusEl.textContent);
  }

  function updateVolUI() {
    const muted = audio.muted || audio.volume === 0;
    muteBtn.setAttribute('aria-label', muted ? '取消静音' : '静音');
    volIcon.innerHTML = muted
      ? '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>'
      : '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.8a8.5 8.5 0 0 1 0 12.4"/>';
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = a + half;
          const uRe = re[a], uIm = im[a];
          const vRe = re[b] * wRe - im[b] * wIm;
          const vIm = re[b] * wIm + im[b] * wRe;
          re[a] = uRe + vRe; im[a] = uIm + vIm;
          re[b] = uRe - vRe; im[b] = uIm - vIm;
          const nextRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextRe;
        }
      }
    }
  }

  function computeSpectrogram(decoded) {
    const sr = decoded.sampleRate || 44100;
    specSampleRate = sr;
    const len = decoded.length;
    const chCount = decoded.numberOfChannels || 1;
    const channels = [];
    for (let c = 0; c < chCount; c++) channels.push(decoded.getChannelData(c));
    const nFft = 1024;
    const half = nFft >> 1;
    const win = new Float32Array(nFft);
    for (let i = 0; i < nFft; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (nFft - 1)));
    const re = new Float32Array(nFft);
    const im = new Float32Array(nFft);
    const mag = new Float32Array(half);
    const fMin = 40;
    const fMax = Math.min(16000, sr * 0.48);
    const bandBins = new Array(bands);
    for (let b = 0; b < bands; b++) {
      const f0 = fMin * Math.pow(fMax / fMin, b / bands);
      const f1 = fMin * Math.pow(fMax / fMin, (b + 1) / bands);
      const k0 = Math.max(1, Math.floor((f0 * nFft) / sr));
      const k1 = Math.min(half - 1, Math.max(k0, Math.floor((f1 * nFft) / sr)));
      bandBins[b] = [k0, k1];
    }
    const grid = new Float32Array(cols * bands);
    const span = Math.max(1, len - nFft);
    for (let col = 0; col < cols; col++) {
      const start = Math.floor((col / Math.max(1, cols - 1)) * span);
      for (let i = 0; i < nFft; i++) {
        const idx = start + i;
        let sample = 0;
        if (idx < len) {
          for (let c = 0; c < chCount; c++) sample += channels[c][idx];
          sample /= chCount;
        }
        re[i] = sample * win[i];
        im[i] = 0;
      }
      fft(re, im);
      const norm = 1 / (nFft * 0.25);
      for (let k = 1; k < half; k++) mag[k] = Math.hypot(re[k], im[k]) * norm;
      const base = col * bands;
      for (let b = 0; b < bands; b++) {
        const [k0, k1] = bandBins[b];
        let best = 0;
        for (let k = k0; k <= k1; k++) if (mag[k] > best) best = mag[k];
        const db = 20 * Math.log10(best + 1e-6);
        const normDb = Math.max(0, Math.min(1, (db + 74) / 66));
        grid[base + b] = Math.pow(normDb, 0.85);
      }
    }
    specGrid = grid;
  }

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const dark = document.documentElement.dataset.theme === 'dark'
      || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    return {
      dark,
      accent: cs.getPropertyValue('--accent').trim() || (dark ? '#e56548' : '#d14124'),
      muted: cs.getPropertyValue('--muted').trim() || '#767268',
      bg: cs.getPropertyValue('--surface-2').trim() || (dark ? '#282723' : '#f1efe9'),
      gridLine: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    };
  }

  function drawSpectrogram(pct = lastPct) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    const cw = rect.width;
    const ch = rect.height;
    const plotW = Math.max(40, cw - padL - padR);
    const plotH = Math.max(40, ch - padT - padB);
    const c = themeColors();
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, cw, ch);

    const fMin = 40;
    const fMax = Math.min(16000, specSampleRate * 0.48);
    const yTicks = [[60, '60Hz'], [250, '250'], [1000, '1k'], [4000, '4k'], [16000, '16k']];
    ctx.font = '500 10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const [hz, label] of yTicks) {
      if (hz > fMax) continue;
      const frac = Math.log(hz / fMin) / Math.log(fMax / fMin);
      const y = padT + (1 - frac) * plotH;
      ctx.strokeStyle = c.gridLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.fillText(label, padL - 5, y);
    }

    if (specGrid) {
      const colW = plotW / cols;
      const bandH = plotH / bands;
      const playedCols = pct * cols;
      for (let col = 0; col < cols; col++) {
        const x = padL + col * colW;
        const played = col <= playedCols;
        const base = col * bands;
        for (let b = 0; b < bands; b++) {
          const val = specGrid[base + b];
          if (val < 0.04) continue;
          const y = padT + plotH - (b + 1) * bandH;
          if (played) {
            const hue = 11 + (1 - val) * 26;
            const lit = c.dark ? (22 + val * 44) : (82 - val * 38);
            const sat = 68 + val * 24;
            ctx.fillStyle = 'hsla(' + hue + ', ' + sat + '%, ' + lit + '%, ' + (0.28 + val * 0.72) + ')';
          } else {
            ctx.fillStyle = c.dark
              ? 'rgba(215, 210, 200, ' + (0.06 + val * 0.56) + ')'
              : 'rgba(45, 42, 36, ' + (0.07 + val * 0.60) + ')';
          }
          ctx.fillRect(x, y, colW + 0.65, bandH + 0.55);
        }
      }
    }

    ctx.textBaseline = 'top';
    ctx.fillStyle = c.muted;
    const tSteps = 4;
    for (let i = 0; i <= tSteps; i++) {
      const frac = i / tSteps;
      const x = padL + frac * plotW;
      ctx.textAlign = i === 0 ? 'left' : i === tSteps ? 'right' : 'center';
      ctx.fillText(duration ? fmtTime(duration * frac) : '00:00', x, padT + plotH + 6);
    }

    if (duration > 0) {
      const headX = padL + Math.max(0, Math.min(1, pct)) * plotW;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(headX, padT);
      ctx.lineTo(headX, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(headX, padT + 3.5, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function syncProgress() {
    const dur = duration || audio.duration || 0;
    const cur = audio.currentTime || 0;
    const pct = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
    lastPct = pct;
    if (!scrubbing) seekInput.value = String(Math.round(pct * 1000));
    scrubFill.style.width = (pct * 100).toFixed(2) + '%';
    curTimeEl.textContent = fmtTime(cur);
    drawSpectrogram(pct);
    if (!audio.paused && !audio.ended) {
      rafId = requestAnimationFrame(syncProgress);
    } else {
      rafId = 0;
    }
  }

  function seekFraction(frac) {
    const dur = duration || audio.duration || 0;
    if (!(dur > 0)) return;
    const clamped = Math.max(0, Math.min(1, frac));
    audio.currentTime = clamped * dur;
    lastPct = clamped;
    seekInput.value = String(Math.round(clamped * 1000));
    scrubFill.style.width = (clamped * 100).toFixed(2) + '%';
    curTimeEl.textContent = fmtTime(audio.currentTime);
    drawSpectrogram(clamped);
  }

  function fractionFromClientX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const plotW = Math.max(40, rect.width - padL - padR);
    return Math.max(0, Math.min(1, (clientX - rect.left - padL) / plotW));
  }

  playBtn.addEventListener('click', () => {
    if (audio.paused || audio.ended) audio.play().catch(() => {});
    else audio.pause();
  });
  replayBtn.addEventListener('click', () => {
    seekFraction(0);
    audio.play().catch(() => {});
  });
  seekInput.addEventListener('input', () => {
    scrubbing = true;
    seekFraction(Number(seekInput.value) / 1000);
  });
  seekInput.addEventListener('change', () => { scrubbing = false; });
  muteBtn.addEventListener('click', () => { audio.muted = !audio.muted; updateVolUI(); });
  volInput.addEventListener('input', () => {
    audio.volume = Number(volInput.value);
    if (audio.volume > 0 && audio.muted) audio.muted = false;
    updateVolUI();
  });

  let pointerActive = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (!(duration > 0)) return;
    pointerActive = true;
    canvas.setPointerCapture(e.pointerId);
    seekFraction(fractionFromClientX(e.clientX));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!(duration > 0)) return;
    const frac = fractionFromClientX(e.clientX);
    const rect = canvas.getBoundingClientRect();
    const plotW = Math.max(40, rect.width - padL - padR);
    specHover.style.left = Math.max(24, Math.min(rect.width - 24, padL + frac * plotW)) + 'px';
    specHover.textContent = fmtTime(frac * duration);
    specHover.classList.add('is-on');
    if (pointerActive) seekFraction(frac);
  });
  canvas.addEventListener('pointerleave', () => { specHover.classList.remove('is-on'); });
  canvas.addEventListener('pointerup', (e) => {
    if (!pointerActive) return;
    pointerActive = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  });
  canvas.addEventListener('pointercancel', () => { pointerActive = false; });

  audio.addEventListener('play', () => {
    setPlayUI(true);
    notifyParent(true);
    if (!rafId) rafId = requestAnimationFrame(syncProgress);
  });
  audio.addEventListener('pause', () => {
    setPlayUI(false);
    notifyParent(false);
    cancelAnimationFrame(rafId);
    rafId = 0;
    drawSpectrogram(lastPct);
  });
  audio.addEventListener('ended', () => {
    setPlayUI(false);
    notifyParent(false);
    cancelAnimationFrame(rafId);
    rafId = 0;
    syncProgress();
  });
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      duration = audio.duration;
      durTimeEl.textContent = fmtTime(duration);
      drawSpectrogram(lastPct);
    }
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.closest('input, button')) {
      e.preventDefault();
      if (!playBtn.disabled) playBtn.click();
    }
  });
  addEventListener('message', (e) => {
    if (e.data?.source === 'sp-arena-audio' && e.data.pause) {
      if (!audio.paused) audio.pause();
    } else if (e.data?.source === 'sp-arena-theme' && ['light', 'dark'].includes(e.data.theme)) {
      document.documentElement.dataset.theme = e.data.theme;
      drawSpectrogram(lastPct);
    }
  });
  if (window.ResizeObserver) new ResizeObserver(() => drawSpectrogram(lastPct)).observe(specBox);
  else addEventListener('resize', () => drawSpectrogram(lastPct));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => drawSpectrogram(lastPct));

  async function init() {
    drawSpectrogram(0);
    try {
      const resp = await fetch('audio.mp3');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const raw = await resp.arrayBuffer();
      const blobUrl = URL.createObjectURL(new Blob([raw], { type: 'audio/mpeg' }));
      audio.src = blobUrl;
      await new Promise((resolve) => {
        if (audio.readyState >= 1) return resolve();
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 4000);
      });
      if (Number.isFinite(audio.duration) && audio.duration > 0) duration = audio.duration;
      const Ctx = window.OfflineAudioContext || window.AudioContext || window.webkitAudioContext;
      const actx = Ctx === window.OfflineAudioContext ? new Ctx(1, 1, 44100) : new Ctx();
      const decoded = await actx.decodeAudioData(raw.slice(0));
      if (actx.close) actx.close().catch(() => {});
      if (!(duration > 0) && decoded.duration > 0) duration = decoded.duration;
      durTimeEl.textContent = fmtTime(duration);
      const srK = ((decoded.sampleRate || 44100) / 1000).toFixed(1).replace(/\.0$/, '');
      const chText = decoded.numberOfChannels === 1 ? '单声道' : '立体声';
      techEl.textContent = fmtTime(duration) + ' · ' + srK + ' kHz · ' + chText;
      computeSpectrogram(decoded);
      specState.classList.add('is-done');
      playBtn.disabled = false;
      replayBtn.disabled = false;
      seekInput.disabled = false;
      statusEl.textContent = '就绪 · 点击播放试听';
      drawSpectrogram(0);
    } catch (err) {
      console.error('音频解析失败：' + (err?.message || err));
      specState.textContent = '音频解码失败，请确认提交的是标准 MP3 文件';
      specState.classList.add('is-error');
      techEl.textContent = '解码失败';
      statusEl.textContent = '无法播放该文件';
    }
  }

  void init();
})();
</script>
</body></html>
`;

export function renderAudioUpload(buffer, filename) {
  const info = validateMp3Buffer(buffer, filename);
  const sha = createHash('sha256').update(buffer).digest('hex');
  const html = STUDIO_HTML_TEMPLATE.replace('__SHA__', sha);
  return {
    files: new Map([['index.html', Buffer.from(html, 'utf8')], ['audio.mp3', buffer]]),
    bytes: buffer.length,
    ...info,
  };
}
