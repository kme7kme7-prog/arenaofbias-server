# 2026-09-30 · 作品来源维度第 4 轮（榜单筛选） · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5（Claude Code 桌面版）

## 本轮目标

排行榜可按 Harness、服务商筛选，但不把两者并入计分配置，历史票计分不受影响。配套：Show2 榜单页（wsnxxxs/same-prompt-gallery `provenance-round4`）、数据仓收录传递来源（kme7kme7-prog/arenaofbias-data `provenance-intake`）。

## 改动

- 基线 `origin/main@31651f3`（第 2、3 轮，已于 2026-09-30 部署）。无迁移，数据包 pin 不变。
- `server/arena.mjs`：`leaderboard()` 接受 `harness`、`provider`（`null`、注册表 ID 或 `unset`）。一张票只有两侧身份快照（有更正时取更正）都满足条件才计入；快照只存 ID，自填「其他」与旧快照都视为 `unset`。作品池（`unranked` 与 `works` 计数）按作品当前字段筛选。带筛选时响应多 `filters`，缓存键追加筛选；不带筛选时缓存键、计票和响应与之前完全相同。配对抽样不受影响。
- `server/app.mjs`：路由读取两个参数，非注册表 ID 且非 `unset` 时 `400 invalid_query`。
- `docs/api-contract.md`：排行榜一节补筛选语义与错误。
- `test/provenance.test.mjs`：补「未筛选无 `filters`」「仅一侧满足不计入」「两侧满足计入」「provider 条件」「非法值 400」断言；因对局左右随机，先把 b 侧更正为未注明再断言，保证结果确定（修复前 1/3 左右概率失败）。

## 验证

- `npm run check`：54 文件、0 错。`npm test`：116/116（连续多次通过，provenance 用例单独重复 6 次均通过）。
- 部署版 `31651f3` 与本分支各自打开同一 v15 副本（`output/schema-study/tmpdb/seed.db` 的两份拷贝），用 `output/deploy-provenance/compare-leaderboards.mjs` 计算全部题目与每题、按配置与按模型的榜单：去掉 `updatedAt` 后逐字节相同。
- 本地种子库（四件投稿：Claude Code×2、Codex、未注明；两位用户 12 张 arena 票）HTTP 验证：未筛选 12 票；`harness=claude-code` 2 票；`harness=codex`、`harness=unset` 各 0 票、1 个未上榜配置；`harness=claude-code&provider=official` 2 票；`harness=nope` 返回 400。

## 明确没做

- 实验性的按 Harness 计分视图（proposal §3.3 Ⅲ）；回填脚本（第 5 轮）。
- 未部署、未合并。

## 遗留物

- 验证用种子库与部署版代码导出在执行会话临时目录。

## 下一步建议

- 部署只需更新代码（沿用 `output/deploy-provenance/runbook.md` 第 2–4、7–8 步，数据包与迁移步骤可跳过）；部署后再合并 Show2 `provenance-round4`。
