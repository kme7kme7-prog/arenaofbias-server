// A small Markdown subset with pipe tables and TeX math. Only our own tags are emitted; user HTML
// and URLs stay text.
import { fail } from './http.mjs';

const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist';

const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Math leaves as escaped TeX in a .math element that KaTeX renders in the page; without KaTeX the
// source stays readable. `$` follows Pandoc: no space after the opening one, none before the closing
// one and no digit after it, so "$5 and $10" stays text. `\$` is a literal dollar. Code wins over math.
const math = (tex, display = false) => `<span class="math"${display ? ' data-display' : ''}>${escape(tex.trim())}</span>`;
// An underscore inside a word (a_1) does not start emphasis.
const INLINE = /\\\$|(`{1,2})([^`\n]+)\1|\$\$([^$\n]+?)\$\$|\\\((.+?)\\\)|\$([^\s$](?:[^$\n]*?[^\s\\$])?)\$(?!\d)|\*\*([^*\n]+)\*\*|(?<![\p{L}\p{N}])__([^_\n]+)__(?![\p{L}\p{N}])|\*([^*\n]+)\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu;

function inline(value) {
  let result = '', offset = 0;
  for (const match of value.matchAll(INLINE)) {
    result += escape(value.slice(offset, match.index));
    if (match[0] === '\\$') result += '$';
    else if (match[2] !== undefined) result += `<code>${escape(match[2])}</code>`;
    else if (match[3] !== undefined) result += math(match[3], true);
    else if (match[4] !== undefined || match[5] !== undefined) result += math(match[4] ?? match[5]);
    else if (match[6] !== undefined || match[7] !== undefined) result += `<strong>${inline(match[6] ?? match[7])}</strong>`;
    else result += `<em>${inline(match[8] ?? match[9])}</em>`;
    offset = match.index + match[0].length;
  }
  return result + escape(value.slice(offset));
}

