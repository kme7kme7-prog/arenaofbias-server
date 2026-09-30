# Show1 历史数据迁移

本文描述一次性的 Show1 历史导入脚本，不能作为恢复当前票数或重新导入生产的操作清单。2026-09-30 的 vote-release 已清除两站旧票与对局，旧快照票不再参与计分；当前发布与回滚入口见 [HANDOFF](../HANDOFF.md)、[投票发布归档](archive/2026-09-30-vote-release-wsnxxxs.md)。

运行环境：Node ≥ 22.13，零 npm 依赖。目标库须由当前后端完成迁移（当前 schema v19；写入使用 v18 的 `model_other`，不能照旧说明使用仅 v7 的库）。先备份目标库，并在维护窗口停止后端写入。源库始终以 `new DatabaseSync(path, { readOnly: true })` 打开。

```powershell
node scripts/migrate-show1.mjs --dry-run `
  --source-db C:\path\to\show1.db `
  --target-db C:\path\to\platform.db `
  --source-works C:\path\to\Show1\data\works `
  --datapack C:\path\to\current-datapack `
  --models C:\path\to\models-unified.json `
  --prompts C:\path\to\show1-prompts.json `
  --out-dir C:\path\to\migration-artifacts
```

检查 `report.md` 的逐表计数、全部歧义和末尾的人工决策清单。确认正式备份与作品文件完整后，把 `--dry-run` 改为 `--apply`，其余参数和输出目录保持不变。可重复 dry-run 或 apply；相同源 ID 使用稳定的用户/作品 ID，已存在行不会重复插入。`content-map.json` 保存随机内容令牌，须与备份一起妥善保存；不要公开该文件。所有 JSON artifact 均用于对账：`user-map.json`、`work-map.json`、`content-map.json`、`task-map.json`、`prompt-weights.json`、`report.json`。

题目只输出映射与六维权重，不写入目标库：004 → `chinese-architecture`，其余 → `show1-001` 等稳定 ID。当前 Show1 兼容层合并数据包正式题与历史快照，保留尚未进入共用题库的历史题；最近发布提供 20 道共用题与 5 道历史题，不再把原迁移阶段的“七题待定义”作为当前任务。脚本仍按目标数据包报告缺少的题目定义，共享画廊盲测池只使用该数据包已定义的题目。

迁入作品是 Show1 线上审核过的内容，脚本按 `status='verified'`、`show_gallery=1`、`show_arena=1` 登记；实际公开展示与入池还受当前内容状态、题库和站点规则约束。脚本对两件旧 `web` React 模板生成占位页，报告要求管理员补齐独立作品文件后替换；这是导入时的处理规则，不代表本轮确认生产仍有两件待补作品。`mimo-x-flash` 无唯一映射时不删除，作品照常迁入，`model_id` 置空、`model_other` 保留原值，报告标“待确认”。

旧票逐张迁入，不产生重复：每张票生成一条占位 `matches` 行（确定性 id `sha256("show1:match:"+源id)` 取 16 hex；`a_work`/`b_work` 为 `legacy:<mid>`，pair_key 字典序较小的一侧放 a；`a_token`/`b_token` 为 w/m 前缀 32 hex 确定性令牌；`created_at=decided_at=expires_at=源 created_at`；`choice` 由 outcome 推出——win 看 winner 在 a 还是 b 侧，draw 记 `tie`）和一条 `votes` 行（确定性 id；`a_identity`/`b_identity` 填源 mid，`source='legacy'`，`pair_key` 保留源值；`user_id` 经映射表转换，源为 null 则保持 null）。目标 `votes` 有 `UNIQUE(user_id, pair_key)`：同用户同 pair_key 的重复票只保留最早一张，后到的进报告并计入冲突；SQLite 中 `user_id IS NULL` 不受该约束，匿名票不去重。占位对局的 `legacy:` 作品引用解析不到真实作品，因此不参与 Bradley-Terry 计分，只作历史存档。旧评论按"评论者在该题最近一场胜局所站一侧的模型"定位迁入作品（平局没有站队侧，逐行进报告跳过），mid→作品解析与 reactions 共用同一逻辑（多候选按作品 ID 排序取首个并记录歧义）；评论 `user_id` 为 null 或无法映射的行跳过并进报告。旧反应 `up/down/laugh` 临时对应 `👍/👀/🤯`。`sessions`、`page_views`、`auth_limits`、`email_codes`、`guess_results` 整表不迁，报告逐条说明理由。

脚本不会读取 `.datapack` 之外的目标题目定义，也不会修改正在使用的前端数据包。当前 `C:\Users\hyc\Documents\Show1\data\comments.db` 只是本地开发库，与正式备份的行数不一致，不能作为正式迁移来源。
