# 2026-10-22 · dots 队列外只读资产 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok 4.7（Cursor）
- 范围以 `dots-read-assets-proposal-20261022.md` 第 2 节为准。未部署，未改生产库或线上令牌。

## 本轮目标

让已有 `works:read` 的令牌能下载不在审核队列里的作品截图和上传包文件。不新建 scope，不实现服务端重截图。

## 改动

- `GET /api/dots/works/:task/:id` 增加 `entry`（数据包作品为 `null`）和 `images: [{ name, url }]`。`images` 只列 `media/<作品>/` 下 JPEG/PNG/WebP。原有字段保留。仍不返回邮箱、IP、digest、内容密钥、scene URL 或令牌。
- `GET /api/dots/works/:task/:id/images/:name`：scope `works:read`，审计 `work-image`。文件名须过图片白名单且出现在目录列表里。`Cache-Control: no-store`，`Content-Security-Policy: sandbox; default-src 'none'`。
- `GET /api/dots/works/:task/:id/file?path=`：scope `works:read`，审计 `work-file`。只服务 `library.uploadById` 的上传作品。realpath 沙箱，禁止 `..`。`application/octet-stream`、`attachment`、no-store、CSP sandbox。数据包作品 404。
- 不新增 `TOKEN_SCOPES`。限流仍是每令牌每分钟 120 次。文档见 `docs/dots-moderation-api.md` 第 10 节。

## 验证

- `npm run check`：157 个文件，0 错误。
- `node --test --test-concurrency=2 test/*.test.mjs`：460 通过，0 失败，0 取消，0 跳过。
- `node --test test/dots-moderation.test.mjs`：30 通过，0 失败。覆盖队列外截图和包内文件 200、路径越界 404、数据包包内文件 404、缺少 `works:read` 时 403，以及 DTO 的 `entry` / `images`。
- `git diff --check` 通过。未做浏览器验收：本轮没有页面。未部署，未对生产库或线上令牌做任何操作。

## 明确没做

- 未做第 3 节服务端重截图，没有 `captures/rerun`，没有新 scope。
- 未提供数据包作品的包内文件，未做整包 zip，未做无鉴权公开媒体直链。
- 未部署，未 grant 或改线上令牌。已有 `works:read` 的令牌在部署后自动拥有新只读流；尚未授予 `works:read` 的令牌仍须运维另授。

## 遗留物

- 无。

## 下一步建议

- 合并后再谈部署。部署时保留现场补丁，不要整仓覆盖。不要为本批只读流改令牌明文；缺 `works:read` 的令牌由运维按既有默认档 `grant`。
