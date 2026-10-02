# 2026-10-02 · 截图服务隔离与喷泉截图核对 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex，三名 GPT-6.1 Sol / high 子代理

## 本轮目标

完善服务器执行投稿脚本的隔离。用户随后要求提高截图等待时间，并先核对“古典庭园喷泉”；因此保留原等待值，先复现并区分等待不足和渲染环境问题。

## 改动

- `server/capture.mjs` / `server/config.mjs` 支持从 `CAPTURE_ENDPOINT_FILE` 读取独立 Playwright worker 的端点，连接失败不退回本地执行，重连重新读端点；图片仍由平台写入本地媒体目录。
- 新增 `scripts/capture-browser.mjs`：非 root、环回监听、Chromium sandbox、拒绝未路由流量的代理、精简 Chrome 环境、原子发布 0640 端点文件、systemd ready 通知及退出清理。
- 新增两个 systemd 配置：平台用户 `arenaofbias`，截图用户 `aob-capture`，独立 UID、文件系统可见范围和资源限制。worker 隐藏平台源码/数据、平台 drop-in、审核配置和平台 HOME。采用 systemd 文件系统沙盒，没有安装 Docker。
- 更新部署文档 7.2–7.3；增加三项连接/重连/无回退定向回归。没有 npm 依赖、数据库迁移或等待时间改动。

## 验证

- 干净生产基线 83e43fe 加本轮代码：Windows Node 24.16.0 和 VPS Node 22.23.2 均 check 83/0、test 233/233。初次 Linux 一项 datapack shell 用例因导出 CRLF 失败，仅转换隔离导出的换行，重跑全过。最终共享工作区包含另轮已提交登录保护，check 87/0、test 244/244，diff --check 通过。
- VPS 真实浏览器与临时 API：独立用户运行；`chrome://sandbox` 显示 namespace、PID/network namespace 和 seccomp 启用；四张合成截图、中文及同源 iframe 文字正常；禁止外站 HTTP/WebSocket 命中为 0。worker 无法读取平台 DB、密钥配置、root SSH 及合成私有数据；Chrome 环境不含平台配置。worker 停止时截图不可用，重启后恢复远程连接，关闭客户端不会停止 worker。
- “古典庭园喷泉”两件馆藏和一件相关投稿，在加载后 3.5、8、15、25 秒分别取图；三个独立上下文的 WebGPU adapter 均为空，25 秒实际画面为 WebGPU 错误提示。现有 root 启动参数的合成页能力检查同样 adapter 为空。馆藏 Opus captureNote 注明预热后等 25 秒，已有两张馆藏封面完整；投稿 up-ccnksbcp 的当前封面为适配器错误。等待不足和缺适配器是不同问题，当前复现中等待 25 秒不能解决。
- 正式公开首屏为 load 后 3.5 秒；约 12 秒的延迟截图仅供审核。重启或周期复查不会重写已有公开封面；馆藏图片须由数据仓构建发布。
- 最终生产版本标记仍 83e43fe072a0280d86c76379d9964bd4a32eb4bd，API active 且仍为 root；正式源码、数据库、unit、媒体与 owner 未更改。

## 明确没做

没有 push、正式部署、修改等待时间、开启实验 GPU 参数、修改既有封面或数据包、创建生产投稿、调用自动审核/SMTP、操作真实账号或迁移业务数据库。本轮本地提交仅纳入截图改动和记录，不纳入其他会话代码。

## 遗留物

- 忽略目录 `output/capture-isolation-20261002-01a0fb12/` 保存测试日志、审计 JSON、截图和本轮 SSH/验收工具，不入库。
- 服务器新增 `arenaofbias` / `aob-capture` 系统用户；临时 API 和截图服务已停，截图 runtime unit 已移除。
- 只含本轮演练的 `/opt/arenaofbias-capture/isolation-rehearsal-01a0fb12`、`/var/lib/arenaofbias/isolation-rehearsal` 和 root 私有 `/root/aob-capture-isolation-20261002-01a0fb12` 保留。备份包含一致性 SQLite 快照、原源码/版本/unit，以及 1859 条 `.data` owner/mode；原数据混有 root/www/其他 UID，回滚必须恢复原元数据并保留部署后的业务写入。
- 现有 SMTP drop-in 的 systemd 语法提示属部署前已有问题，本轮不修改。

## 下一步建议

先解决截图环境的 WebGPU adapter，再设定更长的公开首屏等待并重截选定投稿。部署前遵守版本门禁、用户推送授权与完整目标范围核对；共享 main 已有另轮 b93a807 登录保护和 v32 配套前端，不应仅凭本轮基于 83e43fe 的截图演练直接发布整个 HEAD。
