# 2026-11-06 · 引导式盲评测试版 · wsnxxxs

- 负责人：wsnxxxs（GitHub ID 269096463，269096463+wsnxxxs@users.noreply.github.com）｜执行 AI：Claude Opus 5.5（Claude Code）。
- 范围：本仓起点 `b664ed3`（origin/main）；配套 Gallery 同日同名归档。用户授权提交、推送、开 PR 合并并上线。
- 本文写于发布准备时点。正式安装、备份与线上验收记在服务器 `/root/aob-guided-trial-20261106/`，不在此预填成功状态。

## 本轮目标

用户先定下「停靠问题卡」方案并看过本地演示，随后要求部署一个只对管理员开放、有单独链接的测试版。用户选定：共用正式后端；测试票不计入大众榜和精选榜；提交、推送、合并与上线都由执行 AI 完成。

## 改动

- `server/aspects.mjs`（新）：测评点题库。目前只有建模题 6 道：floating、fidelity、atmosphere、lighting、material、extra_idea，分属工程完备、逻辑、审美、发散。`pickAspect` 取本题已答最少的一道，同数随机；`publicAspect` 生成下发给前端的字段。
- `server/arena.mjs`、`server/app.mjs`：创建对局可带 `guided: true`，仅普通与高级管理员可用，其他人得到 `403 guided-staff-only`。测试局记入 `guided_matches` 并附一道测评点，响应 `counted:false`，`countableFor` 两项均为 false。测试局投票可带 `tieKind`（good/bad，仅配 tie）与 `aspect {id, choice, tieKind?}`，写入 `guided_trial_votes`，不写 votes，返回 `reason:"trial"`。对局照常终局、揭晓并进入冷却，风控证据照常记录（vote_id 为空）。普通对局带这两个字段返回 400；不带 `guided` 的请求行为不变。
- `server/db.mjs`：MIGRATIONS 末尾追加 v54，只建 `guided_matches`、`guided_trial_votes` 和一个按题索引，不改旧表、旧行。
- `test/guided-trial.test.mjs`（新）：覆盖管理员限定、普通对局不变、测评点轮换、非法 tieKind/aspect、测试票入库以及榜单与 votes 不变。
- 文档：`docs/api-contract.md` §1.1、§3.8、§3.9；`docs/deploy.md` 补 v54 发布核对要求。

## 决策

- 测试票放在独立表，不给 votes 或 matches 加列。上一版试点加列后，4 个迁移快照测试失败；独立表也方便试用结束后整体清空。
- 测试版靠请求参数开启，不另起后端。服务端强制管理员身份，前端拦截只是提示。
- 平局细分（都很好/都不好）与测评点只存在测试表里；Bradley–Terry、两张榜和风控统计都不读取，平局照旧计和。
- 待定：测评点题库扩到其他分类；试用后是否以及如何把细分结果计入正式口径。均需用户另行拍板。

## 验证

- `npm run check`：180 文件，0 错误。`npm test`：597/597。
- 本地演示：数据包由 arenaofbias-data `origin/datapack`（3d2c3f8）导出，演示库重建到 v54，配套 Gallery 以 `GUIDED_VOTING=1` 构建，在内置浏览器验证：
  - 未登录不抽题；普通成员在前端被拦下，直接调接口返回 `403 guided-staff-only`。
  - 管理员先答引导题 A 更好，再答综合题「都很好」：trial 表写入 tie/good 与 extra_idea=a，votes 仍为 0；下一组按最少作答换到 atmosphere。
  - 不带开关的正式构建：仍是三个按钮，X 键无效，S 键投 tie 后计入 votes。
- 未跑：生产一致副本上的迁移演练与线上验收——本文写于发布前，结果记在服务器 receipt 目录。

## 明确没做

- 没有把细分结果接入任何榜单或模型分，也没有改 Show1。
- 没有新增域名或 DNS。测试页放在 Gallery 同域名下的单独路径，由 Gallery 另一份构建提供。
- 不在仓库记录任何凭据；本地演示账号的密码只写在工作区 `.demo/README.md`。

## 遗留物

- 工作区 `.demo/`（在两个仓库之外）保存本地演示数据包、演示库和静态服务脚本，可整体删除。
- 试用结束后，`guided_matches` 与 `guided_trial_votes` 可以直接清空；删除表需要另写迁移。

## 下一步建议

- 先收集管理员试用反馈：每题耗时、跳过率，以及「都很好/都不好」的比例。
- 扩展到其他分类前，先为每个分类定好测评点和「看哪里」提示，再决定是否把细分结果计入正式口径。
