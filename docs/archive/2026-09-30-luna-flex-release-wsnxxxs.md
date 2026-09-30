# 2026-09-30 · Luna Flex moderation deployment · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop

## 本轮目标

按用户“你先部署一下”的授权，将已实现的文字、图片内容审核及配套前端部署到正式 VPS；先准备配置，密钥后续由用户填写。

## 改动

- 后端 d69919eedb0731c1edeb834763a4c018d69a8568、前端 50c0893c07806bb05c746dca5e6d71c41260b0a0 普通快进推送到各自 main。正式服务目录为 /www/wwwroot/arenaofbias-server，systemd 服务为 arenaofbias-server。上线后全部跟踪文件匹配 d69919e；此后的收尾文档提交不重新部署，.server-version 保持实际运行源码提交。
- 内容审核所需的先前安全修复随后端上线；数据库追加 v19。旧作品保持 legacy 与原发布状态，新稿在启用自动审核后按通过/人工复核流程处理，内容状态独立于模型来源核验。
- server 使用的不可变数据包仍为 2cb2a5b265e8bda8c8069a4b498f1046d825acee，来源 ef10cdd9ab28dfe52a60a5a072a3cd10ae422ab3；前端 pin 同步到该包。前端 release 从既有 main 仅接入审核配套，未纳入另一分支的海报迁移。
- 前端由 Git archive 50c0893 构建，完整 1183 文件清单在服务器校验后原子切换 /www/wwwroot/gallery，实际更新 7 文件、删除 0 文件。旧站保留在 /www/wwwroot/gallery.prev，更早副本保留为 gallery.prev.before-luna-20260930。
- 可选截图运行环境单独放在 /opt/arenaofbias-capture，服务 node_modules 链接到该运行环境；Playwright 1.63.0、Google Chrome 154.0.8037.92 已准备。服务仓没有新增 npm 依赖。
- /etc/systemd/system/arenaofbias-server.service.d/moderation.conf 已配置 gpt-6-luna、https://api.openai.com/v1 与 Chrome。当前 CONTENT_MODERATION=0、CAPTURE=0，没有 MODERATION_API_KEY。未把密码或 Key 写入仓库、文档、部署包。
- gallery 的 Pages workflow 保留验证并移除单独发布任务，避免 main 推送发布另一份站点；该 workflow 本已 disabled_manually，本轮未启用。正式站仍在 VPS。

## 验证

- Windows 与 VPS 上固定后端提交均 check 59 文件 0 错、128/128 测试通过；GitHub CI 36681917167 对 d69919e 成功。
- 前端 check 36 文件 0 错、11/11 测试通过；固定线上包下 CI=1 构建 83 件结果、114 个 overlays，intake 83 件 0 错。3 条既有 warning 为 space-bunny 厂商待确认与两件模型作品体积偏大。配套服务 integration smoke 通过。
- 生产前端从已提交的源码归档独立构建，使用 GITHUB_SHA=50c0893 与正式 API_BASE_URL；服务器核对完整文件树 SHA256。前后端 catalogDigest 均为 f32ad007ed35571e720a7dd8f96ecf94e2a492d3a62e3c76f81a1858e1b4b3f5，build-info 与公网 data.json 版本、数据包一致。
- 先复制线上 v18 库演练，再在正式停写后保存一致备份并迁移；两次检查原 16 张表的所有原列/行哈希保持一致。v19 quick_check=ok、外键错误 0，正式库 267 件作品、27 用户、622 张票保留。历史作品未自动重新送审。
- 实际生产截图模块用隔离 HTTP 夹具生成 1440×900、390×844 JPEG，页面文字与夹具一致，未产生业务数据或付费 API 调用。
- 重启后服务 active；公网 API bootstrap、管理页、榜单与 gallery、Show1 首页均 HTTP 200。bootstrap 版本 d69919e，contentModeration=false；前端版本 50c0893。桌面及 390px 手机浏览器页面正常，控制台无错误，手机无横向溢出。截图保存在本地 gallery worktree 的 output/release-luna-gallery/live-desktop.jpg 与 live-mobile.jpg。

## 明确没做

- 未配置正式 API Key，未启用自动审核，未调用真实付费模型；本轮不能声称真实 Luna 审核已通过。
- 未在生产创建测试用户、提交测试作品或操作人工审核；之前的人工流程测试使用隔离服务。
- 未更改 Nginx、Show1 静态代码、数据仓或服务器数据包，未部署其他任务的未提交修改。原前后端工作区与数据包指针的他人改动未动。
- 未启用已停用的前端 GitHub workflow，不将本地验证称为前端 GitHub CI 成功。

## 遗留物

- /root/arenaofbias-luna-release-20260930/ 下保存原代码 code.tar.gz、版本与数据包指针、预览库、正式停写后的 backup/platform.db（v18）及 frozen-audit.json、演练和迁移核对结果、测试与运行环境日志、构建清单、差异包和截图夹具证据。原线上后端版本为 26da6d6a350bbb4464879206bdbeb0c7eb303087。
- /www/wwwroot/gallery.prev 与 gallery.prev.before-luna-20260930 保留。回滚后端时须同时恢复原 v18 数据库与旧代码；仅退代码会忽略新审核访问限制。
- 独立 runtime、远端备份和本地 output、node_modules、失败构建临时产物均为生成物，不入库。验证浏览器临时标签页关闭；SSH 会话在收尾时退出。

## 下一步建议

用户在服务器 moderation.conf 添加 MODERATION_API_KEY，并将 CONTENT_MODERATION 与 CAPTURE 改为 1；执行 systemctl daemon-reload 与 systemctl restart arenaofbias-server。核对 bootstrap 的 contentModeration=true 后提交一件真实作品，确认 Luna Flex 结果与人工复核入口；密钥不要发在聊天中。
