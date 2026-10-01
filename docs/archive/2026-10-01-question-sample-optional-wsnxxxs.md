# 2026-10-01 · 示例作品选填与上传忽略依赖目录 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5（Claude Code 桌面版）负责方案、Gallery 前端、联调与归档；后端实现由另一个 agent 按提示词完成

## 本轮目标

用户希望降低出题门槛：建题时示例结果改为选填（题目本来就要人工审核）；并放宽上传判定，整包打包的 Vite 项目不应因为 `node_modules/.package-lock.json` 被拒。

## 改动

- `5f2320c`：`server/app.mjs` 无作品建题分支（只建题与 `question-create` 审计同事务，返回 `{ question }`）；`server/inspect.mjs` 拆分目录与密钥规则，`readZip` 返回 `{ files, ignored }`，有忽略文件时增加 `ignored` 检查项；`test/questions.test.mjs`、`test/platform.test.mjs` 新增用例；README 路由表与 `docs/api-contract.md` 同步。
- 联调后提交：`ignored` 检查项标签由「已忽略」改为「依赖目录」（原标签与说明在前端连读为「已忽略已忽略」），同步测试断言与 API 契约；本归档与 HANDOFF.md。

## 验证

- `npm run check`：69 文件 / 0 错；`npm test`：159/159；`git diff --check` 通过（本地 Windows / Node v24.16.0）。
- 本地联调：后端隔离库（scratch 目录）、`CAPTURE=0`、未开 `CONTENT_MODERATION`，`DIST_DIR` 指向 Gallery 固定包 `39a2fa4`；Gallery 以 `API_BASE_URL` 指向本地后端构建预览。通过：无示例建题（完成页、我的题目、公开 bootstrap 不含）；附示例建题（带 node_modules 的 Vite ZIP 显示「依赖目录」项，试加载、信息填写、提交成功）；带 `.env` 的包返回「请移除 p/.env：压缩包不能包含密钥文件」；草稿目录只有 dist、package.json、src，无 node_modules/.git；`GET /api/admin/questions` 两题 samples 为 0 / 1，后台「题目审核」无示例时显示空态。
- 浏览器面板未渲染，交互通过页面脚本触发事件完成，未做截图目检与移动端；未调用真实 Luna/截图服务；未在生产 Node 22 验证。

## 明确没做

- 未推送、未部署；未改 30 MB 上传上限；未增加迁移或依赖。
- 未更新本地 `.datapack/current`（仍为旧包 `92f8ab9`），联调用 `DIST_DIR` 绕开。

## 遗留物

- 无。联调临时库与测试账号只在会话 scratch 目录，未进入仓库。

## 下一步建议

- 与 Gallery 配套改动一起推送、部署；部署后在正式站做一次无示例建题与带 node_modules 的 Vite 上传验收，再由管理员处理测试题。
