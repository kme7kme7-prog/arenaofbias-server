# 2026-10-06 · 数据包作品改档位后旧票更正与上线 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5 / Claude Code 桌面版

## 本轮目标

公网榜单 GPT-6 Astra Pro High / Max 两行作品为 0：作品已在后台改为 Default，旧票快照仍是旧档位。用户要求同类几行一起修，并让后台以后自动更正。

## 改动

- c80161d：`currentAttribution` 让后台 meta / review 保存时，按作品当前归属更正该作品既有 arena 票（包作品按题目+ID，投稿仍要求同 digest），不再要求本次字段变化，重新保存可补齐遗漏；投票时同样按当前归属写更正。新增 `npm run reconcile:attribution`（默认 dry-run）；api-contract 同步；新增包作品更正测试。
- 生产（2026-10-06）：停服备份后部署 c80161d；reconcile 更正 137 侧（astra-pro high/max→default 81、qwen3.8-max-0902→qwen3.8-max 47、deepseek-v4.1-flash extra→xhigh 5、minimax-m3 空档位→default 4）；以 shadow 在后台逻辑保存 5 件投稿：up-brjfqfun 档位 pro→Default（标题同步）、up-jj3xuy3h / up-st4vn91c 空档位→Default、up-esj2b4ji 登记 minimax-m3.1（标题去掉错拼）、up-2xp5x707 登记 seed-2.1-pro，自动更正 56 侧。原身份快照、选择、来源未改，每侧一条审计。

## 验证

- 本地 check109/0、test318/318；合成库复现 works0 → dry-run → apply → 重跑 0 变更。
- 生产副本完整演练后才正式执行；正式执行 expected 137 核对一致，integrity ok、外键 0、v40，服务 active/running、NRestarts0，bootstrap serverVersion=c80161d。
- 公网 leaderboard 作品为 0 的行由 5 行变 0；GPT-6 Astra Pro Default 275 次 / 13 件，第 7。有效计分票 3920→3919：一张票两侧更正后同属一个配置，按规则不计分。Gallery check:deployment 通过；生产 Gallery 榜单页核对无 0 作品行。

## 明确没做

- 未改 Gallery、游戏、数据包；未动其他作品或投票。未做手机目检。

## 遗留物

- 服务器 `/root/aob-attribution-20261006/`：backup/（platform.db 停服备份、before-reconcile.db、runtime-before.tar.gz、前后榜单与执行结果）、src/ 与 copy/ 演练副本。回退：停服后还原 runtime-before.tar.gz 与 backup/platform.db。

## 下一步建议

- 无。演练副本确认无用后可删除。