// Pipe tables: a header row, a divider with the same number of cells, then rows until a blank line.
// A literal pipe inside a cell, math included, is written \|.
const cells = (row) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
const DIVIDER = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const alignOf = (cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');

function markdown(text) {
  const lines = text.split('\n');
  const output = [];
  const special = (line) => /^(?: {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|[-+*]\s|\d+[.)]\s|\$\$|\\\[)|\s*(?:\*\s*){3,}$|\s*(?:-\s*){3,}$|\s*(?:_\s*){3,}$)/.test(line);
  const tableAt = (i) => i + 1 < lines.length && lines[i].includes('|') && lines[i + 1].includes('|') && DIVIDER.test(lines[i + 1])
    && cells(lines[i]).length === cells(lines[i + 1]).length;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})[^\n]*$/);
    if (fence) {
      const body = [];
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      i++;
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      output.push(`<pre><code>${escape(body.join('\n'))}</code></pre>`);
      continue;
    }
    // A display formula, $$ … $$ or \[ … \], alone on its line or spread over lines without a blank one.
    const open = line.match(/^ {0,3}(\$\$|\\\[)(.*)$/);
    if (open) {
      const close = open[1] === '$$' ? '$$' : '\\]';
      const at = open[2].indexOf(close);
      let end = at === -1 ? i + 1 : at === open[2].trimEnd().length - close.length ? i : -1;
      if (at === -1) while (end < lines.length && lines[end].trim() && !lines[end].trimEnd().endsWith(close)) end++;
      if (end !== -1 && end < lines.length && lines[end].trim()) {
        const tex = [open[2], ...lines.slice(i + 1, end + 1)].join('\n').trimEnd().slice(0, -close.length);
        output.push(`<div class="math" data-display>${escape(tex.trim())}</div>`);
        i = end + 1;
        continue;
      }
    }
    if (tableAt(i)) {
      const head = cells(line), aligns = cells(lines[i + 1]).map(alignOf);
      const cell = (tag, text, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(text ?? '')}</${tag}>`;
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
        const row = cells(lines[i]);
        rows.push(`<tr>${head.map((_, k) => cell('td', row[k], k)).join('')}</tr>`);
      }
      output.push(`<div class="table"><table><thead><tr>${head.map((text, k) => cell('th', text, k)).join('')}</tr></thead>${rows.length ? `<tbody>${rows.join('')}</tbody>` : ''}</table></div>`);
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) { output.push('<hr>'); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      output.push(`<blockquote><p>${body.map(inline).join('<br>')}</p></blockquote>`);
      continue;
    }
    const list = line.match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const itemPattern = ordered ? /^ {0,3}\d+[.)]\s+(.+)$/ : /^ {0,3}[-+*]\s+(.+)$/;
      const items = [];
      let item;
      while (i < lines.length && (item = lines[i].match(itemPattern))) { items.push(`<li>${inline(item[1])}</li>`); i++; }
      const tag = ordered ? 'ol' : 'ul';
      output.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const body = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !special(lines[i]) && !tableAt(i)) body.push(lines[i++]);
    output.push(`<p>${body.map(inline).join('<br>')}</p>`);
  }
  return output.join('\n');
}

export function renderTextUpload(buffer, filename) {
  const extension = filename.match(/\.(txt|md|markdown)$/i)?.[1].toLowerCase();
  if (!extension) fail(400, '文本作品请上传单个 .txt、.md 或 .markdown 文件');
  if (buffer.length >= 4 && [0x04034b50, 0x06054b50, 0x02014b50].includes(buffer.readUInt32LE(0))) fail(400, '文本作品不接受 ZIP 压缩包');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { fail(400, '文本文件必须使用 UTF-8 编码'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail(400, '请上传文本文件，不能包含二进制内容');
  const characters = Array.from(text).length;
  if (characters > 200000) fail(413, '文本作品不能超过 200000 字符');
  if (!text.trim()) fail(400, '文本文件是空的');
  text = text.replace(/\r\n?/g, '\n');
  const isMarkdown = extension !== 'txt';
  const body = isMarkdown ? markdown(text) : text.split(/\n\s*\n/).map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`).join('\n');
  // Only pages with math load KaTeX, pinned and checked, from the CDN path the content CSP allows.
  const katex = body.includes('class="math"') ? `
<link rel="stylesheet" href="${KATEX}/katex.min.css" integrity="sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA" crossorigin="anonymous">
<script defer src="${KATEX}/katex.min.js" integrity="sha384-CwjPRVHTvLiMBFjEoij+QZViMV5rhTOIp7CJzl24JEqpRDA1sJFHVXXLURktbYYp" crossorigin="anonymous"></script>
<script>addEventListener('DOMContentLoaded',()=>{if(!window.katex)return;for(const el of document.querySelectorAll('.math'))try{katex.render(el.textContent,el,{displayMode:el.hasAttribute('data-display'),throwOnError:false})}catch{}})</script>` : '';
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>文本作品</title>${katex}
<style>
:root{color-scheme:light dark;background:#faf9f6;color:#252421}*{box-sizing:border-box}body{margin:0;font-family:Georgia,"Noto Serif CJK SC","Songti SC",SimSun,serif;font-size:18px;line-height:1.85}main{max-width:46rem;margin:0 auto;padding:3rem 1.5rem 5rem;overflow-wrap:anywhere}p{margin:0 0 1.25em}h1,h2,h3,h4,h5,h6{line-height:1.4;margin:1.5em 0 .65em}h1{font-size:1.8em}h2{font-size:1.5em}h3{font-size:1.25em}blockquote{margin:1.5em 0;padding-left:1.2em;border-left:3px solid #aaa}code{font-family:ui-monospace,Consolas,monospace;font-size:.85em}pre{padding:1em;background:#eeece7;overflow:auto;white-space:pre-wrap}hr{border:0;border-top:1px solid #aaa;margin:2em 0}.table{margin:0 0 1.25em;overflow-x:auto}table{border-collapse:collapse;font-size:.9em;line-height:1.6}th,td{padding:.4em .75em;border:1px solid #c9c6bf}th{background:#eeece7}div.math{margin:0 0 1.25em;overflow-x:auto;overflow-y:hidden}@media(prefers-color-scheme:dark){:root{background:#1c1c1b;color:#e5e3de}pre,th{background:#292927}th,td{border-color:#4a4946}}@media(max-width:600px){main{padding:1.5rem 1rem 3rem}}
</style></head><body><main>${body}</main></body></html>`;
  return { files: new Map([['index.html', Buffer.from(html)], [`original.${extension}`, buffer]]), isMarkdown, characters, math: Boolean(katex) };
}
