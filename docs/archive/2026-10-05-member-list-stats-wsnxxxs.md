# 2026-10-05 · 成员列表统计与最近活跃 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5（Claude Code 桌面版）

## 本轮目标

配合 Gallery「审核 · 管理 · 全部成员」（仅高级管理员），扩充账号列表接口；随后用户要求补最近活跃字段迁移并提交。

## 改动

- `server/auth.mjs`：`list()` 增加 `nickname`、`avatar`、`fixed`、打码 `email`、`emailVerified`、`lastSeenAt`；登录写入 `users.last_seen_at`，`userFrom` 超过 1 分钟才更新；会话查询的 `sessions.last_seen_at` 改别名 `session_seen_at`，避免与新列同名。
- `server/db.mjs`：MIGRATIONS 末尾追加幂等迁移，新增 `users.last_seen_at`，按现存会话最大值回填。
- `server/admin.mjs`：`members()` 用三条分组统计补 `works`（已核验 / 存疑 / 待审 / 内容拒绝，未删除且题目未删除）、`questions`、`votes`，并带 `trusted`、`pendingLimit`。
- `server/library.mjs`：拆出 `trusted()`，`pendingLimit` 复用。
- `server/app.mjs`：`GET /api/admin/users` 返回 `adminService.members(auth.list())`；权限、角色接口与审计不变。
- 测试：用户管理测试断言新字段、邮箱打码、固定标记、计数与库一致、删除会话后最近活跃仍在；新增 `test/last-seen-migration.test.mjs`；`question-references` 的 v39 迁移测试改为断言 `MIGRATIONS.length`。
- `docs/api-contract.md` 同步。以上为本提交。

## 验证

- `npm run check`：97 文件 / 0 错。
- `npm test`：303/303。本轮先后两次失败均已处理：一次批量核验随机端口 `bad port`（既有问题，重跑通过，未改测试设施）；一次 v39 测试把最新版本号写死为 39，新增迁移后改为 `MIGRATIONS.length`。
- Gallery 真实页面联调（临时库）见 Gallery 同日归档。
- 未跑：生产库迁移、Node 22 复验、部署 —— 原因：本轮只做本地提交。

## 明确没做

- 没有推送或部署；没有封禁、强制下线、手动可信。
- `/admin/` 页只读旧字段，未改动。

## 遗留物

- 无。

## 下一步建议

- 与 Gallery 同版本发布；迁移前没有会话的账号最近活跃为空，登录后补上。
