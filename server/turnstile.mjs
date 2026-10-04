// Cloudflare Turnstile verification with Node's built-in fetch.
// Guards password login and the email-code sending endpoint.
// Without both keys the feature is disabled and /api/auth/turnstile returns null.
// 环境变量：
//   TURNSTILE_SITE_KEY     站点密钥（公开，前端 widget 用，经下方接口下发）
//   TURNSTILE_SECRET_KEY   服务器密钥（siteverify 校验用，绝不外发）
//   TURNSTILE_VERIFY_URL   校验地址，默认 Cloudflare 官方；回归测试指向本地桩

export const turnstileSiteKey = () => process.env.TURNSTILE_SITE_KEY || null;
export const turnstileEnabled = () => Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);

// 三态结果：ok 放行 / fail 没过（脚本或 token 过期）/ down 校验服务够不着
export const verifyTurnstile = async (token, ip) => {
  if (!turnstileEnabled()) {
    // An intentionally disabled local challenge differs from a half-configured one.
    return process.env.TURNSTILE_SITE_KEY || process.env.TURNSTILE_SECRET_KEY ? 'down' : 'ok';
  }
  if (typeof token !== 'string' || !token) return 'fail';
  const body = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (ip) body.set('remoteip', ip);
  try {
    const response = await fetch(
      process.env.TURNSTILE_VERIFY_URL ||
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body, signal: AbortSignal.timeout(8000) },
    );
    const data = await response.json();
    return data.success ? 'ok' : 'fail';
  } catch {
    // 宁可暂时拒绝也不放行：Cloudflare 够不着时让真人稍后重试，
    // 好过给刷接口的脚本开天窗
    return 'down';
  }
};
