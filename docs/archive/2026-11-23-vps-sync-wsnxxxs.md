# 2026-11-23 · 服务器现场补录入库 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5（Claude Code 桌面版，子代理 Opus 重建、Sonnet 盘点）

## 本轮目标

用户要求整理服务器上未经仓库提交的更新并规范开发。`/www/wwwroot/arenaofbias-server` 不是 Git 仓库，现场由 base 91d0e22、PR 合并、本地未推送的 `lb/*` 分支和 10-17 至 11-19 的多轮热修叠加而成，与任何分支都不一致。本轮把现场全部改动按轮次补录到 `sync/vps-20261123`，不部署、不改服务器。

## 改动

- 以真合并（d11daea）纳入本地未推送的 `lb/integration` 15 个提交，保留原哈希；`lb/baseline`、`lb/v3`、`lb/usage-tools` 与已纳入提交 patch-id 相同，未重复纳入。合并时迁移按生产实际顺序排列：v55–v57 为加权试运行、v3 与用量，v58 为批量投稿。
- 21 轮热修各一条提交，按时间顺序：仅竞技场题、社区题提示词变体、Show1 题目标签、Nginx EdgeOne 客户端地址与媒体域 CSP、HTML 验证码邮件、沙盒 `data:` 脚本、Sub2API OIDC、管理员上传免通用限流、停用模型 ID 解析到替代模型，以及 11-17 至 11-19 的引导试运行（维度改名、测评点、音乐类与 MP3、音乐公开展示、解题状态 v59、子分类 v60、其他领域、文学测评点、维度票衰减）和精选分区开关（v61）。每轮以服务器作业目录的修改前后副本做三方合并，统一 LF。
- 补录 cron 实际运行的 `/root/cleanup-retention.sh`（10-30 事故后改造版）和截图服务 8 核资源 drop-in，`docs/deploy.md` 记一句。
- 测试与夹具按已上线行为更新（10 个测试文件，未改服务端代码）。
- 修复 76d7425 带来的回归：管理员视图 `selectedQuestionCount` 恢复为只计可用入选题，仅音乐分区计全部入选题，与 `docs/api-contract.md` 一致。经用户同意；该修复尚未部署，线上仍是旧行为。

## 验证

- `npm run check` 220 文件 0 错误；`npm test` 725/725（`TMPDIR` 用真实路径）。macOS 默认 `TMPDIR` 是软链接，`batch-cli` 6 项与 `dots-preview-download` 1 项会失败，`origin/main` 上同样失败，与本轮无关；Linux CI 不受影响。
- `scripts/live-drift.mjs` 对生产比对：`server/` 全部一致，3 个文件只差 CRLF。不同之处只有 `origin/main` 已有、从未部署的批量投稿 CLI 修复（`server/batch-plan.mjs`、`tools/batch-upload/*`）、`read-zones.conf` 一处、仓库版截图服务单元，以及本轮的精选计数修复和清理脚本（部署目录里的副本是旧版，cron 用的是 `/root/` 下的新版）。
- 提交前逐条扫描密钥，并与生产实际密钥值比对（不输出），零命中。

## 明确没做

- 未推送、未部署、未写服务器、未重启服务。
- 未改动服务器上的 systemd 单元与 drop-in，其中的运行配置整理另行处理。
- 仓库较新的 `archive-backup.sh`（线上漏备参考图）与 `datapack-sync.sh` 未部署。
- 精选开关路由 `PUT /api/admin/curated/questions/:task` 先读请求体再鉴权，也未走 `adminJson` 的审计记录；非管理员仍返回 403，只记录未改。新接口和字段（解题状态、子分类、精选开关、维度 `?category=`、音乐与音频上传、`GUIDED_DOMAINS`）尚未写入 `docs/api-contract.md`。生产 186 条子分类种子数据不在仓库。

## 遗留物

- 本地工作树 `.wt/sync-server-20261123`、`.wt/live-drift-20261123`；本地 `main` 和 `.wt/aob-sub2-sso`、`.wt/fable52-server-20261116` 的他人未提交改动未动。

## 下一步建议

- 合并前留意迁移编号：`origin/main` 把批量投稿放在 v55，本分支按生产放在 v58。已用 `origin/main` 迁移到 v55 及以上的开发或 CI 库会缺 `legacy_vote_levels` 表，合并后重建这类库。
- 合并后用合并提交完整构建、部署一次，以 `scripts/live-drift.mjs` 核对并写入 `/root/deploy-log.tsv`，此后按 `docs/deploy.md` 第 0 节只从提交上线。
