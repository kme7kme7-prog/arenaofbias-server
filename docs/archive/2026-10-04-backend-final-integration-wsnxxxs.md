# 2026-10-04 · 空标题与随机混合联调核对 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6.1 Sol / high，Codex desktop 子代理

## 本轮目标

按用户授权核对近期未发布后端修改、适用分支与 Gallery 随机混合 API 兼容性，验证、提交并推送；服务器部署由父代理统一执行。

## 改动

- 初始 main b3b1433c0518bf8a77bead58c37ee983ec8ff979，工作区干净。实际远端仅 origin；git fetch --all --prune 后 origin/main 为 13b7aaacfe49c80675a95f09f41c14fd2ed13858，空标题功能领先一条。
- codex/backend-integration-20261003、codex/gallery-csp-repair、codex/luna-flex-moderation、show1-vote-processing、unify-pool-defaults 相对 main 独有提交均为 0，无需重复合并或删除。
- 仅同步 docs/api-contract.md：新投稿的空 / 省略标题使用模型名称与推理档位默认值，编辑显式空标题使用相同规则、省略保留原标题；移除投稿错误清单的旧缺标题说明。
- 审查现有上传、编辑、审核实现，无功能修复需要。随机范围消费端继续为每一组传具体 task，跨题 previous 不影响后端配对，不新增接口。

## 验证

- npm run check：95 文件，0 错误。
- npm test 最终完整通过 287/287，0 失败、取消、跳过。前两次完整执行遇到既有随机监听端口被 Node fetch 拒绝（bad port）：首轮 286 通过 / 1 失败，第二轮 282 通过 / 5 取消；未改无关测试，第三轮通过。
- git diff --check 通过。
- 隔离 createPlatform / 真实 HTTP / 合成 SQLite 复现：普通用户登录，两题全站 poolStats 都为 works=2、entries=2；owned 题两件均属本人，创建对局返回 409 insufficient；other 题两件非本人，创建对局返回 200 task=other。已向父代理提供消费端跳题的证据。
- 本地正式包经 createCatalog 读取，20 题 / 176 件，catalogDigest=b9a2a5d29c8705089d4cf9b16752bee2cf589c2393f7816734c28da677621cab。

## 明确没做

- 无新增依赖、数据库迁移、配置或数据包修改；本仓无 build / check:intake 脚本。
- 未 SSH、生产登录、业务写入、部署或浏览器验收；本地测试不代表全部生产交互通过。

## 遗留物

- 忽略 output/coordinated-integration-20261004-backend-final/ 中保留三轮测试日志与 random-insufficient-repro.mjs / .json / .log。临时合成数据库与 HTTP 端口已经关闭，不提交业务或生成文件。

## 下一步建议

- 父代理固定推送后的 main 完整 SHA，按 docs/deploy.md 核对线上 .server-version，再部署并验收 bootstrap 的 serverVersion。此次空标题功能无数据库迁移；若线上代码更早，仍需核对既有 v39、参考图备份、已审阅预览媒体与 PENDING_PER_USER 显式覆盖。
