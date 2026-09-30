# HANDOFF.md · 当前状态

接手先读 [AGENTS.md](AGENTS.md)。运行与仓库边界见 [README](README.md)，接口见 [API 契约](docs/api-contract.md)，发布与回滚见 [部署文档](docs/deploy.md)。本页只保留当前状态、后续事项与历史入口；归档中的“未推送/未部署/待审阅”是各轮结束时的状态，不是当前待办。

## 仓库与实现状态（2026-09-30）

- 本轮整理基线为 `main@1b55bb0`；fetch 后与 `origin/main` 一致，开放 PR 为零。远端只保留 main；主 agent 已删除完全合入的 show1-vote-processing 及只剩历史文档补记的 codex/shared-question-intake，本地占用中的 worktree 保留。
- 本仓是两站唯一动态 API 和数据库写入者，使用 Node ≥ 22.13 内置模块；包含 `/admin/` 管理页面。`arenaofbias` 与 `wsnxxxs/ArenaGalleri` 是独立用户前端，私有 `arenaofbias-data` 构建馆藏数据包；旧 same-prompt-gallery 已归档。
- 当前代码的迁移序列到 v19。`datapack.json` 固定不可变产物 `4c926d5f8a3c240ff769de360a9168abbe4e9dfc`，来源为数据源 `27f9a680886772ae9298cc188fef0868873e6921`；文档提交或数据源 main 前进不要求消费者自动追包。
- Show1 榜单、Elo 配对分与六维画像由后端聚合，只读库内 Show1 新票；旧快照票不回流。Gallery 继续使用独立的 Bradley–Terry 口径。自动审核、SSH relay、读取限流、共享题库与提示词变体均已进入 main。

## 最近已记录的部署

以下来自已有发布证据，本轮未连接 VPS、重新部署或写入业务数据库；下一次发布必须现场核对，不能以本页替代版本门禁。

- 2026-09-30 shared-question-release：实际服务代码 `f4685c9345fa26688ae337555e5a842aba08093c`，数据包 `4c926d5`；Gallery `ccfd11d11e407af3c75c2e5482cc773a74996c2a`，Show1 静态仍为 `980541642706a3cd9141c3c90ab0da55bec93b87`。后端 main 的随后交接提交不代表服务重部署。
- Gallery 为 20 道正式题、83 件既有作品，Show1 为 25 题（20 共用 + 5 历史）；014 SupernovAI、016 云山巨城各有两份原文，长短版保持同一个 task ID。公开变体只含 id/label/prompt，不输出私有链接。Gallery 跳过空题榜单读取，首页由 20 次减为 5 次。
- 最近停写核对仍为库 v19：27 用户、267 作品、0 票/0 对局、16 评论、56 表情、6 猜题成绩；这些是发布时计数，后续正常写入可能变化。投票曾在 vote-release 清零，不能把它当作本轮操作。
- 正式四个 HTTPS vhost 已记录安装共享读取/并发限制；Gallery、API、作品三处有私有文件规则。旧 Gallery Pages 已关闭，旧仓 private/archived，数据仓 private。审核与截图已启用，通过专用 SSH tunnel 连接 relay；真实隔离图文 Flex 调用已通过，未创建生产投稿。
- 最新发布归档记录后端 check 68 文件、141/141 测试与公网题库/资产验收；没有完成全部原作、生产登录投票或全站 UI 验收。两道版本题当时均无实际作品，生产配对仍无样本。

## 后续事项与已知边界

- 当前没有因共享题库、投票聚合、审核或反爬实现而待合并/待部署的步骤。以后收录长短版作品时应声明实际 `promptVariant`，有真实样本后再验收同模型卡片与两栏配对；不伪造作品。
- 作品目前使用 `*.w.arenaofbias.icu`，迁至与主站不同的可注册主域仍是已记录的运维项，需另行制定发布计划。
- setMeta 不接收 vendor，管理员可把手填厂商写进备注；兼容厂商追加后备注可能略超 1000 字。这两项按既有用户决定保留。猜模型每日答案可由前端推导，仍是娱乐玩法的设计边界。
- 自动审核只审声明、入口及两档页面文字、封面与首屏，不覆盖全部交互；错误/疑似转人工，不降至标准档。历史作品维持 legacy，公开展示仍受访问状态与门面开关约束。
- 旧临时目录的删除曾被自动审批拒绝，见 security-review/security-fixes、work-generation-metadata 归档；本轮不清理他人文件或生成物。

