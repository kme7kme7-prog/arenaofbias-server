# 普通管理员本地批量投稿

这是给没有 SSH 的普通管理员用的通道。作品进入「未核验 + 待内容审查」，不自动公开。默认关闭。未把 `BATCH_UPLOAD` 设为 `1` 之前，登记和上传都会被拒绝。

不要把网站登录 Cookie、dots 令牌或批量上传令牌交给自动化，也不要写进聊天、命令参数或环境变量。

## 运行版本

命令只使用 Node 内置模块。`zip.mjs` 用 `zlib.crc32` 计算 ZIP 校验，这个 API 从 Node.js 22.2.0 起提供（20.15.0 也有）。本仓库声明的运行版本是 Node.js ≥ 22.13。更旧的 Node 在 `plan` 时会直接说明缺 `zlib.crc32`，而不是算出一份对不上的摘要。

## 人先做的事

1. 在自己的电脑上选定一个允许根目录，把绝对路径单独写进 `~/.config/arenaofbias/batch-root`。这个文件必须是普通文件，不能是符号链接或硬链接。不要把家目录设成允许根。
2. 在这个根下面准备批次目录。每个作品一个子目录，入口是 `index.html`。不要放 `.env`、`.git`、`.ssh`、密钥、符号链接或硬链接。
3. 写 `manifest.json`。它只描述投稿事实。`pipeline`、`role`、`autoVerify`、`publish`、`show_gallery` 即使写了也会被服务器丢掉，不能用来关闭审查或打开画廊。作品键不能重复，也不能是 `__proto__`、`constructor`、`prototype` 以及 `__defineGetter__` 这一类对象特殊名。

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

4. 用已登录的普通管理员账号打开 CLI 打印的确认页，对照完整摘要后再点确认。确认页必须属于 `https://api.arenaofbias.icu`，否则命令失败，不会把设备码写入凭据库。不要让自动化代替人确认。

## 命令

程序在 `tools/batch-upload/aob-batch.mjs`。摘要算法在同目录的 `plan.mjs`，服务器通过 `server/batch-plan.mjs` 引用同一份，不另存一份。没有 `--token`、`--endpoint`、`--insecure`。地址固定为 `https://api.arenaofbias.icu`，校验 TLS，不跟随重定向。

```text
node tools/batch-upload/aob-batch.mjs plan --dir <允许根内的批次目录>
node tools/batch-upload/aob-batch.mjs auth --dir <同一目录>
node tools/batch-upload/aob-batch.mjs upload --dir <同一目录>
node tools/batch-upload/aob-batch.mjs status --dir <同一目录>
node tools/batch-upload/aob-batch.mjs cancel --dir <同一目录>
```

`plan` 不访问网络。它读取 `manifest.json` 和作品文件，写出 `plan.json`。这两个元数据文件和作品文件一样，先 `lstat`：必须是普通文件、不能是符号链接、不能是硬链接，再用 `O_NOFOLLOW` 打开。Windows 没有 `O_NOFOLLOW`，那里改为比对打开前后的 inode，并且仍然拒绝符号链接和硬链接。`plan.json` 用同目录临时文件加 `rename` 替换，不会对目标路径做截断写入，因此不会顺着符号链接或 FIFO 把外面的文件写掉。

本地限额与服务器试点默认值、普通上传单件上限对齐，命令行不读取 `BATCH_MAX_*`。服务器若改了这些变量，可能比 CLI 更严或更松：

- 每批最多 10 件
- 压缩合计 100 MiB，解压合计 300 MiB
- 单件压缩 30 MiB，单件解压 150 MiB，单件最多 2000 个文件，单个文件 50 MiB
- `manifest.json` 和 `plan.json` 各自最多 16 MiB，这只是本地读取上限

超过上限时停止，不会把超出的那一个文件再读进内存。`status` 和 `cancel` 只读已经写好的 `plan.json` 里的批次编号，再从凭据库取令牌。作品目录或 `manifest.json` 之后被移走，仍然可以查询和取消。`auth` 和 `upload` 仍会重算摘要；文件变了就拒绝，避免传上一份没确认过的内容。

`auth` 把设备码写入操作系统凭据库，终端只显示确认页、确认码和摘要。确认失败、轮询被拒或等待超时后会删掉设备码。进程被杀掉时，这次删除来不及执行，设备码会留到凭据库里，服务端大约 15 分钟后过期。凭据库不可用时命令失败，不会因此把令牌写进文件。

凭据库的秘密不放进命令参数：

- Linux：`secret-tool`，秘密走标准输入。
- macOS：`security add-generic-password` 的 `-w` 放在最后且不带值，秘密从标准输入写两遍（工具会再要一次确认）。不把秘密放进 argv。这个提示在已公开的测量里大约只读 128 字节，所以超过 127 字节或含换行的秘密会被拒绝。写完会读回比对，不一致就删除并失败，失败信息里不附带 `security` 的输出。设备码和上传令牌远短于这个限制。本仓库的验证环境是 Linux，没有在 macOS 上实际调用 `security`。
- Windows：凭据管理器的 `PasswordVault`，秘密走标准输入。删除用 `PasswordVault.Remove`，不把秘密打印出来。

`upload` 一次传一件，断了可以重试同一作品键；内容变了服务器返回 409，不会覆盖。`cancel` 只取消还没提交的暂存。已经提交的作品要本人用网站登录后按原有流程处理，批量令牌不能删除。

Linux 需要 `secret-tool`。没有它就不能 `auth`、`upload`、`status` 或 `cancel`。

## 独立压缩包

给没有这份仓库的管理员用的压缩包必须自带 `tools/batch-upload/` 里 CLI 会 import 的全部文件，包括 `plan.mjs`。不能只拷 `aob-batch.mjs`。在解压后的根目录执行与上面相同的 `node tools/batch-upload/aob-batch.mjs ...`。

## 服务器保证

- 认证种类是 `batch-grant`。Cookie 会话里的管理员投稿、收件箱和高级管理员直传仍按现在的规则自动核验。
- 每次上传都会重新检查角色、邮箱、吊销、过期、批次、题目和摘要。角色一变，旧授权失效；之后重新升为普通管理员也不会复活它。
- 幂等键是账号 + 批次 + 作品键。摘要相同返回原来的作品；摘要不同返回 409。
- 试点默认每批最多 10 件、压缩 100 MiB、解压 300 MiB。管理员免草稿次数不免除这些限额。服务器上的 `BATCH_MAX_*` 可以改这些默认值；CLI 不跟着改。
- 磁盘或 inode 不足时返回 507。审查或截图队列过深时，在写入作品之前返回 429 或 503。
- 截图出网会拒绝私网、链路本地、云元数据和重绑定后的地址。作品页面仍使用现有内容隔离。

## 现在不要做的事

不要为了试这条通道重启生产服务，不要在生产库里登记真实批次，不要制造生产令牌。本地验证用 `npm test`。`plan` 可以在本地目录上试；在功能被明确打开并部署之前，不要运行 `auth` 或 `upload`，它们只会访问生产地址。`status` 和 `cancel` 同样会访问生产地址。
