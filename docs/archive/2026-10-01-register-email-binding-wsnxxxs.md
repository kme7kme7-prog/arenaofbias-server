# 2026-10-01 · 注册强制绑定邮箱 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex，GPT-6.1 Sol medium 子代理协助认证实现与测试夹具 / 迁移

## 本轮目标

实现 Gallery `register-email-binding` 前端契约。用户确认只完成后端本地提交；同时确认邮箱限制覆盖 Show1 兼容表态和投票接口。

## 改动

- `POST /api/auth/email/send` 新增无需登录的 register，沿用邮箱格式、占用提示、Turnstile、IP / 邮箱桶、冷却与 SMTP 503 行为；邮件区分注册验证。
- `POST /api/auth/register` 必填 email/code，兼容 name/username，不再校验 Turnstile，保留 auth 桶。验证码仅匹配 register；异步哈希后校验验证码，在同一事务消费验证码、创建已验证邮箱用户。创建失败整体回滚，验证码可重试；不改变公开用户对象或 bind/reset 流程。
- v24 在 `server/db.mjs` 末尾追加幂等迁移，扩展原 email_codes purpose CHECK，保留 bind/reset 记录、主键与过期索引。没有改写旧迁移。
- `bootstrap.user.emailBound` 仅当前会话用户返回。无邮箱账号在题目、上传、草稿 POST/GET/DELETE、两站表态入口返回 403 email_required。Gallery 仍可双盲揭晓，未绑定不写票；Show1 有效投票请求返回 200 counted:false/reason:unbound 且不写对局/票，绑定用户保持既有 201 响应。
- createPlatform/createEmailAuth 支持注入 mailer ready/send，测试捕获验证码后走 send/register；生产仍使用 SMTP，不暴露 HTTP 验证码。调整旧夹具以构建绑定用户或旧无邮箱用户，并同步 README、接口契约和 HANDOFF。

## 验证

- Windows Node 24.16.0：`npm run check` 73 文件 / 0 错；最终 `npm test` 173/173，通过且无取消/跳过；`git diff --check` 通过。
- 新增覆盖注册必填、格式/占用、验证码用途与一次性、过期/错误、发送限流/不可用、注册 INSERT 失败回滚重试、Turnstile 仅发码、v24 保留记录并重复执行、bootstrap 字段隐私、两站旧账号拒绝互动与不写票。现有 bind/reset、密码重置会话撤销、SMTP shutdown 用例通过。
- 首轮全量 171/173：admin voter fixture 仍无邮箱；平台新增 bootstrap 检查导致末尾读请求超过 catalog 默认桶。修复 fixture、仅提高生命周期测试的 catalog 桶到 100，最终全部通过。生产限流不变，专门的读取限流测试照常通过。
- 测试中的邮件发送失败、作品/审计 INSERT 失败等日志来自预期故障注入，无未解决异常。

## 明确没做

未推送、部署、操作生产数据库、修改前端或数据包、验证生产 Node 22、真实 SMTP / Turnstile、Gallery/Show1 浏览器联调。没有新增 npm 依赖或注册绕过开关。

## 遗留物

仅本轮源码、测试与文档本地提交；没有新增业务生成物或持久测试服务。

## 下一步建议

发布前配合 Gallery `register-email-binding`，并核对 Show1 注册表单和 counted:false/unbound 响应消费。前端 smoke 与审计探针先走 send/register，使用本地隔离 mailer 或测试 SMTP 捕获验证码；本轮后端已提供所需注入点与示例辅助函数。上线须检查 SMTP、Turnstile 和 v24 迁移，并完成两站联调。
