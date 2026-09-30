# 2026-09-30 · shared-question-intake · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex

## 本轮目标

让数据仓库登记的题目同时用于画廊展示与 arena 娱乐玩法；用户最终决定长短版不拆题。

## 改动

catalog 保留题目元数据与作品变体标记；Show1 兼容层通过稳定 arenaId 动态合并正式与历史题目。新增题目可以使用同一 task ID 接收合规投稿并投票，历史题目名称、编号、权重与投票映射保留。提示词变体随 /api/prompts 返回，API 文档同步。

## 验证

check 59 文件 0 错；npm test 127/127，覆盖历史接口黄金数据、正式题映射、两版原文同题返回、新题投稿娱乐票和跨题拒绝。真实 HTTP 本地包返回 25 道题，014/016 各两份原文，20 个正式映射有效。两前端实际使用同一后端完成浏览器核对。

## 明确没做

业务 SQLite 未写入，无 schema 迁移、历史票更改、作品展示开关变更、push、部署或 pin 更新；新增题目没有结果时不伪造作品。

## 遗留物

隔离联调数据库和资源在 output/shared-question-intake-20260930，本轮服务收工关闭。

## 下一步建议

数据包正式发布后，按既有版本部署流程同步后端与前端。

## 后续状态补记（2026-09-30 · 整理历史分支）

- 保留 `codex/shared-question-intake@7d87557` 独有文档补记的有效信息：实现 `aa67258` 后续已推送，并随 vote-release 合入 main，以 `c0ab6ac` 上线。该分支没有独有功能修改，只修改 HANDOFF、README、部署说明和本归档。
- 该补记曾只读核对生产仍消费 `2cb2a5b`，并指出新题库源码上线不等于消费包已切换；这是共用题库发布之前的历史现场。随后 [shared-question-release](2026-09-30-shared-question-release-wsnxxxs.md) 已切入 `4c926d5` 并发布 Gallery，原“新题库待更新”“Gallery 未合并”均已完成。
- Gallery 维护仓库为 `wsnxxxs/ArenaGalleri`，旧 same-prompt-gallery 已 private、archived，旧 Pages 已关闭；现行 README 和部署说明保留此仓库边界。
- 原补记仅修改文档，不重新运行功能测试、浏览器或生产写操作；沿用实现 127/127 和 vote-release 合并发布 141/141 的历史验证，不将这些数量称为本轮整理验证。后续发布以独立归档为准。
