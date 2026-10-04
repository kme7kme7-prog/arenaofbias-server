# 2026-10-04 · 后端发布前核对 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6.1 Sol / medium，Codex desktop

## 本轮目标

- 按用户授权核对当前源码、所有 worktree、实际远端分支与邮箱注册/盲评兼容性，为父代理统一发布提供固定来源。

## 改动

- 主线初始干净，源码 `8e8e6f8a52bc290bd3c9ed6340899e47296eb3d4`；本轮仅补交接与本归档，无功能变更。
- fetch/prune、ls-remote heads：origin 仅 main=`dc1977c`。主线待推 `c9d1f12` 会话闲置 7 天和 `8e8e6f8` 软冷却/跳过不揭晓；五条本地支线均已包含于 main，没有独有提交，不做重复合并。
- 审查注册必填邮箱/验证码、邮箱发码、唯一性及事务消费验证码；现有后端可消费 Gallery 注册分支，无新增后端依赖。两条待推功能无新迁移或配置变化。

## 验证

- Node 24.16.0，npm run check：95 文件 / 0 错。
- 首次 npm test：292/293，admin HTTP 夹具随机监听端口触发 Node fetch bad port；保持无关测试原样，完整重跑 293/293，0 失败/取消/跳过。
- git diff --check 通过。真实本地目录只读加载：20 题 / 176 件，digest `b9a2a5d29c8705089d4cf9b16752bee2cf589c2393f7816734c28da677621cab`。
- 源码检查包含会话闲置、avoidCooling、跳过 a/b:null、保留登录已决定历史；现有全套包含 HTTP/SQLite 邮箱注册及迁移回归。

## 明确没做

- 本仓没有 build/check:intake 脚本。未做浏览器、真实 SMTP/CAPTCHA、生产账号写入、生产 Node 22 复验、SSH 或部署。推送等待父代理协调。

## 遗留物

- 旧 backend-integration worktree 的本地 datapack 配置、gallery-csp-repair worktree 的历史上线补记，以及 review 隔离发布暂存与未跟踪副本保留。review 功能是已包含于 main 的旧版本，不能合并覆盖后来包参考图/空标题/冷却功能。
- 忽略日志 output/coordinated-backend-release-20261004-test.log 与 output/coordinated-backend-release-20261004-test-retry.log；不提交配置、生成物、凭据或业务数据。

## 下一步建议

- 由父代理统一推送、固定最终文档提交 SHA，并执行 Linux/生产发布与跨前端验收；上线后现有会话按 7 天闲置重新计算。
