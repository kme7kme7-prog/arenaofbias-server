// Gallery account mail. Inline styles and presentation tables are the baseline;
// media queries enhance narrow screens and clients that support dark mode.
const SANS = "'PingFang SC', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif";
// Use a contemporary book face where available; fall back to a clear system
// sans instead of Windows' small-size bitmap Song font. No font download needed.
const SERIF = "'Noto Serif SC', 'Source Han Serif SC', 'Source Han Serif CN', 'Songti SC', 'Noto Serif CJK SC', 'PingFang SC', 'Microsoft YaHei', serif";
const LATIN = "'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif";
const NUMERALS = "'Avenir Next', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PURPOSES = {
  register: { label: '注册账号', action: '注册账号并验证邮箱', title: '验证你的邮箱', en: 'VERIFY YOUR EMAIL', note: '请在刚才的注册页面输入下方验证码，完成邮箱验证。' },
  bind: { label: '绑定邮箱', action: '绑定邮箱', title: '关联你的邮箱', en: 'CONNECT YOUR EMAIL', note: '请在账号设置页面输入下方验证码，完成邮箱绑定。' },
  reset: { label: '重置密码', action: '重置密码', title: '重设你的密码', en: 'RESET YOUR PASSWORD', note: '请在找回密码页面输入下方验证码，继续设置新密码。' },
};

function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError('Invalid verification code lifetime');
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

// Recreate the site's simple geometric mark with tables, so blocked images or
// missing SVG support never hide the identity or the verification code.
const logo = `<table role="presentation" width="36" height="36" cellspacing="0" cellpadding="0" border="0" bgcolor="#1c1b19" style="width:36px;height:36px;background-color:#1c1b19;border-radius:8px;"><tr><td align="center" valign="middle"><table role="presentation" width="20" cellspacing="0" cellpadding="0" border="0" style="width:20px;"><tr><td colspan="3" height="5" bgcolor="#f5f4f0" style="height:5px;line-height:5px;font-size:0;background-color:#f5f4f0;">&nbsp;</td></tr><tr><td colspan="3" height="4" style="height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr><tr><td width="8" height="5" bgcolor="#f5f4f0" style="width:8px;height:5px;line-height:5px;font-size:0;background-color:#f5f4f0;">&nbsp;</td><td width="4" style="width:4px;font-size:0;">&nbsp;</td><td width="8" bgcolor="#e46a50" style="width:8px;background-color:#e46a50;font-size:0;">&nbsp;</td></tr></table></td></tr></table>`;

