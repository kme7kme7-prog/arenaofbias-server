import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectUpload } from '../server/inspect.mjs';

const inspect = (text, filename = 'work.md') => inspectUpload(Buffer.isBuffer(text) ? text : Buffer.from(text), filename, { limits: {}, cdn: [], template: 'text' });

test('text uploads render a self contained Markdown subset and retain original bytes', () => {
  const source = Buffer.from('\ufeff# 标题\r\n\r\n正文 **粗体**、*斜体*、`代码`。\r\n\r\n- 第一项\r\n- 第二项\r\n\r\n1. 有序项\r\n\r\n> 引用\r\n> 第二行\r\n\r\n---\r\n\r\n```html\r\n<div>代码</div>\r\n```');
  const result = inspect(source, '../../投稿.MARKDOWN');
  assert.equal(result.kind, 'text');
  assert.equal(result.entry, 'index.html');
  assert.equal(result.root, '');
  assert.equal(result.count, 2);
  assert.deepEqual(result.files.get('original.markdown'), source);
  const html = result.files.get('index.html').toString();
  for (const fragment of ['<h1>标题</h1>', '<strong>粗体</strong>', '<em>斜体</em>', '<code>代码</code>', '<ul><li>第一项</li><li>第二项</li></ul>', '<ol><li>有序项</li></ol>', '<blockquote><p>引用<br>第二行</p></blockquote>', '<hr>', '<pre><code>&lt;div&gt;代码&lt;/div&gt;</code></pre>', 'prefers-color-scheme:dark']) assert.ok(html.includes(fragment), fragment);
  assert.match(result.checks[0].detail, /^识别为 Markdown · 约 [\d,]+ 字/);
  assert.ok(!result.checks.some((check) => check.id === 'readme'));
  assert.equal(result.checks.find((check) => check.id === 'external').state, 'ok');
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test('text uploads escape raw HTML, code and link or image syntax without external requests', () => {
  const result = inspect('<script>alert(1)</script>\n\n<img src="https://evil.invalid/a">\n\n![picture](https://evil.invalid/a)\n\n[click](javascript:alert(1))\n\n**<iframe src="x">**\n\n```\n</code><script>alert(2)</script>\n```');
  const html = result.files.get('index.html').toString();
  assert.doesNotMatch(html, /<(?:script|img|iframe|a)\b/i);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('<strong>&lt;iframe src=&quot;x&quot;&gt;</strong>'));
  assert.ok(html.includes('&lt;/code&gt;&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.equal(result.checks.find((check) => check.id === 'external').state, 'ok');
});

test('plain text keeps paragraphs and line breaks without Markdown formatting', () => {
  const result = inspect('# 字面标题\r\n第二行\r\n\r\n**字面粗体** <b>原文</b>', 'work.txt');
  const html = result.files.get('index.html').toString();
  assert.ok(html.includes('<p># 字面标题<br>第二行</p>'));
  assert.ok(html.includes('<p>**字面粗体** &lt;b&gt;原文&lt;/b&gt;</p>'));
  assert.match(result.checks[0].detail, /^识别为 纯文本 · 约 [\d,]+ 字/);
});

test('text uploads reject unsupported extensions, ZIP, binary, invalid UTF-8 and oversized text', () => {
  for (const name of ['work.html', 'work.htm', 'work.zip', 'work.pdf']) assert.throws(() => inspect('文字', name), /单个 .txt/);
  for (const bytes of [Buffer.from('PK\x03\x04pretend'), Buffer.from('PK\x05\x06pretend'), Buffer.from('PK\x01\x02pretend')]) assert.throws(() => inspect(bytes, 'disguised.md'), /ZIP/);
  assert.throws(() => inspect(Buffer.from([0xe4, 0xb8])), /UTF-8/);
  assert.throws(() => inspect('text\x00binary'), /二进制/);
  assert.throws(() => inspect(' \n\t'), /空/);
  assert.throws(() => inspect('文'.repeat(200001)), (error) => error.status === 413);
  assert.equal(inspect('😀'.repeat(200000), 'emoji.txt').kind, 'text');
  const unclosedCode = 'x' + '`'.repeat(199999);
  assert.ok(inspect(unclosedCode).files.get('index.html').toString().includes(`<p>${unclosedCode}</p>`));
});
