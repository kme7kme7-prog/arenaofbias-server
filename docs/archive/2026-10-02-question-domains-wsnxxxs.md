# 2026-10-02 · 题目领域与排行榜领域范围 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Code

## 本轮目标

配合 Gallery 的「形式 + 领域」两轴：社区题目保存领域，bootstrap 下发词表，排行榜按领域收窄，并统一「有效比较」口径。

## 改动

均在本条提交内。

- server/categories.mjs：DOMAINS（11 个）、requireDomains（1–2 个、在词表内、去重）。
- server/db.mjs：v29 幂等追加 `questions.domains TEXT NOT NULL DEFAULT '[]'`，不回填。
- server/questions.mjs：创建时 `domains` 选填（旧 Gallery 不传仍可发起）、带上即校验；通过时可替换，audit 记 `domains: {from, to}`；视图输出 `domains`。
- server/catalog.mjs 读取数据包 task.domains；server/app.mjs bootstrap 顶层 `domains`，`/api/leaderboard` 新增 `domain` 参数校验。
- server/arena.mjs：领域范围（可与 category 叠加、不与 task 同用），缓存键含 domain，有 domain 时不出 standings；`totals.votes/voters` 只数实际计分的比较，新增 `totals.tasks`。
- 测试：questions、platform、blind-pool 新增用例，admin 旧断言补 `tasks`；docs/api-contract.md 同步 3.1、3.10、3.14、v29；HANDOFF.md。

## 决策

- 领域榜与形式榜同法：只取含该领域的题目的票重新拟合 Bradley–Terry，一题两领域两边完整计入。
- 同一计分单位两件作品之间的票不计分，也不再计入有效比较，修正此前「按模型」时数字偏多。
- 后台不强制领域，前端必选；旧客户端兼容。

## 验证

- Windows Node 24.16.0：`npm test` 213/213、`npm run check` 81/0、本轮文件 diff --check 通过。
- 未跑：生产或本地业务库迁移、部署 —— 未授权。

## 明确没做

未推送、未部署、未改 datapack pin，未给已上线社区题目补领域。

## 遗留物

另一会话的未提交改动（红队加固：auth、capture、moderation、mail、content、inspect、config；作品审核：admin、library、v30 迁移及相关测试、deploy 文档）仍在工作区与暂存区，未纳入本提交。其暂存的 api-contract、admin/platform 测试若不重新 add 就提交，会撤回本轮改动。

## 下一步建议

数据包发布并改 pin 后部署；管理员在审核里补齐社区题目领域。
