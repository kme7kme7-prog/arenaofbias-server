# 普通管理员本地批量投稿

这是给没有 SSH 的普通管理员用的通道。作品进入「未核验 + 待内容审查」，不自动公开。默认关闭。未把 `BATCH_UPLOAD` 设为 `1` 之前，登记和上传都会被拒绝。

不要把网站登录 Cookie、dots 令牌或批量上传令牌交给自动化，也不要写进聊天、命令参数或环境变量。

## 人先做的事

1. 在自己的电脑上选定一个允许根目录，把绝对路径单独写进 `~/.config/arenaofbias/batch-root`。不要把家目录设成允许根。
2. 在这个根下面准备批次目录。每个作品一个子目录，入口是 `index.html`。不要放 `.env`、`.git`、`.ssh`、密钥或符号链接。
3. 写 `manifest.json`。它只描述投稿事实。`pipeline`、`role`、`autoVerify`、`publish`、`show_gallery` 即使写了也会被服务器丢掉，不能用来关闭审查或打开画廊。

```json
{
  "batch": "lamp-2026-11-09",
  "works": [
    {
      "key": "lamp-01",
      "task": "题目id",
      "dir": "works/lamp-01",
      "title": "台灯",
      "modelId": "数据包里的模型id",
      "effort": "High",
      "providerId": "official",
      "harnessId": "claude-code",
      "generationMode": "single-turn",
      "humanIntervention": "none"
    }
  ]
}
```

4. 用已登录的普通管理员账号打开 CLI 打印的确认页，对照完整摘要后再点确认。不要让自动化代替人确认。

## 命令

程序在 `tools/batch-upload/aob-batch.mjs`。只使用 Node 内置模块。没有 `--token`、`--endpoint`、`--insecure`。地址固定为 `https://api.arenaofbias.icu`，校验 TLS，不跟随重定向。

```text
node tools/batch-upload/aob-batch.mjs plan --dir <允许根内的批次目录>
node tools/batch-upload/aob-batch.mjs auth --dir <同一目录>
node tools/batch-upload/aob-batch.mjs upload --dir <同一目录>
node tools/batch-upload/aob-batch.mjs status --dir <同一目录>
node tools/batch-upload/aob-batch.mjs cancel --dir <同一目录>
```

`plan` 只在本地计算摘要，不访问网络。`auth` 把设备码写入操作系统凭据库（macOS 钥匙串、Windows 凭据管理器或 Linux Secret Service），终端只显示确认页、确认码和摘要。凭据库不可用时命令失败，不会改把令牌写进文件。`upload` 一次传一件，断了可以重试同一作品键；内容变了服务器返回 409，不会覆盖。`cancel` 只取消还没提交的暂存。已经提交的作品要本人用网站登录后按原有流程处理，批量令牌不能删除。

Linux 需要 `secret-tool`。没有它就不能 `auth` 或 `upload`。

## 服务器保证

- 认证种类是 `batch-grant`。Cookie 会话里的管理员投稿、收件箱和高级管理员直传仍按现在的规则自动核验。
- 每次上传都会重新检查角色、邮箱、吊销、过期、批次、题目和摘要。角色一变，旧授权失效；之后重新升为普通管理员也不会复活它。
- 幂等键是账号 + 批次 + 作品键。摘要相同返回原来的作品；摘要不同返回 409。
- 试点默认每批最多 10 件、压缩 100 MiB、解压 300 MiB。管理员免草稿次数不免除这些限额。
- 磁盘或 inode 不足时返回 507。审查或截图队列过深时，在写入作品之前返回 429 或 503。
- 截图出网会拒绝私网、链路本地、云元数据和重绑定后的地址。作品页面仍使用现有内容隔离。

## 现在不要做的事

不要为了试这条通道重启生产服务，不要在生产库里登记真实批次，不要制造生产令牌。本地验证用 `npm test`。`plan` 可以在本地目录上试；在功能被明确打开并部署之前，不要运行 `auth` 或 `upload`，它们只会访问生产地址。