## 回滚入口

- 最新题库发布备份与验收在 VPS `/root/arenaofbias-questions-release-20260930-8132028b/`；`gallery.prev` 对应 `307df34`，中间版与更早备份位置见 [shared-question-release](docs/archive/2026-09-30-shared-question-release-wsnxxxs.md)。回退该轮代码/pin/数据/Gallery 时保留当前 v19 库及上线后写入。
- Nginx 防护备份见 [gallery-protection-deploy](docs/archive/2026-09-30-gallery-protection-deploy-wsnxxxs.md)；审核配置和 tunnel/relay 回退见 [luna-flex-relay](docs/archive/2026-09-30-luna-flex-relay-wsnxxxs.md) 与部署文档 6.1，不触碰 Xray 或业务库。
- 投票清零前备份在 `/root/arenaofbias-vote-release-20260930-c0ab6ac/`。退回旧投票代码可能重新读取冻结票快照；不得为新题库或 Nginx 回退误用清零前库。确需恢复旧票时先核对全部后续写入并按 [vote-release](docs/archive/2026-09-30-vote-release-wsnxxxs.md) 执行配套数据库/代码恢复。

## 本轮整理验证

- 仅整理文档；核对路由、配置、迁移、数据 pin、Git 提交关系与开放 PR，不把历史测试数量当作本轮测试结果。
- 已保留 shared-question-intake 独有补记的有效发布链、验收边界和仓库迁移信息，注明后来正式发布已经完成。`npm run check`：68 文件、0 错；文档相对链接检查与 `git diff --check` 通过。仅文档变化，不重复运行功能测试或浏览器；详情见 [本轮整理归档](docs/archive/2026-09-30-repository-cleanup-wsnxxxs.md)。

## 历史索引

按日期保存的原始轮次记录保留；旧状态由后续发布记录覆盖。以下索引包含现有所有轮次归档，新增记录按 [模板](docs/archive/_TEMPLATE.md) 编写。

