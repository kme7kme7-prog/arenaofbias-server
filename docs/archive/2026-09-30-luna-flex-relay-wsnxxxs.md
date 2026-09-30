# 2026-09-30 · Connect the Luna Flex review host · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop

## 本轮目标

用户提供新的审查服务器并授权配置，要求保留既有 Xray 与其使用的 443 接入。完成正式站到官方 Luna Flex 的可用审核连接。

## 改动

- 新增只使用 Node 内置模块的 scripts/moderation-relay.mjs。在 154.36.185.169 的 127.0.0.1:5280 监听，认证现有 Key，只接受指定模型、Flex、store=false、非流式 /v1/responses。目标固定为官方 Responses HTTPS 接口；不自动重试或降档，保留上游 HTTP 状态。正文最多 81 MiB，上游请求时限 15 分钟，客户端断开取消上游。没有正文、Key 或提供商消息日志。
- 新服务器独立安装官方 Node v22.23.3，归档 SHA256 df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de 校验成功；原全局 v22.12.0 不变。relay 运行目录 /opt/arenaofbias-review，用户 arena-review 无登录 shell；systemd arenaofbias-review-relay 使用 /etc/arenaofbias-review.env（root 0600）。服务开机启动、失败后恢复。
- 原站新增 systemd arenaofbias-moderation-tunnel，使用独立 Ed25519 私钥与固定远端主机公钥，将本机 127.0.0.1:5280 转发到新服务器同一 loopback 端口。远端授权公钥为 restrict,port-forwarding,permitopen="127.0.0.1:5280"，专用账户无登录 shell；不修改共享 sshd 配置。
- 原站 moderation.conf 改为 http://127.0.0.1:5280/v1，保留 Key 和 CONTENT_MODERATION=1、CAPTURE=1，并添加 Wants/After 专用 tunnel。daemon-reload、重启平台后实际进程环境确认配置生效。平台仍运行 d69919eedb0731c1edeb834763a4c018d69a8568；本轮未更新其源码或 .server-version。
- 原截图机器缺少 CJK 字体，实际图像中文字显示方框。仅安装 fonts-noto-cjk 1:20220127+repack1-1，重新启动截图浏览器后中文清晰。部署文档补字体核验及独立审查/SSH 连接说明。
- 没有新 npm 依赖、公开 HTTP 端口、域名、TLS 入口或数据库迁移。

## 验证

- 本地语法检查 61 文件、0 错。新增 1 项定向测试覆盖错误凭证、路径、无效 JSON、错误模型、标准档、store=true、stream=true 拒绝；正常响应与正文保持一致，429 原样返回且不重试，真实上游断连映射为 503。全套平台 128 项未重跑：平台代码无变更，本轮验证集中在独立 relay 与实际连接；不把之前的全量验证称为本轮执行。
- relay 上传前后 SHA256 一致：6298481d6287aedee575b521e3b154b639cec3bb0b519b12635d9c0d3a0f2247。新服务与 SSH 通道均 active、enabled，两側 health 正常；使用专用身份连接非许可的 127.0.0.1:1 被 administratively prohibited 拒绝。
- 两次真实验证使用原站部署的 createCapturer/createModerator，独立 HTTP 页面、媒体目录和内存 library，包含 1440×900、390×844 截图与中文文字。首次 HTTP 200/completed/gpt-6-luna/flex，结果 review，理由为图片中文字无法辨认；2362 输入、217 输出，共 2579 tokens。
- 字体修复后第二次同链路 HTTP 200/completed/gpt-6-luna/flex、approved，理由为文字和图片均正常；2362 输入、34 输出，共 2396 tokens。截图前后已本地查看，方框变为清晰中文。两次实际调用会计费，未进入标准档；未写生产作品或用户。
- 正式平台服务 active，进程实际 base URL 为 SSH loopback 接口，Key 存在布尔检查为 true，审核和截图开关启用；公网 bootstrap.contentModeration=true。画廊、bootstrap、管理页、榜单均 HTTP 200。
- 生产库只读检查：v19、quick_check=ok，267 件作品、27 用户，全部旧作品 legacy；没有旧作品自动重审。未修改前端或数据包。
- 新服务器 Xray 的 ActiveState、MainPID、ActiveEnterTimestamp 与开始时完全相同。443 原 Nginx 监听地址、进程和 FD 逐项相同；新增 relay 仅 loopback。Xray 未重启、删除或修改，全局 Node、Nginx、其他服务与防火墙保持原配置。

## 明确没做

- 未移迁网站和数据库、未开放审核公网 HTTP 端口或占用 443、未安装代理客户端或修改 Xray。
- 未创建生产测试账号、投稿、人工审核决定，未重审旧作品；实际验证使用内存结果提交。原有持久化与前端流程由已部署内容审核实现承担。
- 未将密码、API Key、私钥写入仓库或验收日志；API Key 通过隐藏输入保存到受限服务器文件，跨机请求经 SSH，连接官方接口经 HTTPS。
- 未改动原工作区他人未提交文件、数据仓或生成包，不新增 npm 依赖。

## 遗留物

- 新服务器 /root/arenaofbias-review-setup-20260930/ 保存官方校验清单与 Node 归档、原/后监听与 Xray 状态、verification.json。运行文件与服务分别在 /opt/arenaofbias-review/、/etc/systemd/system/arenaofbias-review-relay.service、/etc/arenaofbias-review.env、/var/lib/arenaofbias-review/.ssh/authorized_keys。
- 原服务器 /root/arenaofbias-review-connect-20260930/ 保存受限 moderation-before.conf、两次 API 结果、隔离截图/文字夹具、字体安装日志、密钥限制验证、runtime-after.json、bootstrap-after.json、database-after.json。专用 SSH 私钥和固定主机公钥文件在 /root/.ssh/arenaofbias-review-*，只用于该新连接。
- 本地 output/release-luna-relay/ 保存 first-before-fonts.jpg 与 first-after-fonts.jpg，属忽略的生成物，不提交。隔离测试进程已退出，两个管理 SSH 会话在收尾退出；systemd 中的正式 relay/tunnel 保持运行。

## 下一步建议

新投稿沿已部署的审核队列自动审查，疑似或请求失败交人工；源核验与内容审核仍分别处理。若连接出问题，先检查两台机器的专用 service 与本机 /health。

回滚本轮连接：恢复原服务器 moderation-before.conf、daemon-reload 并重启 arenaofbias-server，然后停止/停用专用 tunnel 和 relay；不回滚数据库、不改 Xray 或共享端口。恢复旧官方 base URL 会回到原 VPS 无法直连的状态，故只用于撤销连接。

官方接口与 Flex 约定按 OpenAI Docs 核对：https://developers.openai.com/api/docs/guides/flex-processing 与 https://developers.openai.com/api/docs/models/gpt-6-luna。
