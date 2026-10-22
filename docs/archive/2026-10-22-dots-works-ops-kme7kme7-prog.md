# 2026-10-22 · dots 作品完善默认权限 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok 4.7（Cursor）
- kme7 已在对话中批准实现。范围以 `dots-works-ops-proposal-20261022-rev2` 的默认档 A′+F′ 为准。未部署，未改生产库或线上令牌。

## 本轮目标

把 dots 的作品完善默认权限做成 `moderation + capture:read + cover:write + works:read + meta:write + preview:write + captures:write`。先把未合并的预览 PR #22 rebase 到当前 main，再在同一叠加上读取、改信息和截图写入。

## 改动

- Rebase `feat/dots-preview`（原 `125d89a`）到 `2a55302`。冲突只在 `HANDOFF.md`：保留 main 上的 EdgeOne 记录，并把预览说明放回 2026-10-20 一节。预览代码按原提交保留。
- `works:read`：`GET /api/dots/works/:task/:id`。队列外可读。不返回邮箱、IP、内容密钥、场景地址或摘要哈希。文件路径列表默认没有，`?files=1` 才返回。
- `meta:write`：`PATCH /api/dots/works/:task/:id/meta`。字段为 title、summary、note、modelId、modelName、vendor、effort、promptVariant、harnessId、harnessOther、providerId、generationMode、humanIntervention。`task` 返回 `400 task_forbidden`。管理员语义，默认不重送审；`resubmitModeration: true` 且送审文本变化时才回到 pending。带 `updatedAt` 做条件更新，冲突 409。数据包作品写 `work_overrides.display_json`。
- `captures:write`：`PUT /api/dots/works/:task/:id/captures/:slot`，slot 只允许 first 或 mobile。只收 JPEG，尺寸与封面相同（3 MB，64–4096）。新文件名 `first-<stamp>.jpg` / `mobile-<stamp>.jpg`，只更新 captures JSON 的对应键。不改 moderation、cover、late 图、owner、digest。不把 `capture_incomplete` 清掉。无 dots 回滚。
- 写操作另计 `DOTS_WRITES_PER_MIN`（默认 30），与每分钟 120 次总限额分开。审计动作 `work-get` / `meta` / `capture-replace`，不写令牌明文。
- 文档：`docs/dots-moderation-api.md` 第 10–12 节，契约、README、部署文档里的授予示例。新建令牌的默认权限仍是只有 `moderation`。

## 验证

- `npm run check`：157 个文件，0 错误。
- `node --test --test-concurrency=2 test/*.test.mjs`：458 通过，0 失败，0 跳过。
- 其中 `test/dots-moderation.test.mjs` 28/28，覆盖新路由的权限、409、截图不改审核字段、封面与截图权限独立、写限流，以及原有预览/封面用例。
- 令牌明文检查改为取 `aobd_<id>_` 之后的整段 secret。base64url 里的下划线以前会把检查切成空串，空正则会误匹配。这是同一测试文件里的修正。
- 未做浏览器验收：本轮没有页面。未部署，未对生产库或线上令牌做任何操作。

## 明确没做

- 未做 `task:write`、`face:write`、`review:write`。
- 未做删除、软删、任意 SQL、读密钥、直接 verified 公开、dots 封面/预览回滚、改 owner_id / digest / 作品包、投票或风控、`MODERATION_MODE`。
- 未做 ArenaGalleri、Show1、voxel 或生产发布。没有运维手册，只有 HANDOFF 和部署文档里的一行授予示例。

## 遗留物

- 落地 PR 的历史包含 rebase 后的预览提交和本轮提交。`feat/dots-preview` 只更新到 rebase 后的预览提交，用来让 #22 不再 dirty。合并落地 PR 就已经带上预览，不要把两边当成两套预览各上一遍。
- 已有线上令牌不会自动得到新权限。运维以后自行 `grant`，不在本轮执行。

## 下一步建议

- 合并包含本叠的 PR 之后再谈部署。部署时保留现场补丁，不要整仓覆盖。需要时用 `DOTS_DISABLED_SCOPES` 单独关掉 `meta:write`、`preview:write` 或 `captures:write`。
- 给「作品完善」令牌按默认档逐项 `grant`。先封面，再预览（没有人工封面时预览仍是 `409 poster_required`）。
