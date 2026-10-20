# 2026-10-20 · 网站公告 API · Atmeplz

- 负责人：Atmeplz ｜ 执行 AI：Codex

## 本轮目标

支持 Gallery 公告历史、仅管理员发布与新公告实时广播。

## 改动

- 本轮提交（提交号见仓库历史）：`server/db.mjs` 追加 v47 幂等 `announcements` 表；`server/announcements.mjs` 提供列表、校验、发布与 SSE；`server/app.mjs` 接入公开读和 Lv3 写接口。
- 本轮提交：`docs/api-contract.md` 增加公告端点与数据契约；`test/announcements.test.mjs` 覆盖迁移、角色、历史、SSE 和非法输入；`test/changelog.test.mjs` 改为按最新迁移数检查版本，避免新迁移使旧测试失效。

## 验证

- `npm run check`：146 文件 / 0 错；公告与更新日志定点测试 8/8；`npm test` 复跑 412/412；`git diff --check` 通过。
- 截图限时测试首次与全套并行运行时偶发超时，独立 27/27、全量复跑均通过。
- 本地隔离服务曾使用两条示例公告，通过 Gallery 5173 代理验证列表和 SSE 初始事件；交付前清空为 0，启动脚本不再播种。未运行生产库副本迁移演练。

## 明确没做

- 未改生产公告或数据库；未部署。无新依赖、无生产种子公告，首次上线空库不会推送空白内容。

## 遗留物

- 父工作区 `.local/announcement-demo-*` 是忽略的本地预览数据与日志，隔离公告表已清空。

## 下一步建议

- 后端与 Gallery 配套发布，迁移前按既有流程备份生产库；上线后再发布正式公告并验证广播。
