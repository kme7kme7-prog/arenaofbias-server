# 2026-10-03 · 共池分支发布准备 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop

## 本轮目标

用户授权发布四仓合并结果，并明确选择开启当前数据包作品的正式盲评。

## 改动

后端 pin 同步到数据源码 7c1933f 的不可变包 3c82309f65ec2a405741a53e581bd68aeb09460d。部署使用合并后的主线源码；Gallery 固定 4c3a084，游戏前端功能未改。计划经现有 batchSetFaceSettings 开启当前 90 件关闭作品并逐件审计，其他设置保留。

## 验证

数据私有 CI 全部成功，sourceDirty=false；177 件 / 20 题。Linux check 83/0、test 247/247；Gallery check 51/0、test 19/19、固定提交 build、CI intake 0 错 / 9 条既有提示、不可变包跨仓联调通过。数据包及 Gallery 全文件集和 SHA256 验证完成。退役四件按 task/id 的生产投票、比赛和精选引用均为 0。通用 reconcile-catalog 的字符串搜索误报了其他题同名模型，未运行 apply；本轮不改历史身份。

## 明确没做

本提交为发布准备，生产切换及公网验收结果待追加。无数据库迁移，不清票，不改投稿、校准、身份、审核或 Nginx。未提交用户的其他未提交文档。

## 遗留物

服务器 /root/aob-pool-release-20261003 保存代码和 SQLite 备份、部署清单与验收材料；本机忽略 output/pool-release-20261003 保存固定源码、构建和传输证据。旧数据包及静态目录保留以便回滚。

## 下一步建议

完成后端、数据包与 Gallery 协同切换，验证当前 177 件数据包作品全部 eligible，并验证业务表保留和公网目录 digest 一致。

## 发布结果追加（2026-10-03）

发布完成于 2026-10-03 04:32:51 UTC（Brisbane 14:32:51）。后端 5527c5e、Gallery 4c3a084；两端消费同一验证包，公开目录 177 件 / 20 题，catalogDigest 相同。用户明确授权统一开启当前数据包作品的正式盲评，实际经后端 batchSetFaceSettings 恢复 90 件，另 87 件已开启，当前 177 件全部 eligible；校准、其他门面开关和 5 条退役关闭记录保留。篝火营地正式池 11 件 / 11 配置，展示目录 12 件（含 4 件投稿，展示与正式资格规则不同）。

数据源固定 7c1933fb877458f1b56ae64b212a6de26aac2228，不可变产物 3c82309f65ec2a405741a53e581bd68aeb09460d，sourceDirty=false。

私有数据 CI、后端两次主线 CI、Linux check / 247 tests、Gallery check / 19 tests / 固定提交构建 / intake 0 错 9 条既有提示 / 跨仓联调均通过。后端安装文件与固定 main 逐文件哈希一致；数据包及静态站完整集合和 SHA256 校验通过。线上重启后数据库 v36，votes=369、works=360、questions=14、users=31、matches=370、reactions=1 的行内容哈希与停服前一致；只有授权的 work_overrides 和逐件审计变化。公网版本、共享 digest、营地正式池、retired scene 404、fold.js 200、跨站 CORS、游戏入口及旧 game API 兼容路径通过。浏览器目录桌面正常，Gallery 与游戏无捕获的 console error；未逐一测试全部作品交互，未登录生产管理员或提交投票。服务 active；该机 journald 无可读取 journal，未据此宣称日志没有错误。



数据包娱乐开关按用户要求保留原值，当前娱乐目录 526 件，其中数据包 177 件；旧快照默认关闭只作用于无 override 的记录，没有据此自动清理历史显式开启项。

备份位于服务器 /root/aob-pool-release-20261003 和 gallery.prev；本机证据位于后端忽略 output/pool-release-20261003，含固定源码、public-verification.json、pool-apply.json 和截图。本轮无迁移，无清票，无身份修订，无生产账号 / 实际投票交互验收。
