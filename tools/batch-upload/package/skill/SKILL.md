---
name: Arena 批量上传
description: >-
  Use when an ordinary moderator wants to batch-upload local work folders to
  arenaofbias without SSH, via the aob-batch CLI and website confirmation.
---
# Arena 普通管理员本地批量上传

给没有 SSH 的普通管理员：本地每作品一个子目录 → 人在网站确认批次摘要 → CLI 逐件上传。上传结果保持 **未核验 + 待内容审查**，三面关闭，不自动公开。

这不是仓库里的 Cursor Skill id `arena`。它随独立压缩包提供。装到 Cursor 或其他 AI 时，用这份文本替换旧包里的同名说明。

## 前置

- 服务端已部署且 `BATCH_UPLOAD=1`；否则登记/上传会 403。未打开之前不要运行 `auth`、`upload`、`status`、`cancel`。
- Node.js ≥ 22.13。ZIP 校验依赖 `zlib.crc32`（22.2.0 起）。Linux 还要有 `secret-tool`。凭据库不可用则停，不要改成把令牌写进文件。
- 小工具入口：`tools/batch-upload/aob-batch.mjs`。同目录的 `plan.mjs` 必须在一起。完整说明：`docs/batch-upload.md`。
- 固定只连 `https://api.arenaofbias.icu`；没有 `--token` / `--endpoint` / `--insecure`。确认页源必须是这个源。

## 人先准备

1. 选一个允许根目录，把**绝对路径**写进 `~/.config/arenaofbias/batch-root`（普通文件，不要用家目录当允许根）。
2. 在该根下准备批次目录：每个作品一个子目录，入口 `index.html`；不要放 `.env`、`.git`、`.ssh`、密钥、符号链接或硬链接。
3. 写 `manifest.json`（只写投稿事实）。作品键不能重复，也不能是 `__proto__`、`constructor`、`prototype`。`pipeline` / `role` / `autoVerify` / `publish` / `show_*` 即使写了也会被丢掉。
4. **本人**用已登录的普通管理员账号打开 CLI 打印的确认页，对照完整摘要后再点确认。不要让自动化代替人确认。

## 命令顺序

```text
node tools/batch-upload/aob-batch.mjs plan --dir <允许根内的批次目录>
node tools/batch-upload/aob-batch.mjs auth --dir <同一目录>
node tools/batch-upload/aob-batch.mjs upload --dir <同一目录>
node tools/batch-upload/aob-batch.mjs status --dir <同一目录>
node tools/batch-upload/aob-batch.mjs cancel --dir <同一目录>
```

- `plan`：只本地算摘要，不访问网络。限额是每批 10 件、压缩 100 MiB、解压 300 MiB，单件压缩 30 MiB、解压 150 MiB。写出的 `plan.json` 不跟随符号链接，也不截断意外文件。
- `auth`：设备码进 OS 凭据库，不进命令参数。终端只显示确认页、确认码和摘要。失败或超时会删掉设备码。
- `upload`：一次一件；断点可重试同作品键；内容变了服务器 409，不覆盖。
- `status` / `cancel`：只读 `plan.json` 里的批次编号和凭据库里的令牌。作品文件被移走后仍可查询或取消。`cancel` 只取消未提交暂存。

## 硬规矩（AI 必须遵守）

- 不要把网站 Cookie、dots 令牌或批量上传令牌写进聊天、命令参数、环境变量或日志。
- 不要扫描允许根以外的路径，不要跟随符号链接，不要读取 `.env` / 密钥文件去“帮忙”。
- 不要声称可以跳过审核或直接公开；服务端强制 unverified + pending。
- 不要声称 macOS 秘密“永远不会出现在进程内存里”。它不在 argv 里；`security` 从标准输入读，并且有大约 128 字节的提示上限。
- 同一 OS 用户若能解锁凭据库，理论上可读令牌——真正边界是人确认摘要 + 服务端每次重查角色/吊销/过期。

## 汇报

上传结束后汇总：成功 workId、幂等回放、409/403/429/507 失败原因；提醒管理员去审核页人工核验。
