# 2026-10-11 · Gallery 公开目录缓存 · wsnxxxs

- 负责人：wsnxxxs；执行：Codex 与用户指定 GPT-6.1 Sol/high 代理。仅后台加载路径与配套Gallery消费端；不改另一前端或私有数据源码。

## 本轮目标

解除Gallery题库对包含会话、权限和统计的重聚合请求的依赖，降低重复读取开销，保持公开可见性和账号隔离。

## 改动与决策

- 本归档随本轮英文提交保存。新增纯公开 `/api/catalog`、轻量 `/api/session`、私有 `/api/activity`，保留 `/api/bootstrap` 兼容。catalog无用户字段与mine、无session touch；activity仅登录用户生成workAccess，匿名无需重复枚举权限。
- 新模块catalog-response缓存序列化Buffer及ETag，同版本冷请求合并，分批构建让步；public,no-cache要求客户端每次重验证，支持304/HEAD、CORS条件请求及Server-Timing。session/activity继续no-store。
- 包版本、相关表TEMP触发器修订、PRAGMA data_version检测目录改变；构建结束再检查，防止并发审核撤下生成过期快照。用户公开资料变化失效，会话续期不失效；仅文件预览元信息最长30秒后重新读取。媒体和内容访问依然实时校验，不把缓存当作授权。
- 恢复部署端相关池复用、序列化让步与精确总计优化，不运行全榜计算求总数；保留本地个人署名和预览行为。更新读取门禁及API契约。无schema迁移、无新增外部缓存依赖。
- 对前端独立复查发现并修复统计迟到导致表单重建、未知统计禁用榜单筛选、401清理后缺少匿名恢复；主代理补充真实浏览器回归。写前旧统计覆盖新结果也经单测与浏览器验证。

## 验证

- `npm run check`：117文件/0错误；`npm test`：337/337；diff whitespace检查通过。
- HTTP契约测试：匿名/成员/管理员公开字节一致，无会话写入；热命中不遍历作品或榜单；ETag/304/HEAD/CORS；发布、撤下、题目、作者资料、外部DB与包更新失效；冷构建并发审核；activity权限与旧聚合兼容。
- 合成基准：Windows Node v24.16.0、本地顺序HTTP，每种5次，1200包内作品/60题/20模型，无投稿与票。中位旧bootstrap2817.81ms（604215B）、冷catalog1369.14ms（585295B）、热catalog1.973ms、304为0.556ms（0B）、匿名session0.597ms、成员session2.832ms、匿名activity1499.47ms（2687B）。结果不含真实票历史、预览文件、网络与浏览器渲染，不能作为公网速度保证。
- Gallery check69/0、test39/39、生产配置build176/70与CI intake0错/8既有提示；11项浏览器异常/竞态场景通过。真实后端+实际20题/176件包跨源浏览初次457ms、整页刷新221ms、条件304/预检与会话no-store通过，pageerror0，无业务POST。
- integration smoke通过。Gallery原本地联调固定版本较旧，只在忽略目录复制配置中对齐已验证消费包；原配置与私有源码未改。

## 明确没做

未push、未部署、未运行Linux全套或新版公网check:deployment；未生产登录/投稿/投票。未替换生产数据库、数据包或配置。未声称全部原作交互通过。

## 遗留物

忽略目录 `output/loading-fix-20261011/` 保留可复现基准脚本与 `benchmark-final.json`；早期benchmark留存但最终结果以上述final为准。浏览器、跨仓联调证据在Gallery同名output目录。新增源码、测试与文档纳入本轮提交；临时数据库和生成物不提交。

## 下一步建议

先发布兼容后端再发布Gallery。核对生产全目录、ETag变更、账号权限、共享限流及真实读延迟，保留原数据与配置。Gallery同轮归档记录完整浏览器场景与发布边界。
