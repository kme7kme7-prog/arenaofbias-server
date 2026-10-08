# 2026-10-08 · 模型名称去点与只读重复报告 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex 桌面客户端，无子代理。
- 范围：catalog 名称匹配、只读报告、2个测试、api-contract 与本轮交接；起始后台工作树干净，Gallery 既有未提交匹配改动保留。

## 本轮目标

名称归一与 Gallery compact 一致，补上点及其他标点；先检查完整注册表冲突和键的使用范围，再实现只读疑似重复报告。不得 commit/push/部署/写生产，不改历史数据、schema 或读榜时的 x: 归属，不做错字匹配。

## 改动

- 未提交：`server/catalog.mjs` 的 modelNameKey 改为 NFKC、小写后 `replace(/[^\p{L}\d]+/gu, '')`。修改前检查当前 modelPool/models 合并去重后的262模型、442名称/别名：303新键、跨模型冲突0。modelNameKey 仅用于内存 modelsByName/modelNamed，无持久化键消费者；library.identity 在明确保存时调用 modelNamed，modelKey/entityKey 及读榜 x: 键未改。旧离线 reconcile-catalog 有独立旧名称匹配函数，仅做显式协调修复，不是该导出键的持久化消费者，本轮不改。
- 未提交：`scripts/report-model-duplicates.mjs`，`--db` 必填、`--dist` 默认当前包。使用 readOnly SQLite 连接和单个 BEGIN 读事务，不启动平台、调用迁移、创建作品目录、清理对局、自动合并或更新任何数据库行。输出空 model_id 且 model_other 命中登记名称/别名的作品、题目、自填名、登记模型、状态/下架/策展状态，以及 config/model 两种当前有效票数。
- 有效票遵循 arena 当前资格/归属：双方合格、arena 来源、有身份、排除 AI 题和移题前票，沿用 digest 当前归属与显式人工更正，分别排除同配置/同模型比较。待审/存疑作品也列入匹配报告，有效票为0；下架/关盲评作品保留仍有效的历史票。票数用于人工审阅，不预测修正后的分数变化。
- 未提交：`test/model-name-duplicates.test.mjs` 2用例覆盖去点、别名、全角、5.7版本隔离/错字不匹配、x:计分键保持，以及真实CLI临时库列出1件未登记作品（配置2票、模型1票），排除待审/缺身份/legacy票，源库逐字节不变。
- 未提交：`docs/api-contract.md` 同步匹配规则、报告命令/字段/口径；HANDOFF 和本归档。Gallery 只追加本轮交接和归档。

## 决策

只补精确 compact 规则，不加入前端词序/错字提示逻辑。名称索引仍是查询键，持久化与读取排名的自填名归属保持。历史修正仍由用户逐件决定后经 library.setMeta 执行；无待拍板事项。前后端可任意顺序上线。

## 验证

- Windows Node24.16.0：`npm run check` 111文件/0错误；`npm test` 327/327。
- WSL Ubuntu Node24.16.0、隔离 Linux 本地文件系统源码：最终标准 `npm run check` 111文件/0错误、`npm test` 327/327；新增2用例全程通过。
- Linux前两次全量和一次串行尝试，均在既有 `blind-pool.test.mjs` 厂商刷新断言出现 Current vendor / Renamed vendor 不一致；该用例单独通过，修改前 HEAD 的完整325项通过但独立 blind-pool 也复现相同18/19失败。仅隔离复制的测试加统计诊断，未改仓库缓存或无关测试；诊断时两次同长度写入 stat 时间相差4ms并通过19/19，缓存时序问题为推测。最后标准全量327/327通过，保留全部失败/基线日志，不宣称永不偶发。
- 只读运行已有一致副本：采集时间2026-10-08 02:25:55 Brisbane，v40、874作品/6645票；16件 model_id 为空，按当前注册表精确匹配疑似重复0件。前后主数据库与WAL SHA256均不变。副本较旧，不能代表当前生产数量；未连接生产采集新数据。
- Gallery 本地 check68/0、test33/33；其已有未提交匹配功能未改。`git diff --check` 通过。
- 后台没有 build/check:intake 脚本；Gallery本轮仅记录、无本轮源码/数据包变化，未重新build/intake。不涉及新的界面实现，未浏览器/真机/生产交互验收。

## 明确没做

未改 schema、任何历史作品/票/审计/榜单归属、私有数据包、另一前端或本轮 Gallery 功能源码。未 commit、push、部署、生产登录/写入或重启。

## 遗留物

本轮后台6个相关文件（含新脚本/测试/归档）未提交；Gallery本轮HANDOFF/归档未提交，其他会话原有修改及暂存的测试重命名保留。忽略证据 `output/model-name-duplicates-20261008/` 含 registry-collisions.json、duplicates.json、report-summary.json、Windows/Linux/基线/失败日志及 Linux 工作区路径；Linux隔离目录保留，无无差别清理。

## 下一步建议

后续获授权再提交或上线；若需当前生产清单，应另行只读采集最新一致副本后运行报告，不用本次旧副本的0件结论替代现场检查。
