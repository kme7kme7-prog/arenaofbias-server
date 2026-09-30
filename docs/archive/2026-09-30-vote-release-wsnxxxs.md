# 2026-09-30 · vote-release · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop
- 范围：server 投票分支合并、推送、共享后端上线、两站旧票清零，以及配套主站前端发布。用户明确授权「推送部署」及主站和画廊全部投票清零；分支名已按要求移除 codex。

## 本轮目标

发布服务端投票聚合和清零逻辑，保留期间新增的共享题库、内容审核、relay 与前端主题改动。

## 改动

- 合入远端 main@2ead072 与本地主线 aa67258；保留读取限流、审核队列、捕获工厂和共享题库映射。更新已发布作品测试夹具的 moderation 状态，最终发布 server `c0ab6acf225ebcb4d99a7c3a5e145d011ee93d37`。
- 主站保留最新 `980541642706a3cd9141c3c90ab0da55bec93b87` 的题目原文切换与纸墨双主题；两个仓库均普通快进推送上游 main 和 show1-vote-processing，没有 force push。收尾文档提交不重新部署。
- 投票功能详情沿用上一轮归档：主站 Elo/画像/分类聚合由 server 提供，Gallery Bradley–Terry 保留；评分只读新数据库票，冻结快照票不再回流。CLI 默认只读，显式 apply 前先备份，事务清除全部 votes/matches 并记审计。
- 已核实旧线上源码 d69919e 的 121 个跟踪文件完全一致，生产 v19 与目标迁移相同，无被删除/改名文件。源代码从已推送 SHA 归档覆盖，139 个目标跟踪文件逐字节一致，数据包仍 2cb2a5b265e8bda8c8069a4b498f1046d825acee。
- 先在线快照演练，再停止 arenaofbias-server，VACUUM INTO 完整备份，清掉 599 legacy + 23 show1 共 622 票/622 对局；其余全部表逐行一致，audit 原行保留且新增一条 votes-reset。重启后 27 用户、267 作品、16 评论、56 表情、6 guess_results 保留，votes/matches 均 0。
- 主站 Git archive 新建独立源码目录构建，沿用经核对的现有 node_modules；完整 786 文件 manifest 校验通过。差异包更新 6 文件、暂存目录移除 4 旧哈希文件后切换，旧站完整保留。未手改生成物。

## 验证

- 本机及 VPS：check 68 文件、0 错；npm test 141/141，9 suites。GitHub CI [36694501472](https://github.com/kme7kme7-prog/arenaofbias-server/actions/runs/36694501472) 成功。
- 主站当前源码 typecheck/build/validate:leaderboard 12/12 通过；此前合并主题后的 check:theme/check:motion/改动源文件定向 lint 通过。既有 lock 缺少可选依赖导致 fresh npm ci 的问题保留，npm ls --depth=0 成功，独立源码复用已验证依赖构建。
- 演练与正式停写校验：votes/matches 清零，其余表全部行摘要一致；audit 只新增清零记录；quick_check=ok、foreign_key_check 空。最终读取仍 v19，核心业务计数保持。
- 公网 bootstrap 返回实际后端 SHA 和原数据包，capture/contentModeration=true；两范围×三分类为 0、rows 空、两组 ratings/games 空，Gallery totals/rows 为 0/空。auth/me、后台、Gallery 首页正常。
- 公网主站 index.html/capture.html/admin.html 与 10 个 JS/CSS 均 200，字节 SHA256 与发布包一致；HTML no-cache，哈希资源沿用现场 max-age=2592000，未修改 Nginx。
- 浏览器主站空榜、娱乐/正式与分类切换、纸墨主题、390px 无横向溢出、投票入口两侧实际作品显示，以及 Gallery 首页/零票榜单正常，无 console error。截图已目检，验收标签关闭，viewport 复原。
- moderation.conf SHA256 与上线前相同，capture、Luna、SSH tunnel 均仍启用；未改凭证或审核服务。

## 明确没做

没有创建生产测试用户、票或投稿，没有重复付费审核、全量原作交互或全量前端 lint。Gallery 前端、数据仓、数据包和 Nginx 均未重新发布；准备的边缘读取限流不是本轮安装范围。部署辅助 Python 仅在忽略目录，不是后端依赖。

## 遗留物

- VPS `/root/arenaofbias-vote-release-20260930-c0ab6ac/`：before-reset.db（884736 bytes）、code-before.tar.gz、server-version-before、datapack-before、源码归档、完整清单、演练/正式数据库摘要与公网验收 JSON。目录 root 0700，不包含新写出的凭证。
- 旧主站 `/www/wwwroot/show1-dist.prev`；此前 prev 保留为 `/www/wwwroot/show1-dist-backups/show1-dist.prev-before-votes-20260930-c0ab6ac`。
- 本机发布包、辅助工具、manifest 和截图在 worktree 的忽略目录 output/vote-release/。原工作区与他人文件不动。

## 下一步建议

正常投票将从零累计。若需回滚，先停止服务并另存当前数据库，核对发布后业务写入，再一起恢复旧代码、备份数据库和 .server-version；只退旧代码会重新读取冻结快照票。清理 WAL/SHM 或新增源码须按恢复现场核实，不能直接在线覆盖数据库。静态旧站可从 prev 恢复；数据包指针和审核配置本轮未变。
