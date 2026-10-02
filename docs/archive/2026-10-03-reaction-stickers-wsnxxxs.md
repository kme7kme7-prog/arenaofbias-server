# 2026-10-03 · Gallery 表情改为贴纸 id 并清空互动 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5

## 本轮目标

配合 Gallery 前端把 emoji 表情互动换成原创动图贴纸，前后端一起改，并清空现有互动。

## 改动

- server/config.mjs：EMOJIS 改为 `lick, lol, press, luck, yes, drool, knock, stare, no`。
- server/db.mjs：追加迁移，reactions 表存在时整表清空。
- server/profile.mjs：收到的表情只计 EMOJIS 内的 id。
- docs/api-contract.md 示例同步；test/platform.test.mjs 改用新 id，并断言旧 emoji 返回 400。
- test/auth-security.test.mjs：会话迁移测试原用 `MIGRATIONS.at(-1)`，追加迁移后失效；改为固定 `MIGRATIONS[31]`。与工作区 model_vendor 轮次的同一处未提交改动完全一致，一并纳入。

## 决策

- 用户确认清空全部 reactions，包括 Show1 的 👍/👀/🤯 表态；show1compat 映射与写入不变，上线后 Show1 从零计数。
- 工作区未提交的 model_vendor 迁移顺延到本条之后，提交只含本条，迁移顺序与提交一致。

## 验证

- `npm run check`：87 文件 / 0 错。
- `npm test`：工作区 248/248；仅含本次提交的独立快照 244/244。
- 未跑：生产迁移与真实前端联调 —— 原因：本轮未部署。

## 明确没做

- 未推送、未部署，未在生产库执行迁移。

## 遗留物

- 工作区其他未提交改动（审核规则、vendor、CSP 等）属他人轮次，未纳入本次提交。本地库若已跑过 model_vendor 迁移，user_version 会越过本条。

## 下一步建议

- 与 Gallery 前端同版本上线。
