# 2026-09-30 · shared-question-release · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop

## 本轮目标

核对“arena 与后端已上线，但新版题库与 Gallery 切换仍待发布”的状态，继续完成实际生产发布。

## 改动

- 现场版本与本人上轮记录一致：server `9ebf472b3020adeda94e6514373e2e0a1da7eb2b`，数据 `1fb62c19d890faceccd68c8641d673062aeee383`，Gallery `307df34c5966c3e45d98ce2b257b57bbd4042c49`；逐文件确认后选定已合入 main 的目标。
- `f16d295` 更新 pin 为数据源 `27f9a680886772ae9298cc188fef0868873e6921` 的产物 `4c926d5f8a3c240ff769de360a9168abbe4e9dfc`（不可变 tag `datapack/27f9a680886772ae9298cc188fef0868873e6921`）。20 道正式题、83 件既有作品，SupernovAI 与云山巨城各一题两份原文；原有 83 件作品与完整模型池逐项相同。
- `f4685c9345fa26688ae337555e5a842aba08093c` 对公开 promptVariants 仅输出 id/label/prompt，阻止新包中的私有 promptUrl 从 `/api/prompts` 泄露；扩展既有真实 HTTP 数据包回归，无依赖或迁移。
- Gallery 在独立新仓通过 `ad483e1` 合并版本切换，最终 `ccfd11d11e407af3c75c2e5482cc773a74996c2a` 跳过空题榜单读取，首页由 20 次减至 5 次；两个提交均已推送 main。原始数据、提示词与作品不手改，不合入另一前端或后台。
- 原生包差分 4 文件、0 删除，136539 字节；全树 SHA256 从 `9519148f91c6dd8f27943c4a44a804d38679eadc3016e68973bba692efe8a408` 到 `2cdce99fedaee72a3e97c5c59d9df5703bd6fbea443931640c409e830f597dba` 验证通过。先在隔离目录演练，再停写备份、切换后端与数据、切换 Gallery。Gallery 初次改 5 文件，收尾修正仅 3 文件，完整目标集合 1178 文件一致。
- Show1 `980541642706a3cd9141c3c90ab0da55bec93b87` 的全部 786 文件未变，现有共用题库代码自动读取新包，提供 25 题（20 共用 + 5 历史）。5 份 Nginx 配置与 SMTP/Turnstile/审核 drop-in 哈希保持；后台和审核 tunnel active。

## 验证

- 本机及 VPS：`npm run check` 68 文件、0 错；`npm test` 141/141。隔离真实 HTTP 核对 25 题、两组变体与私有链接过滤，不写生产库。
- Gallery：check 39 文件、14/14 测试，两个已提交源码归档各自完整构建、CI=1 intake 83 件，0 错、3 条既有 warning。最终 1178 文件逐 SHA256 一致。
- GitHub：数据发布 CI 36699883762、server 功能 CI 36708375644、Gallery 最终功能 CI 36709276011 均成功。最终文档提交不重新发布服务。
- 通过正式 TLS vhost 的独立环回探针核对 20/25 题、83 件作品、原文/变体逐字相同、公开白名单、改变的 JS/JSON/HTML 哈希、私有文件 404、bootstrap 包版本和目录摘要一致。探针未执行写请求。
- 真实公网浏览器：Gallery 首页、20 题题库、两题长→短、实际短版复制成功；Show1 25 题、014/016 原文切换正常。修正后的正常导航 console error 空，不再出现之前的榜单 429。截图与浏览器记录在忽略输出目录。
- 停写 `platform-at-switch.db`，切换前后 users/works/votes/matches/comments/reactions/guess_results 按行规范化哈希完全相同；计数 27/267/0/0/16/56/6，v19、quick_check、foreign_key_check 通过。数据库未清零。
- 未再次运行数据源源码测试：数据仓本轮只有交接文档，发布目标已经由成功 CI 验证且下载后全树校验。未重跑 Show1 构建：其静态 manifest 完全不变。

## 明确没做

没有改原作、稳定题号/模型 ID、业务表结构或投票/审核/relay 实现；没有创建生产测试票、用户、投稿或触发付费审核。未重测手机、全部原作或生产登录投票流程。两组版本题当前都没有实际结果，生产作品配对切换无样本，分组与版本选择只由合成回归覆盖。

## 遗留物

本机忽略目录 `output/questions-release-20260930-8132028b/` 保存源码归档、构建、差分、manifest、HTTP/业务库哈希及截图；临时浏览器已关闭。凭据未写文件、日志或仓库；他人文件未改。

VPS `/root/arenaofbias-questions-release-20260930-8132028b/` 保存 `server-before.tar.gz`、原包差分、数据库停写备份及全部验证记录。`/www/wwwroot/gallery.prev` 是 `307df34`；`gallery.before-read-fix-8132028b` 是中间 `ad483e1`，更早副本位于 `gallery.prev-before-questions-8132028b`。不覆盖这些备份。

## 下一步建议

当前没有待合并或待部署步骤。新增两题的作品收录应按各自 promptVariant 标记，真实长短结果进入后再验收同模型卡片与两栏的生产配对。

若回退整轮，先核对当前版本与新写入，停服务恢复本轮前源码与旧 pin，激活已保留的 `1fb62c1` 包，再恢复 `gallery.prev`。保留当前 v19 业务库，不恢复旧投票清零前数据库；Nginx 与 Show1 不需要回退。后续消费者继续固定不可变产物，文档提交触发的新产物不需自动追随。
