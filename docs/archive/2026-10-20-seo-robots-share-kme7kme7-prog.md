# 2026-10-20 · API 与作品域 robots、作品外壳分享卡片 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：按本轮提交规则不署名
- 本文写于提交前。用户授权开分支和 PR，未授权合并或部署。

## 本轮目标

kme7 要让三个静态站能在搜索引擎里按名字「亿模亿样」搜到。api 与 w.* 不应进入搜索结果，所以 `robots.txt` 返回 `Disallow: /`。作品外壳页会被直接分享，QQ/微信卡片只读原始 HTML，需要一份正式介绍。

## 改动

- 新增 `server/robots.mjs`：`withRobots` 对 GET/HEAD `/robots.txt` 返回 `User-agent: *`、`Disallow: /`，其他请求原样交给原 handler。
- `server/index.mjs`：站点与作品两个 `createServer` 用 `withRobots` 包一层。没有改 `app.mjs`、`content.mjs` 和现场补丁涉及的文件，可以增量合并。
- `server/content-path.mjs`：外壳标题由「作品预览」改为「AI 作品预览 · 亿模亿样」，补 `noindex`、description、Open Graph、itemprop、twitter。分享图用 Gallery 的 `https://gallery.arenaofbias.icu/assets/share-preview.png`（占位，随 Gallery 发布）。外壳脚本不变，CSP 哈希不变。
- 测试：新增 `test/robots.test.mjs`；`test/content-path.test.mjs` 增加一条外壳 og:image 断言。
- 文档：README 的 API 概览、`docs/deploy.md`「线上路由与 Nginx」、HANDOFF。
- 无数据库迁移，无 npm 依赖。

## 合并前核对

- 2026-10-20 公网 `serverVersion` = `006ef81…+base.6d941d2…+…+base.3629a9e…+curated-staff.2c76759e5841`。本分支基于 main 006ef81，改动文件与现场补丁（app/library/questions/show1compat/arena/curated-boards/read-guard）不重叠。

## 验证

- `npm run check`：144 个文件，0 错误。
- 串行跑全量 `node --test --test-concurrency=1 test/*.test.mjs`：399/400。失败的 1 条是 `test/blind-pool.test.mjs` 的既有断言，与本轮无关，main 上同样失败。
- 本地用临时 DIST_DIR/DATA_DIR 启动 `server/index.mjs`：站点端口和作品端口的 `/robots.txt` 都返回 200 和 `Disallow: /`，`/api/bootstrap` 返回 200。

## 明确没做

- 没部署，没改 Nginx。上传时生成的文本作品 `index.html` 标题「文本作品」在沙盒内，不是分享入口，没有改。

## 遗留物

无。

## 下一步建议

- 发布后用 `curl https://api.arenaofbias.icu/robots.txt` 和 `https://w.arenaofbias.icu/robots.txt` 验收。
