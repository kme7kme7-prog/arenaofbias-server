# 2026-10-03 · 作品控件折叠接入 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex 父代理，3 个 GPT-6.1 Sol / high 子代理；服务端子代理负责本仓功能。
- 本轮每仓一条英文提交，未推送、未部署。

## 本轮目标

让 Gallery 并排投稿按 aob=fold 获取既有 fold.js，馆藏能在 iframe 加载后注入同一脚本，盲评恢复显示作品控件的操作入口。

## 改动与决策

- server/content.mjs：公开 / 预览 HTML 带 aob=fold 时注入，支持重复 aob 参数中的 bridge 和 fold；/__sp_fold.js 不依赖页面参数。普通公开 HTML 与草稿保持原行为，盲评仍默认折叠。
- server/app.mjs：GET/HEAD /api/fold.js 提供 server/fold.js 原始字节、no-cache、nosniff，沿用受信任前端 CORS 与 API 读取限流。Gallery CSP 已允许 API，不增加内容域名读取权限。
- server/fold.js：文档 complete 时立即扫描，否则等 load；继续 600 / 1800 / 4000ms 扫描。现有启发式、保护阈值、父窗口消息校验与 DOM 状态保留不变。
- docs/api-contract.md 记录新资源与 opt-in。Gallery 配套完成盲评 / 并排按钮、投稿参数和同源注入。无待拍板事项。

## 验证

- npm run check：88 文件 / 0 错；npm test：254/254。test/bridge.test.mjs、test/platform.test.mjs 新增必要回归：opt-in、查询无关资源、bridge/fold 并用、原始字节、CORS、HEAD、后注入即时扫描。
- Gallery check 51/0、test 19/19、build 181 件 / 61 文件、CI intake 0 错 / 10 既有提示。
- Browser 用真实 content handler 和 Gallery 模块验证合成投稿 / 盲评的双侧显隐、状态保留、重载、换组零计数与 8 按键保护；真实馆藏台灯亮度 / 色温和 787 风扇可操作，折叠后状态保留。390px 两处工具栏可用、无横向溢出 / console error。
- git diff --check 通过。未验收生产、真实账号上传 / 投票、全部作品、多浏览器或手机真机。

## 明确没做

未修改另一前端、作品 / 数据仓、数据库和部署配置；未推送、未部署。

## 遗留物

本仓开始时已有 HANDOFF、协调发布归档改动与上传警告发布归档保留，不纳入本轮提交。证据在相邻 Gallery 的忽略目录 output/fold-controls-20261003。

## 下一步建议

需要上线时协调 Gallery 和后端发布，验收实际 API CORS / 作品参数与两处开关。
