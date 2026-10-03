# 2026-10-03 · 最新后端功能合并 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6.1 Sol high / Codex

## 本轮目标

按用户授权合并四仓待发布功能，保留线上与远端功能，准备后端固定源码供父代理统一推送及部署。

## 改动

- 起点 main `216879e`、origin/main `ca3e2ca`，共同祖先 `9bf06d0`。本地领域扩充 `7f83bd6`、Three.js CDN 与恢复按钮 `216879e` 全部保留。
- 在隔离分支 codex/backend-integration-20261003 合并远端娱乐小窗 `aob=arena-fold` 与键盘 `aob=arena-scene`，两类脚本互斥，作品门禁和 Gallery 语义保持。API 文档冲突保留两侧说明。
- 给娱乐脚本补齐错误恢复区域保护，防止控件折叠隐藏换源 / 重试按钮；扩展已有 VM fixture，一项回归同时验证四类错误区域保留与普通控制面板折叠。
- codex/gallery-csp-repair、codex/luna-flex-moderation、show1-vote-processing、unify-pool-defaults 均是 main 祖先，无独有功能再次纳入。保留远端归档 / 数据同步 / 清理脚本，不执行清理或安装 cron。

## 验证

- Windows Node 24.16.0：npm run check 87 文件 / 0 错；npm test 262 / 262，无失败、取消或跳过。
- 现有回归覆盖邮箱验证码注册 / 一次消费 / 事务回滚、API v2 / domainGroups、三级权限及作品管理、分类扩充、长期内容键 / 410 门禁、娱乐十件门槛和正式豁免。
- `server/db.mjs` 与合并前和 origin/main 相同，MIGRATIONS 仍 38。既有 v36 / v37 -> v38 与幂等回归通过；本轮未追加或改写迁移。
- git diff --check / staged diff --check 通过。固定源码与运行文件清单由父代理采用完整提交 SHA 出包。

## 明确没做

未访问或写入生产数据库，未修改数据包、消费 pin、原主工作区脏文件、其他仓源码；未推送、部署、运行清理脚本或安装 cron。未实际发送 SMTP 邮件、执行外部审核 / 自动截图、验收真实账号 Turnstile、浏览器全部作品或真机。

## 遗留物

隔离 worktree 为 C:/Users/Ryan/AppData/Local/Temp/aob-backend-integration-20261003。原主工作区 main 仍为 216879e，原未提交 / 未跟踪文件保留；父代理统一推进发布分支和工作区。

## 下一步建议

先确认现场运行源码与数据库版本，再把本合并提交推进 origin/main 并核对祖先门禁；备份 SQLite / 旧代码 / 数据包指针，后端先于游戏发布。若生产已 v38，此轮无新迁移；若仍 v37，使用既有 v38 迁移并保留完整备份，不能靠旧代码降级。核对显式 CONTENT_CDN_ALLOWLIST 是否包含 registry.npmmirror.com，SMTP / Turnstile 环境保持并验收验证码注册。
