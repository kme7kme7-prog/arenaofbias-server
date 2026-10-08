# 2026-10-08 · Ultra 与 Ultracode 常用档位 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex 桌面客户端；无子代理。
- 范围：后台配置、管理后台候选、1个提交回归与本轮交接；相邻 Gallery 仅记录。

## 本轮目标

把 Ultra、Ultracode 登记为常用自由文本档位，统一新保存值的大小写，让 bootstrap 与管理后台一致；不改 schema 或历史作品，不 commit、push、部署。

## 改动

- 未提交：`server/config.mjs` EFFORTS 改为 `['Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultra', 'Ultracode']`。
- 未提交：`admin/admin.js` 作品筛选与 effortField 共用编辑/投稿 datalist 的常用候选均增加末尾两档，保留 Default 和手填值。
- 未提交：`test/platform.test.mjs` 新增1条最小真实 HTTP 回归，核对 bootstrap 完整列表，并确认提交 ultracode 后响应和 SQLite 存为 Ultracode。
- `library.mjs` effortOf 已按 EFFORTS 忽略大小写匹配，未修改。搜索 server/admin/scripts/test 的相关源码，未找到其他档位高低、代表作兜底、导出硬编码或旧 EFFORTS/site.efforts 快照；字典排序和审核服务自身 xhigh 参数保持。

## 决策

自由文本规则保持；仅新提交或明确编辑保存时按常用列表规范大小写。档位高低 Ultracode > Ultra > Max > XHigh > High > Medium > Low。Gallery 已补两档并去重，前后端可任意顺序上线；没有待拍板事项。

## 验证

- Windows Node24.16.0：`npm run check` 109文件/0错误；`npm test` 325/325。
- WSL Ubuntu Node24.16.0：复制当前已跟踪源码到独立 Linux 临时目录，`npm run check` 109文件/0错误；`npm test` 325/325。
- 新用例使用临时 SQLite/真实 HTTP，确认 GET /api/bootstrap 的 site.efforts 完整列表及末尾 Ultra、Ultracode，POST /api/works 保存 ultracode 为 Ultracode。
- 另起合成数据临时库：GET bootstrap 同列表；管理保存 ultra→Ultra、ULTRACODE→Ultracode。内置浏览器登录隔离管理员，筛选及编辑 datalist 的 DOM 候选一致，编辑弹窗截图已目检；未在该界面保存业务信息。
- 首轮新增用例使用未绑定邮箱的测试管理员，被既有门槛返回403；改用已验证账号夹具后 Windows/Linux 全量通过。Linux 首次 shell 引号导致启动失败，改为保存固定脚本执行后完成验证。
- 只读本地 `.data/platform.db`（v13）：works 中 lower(trim(effort)) 为 ultra/ultracode 各0件；work_overrides 在该版本无 effort/meta 列。该旧本地库不代表生产，未核查生产数量。
- Gallery 本地 check67/0、test31/31；`git diff --check` 通过。
- 未跑 build/check:intake：本仓没有脚本；Gallery 仅记录、无源码或数据包变化。未做生产、真机或全交互验收。

## 明确没做

未修改 library、数据库结构、历史档位、私有数据包、Gallery 功能源码、另一前端或生产业务数据；未 commit、push、部署或重启生产。

## 遗留物

- 本轮3个后台源码/测试文件、HANDOFF 和本归档未提交；Gallery 本轮 HANDOFF/归档未提交。起始两个工作树均干净。
- 忽略证据 `output/ultra-efforts-20261008/` 含最终 Windows/Linux 检查测试日志、Linux 工作区路径、隔离管理后台启动脚本；首轮失败日志 `output-ultra-windows-test.log` 亦忽略。
- 本轮 Linux 隔离工作区路径见 linux-workspace.txt；临时管理库在系统临时目录，保留用于复核，临时服务收工停止。

## 下一步建议

后续获明确授权再提交/推送/部署；上线无需数据迁移，不批量重写已有手填档位。
