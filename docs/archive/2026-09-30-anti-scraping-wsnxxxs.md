# 2026-09-30 · anti-scraping · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex desktop
- 范围：共享后端及四个 Nginx vhost 的待安装配置；Gallery 前端配套在其仓库提交。arenaofbias 前端无需源码改动，受共享后端和边缘配置保护。

## 本轮目标

用户要求完善两个前端的数据反爬机制，并明确选择停用 Gallery 公开 Pages 副本，仅保留正式站点。

## 改动

- `server/read-guard.mjs` 复用现有限流与真实 IP 解析。GET/HEAD 按 IP 共享 API 180/min、整表/榜单 30/min、资源 1200/min、作品 HTML 60/min；支持四个 READ_* 环境变量。静态与作品共用资源桶，不按登录、查询参数或作品 Host 分桶。
- `server/app.mjs`、`content.mjs` 接入读取限流和 429/Retry-After。完整 API `/data.json` 仅管理员可读，包来源标记不公开，检查实际解析路径以覆盖编码及 Windows 大小写别名。写 API 规则不变；收录导出继续使用现有令牌 2000/min、IP 10000/min 限制。
- `deploy/nginx/read-zones.conf`、`read-server.conf` 准备跨四个域名共享的资源、整表、HTML、模型文件及并发限制，429 保留正式前端 CORS。README、契约、部署文档同步，包含 include 继承、CDN 真实 IP、安装验收、Pages 关闭与回滚步骤。
- 新增四项针对性 HTTP 测试，并更新两处原匿名整表读取预期。无 npm 依赖、数据库迁移、业务数据或数据包 pin 修改。以上随本轮英文提交，未推送。

## 决策

- 保留匿名公开浏览和 Show1 的逐票接口/客户端计分，仅限制读取频率并缩减 Gallery 无需展示的元数据。公开作品、源码和已发布包仍能被下载，限流不保证阻止低频或多 IP 抓取。
- 用户已同意移除 Pages 自动发布，在后续上线时关闭现有副本。此次只落实工作流和部署步骤，未调用远端 Pages 设置接口。
- 沿用用户 initial AGENTS 的完成后英文 commit 授权；身份已核实为 `wsnxxxs <269096463+wsnxxxs@users.noreply.github.com>`。未获本轮 push 或部署授权。

## 验证

- `npm run check`：59 文件、0 错；`npm test`：126/126。
- 新 HTTP 回归覆盖跨端点/参数/会话/HEAD 共享额度、伪造 XFF 前缀无效、不同真实 IP 独立、未知 API 计数、写请求保留、收录导出鉴权、管理员私有目录、跨作品 Host 与静态资源共用额度、429/CORS/Retry-After。
- 官方便携 Nginx 1.30.5 和隔离 Node/临时数据库联调：`nginx -t` 通过；跨 Gallery/main/API/work 四个 Host、GET/HEAD、查询参数/Cookie/XFF 轮换后返回 429，Retry-After=30；通用额度耗尽后无效导出令牌仍返回 404。重复探针不假定固定第几次超限，Nginx 漏桶会随时间恢复。
- 最新正式 Gallery 包 `1fb62c19d890faceccd68c8641d673062aeee383` 下真实浏览器首页、模型预览和 429 页面目视检查通过，正常页面控制台无 error；题目页来源筛选已检查。完整前端验证见其本轮归档。
- 未跑生产 `nginx -t`、线上限流或公网压力测试：配置尚未获准安装；未验证全部作品交互：本轮未改原作。未连接或改写现有业务数据库。

## 明确没做

未 push、合并、部署、重启生产、关闭现有 Pages 或收紧公开 GitHub 仓库。仅升级 Node 不能保护两个 Nginx 静态前端，四个 vhost 的 include 必须配套安装。

## 遗留物

隔离运行目录 `output/anti-scraping-7232a4ec8f9347cba866be53a91e5a2f/` 含便携 Nginx、测试库、日志、验证脚本/JSON 和页面截图，均忽略、不提交；本轮 Node/Nginx 测试进程与浏览器标签已关闭。其他任务文件和既有业务数据未处理。

## 下一步建议

获准上线后按部署文档核对现场、备份并安装配置，正常双站浏览与管理员操作验收后关闭旧 Pages。若存在 CDN，先验证真实 IP 信任链；按正常流量调额度，不直接在公网压测。
