# 2026-10-08 · 推理类别与 AI 计分预留 · wsnxxxs

## 后续联合发布门禁（2026-10-08，暂停）

- 用户随后授权推送联调和部署；公网/现场50259ad已在origin/main，本地以6446abb合并其两条Show1文本修复与a294567，推理仍未提交，未推送。合并后check109/0、test323/323。
- Gallery check64/0、test29/29、build176件/68site、严格intake0错/8既有提示，隔离固定源码副本跨仓联调通过；该副本修正旧integration pin及换行，原本地配置未改。
- 最新一致副本6554票/866作品/208用户/7272matches/3201审计，v40、integrity ok、外键0；实际运行源码已捕获，正式包2289文件SHA一致。读取和备份未改变生产库、代码、题分类或服务。
- 五项门禁失败：config6321→6324、model6212→6215、参与者均163；新增3张有效票，未换归属配置games及模型分数联动。485侧变动同ID+digest，143人工更正保持，0键迁移。新增3票来自up-pswy2p66换题后，旧代码找不到仍在原题的对手，新代码快照taskId回查恢复计票；不是推理排除。用户确认处理原则前不放宽门禁、不部署。
- 本地完整证据output/reasoning-release-20261008/（comparison-win32.json、eligibility-differences.json、实际旧源码及一致副本）；远端备份/root/aob-reasoning-release-20261008/。未推送、部署、迁移、Linux或生产浏览器验收。

- 负责人：wsnxxxs ｜ 执行 AI：Codex（GPT-6）。本轮不提交、不推送、不部署、不迁移业务数据。

## 本轮目标

新增仅接受文本的推理类别，暂由AI评分且不接入计分；排除盲评、综合/类别/领域榜与代表作，保留所有历史票。

## 改动

- server/categories.mjs：推理、哲学、文本类别集合、AI_JUDGED及共享判断函数。
- server/arena.mjs：池/配对/投票与计票过滤；空推理榜、类别名次与unranked过滤。保留a294567的归属解析，过滤发生在缓存结果及worker输入前。
- server/app.mjs：bootstrap arena过滤；无推理题时也允许推理类别查询返回空榜。
- server/featured.mjs：按AI类别排除，包括既有网页作品的题目。
- server/show1compat.mjs：过滤目录、随机作品池及两范围计票输入，拒绝推理投票；保留当前信息归属及现有SQLite/catalog缓存失效。
- admin/admin.js：文学显示写作、推理显示推理，推理新题使用text。
- test/ai-judged.test.mjs：两项必要回归；test/questions.test.mjs：领域数量更新为26并断言哲学。
- HANDOFF.md只追加本轮记录。library.mjs、ranking-worker.mjs、vote-attribution.mjs不改；没有新增依赖或数据库迁移。
- aiScore预留：未来bootstrap works[]可带可选 `{ score:number, max:number, judge:string, rationale:string }`，前端已能展示；本轮不建表、不写数据。

## 验证

- Windows Node24.16.0，check109/0、最终test322/322、git diff --check通过。新测试覆盖创建与纯文本格式、哲学、bootstrap池及有效票/参与者、待投对局拒绝、综合/文学/领域/推理单题榜、Show1缓存变化、历史票不变及已有网页题按类别排除。
- 合成库排除前后bootstrap有效比较2→1、参与者2→1；推理榜rows/unranked为空；原arena票所有列保持，Show1票也未删除。本结果不是生产迁移预测。
- 中间单题榜目录依赖导致匿名容量测试失败，修正为单题只读当前题后专项通过；一次中间全量遇moderation随机bad port，最终全量通过。未改无关代码。
- 统计口径：bootstrap totals来自配置综合榜，减去推理原先有效比较（不是原始票行数）。参与者重新去重，只投推理有效票者退出。综合榜和文学迁出后的写作榜重新拟合，保留模型的分数、名次也可能变化，条目/计分题数可能减少；模型榜按其有效比较口径同样排除。所有旧票及人工更正保持。

## 明确没做

没有本轮commit/push、生产读取或写入、部署、类别迁移、评分写入、schema修改、Linux测试或浏览器/真机全交互验收；本仓无build/check:intake脚本。本轮仅使用合成数据和临时测试库。

## 遗留物

忽略目录output/ai-judged-20261008/保存测试日志，test-final.log为最终322/322结果；未清理其他会话文件。

## 下一步建议

用户确认后才能提交推理轮。上线须先部署a294567归属计分，部署前在当时最新生产一致副本重跑HANDOFF五项门禁。推理随后上线，部署/业务迁移另行授权：后端部署后将q-1479913673ca78cd及q-a028b56bafec3a10改为推理，核对前后有效比较、参与者、综合榜、写作榜与审计，最后部署Gallery。不得复用10-06旧副本作为发布门禁，也不得删除推理旧票。

## 分轮提交与最新发布约定（2026-10-08）

用户已授权本轮仅作两条本地提交。第一条8911689（Exclude ballots cast before a work leaves its question.）只提交错题票规则；本条用非交互补丁暂存其余推理代码、独立ai-judged测试、领域测试、对应HANDOFF和本归档。arena.mjs、show1compat.mjs共有文件的改动块成功拆开，无需合并提交；归属修正及第一条错题票过滤保留。

三票例外已作废，第四票5890a7cbbe284cb2b1abd3dd排除属于纠正同ID不同digest误计。最新门禁及四票完整名单见HANDOFF与[错题票规则归档](2026-10-08-moved-question-ballots-wsnxxxs.md)：正式部署前重采当时最新一致生产副本，规则排除名单必须恰好为四票，只允许规则排除及其拟合影响，其余门禁照旧，任何其他差异停止。

发布计划取代前文顺序：后端只部署一次，包含归属计分、错题票规则、推理代码；线上无推理题时不会触发推理过滤。两题分类迁移和Gallery部署是后续单独步骤，另行授权。bootstrap有效比较排除推理原本有效票，参与者按剩余有效票去重；综合榜和从文学迁出的写作榜重新拟合，分数/名次可能联动。票保留，aiScore只预留，不建表或写评分。

本轮未推送、部署、迁移、重采生产副本、Linux测试或生产浏览器验收；前轮Gallery联调结果保留，不称为本轮重跑。

第二条提交前仅含暂存内容的隔离源码副本验证：npm run check 109文件/0错，npm test 324/324通过，无失败/取消/跳过，暂存diff检查通过。日志output/reasoning-release-20261008/reasoning-commit-check.log及reasoning-commit-test.log。负责人提交身份为wsnxxxs及269096463+wsnxxxs@users.noreply.github.com。
