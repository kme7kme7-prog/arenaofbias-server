# 2026-10-26 · 作品删除/拒绝后清理 COS 与 CDN · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok Bot

## 本轮目标

作品删除或被拒后，`media.arenaofbias.icu` 上的 COS 副本和 CDN 缓存仍可匿名直读。目标是在每条删除路径上异步清掉该作品的 COS 对象，并按单个 URL 刷新 CDN。

## 改动

- `server/cos-dual-write.mjs`：新增 SigV4 GET/DELETE（`buildCosRequest`）、ListBucket 解析、TC3-HMAC-SHA256（`tc3Request` / `buildCdnPurge`）、队列任务 `purge`、模块函数 `purgeWorkMedia` 和 `remirrorWorkMedia`。新增变量 `COS_DELETE_ON_REMOVE`、`MEDIA_CDN_PURGE_HOST`。CDN 只发 `PurgeUrlsCache`。
- `server/library.mjs`：`remove`、`finishModeration`（rejected）、孤儿目录清理调用 purge；`reopen` 重新 Put 磁盘上的公开文件。
- `server/questions.mjs`：删题连带作品、重提时删除样例作品后调用 purge。
- 测试：新增 `test/cos-purge.test.mjs`；`test/platform.test.mjs` 和 `test/moderation.test.mjs` 加调用断言。
- 无迁移，无 npm 依赖，不改 `media/` 匿名读策略。

## 验证

- `npm run check` 通过；`npm test` 553/553（Node 22.21.1）。改动前基线 544/544。
- 新签名代码用只读凭据实测：COS ListObjects 200；CDN DescribeDomainsConfig 返回 CAM 未授权（证明 TC3 签名被接受）。
- `curl -I` 抽测 `media.arenaofbias.icu`：COS 源站不回 `Cache-Control`，CDN 不回 `Age`；`X-Cache-Lookup: Cache Hit` 的响应 `Date` 停留在前一天，说明节点缓存至少十几小时，具体 TTL 需控制台或 `cdn:DescribeDomainsConfig` 权限确认。

## 明确没做

- 没有合并、部署或 SSH；没有删除任何真实 COS 对象，没有调用真实 PurgeUrlsCache；没有改 CDN 或 CAM 配置。
- 没有处理待审核作品在审核前已双写到 COS 的问题，也没有清理 10-25 全量同步带上去的非公开文件名对象。

## 遗留物

- 只读盘点在 box 的 `/workspace/rd/cos-orphans-20261026/`（不在仓库内）。

## 下一步建议

- 给 `server-cos` 补 `cos:GetBucket`（`media/` 前缀）、`cos:DeleteObject`（`media/*`）、`cdn:PurgeUrlsCache` 后再部署；部署时 `library.mjs` 需三方合并以保留线上 arena-only 补丁。
- 拿到生产只读 works 导出后，按盘点清单一次性清理已删除/已拒绝作品的旧对象（需单独批准）。
