# 2026-10-01 · 四仓发布与生产测试题清理 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex desktop，配套文档由 GPT-6.1 Sol / medium 子 agent 协作

## 本轮目标

按用户明确授权提交、推送、整理四仓分支并部署两站、共享后端与最新 38 件作品。用户另行确认：部署后备份、核对指定四道题零作品零票，再通过管理员 API 一并软删除。

## 改动

- 后端题目附样例、人审、删除、v22、admin 审核、静态 ZIP 格式修复已进入 main；契约的字段、路径、取值与用户要求一致。格式记录仅为草稿 checks 内部字段，没有新增外部契约要求。实现文件和回归覆盖见根 HANDOFF 与 question-review 归档。
- Gallery 未公开题作品标题修复及此前提示词版本、投稿、题目审核、题型榜单、法律、头像等本地提交统一推送。Show1 法律、头像、账号文案及评论隐藏配套改动提交并同步 origin / fork main。数据 PR #5 已合并；保留稳定题目/模型 ID 和原作，不重做资源。
- 2026-09-30T17:19:05Z（Brisbane 2026-10-01 03:19:05）上线源码：后端 `566782e54a403c79a5ca4257a34a4beb6caa8d54`，Gallery `a68c94cb4c050202f240a64a9b3e5c69d0025d6e`，Show1 `79266513b295fb6ce8892f0afd08fbd32f61ab09`。这些是实际运行版本；随后交接文档提交不代表再次部署。
- 数据源 `638937a58d6aec02644106d76e2b84d51fbf9fe9`，成功 CI 36731686651；消费 tag `datapack/638937a58d6aec02644106d76e2b84d51fbf9fe9` / 产物 `39a2fa43b25488b09069644fdcd6df50adc06dc0`，schema 1、sourceDirty false、20 题、121 件、37 展示模型、203 注册条目。Gallery 与 API catalogDigest 均 `9bda513317cde7eabbcb085d1556e813c1d2bfb8168f316ea9b2056a261fa640`。Show1 25 题（20 共用 + 5 历史）。文档 CI 产生新包不自动替换本次内容 pin。
- 部署前现场旧源码 56 个运行文件逐项 SHA-256 匹配；目标提交均已在 origin/main。VPS Git 下载不稳定，改用已核对 main SHA 的 LF git archive 上传，并校验压缩包及解包文件，不使用脏工作树。数据差异包 359 个变化 / 0 删除，完整树哈希 `c4d3caec3203f8ff56fe337be0ee897ecd910c7f022fc98b9e2e2a6faf9db4ff` 匹配。Gallery 392 个变化 / 0 删除（352 数据文件 + 40 站点文件），Show1 26 变化 / 8 旧 hash 资产移除；移除仅发生在已校验的新静态目录。
- 已合并远端分支按祖先关系清理，Show1 fork/main 快进同步；数据 intake-new-results 已合入后删除，datapack 和所有 tag 保留。占用中的本地 worktree 不删除。Gallery PR #1 使用过时契约，不合并，关闭及删除 kme7/question-review 分支仍待确认。

### 备份、清理与回滚

备份目录：`/root/arenaofbias-question-review-release-20260930T171825Z/`。含部署前 v19 一致性 `platform.db`、旧 `code.tar.gz`、server-version / datapack-current / database-before.json；迁移后清理前另存 v22 `platform-before-question-delete-v22.db`。两份数据库 integrity_check 均 ok；question-cleanup.json、verification.json、bootstrap-after.json 与 switched-at 保存结果证据。

2026-09-30T17:19:52.309Z（Brisbane 03:19:52.309），wsnxxxs 核对以下题目均属 kme7、未删除作品 0 / 投票 0，再使用既有管理员 kme7 的 60 秒短期会话在环回请求 DELETE，逐条 200 / `{ ok: true }`：

| 题目 | 标题 | 结果 |
| --- | --- | --- |
| q-9becba326438d52c | 我必须马上修复这个 | 已软删除，question-delete 审计完整 |
| q-9c39b8642a46c310 | 那我可以刷榜了？ | 已软删除，question-delete 审计完整 |
| q-82a12216062f8541 | 等下我是不是发现一个漏洞了 | 已软删除，question-delete 审计完整 |
| q-fa132f1b3b3bfa93 | 我不会填什么都能发布上来吧 | 已软删除，question-delete 审计完整 |

临时会话只存在于进程内，完成后撤销；未改账号、密码、角色，未直接 SQL 删除业务数据。清理后公开 bootstrap、/api/me 与 /api/admin/questions 不再含这四题；登录缺示例建题返回 400「请附上一份模型结果」，未产生题目或作品。数据库 v22 原始计数 users 27、questions 4（均软删除）、works 267、votes 0、matches 1、comments 16、reactions 56，与部署前一致；无作品需要连带删除。

当前 `gallery.prev` 为旧 `ccfd11d11e407af3c75c2e5482cc773a74996c2a`，`show1-dist.prev` 为旧 `980541642706a3cd9141c3c90ab0da55bec93b87`；原有 prev 已保留到各自 `.prev.bak-20260930T171905Z`。旧数据包保留。若回退代码、pin 或静态目录，先停写备份并核对上线后写入和 v22 兼容性；不得直接用 v19 快照覆盖新数据或撤销授权清理。

