# 2026-10-20 · dots 接入内容审核（方案 B） · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok Bot
- 本文写于提交前。用户授权自测通过后合并，未授权部署。

## 本轮目标

先让 dots 暂时接手自动审核试运行，不完全替换机器审核：专用审核令牌、三种模式切换、超时回退、给 dots 的 API 文档。

## 改动

- `server/db.mjs`：v48 新增 `moderation_tokens`、`moderation_token_audit`、`moderation_settings`，只建表不改行。
- `server/dots-moderation.mjs`（新）：模式（环境变量 + 数据库覆盖，每次读取，热切换）、令牌（`aobd_<id>_<secret>`，存 SHA-256，按 id 查找后常量时间比较，可吊销）、白名单路由、限流、审计、决定（复用 `library.finishModeration` 条件更新）。
- `server/library.mjs`：新投稿和作者改送审信息时，非 machine 模式在 pending 上记 `route`；新增 `pendingModerationIds()`。管理员重试不带 `route`。
- `server/moderation.mjs`：只加不删。dots 持有期内的作品只截图不调模型；`dots-review-only` 的 review 结果带 `route`；每分钟扫描一次 pending，超时或切回 machine 后交给机器；`sweep()` 供切模式时立即调用。
- `server/app.mjs`：`/api/dots/` 分派；其他 `/api/` 带 Bearer 返回 403；`GET/POST /api/admin/moderation-mode`（Lv3）。
- `server/config.mjs`：`MODERATION_MODE`、`DOTS_REVIEW_TIMEOUT_MS`、`DOTS_REQUESTS_PER_MIN`。
- `scripts/moderation-token.mjs`：create / list / revoke / mode / audit。
- 文档：`docs/dots-moderation-api.md`、README 环境变量、api-contract、deploy 6.0。

## 关键判断

- 只有新产生的 pending 带 `route`；状态值含义不变。部署时已排队的作品（含重审批次）没有 `route`，照旧走机器，`status` / `error` 字段不变。退回旧代码时旧代码忽略 `route`，pending 照常交机器。
- 截止时间 = pending 的 `at` + 超时，存在库里，重启不重新计时；超时靠扫描而不是内存定时器。
- `dots-review-only` 超时不交机器：机器已经审过、结论是要人看，再审一遍只会得到同样结论或浪费调用；作品在 dots 窗口期间本来就一直在人工队列，超时后只是 dots 看不到、不能再决定。
- 竞争：dots、机器、人工都用 `UPDATE ... WHERE moderation = <读到的值>`，先写入者生效，后到的 dots 请求返回 409 `not_in_queue`；同一决定重复提交返回 `applied: false`。可选 `version` 防止作者改动后放出 dots 没看过的版本。

## 验证

- 新增 `test/dots-moderation.test.mjs` 12 条：白名单与 403、只存哈希与即时吊销、审计字段、打回必须有理由、三种模式路由、`dots-review-only` 超时留人工、dots 超时转机器（含模拟重启）、dots 与机器竞争、并发决定只生效一次、切换前已排队作品不受影响与热切换、populated v47 库升级 v48 行不变、限流。
- `test/announcements.test.mjs` 硬编码版本 47 改为最新迁移数。

## 明确没做

- 未部署，未生成线上令牌，未改 Nginx / EdgeOne / systemd。
- 管理端界面未加模式切换按钮（用 API 或脚本）。

## 下一步建议

- 02:15 收尾检查之后再发布、切 `dots`；先观察审计表与超时回退次数。