function document({ title, en, label, preheader, intro, content, safety }) {
  return `<!doctype html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>亿模亿样 · ${esc(label)}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
    @media screen and (min-width:621px) {
      .mail-pad { padding-left:40px !important; padding-right:40px !important; }
      .mail-code { font-size:58px !important; letter-spacing:8px !important; }
      .code-pad { padding:24px 28px !important; }
    }
    @media screen and (max-width:620px) {
      .mail-outer { padding:20px 10px !important; }
      .mail-pad { padding-left:24px !important; padding-right:24px !important; }
      .mail-heading { font-size:30px !important; line-height:1.5 !important; }
      .mail-code { font-size:42px !important; letter-spacing:5px !important; }
      .code-pad { padding:22px 18px !important; }
      .mail-brand-note { font-size:10px !important; letter-spacing:1px !important; }
      .mail-footer-link { font-size:10px !important; }
    }
    @media (prefers-color-scheme:dark) {
      .mail-bg { background-color:#121211 !important; }
      .mail-sheet { background-color:#191918 !important; border-color:#3b3a36 !important; }
      .mail-ink { color:#ecebe6 !important; }
      .mail-secondary { color:#bcb9b1 !important; }
      .mail-muted { color:#a19d95 !important; }
      .mail-line { border-color:#3b3a36 !important; }
      .mail-accent { color:#e46a50 !important; }
      .mail-panel { background-color:#222220 !important; border-color:#3b3a36 !important; }
      .mail-code { color:#ecebe6 !important; }
    }
  </style>
</head>
<body class="mail-bg" bgcolor="#eeede8" style="margin:0;padding:0;background-color:#eeede8;color:#1c1b19;font-family:${SANS};">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="mail-bg" bgcolor="#eeede8" style="width:100%;background-color:#eeede8;">
    <tr><td class="mail-outer" align="center" style="padding:40px 16px;">
      <!--[if mso]><table role="presentation" width="600" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="mail-sheet" bgcolor="#fbfaf8" style="width:100%;max-width:600px;background-color:#fbfaf8;border:1px solid #d0cdc5;">
        <tr><td height="3" bgcolor="#bf3f28" style="height:3px;line-height:3px;font-size:0;background-color:#bf3f28;">&nbsp;</td></tr>
        <tr><td class="mail-pad" style="padding:27px 24px 25px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td width="48" valign="middle" style="width:48px;">${logo}</td>
            <td valign="middle"><p class="mail-ink" style="margin:0;color:#1c1b19;font-family:${SANS};font-size:19px;line-height:26px;font-weight:600;letter-spacing:1px;">亿模亿样</p></td>
            <td align="right" valign="middle"><p class="mail-brand-note mail-muted" style="margin:0;color:#74716a;font-family:${SANS};font-size:10px;line-height:19px;letter-spacing:1px;">展览馆 · 账号服务<br><span style="font-family:${LATIN};font-size:9px;font-weight:500;letter-spacing:1.6px;">ARENA GALLERI</span></p></td>
          </tr></table>
        </td></tr>
        <tr><td class="mail-pad" style="padding:0 24px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="mail-line" style="border-top:1px solid #e3e1db;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
        <tr><td class="mail-pad" style="padding:32px 24px 25px;">
          <p class="mail-muted" style="margin:0 0 16px;color:#74716a;font-family:${LATIN};font-size:10px;font-weight:500;line-height:18px;letter-spacing:1.6px;">ACCOUNT / ${esc(en)}</p>
          <h1 class="mail-heading mail-ink" style="margin:0 0 18px;color:#1c1b19;font-family:${SERIF};font-weight:600;font-size:38px;line-height:1.5;letter-spacing:.2px;">${esc(title)}<span class="mail-accent" style="color:#bf3f28;">。</span></h1>
          <p class="mail-secondary" style="margin:0;color:#4a4843;font-family:${SANS};font-size:14px;line-height:2;letter-spacing:.15px;">${intro}</p>
        </td></tr>
        <tr><td class="mail-pad" style="padding:0 24px 28px;">${content}</td></tr>
        <tr><td class="mail-pad" style="padding:0 24px 30px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td width="16" valign="top" class="mail-accent" style="width:16px;padding-top:2px;color:#bf3f28;font-size:14px;line-height:22px;">·</td>
            <td><p class="mail-secondary" style="margin:0 0 5px;color:#4a4843;font-family:${SANS};font-size:12px;line-height:23px;">${safety}</p><p class="mail-muted" style="margin:0;color:#74716a;font-family:${SANS};font-size:12px;line-height:23px;">如非本人操作，请忽略此邮件。</p></td>
          </tr></table>
        </td></tr>
        <tr><td class="mail-pad mail-line" style="padding:24px 24px 26px;border-top:1px solid #e3e1db;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td valign="top"><p class="mail-ink" style="margin:0 0 8px;color:#1c1b19;font-family:${SERIF};font-size:16px;font-weight:500;line-height:28px;letter-spacing:.25px;">同一份提示词，不同的表达。</p><p class="mail-muted" style="margin:0;color:#74716a;font-family:${SANS};font-size:10px;line-height:19px;letter-spacing:.4px;">亿模亿样 × 偏见试验场 · 共享账号</p></td>
            <td width="35" align="right" valign="top" aria-hidden="true" class="mail-accent" style="width:35px;color:#bf3f28;font-family:Georgia,serif;font-size:32px;line-height:32px;">↗</td>
          </tr></table>
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;"><tr><td align="center" style="padding:18px 8px 0;">
        <p style="margin:0 0 6px;font-family:${SANS};font-size:11px;line-height:20px;"><a class="mail-footer-link mail-muted" href="https://gallery.arenaofbias.icu/" style="color:#74716a;text-decoration:none;font-family:${LATIN};">gallery.arenaofbias.icu</a><span class="mail-muted" style="color:#74716a;">&nbsp; / &nbsp;</span><a class="mail-footer-link mail-muted" href="https://game.arenaofbias.icu/" style="color:#74716a;text-decoration:none;font-size:11px;">偏见试验场</a></p>
        <p class="mail-muted" style="margin:0;color:#74716a;font-family:${SANS};font-size:11px;line-height:20px;">本邮件由账号系统自动发送。</p>
      </td></tr></table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderVerificationEmail({ code, purpose, expiresInMs = 600000 }) {
  if (purpose === 'registered') {
    const notice = '这个邮箱已经绑定了一个现有账号，本次注册请求没有生成验证码。';
    const next = '如果是你本人，请直接登录；忘记密码可在登录页选择「找回密码」。';
    return {
      subject: '亿模亿样 · 注册提醒',
      text: `${notice}\n\n${next}\n\n如非本人操作，请忽略此邮件。\n\n亿模亿样 × 偏见试验场 · 共享账号\nhttps://gallery.arenaofbias.icu/`,
      html: document({ title: '这个邮箱已注册', en: 'REGISTRATION NOTICE', label: '注册提醒', preheader: notice,
        intro: esc(notice),
        content: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="mail-panel" bgcolor="#f5f4f0" style="width:100%;background-color:#f5f4f0;border:1px solid #e3e1db;"><tr><td style="padding:24px;"><p class="mail-ink" style="margin:0 0 8px;color:#1c1b19;font-size:15px;line-height:24px;font-weight:600;">继续使用已有账号</p><p class="mail-secondary" style="margin:0;color:#4a4843;font-size:13px;line-height:24px;">${esc(next)}</p></td></tr></table>`,
        safety: '本次请求不会新建账号，也不会修改已有密码。' }),
    };
  }
  const copy = Object.hasOwn(PURPOSES, purpose) ? PURPOSES[purpose] : null;
  if (!copy) throw new TypeError('Unsupported verification email purpose');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new TypeError('Expected a six-digit verification code');
  const duration = durationLabel(expiresInMs);
  const intro = `你正在${copy.action}。<br>${esc(copy.note)}`;
  const safety = '请勿将验证码转发或告知他人，工作人员不会向你索取。';
  return {
    subject: `亿模亿样 · ${copy.label}验证码`,
    text: [`你正在${copy.action}。`, copy.note, '', code, '', `验证码 ${duration}内有效，且只能使用一次。`, safety, '如非本人操作，请忽略此邮件。', '', '亿模亿样 × 偏见试验场 · 共享账号', 'https://gallery.arenaofbias.icu/'].join('\n'),
    html: document({ ...copy, preheader: `${copy.label}验证码 · ${duration}内有效。请返回原页面完成验证。`, intro, safety,
      content: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="mail-panel" bgcolor="#f5f4f0" style="width:100%;background-color:#f5f4f0;border:1px solid #d0cdc5;border-left:3px solid #bf3f28;"><tr><td class="code-pad" style="padding:22px 18px;">
          <p class="mail-accent" style="margin:0 0 14px;color:#bf3f28;font-family:${LATIN};font-size:10px;font-weight:600;line-height:18px;letter-spacing:1.5px;">VERIFICATION CODE / 验证码</p>
          <p style="margin:0 0 18px;line-height:1;"><strong class="mail-code" dir="ltr" style="display:inline-block;color:#1c1b19;font-family:${NUMERALS};font-size:42px;line-height:1.2;font-weight:600;font-variant-numeric:lining-nums tabular-nums;letter-spacing:5px;white-space:nowrap;">${code}</strong></p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="mail-line" style="padding-top:14px;border-top:1px solid #d0cdc5;"><p class="mail-secondary" style="margin:0;color:#4a4843;font-family:${SANS};font-size:11px;line-height:21px;">${esc(duration)}内有效<span class="mail-muted" style="color:#74716a;">&nbsp;&nbsp; / &nbsp;&nbsp;仅可使用一次</span></p></td></tr></table>
        </td></tr></table>` }),
  };
}
