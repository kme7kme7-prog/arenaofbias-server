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

## 控制框折叠审计与修复（2026-09-30–10-01，未提交、未推送、未部署）

- 授权与范围：先交付83件修改前审计表；用户随后批准同时修复两处漏藏并追加回归。仅修改 `server/fold.js`、在 `test/platform.test.mjs` 追加本轮回归、在本页末尾追加记录；保留已有头像等并行工作，不把其改动计入本轮。零新增依赖，不改 content 注入路由、作品文件或消费者数据 pin。
- 数据基线：使用正式 pin `4c926d5f8a3c240ff769de360a9168abbe4e9dfc` 的已有 rehearsal-2 副本，来源 `27f9a680886772ae9298cc188fef0868873e6921`，20题/83件作品；默认旧包92f8ab9与其422个文件仅未引用的 build-info 时间不同。另行处理的 data PR #5 新增38件尚未进入这个正式 pin，本审计不声称覆盖未发布的121件包。
- 真实复核：本地真实 `createContentHandler`、m token、隔离作品子域与 iframe；只读作品映射替代对局持久化，不写业务数据库。全部83件完成修改前/最终修改后的隐藏与恢复截图、DOM及消息记录，并逐图审阅；最终均为父页1280×720/iframe1280×660，尺寸变化的临时记录已按基线补跑。截图、日志、完整表和本轮 diff 全在忽略的 `output/fold-audit-20260930-445a1454/`，不入库。
- 结果：标记元素84→68；最终58件有标记、25件为0。解除唯一被阻断的 GPT-6 Luna Max 键盘体验入口（默认折叠下实点后“正在体验 A—Z”且 pressed），解除10个透明 checkbox/radio 的误标记，保留误藏的正文/页头/导航、小地图与建筑分页。补藏铁路 Gemini3.8 的1块底栏及飞机 DeepSeek High 的4块 static 调参卡片。键盘本体与配置按钮阵列保留。计数指被标记的 DOM 元素，仍包含1个原本 visibility:hidden 的空 toast，不等同于68个可见面板。
- 取舍：正文、导航、唯一体验入口所在混合区域整体保留，其内嵌调参按钮也保持可见；部分纯调参板附带标题/提示仍随板隐藏。飞机机构“启动”属于调参板且保留既有 F/E 快捷键，没有泛化豁免所有 Start/Play/点击类词语。无真实迟到样本，因此保留 load 后0/600/1800/4000ms扫描，不增加 MutationObserver 或查询协议。
- 协议：顶部注释供前端引用，子→父 `{source:'sp-fold', count}` 在 load 首报一次（可能0），每新批次再报、累计不减；父→子 `{source:'sp-arena', fold:boolean}` 默认隐藏，true隐藏/false显示，仅接受 parent。83件首报0、计数单调、末次与标记数相等，false恢复全部标记；本批 console error 为0。
- 验证：最终 `npm run check` 68文件/0错；完整 `npm test` 145/145通过、0失败/取消/跳过（8820ms）；`git diff --check` 通过。本轮新增3项回归覆盖内容/入口/原生输入保护、全屏层内static卡片识别、批次报告与parent消息约束/输入状态；已有上传内容服务用例追加 w 原作不注入断言，已有 m 注入断言保持。完整测试包含工作区已有头像等改动，不能把145项全部归因本轮。
- 证据：[修改前83件表](output/fold-audit-20260930-445a1454/audit-table.md)、[最终83件对照表](output/fold-audit-20260930-445a1454/after/audit-table.md)、[仅本轮fold/test差异](output/fold-audit-20260930-445a1454/our-changes.diff)、[check日志](output/fold-audit-20260930-445a1454/check-after.log)、[完整测试日志](output/fold-audit-20260930-445a1454/tests-after.log)。输出表含每件数量、元素、误藏/漏藏及两态截图绝对路径。
- 未执行：未逐件覆盖手机、全部滚动/指南/部件动画、交互后新建面板或音频可听性；这些超出本轮实际证据，不宣称全部交互验收。前端开关由另一人实现，本轮未改前端；未连接生产、未部署、未提交或推送后端。本轮本地审计服务已停止。
- 后续数据整理与发布（2026-10-01）：按用户另行授权，data PR #5 的38件完成题目去重映射、模型注册与收录验收，并已合入 main，源码 `638937a58d6aec02644106d76e2b84d51fbf9fe9`；不可变 tag `datapack/638937a58d6aec02644106d76e2b84d51fbf9fe9` 指向产物 `39a2fa43b25488b09069644fdcd6df50adc06dc0`。发布包 schema 1、sourceDirty false、20题/121件、37展示模型/203完整模型、11 Harness/10服务商；PR CI 36731000102 与发布 CI 36731686651 均成功。本地 data check 28文件/0错、测试16/16、完整构建成功、收录检查0错/4提示；原作已有空白提示保留，范围与限制见 data 本轮归档。本轮只提交/推送/合并 data，未更新消费者 pin、未部署、未提交后端；上面的折叠审计仍只覆盖固定正式83件，不包含新增38件。合并、产物与CI核对证据位于 data 忽略目录 `output/intake-pr5-reconcile/worktree/output/pr5-review/published-package-verification.json`。
