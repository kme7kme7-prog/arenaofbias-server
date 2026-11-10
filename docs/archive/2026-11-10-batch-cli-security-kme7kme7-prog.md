# 2026-11-10 · 批量投稿 CLI 安全修复 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok 4.7 / Cursor cloud agent

## 本轮目标

修复普通管理员本地批量投稿 CLI 的静态复查问题，并做出能独立运行的新压缩包。只开 PR。不合并，不部署，不重启，不制造生产令牌，不改 `BATCH_UPLOAD` 的默认值。

## 改动

- `tools/batch-upload/plan.mjs` 是摘要的唯一实现。`server/batch-plan.mjs` 只转出它，服务器和测试继续用原来的导入路径。
- `manifest.json`、`plan.json` 和 `batch-root` 用 `lstat`、普通文件、硬链接和 `O_NOFOLLOW` 读取。`plan.json` 先写临时文件再 `rename`，不截断符号链接、硬链接或 FIFO。
- macOS 用 `security add-generic-password` 且 `-w` 不带值，秘密从标准输入写两遍，并读回核对。Linux 仍用 `secret-tool` 的标准输入。Windows 删除补上 `PasswordVault.Remove`。确认失败、拒绝或超时会删设备码。
- 本地限额对齐试点默认值：每批 10 件、压缩 100 MiB、解压 300 MiB，另加单件 30 MiB / 150 MiB / 2000 文件 / 50 MiB。CLI 不读 `BATCH_MAX_*`。`status` 和 `cancel` 只读 `plan.json`。
- 确认页必须属于 `https://api.arenaofbias.icu`。作品键拒绝重复以及 `__proto__`、`constructor`、`prototype` 等特殊名。
- 说明见 `docs/batch-upload.md`、`tools/batch-upload/README.md` 和 `tools/batch-upload/package/`。

## 验证

- `npm run check`：194 个文件，0 错误。
- `node --test --test-concurrency=1 test/*.test.mjs`：621 项，620 通过，1 失败，0 取消，0 跳过。失败是 `test/blind-pool.test.mjs` 的 “same package content follows registration and provenance changes while other works stay put”（期望 `Renamed vendor`，实际 `Current vendor`）。在 `origin/main` 上整文件运行同样 21/22 失败；该用例单独运行在本分支和 `origin/main` 都通过。未改这个测试，也未跳过。
- 新增 CLI 测试覆盖符号链接、硬链接、FIFO、重复作品键、特殊字段名、本地大小边界、确认页源、设备码清理，以及凭据命令的 argv 不含秘密。
- 从最终压缩包解压到临时目录后，在仓库外执行 `plan` 成功，符号链接的 `manifest.json` 被拒绝且输出不含外部文件内容。没有运行 `auth` 或 `upload`，因此没有访问生产 API。
- 未在 macOS 上调用 `security`，未在 Windows 上调用凭据管理器。

## 明确没做

- 不合并，不部署，不重启 `arenaofbias-server`，不创建生产令牌，不把 `BATCH_UPLOAD` 设为 `1`。
- 不改变 Cookie 会话的工作人员自动核验。
- 不修改上传来的旧压缩包。新包是 `arena-batch-upload-fixed-20261110.zip`。
- 不修复无关的 blind-pool 厂商名失败。

## 遗留物

- macOS `security` 的口令提示大约只读 128 字节；更长的秘密会被拒绝。秘密不在 argv 里，但仍在 `security` 进程内存里。这次没有在 macOS 上实测。
- Windows 没有 `O_NOFOLLOW`。读取靠 `lstat` 和打开后的 inode 比对；写入靠 `rename`，不打开目标做截断。检查和替换之间仍有本地竞态。
- 进程在 `auth` 中途被杀掉时，设备码可能留在凭据库，直到人工删除或服务端约 15 分钟过期。
- CLI 限额不跟随服务器的 `BATCH_MAX_*`。两边可以不一致。
- 能解锁同一操作系统用户凭据库的人仍可能读到令牌。
- 本仓库没有 id 为 `arena` 的 Cursor Skill。压缩包里的 `skill/SKILL.md` 已按新行为改过；若旧包曾被装到仓库外，需要单独替换。

## 下一步建议

kme7 自测后再决定是否合并。合并、部署和打开 `BATCH_UPLOAD` 必须另一次明确授权。
