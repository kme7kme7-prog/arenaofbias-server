# aob-batch

普通管理员在本地目录里准备一批作品，由人在网站上核对完整摘要后再上传。作品保持未核验、待内容审查，不会因为调用者是管理员就自动公开。

完整步骤、限制和明确不要做的事见 [docs/batch-upload.md](../../docs/batch-upload.md)。这里没有密钥，也没有生产地址以外的开关。

```text
node tools/batch-upload/aob-batch.mjs plan --dir <允许根内的批次目录>
```

`plan` 不访问网络。`auth` 和 `upload` 只连接 `https://api.arenaofbias.icu`。功能默认关闭；在 kme7 明确允许试点之前，不要运行 `auth` 或 `upload`。
