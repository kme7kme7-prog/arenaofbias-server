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
