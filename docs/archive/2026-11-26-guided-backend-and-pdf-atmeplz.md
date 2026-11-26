# 2026-11-26 · 引导试运行后端区、1:2:1:2 后端榜与设计 PDF 解析 · Atmeplz

- 负责人：Atmeplz（`224206292+Atmeplz@users.noreply.github.com`）｜ 执行 AI：Antigravity（Gemini）

## 本轮目标

1. 为 `guided-trial` 增加闭卷「后端」题库分区（4 道 AGB-Bench v4.1 分卷，仅显示标题、排名数据与编程语言标签，不开放提示词/投稿/盲评）与 `1:2:1:2`「合成总榜」及分卷榜接口。
2. 将设计区 `Word`、`PPT`、`Excel` 子分类合并为 `PDF`（含历史数据库迁移），强制 `.pdf` 格式校验、拒绝 HTML，并生成盲评安全、可在沙盒内直接翻页与文本解析的 `PDF.js` 查看器。
3. 保证非引导正式站接口与旧前端完全兼容且零泄露。

## 改动

- 新增 `server/backend-benchmark.mjs`：定义 4 个分卷基准与 1:2:1:2 权重校验、18 完整 + 2 缺卷成绩表，提供 `backendQuestions()` 与 `backendLeaderboard()`。
- 新增 `server/pdf.mjs`：`validatePdfBuffer` 严格拒绝 HTML/ZIP/图片/非 `.pdf`/加密 PDF；`renderPdfUpload` 产出盲评安全的 `index.html` + `document.pdf`（多 CDN 备用加载 `pdfjs-dist@4.10.38`、CJK 字体与 CMap、逐页/连续模式、缩放与文本提取抽屉，发送 `aob:work-ready` 与主题响应）。
- 修改 `server/db.mjs`、`server/categories.mjs`、`server/http.mjs`、`server/inspect.mjs`、`server/library.mjs`、`server/questions.mjs`、`server/inbox.mjs`、`server/batch.mjs`、`server/capture.mjs`、`server/app.mjs`：
  - 新增迁移 `#62` 将 `task_subcategories` 中 `Word`/`PPT`/`Excel` 统一更新为 `PDF`。
  - `?guided=1` 目录注入 4 道后端题并将 `PDF` 子分类题模板同步为 `['pdf']`；非引导接口保持隐藏后端题、剥离 `subcategory` 并将 `'pdf'` 夹紧为 `'static'`。
  - 新增 `GET /api/leaderboard/backend`；限制管理员修改含既有作品题目的 `PDF` 子分类（409）。
- 新增 `test/backend-benchmark.test.mjs`、`test/pdf-upload.test.mjs`，更新 `test/curated-toggle.test.mjs`。

## 验证

- `node scripts/check-syntax.mjs`：224/0 通过。
- `node --test test/backend-benchmark.test.mjs test/pdf-upload.test.mjs test/curated-toggle.test.mjs`：全部通过。
- 全栈 Playwright Chromium 真实浏览器 E2E QA：验证数据库 v61→v62 迁移、正式/引导目录隔离、PDF 格式正反校验、PDF.js 沙盒画布像素渲染、翻页、单页与全文文本提取、创建新题到上传详情页完整链路、亮暗主题与移动端零横溢，0 控制台报错、0 页面异常。

## 明确没做

- 未修改正式站前端代码与正式站数据包。
- 未暴露任何 AGB-Bench v4.1 内部题库名称或子题清单。

## 遗留物

- 无（所有改动提交在隔离分支 `feat/guided-backend-and-pdf`，面向 `sync/vps-20261123`）。

## 下一步建议

- 审阅并合并 PR 后，配合前端 `feat/guided-backend-leaderboard-pdf` PR 同步上线至共享后端与 `guided-trial`。
