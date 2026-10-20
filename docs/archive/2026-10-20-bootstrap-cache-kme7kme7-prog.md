# 2026-10-20 · bootstrap 减负 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok Bot
- 本文写于提交前。用户授权开 PR，未授权合并或部署。基线为 main `fd343c8`，与公网 `serverVersion`（`fd343c8…+curated-staff.2c76759e5841`）一致。

## 本轮目标

`/api/bootstrap` 每次请求都重新生成约 1.9 MB 原文，后端不压缩，`no-store`。目标：压缩、未登录缓存加 ETag/304、按需减小首屏体积，并保持新旧前后端双向兼容。

## 体积构成（公网，未登录）

| 块 | 字节 | 说明 |
| --- | ---: | --- |
| works | 1,551,059 | 1945 件；captures、scene、author、时间字段分散占用 |
| questions | 323,204 | 96 题，其中 `prompt` 249,268 |
| featured | 31,448 | |
| reactions | 12,312 | |
| arena / site / serverVersion | 4,235 / 671 / 529 | |

## 改动

- `server/compress.mjs`：解析 `Accept-Encoding`（q 值、`q=0`、`*`、`x-gzip`），br 优先；1 KiB 以下不压缩。br 质量 5（同一 1.75 MB 正文：q5 243,897 B / 24 ms，q9 238,908 B / 62 ms，q11 219,109 B / 1.7 s），gzip 级别 6（306,077 B / 17 ms）。在 libuv 线程池中压缩。
- `sendJson`：1 KiB 以上的响应按协商压缩并合并 `Vary`。小响应仍同步写出，行为不变。
- `createSharedJson`（`server/catalog-response.mjs`）：从原来的 catalog 缓存提炼而来。`strict` 键在构建期间变化会重建（撤下作品不会漏出），`loose` 键只决定是否复用，避免高频投票让请求反复重建。内容哈希不变时沿用已压缩副本。ETag 为 `"<hash>"`、`"<hash>-br"`、`"<hash>-gzip"`，比较时去掉 `W/` 和编码后缀。
- `/api/catalog` 改用上述实现，`public, no-cache` 不变，新增压缩。
- 未登录 `/api/bootstrap`（含无效会话）：完整版与 lite 版各一份缓存。strict 为包版本、目录修订、截图/审核开关；loose 为新增的 `activity_revision` 临时触发器（votes、reactions、featured_picks、featured_refreshes 增删改）；`BOOTSTRAP_CACHE_MS` 默认 15 秒兜底（arena 统计、定时精选等无触发器的变化）。`private, no-cache` 加 ETag。matches 写入频繁，不参与失效。
- 登录用户：每次按本人生成，`no-store`，不读也不写共享缓存，只压缩。
- `?lite=1` 省略 `works`，其余字段不变；`admin/admin.js` 改读 lite（它不使用 bootstrap 的 works）。
- CORS 对 `/api/bootstrap` 也暴露 ETag、Server-Timing。

## 验证

- 本地近生产规模：生产数据包 ff92179（513 MB）+ 生产公开数据灌入的 1769 件上传作品、76 道社区题、216 名用户；读限流放开。盒子 CPU 比线上快约 7 倍（线上源站直连 p50 0.70 s，本地旧版 89 ms）。

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 未登录 bootstrap 传输 | 1,755,158 B 原文 | br 243,897 / gzip 306,077 |
| 未登录 bootstrap p50 / p95（缓存命中，br） | 91 / 109 ms | 6.6 / 8.4 ms |
| 未登录 304 | 不支持 | 0.3 / 0.6 ms，0 字节正文 |
| 未登录写入后首个请求 p50 / p95（br） | 同上 91 / 109 ms（每次都重建） | 161 / 175 ms（重建+压缩） |
| 未登录 lite（br） | — | 109,262 B（原文 309,728），命中 2.2 ms，写入后 51 ms |
| 登录 bootstrap p50 / p95 | 121 / 162 ms，1,756,250 B | br 165 / 201 ms，244,181 B |
| 登录 lite（br） | — | 51 / 78 ms，109,446 B |
| catalog（br，命中） | 1,724,220 B，2.3 ms | 242,749 B，6.0 ms |

- 公网参考（改前，盒子经 EdgeOne）：identity 1,924,830 B 用时 5.0–7.0 s；gzip 344,158 B，总时长 1.46–3.4 s；br 未压缩，3.6–4.5 s。
- 新增 `test/bootstrap-cache.test.mjs`：编码协商、各编码与弱化 ETag 的 304、登录请求不进缓存也不改缓存、无效 cookie 拿共享正文、反应/题目/撤下作品使缓存失效、lite 字段、TTL、高频 loose 写入不循环。`test/catalog-http.test.mjs` 的 HEAD 断言改为显式 identity，`test/platform.test.mjs` 的 Vary 断言加上 Accept-Encoding。

## 明确没做

- 没有改 Nginx、EdgeOne、前端仓库；没有给 catalog 或 bootstrap 加 `s-maxage`。
- 没有缩减 works 的字段或 questions 的 `prompt`，lite 只拆掉 works。

## 遗留物

- 本地基准脚本在操作者工作区，不入库。

## 下一步建议

- 上线后用 docs/deploy.md「API 压缩与缓存头」中的命令验收。
- 线上 CPU 较慢，登录 bootstrap 压缩约增加 0.1–0.2 s 服务端时间，但传输少 1.5 MB；若线上 p95 明显上升，可把 br 降到质量 4。
