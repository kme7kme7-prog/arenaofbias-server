// A small Markdown subset. Only our own tags are emitted; user HTML and URLs stay text.
import { fail } from './http.mjs';

const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(value) {
  const tokens = /(`{1,2})([^`\n]+)\1|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let result = '', offset = 0;
  for (const match of value.matchAll(tokens)) {
    result += escape(value.slice(offset, match.index));
    if (match[2] !== undefined) result += `<code>${escape(match[2])}</code>`;
    else if (match[3] !== undefined || match[4] !== undefined) result += `<strong>${escape(match[3] ?? match[4])}</strong>`;
    else result += `<em>${escape(match[5] ?? match[6])}</em>`;
    offset = match.index + match[0].length;
  }
  return result + escape(value.slice(offset));
}

function markdown(text) {
  const lines = text.split('\n');
  const output = [];
  const special = (line) => /^(?: {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|[-+*]\s|\d+[.)]\s)|\s*(?:\*\s*){3,}$|\s*(?:-\s*){3,}$|\s*(?:_\s*){3,}$)/.test(line);
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
    while (i < lines.length && lines[i].trim() && !special(lines[i])) body.push(lines[i++]);
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
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>文本作品</title>
<style>
:root{color-scheme:light dark;background:#faf9f6;color:#252421}*{box-sizing:border-box}body{margin:0;font-family:Georgia,"Noto Serif CJK SC","Songti SC",SimSun,serif;font-size:18px;line-height:1.85}main{max-width:46rem;margin:0 auto;padding:3rem 1.5rem 5rem;overflow-wrap:anywhere}p{margin:0 0 1.25em}h1,h2,h3,h4,h5,h6{line-height:1.4;margin:1.5em 0 .65em}h1{font-size:1.8em}h2{font-size:1.5em}h3{font-size:1.25em}blockquote{margin:1.5em 0;padding-left:1.2em;border-left:3px solid #aaa}code{font-family:ui-monospace,Consolas,monospace;font-size:.85em}pre{padding:1em;background:#eeece7;overflow:auto;white-space:pre-wrap}hr{border:0;border-top:1px solid #aaa;margin:2em 0}@media(prefers-color-scheme:dark){:root{background:#1c1c1b;color:#e5e3de}pre{background:#292927}}@media(max-width:600px){main{padding:1.5rem 1rem 3rem}}
</style></head><body><main>${body}</main></body></html>`;
  return { files: new Map([['index.html', Buffer.from(html)], [`original.${extension}`, buffer]]), isMarkdown, characters };
}
