# 2026-09-30 · 安全防护修复 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex Desktop

## 本轮目标

按用户“请你修复完善，删除临时目录”修复上一轮安全审查的四项问题，并清理审查目录。代码基线为 `c1acdc651859e4596308fc00ce818c20ca107c40`；审查证据见 `2026-09-30-security-review-wsnxxxs.md`。

## 改动

- SR-01：`server/app.mjs` 的数据包静态入口拒绝 HTML/HTM 和解析为 HTML 的目录入口；其他资源附加 `sandbox; default-src 'none'` 和 `no-referrer`，使 SVG/XML 也不能在 API 源执行脚本。管理端保留自身 CSP，数据 JSON 和图片继续分发，作品 HTML 使用独立内容源。
- SR-02：`server/content.mjs` 的请求处理加统一异常出口。畸形 URL 返回 400，读取期间消失的文件返回 404，其他错误记录后返回固定 500 页面；已发头的连接关闭，不再次写响应。
- SR-03：`server/capture.mjs` 在新上下文创建页面前安装路由。文档只能请求当前作品源；GET/HEAD 资源可请求该源或 HTTPS CDN 白名单。禁止自动跟随重定向，每一跳重新验证，最多跟随五跳并释放响应缓存；禁用 Service Worker、关闭 WebSocket。Chromium 使用本机拒绝代理和禁用非代理 WebRTC UDP 的参数，防止未经过路由的浏览器连接直接出站；允许的资源由 `route.fetch()` 取回。默认 HTTP `*.localhost` 在 Node 不解析该域时连接 127.0.0.1，保留原 Host，浏览器 URL 与 origin 不变。
- SR-04：`server/http.mjs` 仅在 `TRUST_PROXY=1` 且连接来自本机环回时信任 XFF 最后一项，使用 Node `isIP` 验证；非本机连接或无效值使用 socket IP。适配现有单层本机 Nginx 布局；部署文档要求边缘覆盖原头或追加真实客户端 IP，多层代理须核实真实 IP 配置。
- 新增 `test/security.test.mjs` 四项针对实际审查问题的回归；同步 README、接口契约、部署文档和 HANDOFF。未新增 npm 依赖、数据库迁移或数据包修改。

## 验证

- 最终 `npm run check`：57 文件、0 错误；`npm test`：122 测试全部通过、0 跳过。
- API 静态入口：根目录、`index.html`、作品目录、作品 HTML 均 404；SVG 响应有无脚本 sandbox；`data.json` 和可信 `/admin/` 仍为 200。
- 隔离子进程通过实际 HTTP 请求连续接收 `//[`、带反斜线的畸形路径、`http://[`：均 400，随后同一进程的正常作品请求 200，进程正常退出。
- 实际登录请求保持转发头尾部 IP 不变、轮换前缀：十次 401 后第十一次 429；直接连接不能用转发头覆盖自身 IP，无效代理头回退。
- 截图路由回归：跨源文档与 CDN 文档拒绝；作品资源正常；CDN 重定向到私有测试端口在取请求前拒绝，CDN 内相对重定向正常；WebSocket 被关闭。
- 使用预装 Playwright 1.62.1 和本地 Chrome 调用实际 `createCapturer()`，未安装软件或修改依赖。正常页面及恶意页面各完成 1440×900、390×844 两档截图；同源资源共成功加载四次，同源资源重定向到另一环回端口被拦截两次，恶意直接 fetch、WebSocket、顶层跳转也未到达该端口，测试接收器合计 0 次请求。
- 默认 `w<32hex>.localhost` 的实际截图在两档均保留原 Host，成功执行 HTTPS jsDelivr 的 Day.js 脚本；页面回报 `typeof dayjs === 'function'` 两次。已查看正常桌面截图和本地域名桌面截图，内容正常渲染。
- 初次定向验证发现测试 fixture 未指定仓库管理端目录，管理员入口误返回 404；修正 fixture 后 39/39 定向通过。随后发现 Windows 系统 DNS 不解析 `*.localhost`，补本地资源映射后最终完整测试及真实截图通过。
- 请求守卫使用 [Playwright route.fetch 文档](https://playwright.dev/docs/api/class-route#route-fetch) 所述 `maxRedirects: 0`，实现逐跳验证；Playwright 最低要求 1.48（上下文 WebSocket 路由）。

## 明确没做

- 未推送、部署、重启生产服务，未读取现有业务库/密钥/日志，未更改 Nginx；历史部署记录未当作本轮线上验收结果。
- 未修改已发布迁移、数据包 pin 或其他轮次文件；没有泛化的代理链解析、额外 npm 依赖或超出四项问题的重构。
- 实际浏览器验证了同源资源到外部端口的重定向；CDN 到私有地址的重定向为路由回归验证，未搭建真实 HTTPS CDN 重定向服务器。未进行浏览器漏洞利用或操作系统级沙箱验证。

## 遗留物

- 本轮 HTTP 服务与 Chrome 已关闭，测试临时库由测试清理。六张截图为本地生成物，位于 `output/audit/security-capture-20260930/`，不入库；上一轮浏览器证据仍在 `output/audit/security-review-20260930-api-origin.png`。
- 用户已明确授权删除 `C:\Users\Ryan\AppData\Local\Temp\arenaofbias-security-review-lAEFO8`。本轮使用已知的确切目录作为目标，以原生 PowerShell `Remove-Item -LiteralPath ... -Recurse -Force` 发起删除；自动审批再次拒绝启动该命令，理由 `blocked by policy`。随后只读确认目录仍存在；未用其他工具或路径绕过拒绝。待人工清理。
- 提交授权沿用用户 initial AGENTS 的“完成实现或者修改后英文简单句 commit 一条”；提交身份已由 `gh api user` 核实为 `wsnxxxs`（ID 269096463），使用本人 noreply 邮箱。推送和上线不在本轮授权范围。

## 下一步建议

审阅后部署本轮代码并重启服务；启用截图的环境先确认 Playwright ≥ 1.48、Chrome 可用。核对边缘 Nginx 的 XFF 覆盖/追加行为、环回监听和独立内容域；上线后验证 API 作品 HTML 为 404、作品内容源仍为 200，再核对截图。无需数据库迁移或数据包切换。
