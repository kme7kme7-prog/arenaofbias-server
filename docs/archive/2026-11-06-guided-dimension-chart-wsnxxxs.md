# 2026-11-06 · 引导式盲评维度图 · wsnxxxs

- 负责人：wsnxxxs（GitHub ID 269096463，269096463+wsnxxxs@users.noreply.github.com）｜执行 AI：Claude Opus 5.5（Claude Code）。
- 范围：本仓起点 `2e75ad3`（origin/main）；配套 Gallery 同日同名归档。用户确认「现在做」，按上一轮流程提交、推送、开 PR 合并并部署。
- 本文写于发布准备时点。线上安装与验收记在服务器 `/root/aob-guided-trial-20261106/RECEIPT.md` 的维度图一节，不在此预填成功状态。

## 本轮目标

测试版上线后，用户问模型的维度图是否已做。确认没做后，用户选择先做只给管理员看的版本：后端按模型汇总引导题的胜负，Gallery 测试版画成雷达图。

## 改动

- `server/aspects.mjs`：新增 `trialStandings`，按条目统计各维度、各测评点以及同批对局综合题的胜、平、负次数。只计带测评点的测试对局；两边同属一个条目的一对不计。
- `server/arena.mjs`：新增 `guidedDimensions(user, by)`，仅普通与高级管理员可用。归属取抽组时记下的身份快照，默认按模型归并，`by=config` 按配置；非高级管理员看不到受限作品，与榜单一致。
- `server/app.mjs`：`GET /api/arena/guided/dimensions?by=model|config`。未登录 401，非管理员 403 `guided-staff-only`。
- `test/guided-trial.test.mjs`：权限、计数、按配置、受限作品过滤，以及纯函数的跳过规则与排序。
- `docs/api-contract.md`：§1.1 补一句，新增 §3.9.1。

## 决策

- 接口只返回次数，胜率由页面计算。不做缓存，每次直接读 `guided_trial_votes`，测试数据量小。
- 不改表结构，没有迁移；`votes` 和所有榜单不受影响。

## 验证

- `npm run check`：180 文件，0 错误。`npm test`：598/598。
- 本地 `.demo/` 后端：未登录返回 401；管理员按模型、按配置返回 160 组模拟测试票的统计，Gallery 测试版据此正常绘制。

## 明确没做

- 不进任何榜单，不做缓存，不提供公开读取。

## 遗留物

- 无。本地演示库里的模拟测试票见 Gallery 同名归档。

## 下一步建议

- 试用结束清理 `guided_*` 数据时，维度图会一起清空。数据量变大后再考虑缓存或改用 Bradley–Terry。
