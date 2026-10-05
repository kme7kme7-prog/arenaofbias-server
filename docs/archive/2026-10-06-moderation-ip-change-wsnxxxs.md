# 2026-10-06 · 审核服务器 IP 切换 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex
- 范围与目标：用户授权正式 SSH 审核隧道目标从 154.36.185.169 改为 154.36.178.229，恢复 loopback 审核连接。
- 改动：正式 systemd tunnel 远端目标已换新地址，固定 known-hosts 添加已核对的新地址公钥；公钥与旧记录一致。保留原私钥历史文件名及 arena-review 专用账号。仅重启 tunnel，未重启后端或 relay。docs/deploy.md 同步说明。
- 决策：沿用现有 SSH 密钥认证与端口限制，用户提供的密码仅用于本次连接，不保存到仓库。无额外功能或后台审核状态操作。
- 验证：新地址 relay active；正式 tunnel active/running、NRestarts0，后端 active；127.0.0.1:5280/health 返回 ok true 与 gpt-6-luna。使用后端当前 Key 的无效 model 请求返回 relay 400，认证通过；符合 relay 路由条件的空 input 请求返回官方 400 missing_required_parameter，证实 Responses 上游链路。models GET 额外探测返回非 JSON 403，后续 Responses 探测通过，不把前者作为审核链路结论。npm run check 109 文件零错误，npm test 318/318。
- 未执行：真实作品投稿、付费完整审核或人工队列重审；无前端改动，未运行 Gallery build/intake 或浏览器验收，后端无相应构建脚本。未 push。
- 遗留物：服务器回退备份 /root/aob-moderation-ip-20261006/tunnel.service.before 与 known-hosts.before；Gallery 忽略目录 output/moderation-ip-20261006/ 保存本轮无密码连接工具。未修改其他会话文件。
- 下一步：后续实际投稿审核结果仍需按正常流程观察，不能把健康与参数探测称为完整内容审核验收。
