# 2026-09-30 · gallery-protection-deploy · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop
- 范围：用户明确授权部署正式画廊与 Nginx 防护；保持已有服务端投票、主站静态文件、审核和 relay 设置。提交沿用用户完成修改后英文 commit 的授权，普通推送 main，不强推。

## 本轮目标

将干净的新画廊与已实现的共享读取限制部署到正式站，清理旧内部文件，核对私有数据源及前后端版本兼容。

## 改动

- 现场先核实后端 `c0ab6acf225ebcb4d99a7c3a5e145d011ee93d37` 的 139 个跟踪文件、数据库 v19 与投票发布记录一致。快进上游 main，未覆盖另一轮的服务端计分、共享题库或审核代码。
- 功能提交 `9ebf472b3020adeda94e6514373e2e0a1da7eb2b`（Align the gallery datapack.）只将 pin 更新为 `1fb62c19d890faceccd68c8641d673062aeee383`，普通推送并部署。后端功能源码与现场 c0 相同；收尾提交仅文档，不重新部署。
- 新旧数据包完整目录对比：32 展示模型、200 完整模型、5 Gallery 题目、83 原作的 ID 和提示词一致。88 文件变化、0 删除，原生差异包 2853271 bytes；本机试应用、远端重建及完整树 SHA256 校验均通过。旧包保留，激活新包后重启服务。
- Gallery 由 ArenaGalleri `307df34c5966c3e45d98ce2b257b57bbd4042c49` 从 Git archive 独立构建，使用受权认证下载，CI=1、正式 API 地址。1177 文件完整清单验证通过；6 文件更新（account/app/data/index/platform/submit），移除 6 个旧内部/无引用文件。新仓不包含主站、后台或数据历史。
- Nginx http 层加载一次 read-zones，四个 HTTPS vhost 加载 read-server；Gallery/API/作品三处加载网页目录外的 gallery-private-files。API/作品的 XFF 覆盖为真实连接 IP；现场无前置 CDN/realIP 或 location 自有读取限制。首次验收发现 API 原作构建说明仍 200，补同一私有文件规则后已 404，最终配置哈希另记 final-verification.json。
- 发布只短暂停止平台服务完成最终 SQLite 一致备份与切换；未改 systemd drop-in、SMTP、Turnstile、截图、Luna、SSH tunnel 或业务表。

## 验证

- 本机及 VPS 后端 check 68 文件、0 错，141/141 测试通过；[GitHub CI 36702168922](https://github.com/kme7kme7-prog/arenaofbias-server/actions/runs/36702168922) 成功。140 个上线跟踪文件字节均匹配目标提交。
- Gallery check 37 文件、13/13 测试、实际认证取包、完整构建、CI=1 收录检查通过（83 件，0 错、3 条既有 warning）。提示词逐字相同；展示目录无私有字段；原作、模型、海报、截图引用存在。
- Nginx -t/reload 成功；127.0.0.2 独立环回源、跨四个 Host 的 22 次小量 HEAD 请求从第 17 次起为 429，轮换参数/Cookie/XFF 不重置。127.0.0.3 跨 Gallery/API 的模型包 46 次 HEAD 从第 42 次起为 429；Retry-After=30，可信 Origin 的错误 CORS 正常。没有进行公网压测。
- Gallery 9 个内部路径及编码/大小写别名均 404；API 匿名完整 data.json、来源标记和原作 build-info 为 404，正常 Gallery/模型/bootstrap 200。前后端数据版本相同，目录摘要为 20f64ee3a4e00db6fcb4f5db2ea990a44ec334f8a4625a794b3574aabfe01910。
- 库 v19、quick_check=ok、外键为空；部署前后27 用户、267 作品、0 票/0 对局、16 评论、56 表情、6 猜题成绩一致。服务和审核 tunnel active，drop-in 文件哈希保持。
- 浏览器正式 Gallery 首页、题目卡片模型、提示词与实际复制按钮、一个完整原作 3D iframe、Show1 首页/空榜和后台登录页正常，console error 空，截图目检通过。未登录、创建用户、投票、投稿或启动付费审核；手机、全量原作、盲评创建对局及管理员登录后模型下拉未重新验收，避免生产写入；对应接口逻辑由隔离测试覆盖。
- GitHub 只读 API 确认数据仓 private，旧画廊 private 且 archived；原旧历史 raw 下载入口匿名 404。此次未修改这些仓库权限，沿用前轮结果。

## 明确没做

未改变投票与计分实现、清零业务库、增加依赖或迁移，未重新部署主站静态版本 9805416，未合并不同前端。没有给公开内容加入可逆加密包装，正常访客可保存公开展示内容。没有删除数据仓原作、旧数据版本、他人工作区文件或已有备份。

## 遗留物

- VPS root 0700 目录 `/root/arenaofbias-gallery-protection-20260930-307df34-4783ba76/`：server-before.tar.gz、platform-before.db、停写时 platform-at-switch.db、五份原 Nginx 配置、完整清单、差异包和 verification/http-verification/final-verification.json。凭据未新增写入发布脚本、仓库或验收日志。
- 旧 Gallery `/www/wwwroot/gallery.prev`；更早副本 `/www/wwwroot/gallery.prev-before-protection-4783ba76`。原后端数据版本保留在 .datapack/versions。
- 本机发布包、忽略的真实配置、测试日志和截图位于 output/gallery-protection-deploy-20260930-4783ba7604a748bba676bdadbe37f27f；不是新运行依赖，不提交。

## 下一步建议

本轮已部署，无待确认的发布步骤。按正常流量观察共用 IP 的额度，遇到实际误限再调整；无需增加未验证的防御。

回滚本轮时先保存当前代码、Gallery 和 Nginx，停止平台服务，恢复 server-before.tar.gz 中的 c0 与旧 pin/版本文件；移除新增的非功能文档文件按 manifest 核对，激活旧数据包，恢复 Gallery.prev。恢复五份原 Nginx 配置后 -t/reload，再启动服务。库仍为同一 v19，应保留当前业务写入，不能恢复投票清零前的库；若仅撤限流，保留三处私有文件拦截。回滚前仍须执行现场版本门禁，避免盖过后续部署。
