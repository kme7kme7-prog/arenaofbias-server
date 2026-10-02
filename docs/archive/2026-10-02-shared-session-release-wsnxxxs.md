# 2026-10-02 · 四仓协调发布与共用会话 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop

## 本轮目标

按用户明确授权整理、提交、推送和部署四仓既有轮次，并完成联调；game /api 反代暂留。

## 改动

- 先推送准备源码，数据 CI 成功后单独固定消费 pin，实际发布后记录本篇；不改写已推送历史。运行后端为 7a46d7158745b4ad1aa7c84bc51ad3c1067a58a9（业务源码同 e70ba13）；Gallery 3e441a314438d4ac0e66239e5bea6384e0466944；Show1 22bb6b333aada695bf7b7f5edde65828c13e10a1，保留上游 12a626a Hero 改动并同步 origin / fork。
- 固定数据产物 9356c7057c9898ace07cc86d6d8a852d5f7eeb75，来源 623bfebc33e51aca36f8c4d3a83a3bcf0a616da3，CI 36988885817 成功，20 题 / 182 件。两端显式 pin 相同；公开 Gallery 不提交私有配置。catalogDigest 为 2625da614a4f3b61bff59a3494e1d4be72d200bd536b50574d256cd6a5e1b7f7。
- 2026-10-02T10:04:51Z 完成协调切换。源码从已进入 main 的固定提交 LF 导出；数据从不可变包按变化文件重建并核对完整文件集合和 SHA-256。game 差异 7 文件 / 新目录移除 5；Gallery 差异 249 / 新目录移除 35，其中 239 个从已验证数据包复制，另外 10 个上传。普通复制生成新目录，不用硬链接；切换后保留旧目录。
- 源码、数据指针、数据库快照、Nginx 主配置和五个相关配置备份在 /root/aob-shared-session-release-20261002/backup。停服后保存一致 SQLite；数据库 v31 → v32，integrity ok。应用第 8 节的安全头、host CSP、静态私有路径、game XFF 覆盖与 429 CORS，正式 nginx -t 通过后 reload。game /api location 和 CORS map 的 game 来源均保留。

## 验证

- 后端 Windows 与服务器 Node 22.23.2 check 87/0、test 244/244；Gallery check 45/0、test 18/18、构建和严格 intake 182 / 0 错 / 10 警告；数据 check 34/0、test 16/16、intake 同上及发布 CI 成功。Show1 lint / typecheck / build 通过，本轮 placeholder 10/10、formal 6/6，Hero 六种主题 / 视口及 reduced motion、直接访问、离开 / 返回、失败场景通过；像素比较仅 2/6 相同，不声明逐像素一致。
- 固定 LF 源码 + 固定包的真实 integration-smoke 通过；Edge 隔离浏览器 8 场景通过，页面异常 0，详见联调归档。所有账号、评论和票均在临时数据库。跨主机使用真实后端、逻辑 HTTPS 来源和一次性 Turnstile 本机校验桩；焦点 / 可见 / BFCache 为派发事件，不声称真实操作系统焦点或生产挑战已完成。
- 停服前 / 启动后：users 31、works 317、votes 337、questions 9、comments 16、reactions 61、sessions 19，数量一致。另逐行比较 users / votes / comments / questions / reactions，全部一致。matches 424 → 337：只清除 87 个已过期且无正式票引用对局，丢失的已投票 / 未过期对局均为 0；没有清空或回填业务数据。
- 公网 13 项只读检查通过：版本及固定包、两个来源 auth/me / OPTIONS CORS、三站安全头及 HANDOFF 404、game / Gallery 未知路径 404、旧 game API 反代仍为 200、三个入口桌面 / 手机加载和 Show1 只请求 API 主机。页面异常 0；拦截了浏览器自动 track 写入，不提交生产密码、投票或评论。桌面 / 手机截图已目检。
- 生产首次浏览器导航出现 ERR_CONNECTION_RESET；禁用验收浏览器 QUIC 后通过，未改服务器协议配置。Gallery 初次截图在 platform.available 成立但 DOM / 入场字体尚未完成时为空；等账号 DOM 与首页文字转场完成后重拍通过。服务器 Python 不支持 tarfile filter 参数；只在本轮暂存工具中采用已校验文件名和普通文件类型的解包方式，保留第一次未完成目录，最终完整清单校验通过。
- 首次启动健康探针在 Node 尚未监听时收到一次连接拒绝，下一次通过；最终服务 active。CAPTURE、CONTENT_MODERATION、Secure Cookie、Turnstile 双密钥仍启用，审核 tunnel active。截图仍走原有本地 Chrome，未启用独立 worker / 降权 unit。

## 明确没做

未移除 game /api，未修改 Cookie 属性或生产账号角色，未做真实账号密码 / Cloudflare 挑战的生产登录互通验收（需要用户浏览器配合，已询问）。未运行 SMTP、自动审核及生产投稿 / 投票 / 评论写入验收，原因是联调写入使用隔离库。未部署截图降权、SSH / fail2ban / Chrome / DNS 等独立基础设施。三项过时的 Show1 检查 portal-entry、formal-ui、admin-access 保持，不顺手修。

## 遗留物

- 本机 output/four-repo-release-20261002 留源码、manifest、配置候选、部署日志、DB 保护证据、截图与联调结果；生成物不提交，凭据不落盘。完整大包下载慢，变化文件重建校验完成后停止本轮整包下载；受限暂存目录保留部分下载及未完成静态副本，不自动清理历史备份。
- show1-dist.prev、gallery.prev 和原有 prev 的本轮备份保留。回滚按本仓部署文档恢复代码 / pin / 目录 / Nginx；保留当前业务库及后续写入，不能直接用旧快照覆盖活跃数据。
- 本机旧 formal 临时目录 aob-formal-I0Zhsj 删除再次被自动审批拒绝，仅返回 blocked by policy，未绕过，保留供用户手动处理。

## 下一步建议

用户用真实浏览器在 game 登录 → 已打开 Gallery 切回后已登录 → Gallery 登出 → game 切回后未登录，核对新会话 Cookie 只在 API 主机。原 game 会话不再使用，需要重登一次，旧 Cookie 自然过期。观察时长尚由用户决定，第 9 节移除反代需要另行明确授权和展示现场删除计划。后续文档提交不改变已发布功能版本或固定数据包。
