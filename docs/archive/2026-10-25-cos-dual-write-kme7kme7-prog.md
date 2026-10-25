# 2026-10-25 · 媒体 CDN 双写 Phase B · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok 4.7（Cursor Cloud Agent）

## 本轮目标

新的公开投稿媒体在源站落盘成功后异步写入腾讯云 COS，键与公开路径一致。COS 失败或缺少密钥不得让上传或截图失败。只开 PR，不合并，不部署。

## 改动

- 新增 `server/cos-dual-write.mjs`：用 Node `https` 和自写的 AWS Signature Version 4（service 名 `s3`）做 PutObject。主机是 `https://<bucket>.cos.<region>.myqcloud.com`。失败重试 4 次（间隔 0.5s、2s、8s）后只打日志。
- 写入点：投稿封面（`library.mjs`）、截图 `first.jpg` / `mobile.jpg`（`capture.mjs`，不含私有 `outputDir`）、`cover:write`、`captures:write`、dots 预览的 `.sbox` / `.webp`。回滚只改指针，不重新上传。
- 环境变量仅 `COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY`。进程环境优先；否则读 `/root/.config/arenaofbias/cos.env`，再否则读安装目录 `cos.env`。`COS_REGION` 缺省 `ap-shanghai`。缺桶名或密钥则跳过并警告一次。
- 读切换不在本服务。前端变量名为 `MEDIA_CDN_BASE_URL`：空 = `https://api.arenaofbias.icu`；`https://media.arenaofbias.icu`（无末尾 `/`）才改读 CDN。
- 文档：`docs/deploy.md`、`docs/api-contract.md`。`cos.env` 加入 `.gitignore`。无迁移，无 npm 依赖。

## 验证

- `npm run check`：170 个文件，0 错误。
- `node --test test/cos-dual-write.test.mjs`：10/10。覆盖成功 Put（调用方不等待）、缺密钥跳过且不抛、失败重试 4 次后不把错误抛给调用方、环境变量覆盖 ops 文件、ops 文件优先于相对 `cos.env`、SigV4 与 AWS GET 示例签名一致。没有请求真实 COS。
- `npm test`：543 通过，1 失败，0 取消。失败项是 `test/blind-pool.test.mjs` 里「same package content follows registration and provenance changes while other works stay put」（期望厂商名 `Renamed vendor`，得到 `Current vendor`）。在 `origin/main` 上复跑同样失败（533/534）。只跑 `test/blind-pool.test.mjs` 为 21/21。不是本轮改动引入的。
- 没有界面改动，没有用浏览器验收。没有部署，没有对 `media.arenaofbias.icu` 做真实 Put。

## 明确没做

- 没有合并，没有部署，没有把对象设为 public-read。
- 没有让 API 把 `media/...` 改写成绝对 URL，也没有读取 `MEDIA_CDN_BASE_URL`。
- 没有双写 `assets/scenes/`、`media/references/`、`preview.json`、延迟截图或 `history/`。
- 没有改 `test/blind-pool.test.mjs` 里已有的失败。

## 遗留物

- 进程内队列在重启时丢掉尚未完成的 Put。源站文件还在。
- 本机全量测试的那一项既有失败仍在。

## 下一步建议

- Gallery / Show1 另开 PR，用 `MEDIA_CDN_BASE_URL` 做读切换，默认保持 API 源站。
- 运维放好 `/root/.config/arenaofbias/cos.env` 并加上 `EnvironmentFile=-` 之后，用一条新的公开媒体核对 `COS dual-write ok` 和 `https://media.arenaofbias.icu/media/...` 变为 200。