## 验证

- 后端本地 check 69 文件 / 0 错，最终 test 154/154；VPS Node 22.23.2 在待部署源码上同样 check 69 / 0、test 154/154。一次此前本地 readiness 为 153/154，既有 moderation mock 期望 rejected、实际 review；聚焦 6/6 与再次全量通过，根因未确认，未声称已修复该间歇问题。sample insert failed 为预期故障注入。
- Gallery check 41 / 0、test 14/14，干净源码 npm ci、build 121 件 / 55 站点文件成功；intake 0 错 / 4 已知提示（Space-bunny 厂商待确认，旧 Sonnet 4.17 MiB / Fable 5.80 MiB、新悉尼 Astra 4.40 MiB 大包）。1555 文件与精确集合全部匹配发布清单。
- Show1 typecheck、lint、build 在干净提交 export 上通过；npm ci 因 package-lock 缺 @emnapi/core@1.11.3、@emnapi/runtime@1.11.3 失败。本轮连接已验证原 checkout 的 node_modules 构建，未改依赖和锁文件，记录为门禁例外。802 文件与精确集合全部匹配发布清单。
- 数据 check 28 / 0、test 16/16、intake 121 件 / 0 错 / 4 提示；完整 build:data 由上述成功 main CI 验证，本轮使用不可变包。源数据、原作、截图与海报未修改。
- 服务 active、Nginx -t 成功；环境、systemd、Nginx 未变，CAPTURE=1 / CONTENT_MODERATION=1 保留。公网 bootstrap、Gallery data、Show1 prompts 200，版本/数量/digest 一致；bootstrap no-store，Gallery build-info.json / .datapack-source.json 和 API data.json 匿名访问均 404。
- 公网 Gallery 首页与 Seed 2.1 Pro Preview 新工地作品预览、AI 标识正常，console error 0；Show1 首页、条款节目录与 #privacy 直达正常，375px 条款/隐私 clientWidth = scrollWidth = 375，截图目检正常，console error 0。

## 明确没做

- 没有生产注册、邮箱、换头像、真实建题/作品上传或投票写入；隔离库已验证的完整建题/人审流程仍见功能归档。未调用真实 Luna / capture，本轮没有付费外部审核调用。
- Gallery viewport override 未生效，实际 1270/1280px，本轮没有完成 Gallery 窄屏验收；不把之前隔离移动验收当成本次生产验收。Show1 隐藏窗格的条款到隐私点击未产生跳转，直接 #privacy 成功，未声称所有导航点击均通过。
- 未全量验收新增 38 件 fold / 全部交互、低端真机或性能。Show1 无 npm test 脚本；没有改动动效逻辑，未重跑已知旧断言不兼容的动效/猜题专项。
- journalctl 未发现 journal 文件，未验证完整服务日志；健康依据为进程 active、HTTP、数据库和文件校验。

## 遗留物

忽略目录 output/question-release-20261001 保存脚本、构建 export、传输包、校验清单及截图，不入库、不清理他人资源。SSH / GitHub 凭据仅进程内使用，不写入仓库。功能源码与部署完成，四仓最终交接文档独立提交推送。

## 下一步建议

Gallery 过时 PR #1 的关闭/删分支等待用户确认。另行维护 Show1 锁文件可选依赖、间歇 moderation mock、真实新投稿审核/截图、Gallery 窄屏及完整作品交互；这些不是本轮未完成部署。未来部署继续按 docs/deploy.md 门禁现场核对版本并备份。

## 首页补充发布（2026-10-01，追加）

- 收尾发现并行会话提交 4717910 的首页精简，其归档原约定只提交不推送；本轮询问后用户明确确认一并推送、部署，没有擅自包含。未跟踪 .claude/ 保留。
- 4717910e115413941586f170e808a32a05c1d258 已推送 origin/main；干净 LF git archive export 上 npm ci、check 41 / 0、test 14/14、build 121 件 / 55 站点文件、intake 0 错 / 4 已知提示全部通过。
- 只更新 data.json、home.js、index.html、studio.css，4 变化 / 0 删除；差异包 SHA-256 4a7d5a288e723b60f889afd61e792e2f2662e288ee039f833d158504901ee97d，待切换 1555 文件清单完整匹配。数据 pin / digest、后端、Show1 均不变。
- 2026-09-30T17:40:14Z（Brisbane 03:40:14）切换完成。备份 /root/arenaofbias-gallery-hero-release-20260930T174014Z/ 保存 changed-before.tar.gz、data-before.json、data-after.json、manifest-after.sha256、switched-at；未再操作业务数据库。
- 当前 gallery.prev 为 a68c94c，ccfd11d 已保存到 gallery.prev.bak-20260930T174014Z；更早 prev 仍保留。Nginx -t 通过且未改配置。公网返回新源码 SHA、121 件 / 原固定包，首屏无眉标、说明与统计精简正确；1280px 截图目检正常，scrollWidth 1270、innerWidth 1280，console error 0。本轮 Gallery 窄屏未完成的边界不变。
