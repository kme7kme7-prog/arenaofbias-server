# aob-batch

普通管理员在本地目录里准备一批作品，由人在网站上核对完整摘要后再上传。作品保持未核验、待内容审查，不会因为调用者是管理员就自动公开。

完整步骤、限制和明确不要做的事见 [docs/batch-upload.md](../../docs/batch-upload.md)。这里没有密钥，也没有生产地址以外的开关。

需要 Node.js ≥ 22.13。ZIP 校验用的 `zlib.crc32` 从 22.2.0 起才有；更旧的版本会在 `plan` 时直接失败。

```text
node tools/batch-upload/aob-batch.mjs plan --dir <允许根内的批次目录>
```

`plan` 不访问网络。它在本地限额内计算摘要（每批 10 件、压缩 100 MiB、解压 300 MiB，另有单件上限），并安全地写出 `plan.json`。`status` 和 `cancel` 之后只读这份本地记录，不再重读作品文件。`auth` 和 `upload` 只连接 `https://api.arenaofbias.icu`。令牌进操作系统凭据库，不进命令参数。功能默认关闭；在 kme7 明确允许试点之前，不要运行 `auth`、`upload`、`status` 或 `cancel`。

独立压缩包必须带上本目录里 CLI 会 import 的全部文件（含 `plan.mjs`），不能只带入口脚本。
