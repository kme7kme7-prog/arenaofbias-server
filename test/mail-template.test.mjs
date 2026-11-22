import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderVerificationEmail } from '../server/mail-template.mjs';
import { buildMessage } from '../server/mail.mjs';

const envelope = { from: 'account@example.test', fromName: '亿模亿样', to: 'reader@example.test' };

for (const [purpose, action] of [['register', '注册账号'], ['bind', '绑定邮箱'], ['reset', '重置密码']]) {
  test(`${purpose} mail preserves the code, purpose and expiry in both formats`, () => {
    const mail = renderVerificationEmail({ purpose, code: '008169', expiresInMs: 300000 });
    assert.ok(mail.subject.includes(action));
    for (const body of [mail.html, mail.text]) {
      assert.ok(body.includes('008169'));
      assert.ok(body.includes(action));
      assert.ok(body.includes('5 分钟'));
      assert.ok(!body.includes('10 分钟'));
    }
    assert.match(mail.html, /<strong[^>]+>008169<\/strong>/);
    assert.doesNotMatch(mail.subject, /008169/);
    assert.doesNotMatch(mail.html.match(/<div[^>]*>(.*?)<\/div>/s)[1], /008169/);
    assert.doesNotMatch(mail.html, /<(script|iframe|form|input|img|svg)\b|@import|url\(/i);
    assert.ok(Buffer.byteLength(mail.html) < 25000);
  });
}

test('registered notice never renders a supplied code or promises a code', () => {
  const mail = renderVerificationEmail({ purpose: 'registered', code: '008169' });
  for (const body of [mail.html, mail.text]) {
    assert.ok(!body.includes('008169'));
    assert.ok(body.includes('没有生成验证码'));
    assert.ok(body.includes('找回密码'));
  }
  assert.ok(!mail.html.includes('class="mail-code"'));
});

test('untrusted codes and unsupported purposes are rejected before building HTML', () => {
  for (const code of ['<img src=x>', '123456\r\nBcc:x', '12345', 123456]) {
    assert.throws(() => renderVerificationEmail({ purpose: 'register', code }), TypeError);
  }
  for (const purpose of ['login', '__proto__', 'constructor']) {
    assert.throws(() => renderVerificationEmail({ purpose, code: '123456' }), TypeError);
  }
  for (const expiresInMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => renderVerificationEmail({ purpose: 'register', code: '123456', expiresInMs }), TypeError);
  }
  assert.match(renderVerificationEmail({ purpose: 'register', code: '123456', expiresInMs: 90000 }).text, /90 秒/);
});

test('SMTP message has independently decodable text and HTML alternatives with CRLF framing', () => {
  const mail = renderVerificationEmail({ purpose: 'register', code: '008169' });
  const wire = buildMessage({ ...envelope, ...mail });
  const boundary = wire.match(/multipart\/alternative; boundary="([^"]+)"/)[1];
  const chunks = wire.split(`--${boundary}`);
  assert.equal(chunks.length, 4);
  const bodies = chunks.slice(1, 3).map((part, index) => {
    const [headers, body] = part.trim().split('\r\n\r\n');
    assert.match(headers, new RegExp(`Content-Type: text/${index === 0 ? 'plain' : 'html'}; charset=UTF-8`));
    assert.match(headers, /Content-Transfer-Encoding: base64/);
    assert.ok(body.split('\r\n').every(line => line.length <= 76));
    return Buffer.from(body, 'base64').toString('utf8');
  });
  assert.deepEqual(bodies, [mail.text, mail.html]);
  assert.equal(chunks[3], '--\r\n');
  assert.doesNotMatch(wire.replaceAll('\r\n', ''), /[\r\n]/);
  assert.ok(wire.includes(`Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString('base64')}?=`));
  assert.ok(!buildMessage({ ...envelope, ...mail }).includes(boundary));
});

test('existing text-only messages still work, including empty bodies', () => {
  for (const text of ['', '原有通知\n.第一行']) {
    const wire = buildMessage({ ...envelope, subject: '通知', text });
    assert.match(wire, /Content-Type: text\/plain/);
    assert.doesNotMatch(wire, /multipart\/alternative/);
    assert.equal(Buffer.from(wire.split('\r\n\r\n')[1].trim(), 'base64').toString('utf8'), text);
  }
});