- [2026-09-30 · repository-cleanup · wsnxxxs](docs/archive/2026-09-30-repository-cleanup-wsnxxxs.md)
- [2026-09-30 · 作品生成信息与后台选项 · wsnxxxs](docs/archive/2026-09-30-work-generation-metadata-wsnxxxs.md)
- [2026-09-30 · vote-release · wsnxxxs](docs/archive/2026-09-30-vote-release-wsnxxxs.md)
- [2026-09-30 · 投票分支改名与远端检查 · wsnxxxs](docs/archive/2026-09-30-vote-branch-sync-wsnxxxs.md)
- [2026-09-30 · Show1 服务端投票聚合与两站清零 · wsnxxxs](docs/archive/2026-09-30-show1-vote-processing-wsnxxxs.md)
- [2026-09-30 · shared-question-release · wsnxxxs](docs/archive/2026-09-30-shared-question-release-wsnxxxs.md)
- [2026-09-30 · shared-question-intake · wsnxxxs](docs/archive/2026-09-30-shared-question-intake-wsnxxxs.md)
- [2026-09-30 · security-review · wsnxxxs](docs/archive/2026-09-30-security-review-wsnxxxs.md)
- [2026-09-30 · 安全防护修复 · wsnxxxs](docs/archive/2026-09-30-security-fixes-wsnxxxs.md)
- [2026-09-30 · schema-cleanup · wsnxxxs](docs/archive/2026-09-30-schema-cleanup-wsnxxxs.md)
- [2026-09-30 · schema-cleanup-review · wsnxxxs](docs/archive/2026-09-30-schema-cleanup-review-wsnxxxs.md)
- [2026-09-30 · schema-cleanup-release · wsnxxxs](docs/archive/2026-09-30-schema-cleanup-release-wsnxxxs.md)
- [2026-09-30 · 作品来源维度第 4 轮（榜单筛选） · wsnxxxs](docs/archive/2026-09-30-provenance-round4-wsnxxxs.md)
- [2026-09-30 · 作品来源维度第 3 轮（管理后台） · wsnxxxs](docs/archive/2026-09-30-provenance-round3-admin-wsnxxxs.md)
- [2026-09-30 · 作品来源维度第 2 轮 · wsnxxxs](docs/archive/2026-09-30-provenance-round2-wsnxxxs.md)
- [2026-09-30 · Luna Flex moderation deployment · wsnxxxs](docs/archive/2026-09-30-luna-flex-release-wsnxxxs.md)
- [2026-09-30 · Connect the Luna Flex review host · wsnxxxs](docs/archive/2026-09-30-luna-flex-relay-wsnxxxs.md)
- [2026-09-30 · Luna Flex content moderation · wsnxxxs](docs/archive/2026-09-30-luna-flex-moderation-wsnxxxs.md)
- [2026-09-30 · Luna Flex configuration and connectivity · wsnxxxs](docs/archive/2026-09-30-luna-flex-enable-wsnxxxs.md)
- [2026-09-30 · gallery-protection-deploy · wsnxxxs](docs/archive/2026-09-30-gallery-protection-deploy-wsnxxxs.md)
- [2026-09-30 · anti-scraping · wsnxxxs](docs/archive/2026-09-30-anti-scraping-wsnxxxs.md)
- [2026-09-29 · share-v2 · wsnxxxs](docs/archive/2026-09-29-share-v2-wsnxxxs.md)
- [2026-09-29 · Show1 modality match · Atmeplz](docs/archive/2026-09-29-modality-match-Atmeplz.md)
- [2026-09-29 · fix-round3 · wsnxxxs](docs/archive/2026-09-29-fix-round3-wsnxxxs.md)
- [2026-09-29 · 第二轮审计修复 · wsnxxxs](docs/archive/2026-09-29-fix-round2-wsnxxxs.md)
- [2026-09-29 · fix-round1 · wsnxxxs](docs/archive/2026-09-29-fix-round1-wsnxxxs.md)
- [2026-09-29 · email-auth-v2 · wsnxxxs](docs/archive/2026-09-29-email-auth-v2-wsnxxxs.md)
- [2026-09-29 · 提名收录后端 · wsnxxxs](docs/archive/2026-09-29-curate-v2-wsnxxxs.md)
- [2026-09-29 · curate-v2 审阅修订 · wsnxxxs](docs/archive/2026-09-29-curate-v2-review-wsnxxxs.md)
- [2026-09-29 · cleanup-round1 · wsnxxxs](docs/archive/2026-09-29-cleanup-round1-wsnxxxs.md)
- [2026-09-28 · 版本固定与投票身份快照 · wsnxxxs](docs/archive/2026-09-28-versioned-matches-wsnxxxs.md)
- [2026-09-28 · 快照计分与复查修复 · wsnxxxs](docs/archive/2026-09-28-snapshot-only-scoring-wsnxxxs.md)
- [2026-09-28 · 接入独立画廊 · wsnxxxs](docs/archive/2026-09-28-gallery-integration-wsnxxxs.md)
- [2026-09-28 · 画廊接入文档跟进 · wsnxxxs](docs/archive/2026-09-28-gallery-integration-docs-followup-wsnxxxs.md)
- [2026-09-28 · 汇合 gallery-integration 进 main · kme7kme7-prog](docs/archive/2026-09-28-汇合gallery-integration-kme7kme7-prog.md)
- [2026-09-27 · 管理端（admin web app）· kme7kme7-prog](docs/archive/2026-09-27-管理端-kme7kme7-prog.md)
