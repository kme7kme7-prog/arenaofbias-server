# 2026-10-06 · 自填模型名按注册表别名归入登记模型 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5 / Claude Code 桌面版

## 本轮目标

按模型榜同时出现「Kimi k3」与「Kimi K3」、「Doubao Seed 2.1 Pro」与「Seed 2.1 Pro」。自填模型名的投稿无 `modelId`，排行键退化为 `x:<小写名>`，与登记模型分开计分；Gallery 按名称 / 别名显示为登记模型，掩盖了分行。用户要求服务端从源头修复，并改正线上已有作品。

## 改动

- 27fa2f7：`catalog.modelNamed(name)` 按 Gallery 同一规则（NFKC、忽略大小写、空格、-、_）匹配 `modelPool` + `models` 的 `name` / `aliases`；`library.identity()` 自填名命中时改存登记 `modelId`、名称和厂商，投稿、作者编辑、管理员 meta / review 共用。无迁移，仍 v40。api-contract 同步；platform 测试加 `model_a` → `m-a` 断言。同次推送了此前未推送的 de8a141（仅文档）。
- 生产（2026-10-06）：部署 27fa2f7；停服备份后以 shadow 调用 `library.setMeta` 改登记 6 件自填投稿，自动更正 75 侧：up-syvojhs1 / up-07owqctd → seed-2.1-pro（17 / 5）、up-iyswo7ro → kimi-k3（3）、up-ux2le0kj → glm-5.3（12，标题改「GLM 5.3 · Max」）、up-b04mghy4 → glm-5.3-flash（8，标题改「GLM 5.3 Flash · Max」）、up-69hy7vxp → sensenova-6.8-flash-lite（30）。后三件为扫描新发现的同类问题。原身份快照、选择、来源未改，每侧一条审计。

## 验证

- 本地与服务器暂存目录 check109/0、test318/318。
- 现场原为 c80161d，与上次记录一致。服务器 clone GitHub 超时，改为本机 `git archive` 经 ssh 上传（SHA-256 f2417c78…0608061 两端一致），无删除 / 改名文件；重启后 active、NRestarts0，公网 bootstrap serverVersion=27fa2f7，数据包 6403464 不变。
- 生产副本演练：5 个 `x:` 重复行消失、59→54 行、有效比较数不变、重跑 0 变更；正式执行结果与演练一致，integrity ok、外键 0、v40。公网按模型榜 54 行、4918 次，Seed 2.1 Pro 94 次 / 7 件、Kimi K3 200 / 21、GLM 5.3 218 / 17、GLM 5.3 Flash 435 / 28、SenseNova 6.8 Flash Lite 42 / 3。

## 明确没做

- 未改 Gallery、数据包；`x:dots3-note-preview` 不在注册表，保持原样。未做浏览器目检。

## 遗留物

- 服务器 `/root/aob-alias-20261006/`：platform.db（部署前快照）、before-edit.db（停服改登记前快照）、code.tar.gz、server-version、datapack-current、board-before/after.json、edits.json、copy/ 演练副本、scan / edit / board 脚本；`/root/arenaofbias-deploy-27fa2f7…` 暂存目录与 `/root/server-27fa2f7….tar.gz`。回退：停服后还原 code.tar.gz、server-version 与 before-edit.db（或 platform.db）。

## 下一步建议

- 无。演练副本与暂存目录确认无用后可删除。
