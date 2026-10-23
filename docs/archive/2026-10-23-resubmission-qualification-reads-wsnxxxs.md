# 2026-10-23 单题重提与资格查询复用 - wsnxxxs

负责人 wsnxxxs；主代理与三个同模型子代理并行修复及交叉复核。四仓先同步并核对干净基线；用户已授权本轮修复、提交推送及上线。

## Changes and decisions

新增GET /api/me?view=resubmit&question=<id>，严格单值与选择器校验，先查未删本人题，不存在/他人统一404，无admin归属豁免。只取同题本人未删非curated样例7字段，沿原scene权限和审核脱敏，不枚举全部作品/审核队列；旧me保留。qualification overview/adminInfo每次同步read内复用完整保存快照和可用性，Map不跨请求；同作品不同digest不能串用，撤下后新请求重判。考试写入和评分规则保持。无迁移、新依赖或数据包切换。

## Verification

本机及保留现场补丁的Linux Node22.23.4候选check160/0、484/484，0失败/取消/跳过。生产一致私有只读副本47项完整DTO/旧投影对照通过，仅规范随机短期预览token，不启平台队列/维护。每组3次DTO+SQL/文件+JSON采样、不含HTTP/压缩：资格overview273B不变，SQL251→81、暖态31.89→5.79ms；管理22961B不变，1416→204、118.83→16.17ms；所选作者旧全量13309B/482SQL/211.89ms→单题1474B/6SQL/5.10ms，所需投影完全相等。真实临时SQLite+Gallery5项联调通过，other/admin404、匿名401、1窄GET、编辑及数字日期正确。

## Deployment and remaining work

只增量4模块，三方合并保留现场差异；reads5.18f0a37f0173，重启2.21秒。备份/root/aob-performance-round5-20261023/backend-backup，回退仅恢复代码、版本和服务版本配置，保留当前业务SQLite。最终schema49/quick_check ok/外键0，3服务active；gzip/304、私密401、选择器400、可信CORS/不可信403及全部捕获文件指纹通过。

One English commit, verified wsnxxxs noreply identity. Actual SHA/CI: parent private performance-round5-20261023 receipts. No private fixtures, logs or database snapshots committed. No changes to source works, model registration, datapack or frozen game rules. No production business writes in QA. Data repo unchanged: no empty commit. Subsequent user request for dots branch integration and senior assistant is separate, not claimed complete here. No unrelated uncommitted files.
