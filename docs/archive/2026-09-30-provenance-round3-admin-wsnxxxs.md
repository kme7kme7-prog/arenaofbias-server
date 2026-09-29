# 2026-09-30 · 作品来源维度第 3 轮（管理后台） · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5（Claude Code 桌面版）

## 本轮目标

在管理后台里填写、展示和筛选 Harness 与服务提供商，并修正第 2 轮留下的两处小问题。Show2 部分另见 wsnxxxs/same-prompt-gallery#5。

## 改动

- 基线 `origin/main@fec38c2`（含第 2 轮 PR #9）。数据包 pin 仍为 `e5ef61c882e11319ebe1f06ca5534cb1b4723adb`；无数据库迁移。
- `server/library.mjs`：`provenance()` 把 `harnessId` / `providerId` 的空串视同 null（未注明），不再返回 400。
- `server/arena.mjs`：`correctVote` 的报错由「所选harness不存在」改为「所选Harness不存在」「所选服务商不存在」。
- `server/admin.mjs`：`GET /api/admin/works` 新增 `harness`、`provider` 参数，取注册表 ID、`other`（只有自填文本）或 `unset`（未注明），其他值 `400 invalid_query`；`search` 覆盖 Harness 与服务商名称。
- `admin/admin.js`、`admin/admin.css`：
  - 列表元信息行：投稿显示「Harness 版本 · 服务商」，没有时回退为 `tool`；馆藏在「精选馆藏」后追加来源。模型列下以小字显示来源。
  - 审核面板显示 Harness、服务商与作者原始声明；审核面板、编辑信息、收件箱登记三处可选登记项（含当前已停用值）、「其他」、「未注明」及 Harness 版本，只提交改动过的字段，ID 与「其他」成对发送以清除另一半。
  - 「其他」原文按 NFKC、小写、去空格和连字符后命中注册表名称或别名时，提示「可能是 X」并提供改选按钮，不自动改写。
  - 列表筛选条新增 Harness、服务商两个下拉，写入地址栏参数。
  - 注册表直接取管理页已加载的 `/data.json`（数据包顶层 `harnesses` / `providers`），未新增接口。选择框的「其他」用 `__other` 作为取值，注册表 ID 不含下划线，不会冲突。
- `docs/api-contract.md`：补筛选参数与「ID 空串即未注明」。
- `test/provenance.test.mjs`：补空串 ID、后台筛选（ID、`other`、`unset`、组合、名称搜索、非法值）和中文报错断言。

## 验证

- `npm run check`：54 文件、0 错。`npm test`：116/116 通过（新断言并入已有用例），Show1 golden 未改动且通过。
- 真实浏览器（本地临时 `DATA_DIR`，数据包 `e5ef61c`，三件样例投稿：登记项、自填、未注明）：
  - 列表显示样例与两份 Arena 馆藏的来源；筛选 `harness=arena`、`harness=other`、`harness=claude-code&provider=official`、`provider=other` 结果正确。
  - 审核面板对自填「claudecode」「Open Router」分别提示 Claude Code、OpenRouter，逐个改选后请求只含改动字段，保存后 ID 生效、「其他」清空、版本写入。
  - 编辑信息把 Harness 改为未注明：版本框禁用，请求发送 `harnessId: null, harnessOther: '', harnessVersion: ''`，保存后三者清空、服务商不变。
  - 收件箱登记选择 KimiCode Desktop、版本 1.4、服务商官方：保存正确，`tool` 为「KimiCode Desktop」而非「管理员代传」。
  - 控制台无错误。
- 浏览器面板未绘制，截图超时，以上均用页面文本和 DOM 检查完成，没有截图，也没有检查 390px 布局（后台以桌面使用为主）。
- 观察到的既有行为：后台地址栏缺少某个筛选参数时沿用上一次的值（任务、状态、开关筛选同样如此），通过筛选表单操作时不受影响；本轮未改。

## 明确没做

- 排行榜筛选（第 4 轮）、回填脚本（第 5 轮）、Q13 两项修复、Show1 兼容层。
- 未部署、未合并。

## 遗留物

- 本地浏览器验证用的临时库与种子脚本在执行会话的临时目录，不在仓库内。

## 下一步建议

- 部署顺序：server 第 2 轮（部署前按其归档做线上副本排行榜对比）→ 本轮 → 合并 Show2 PR #5（合并即发布 Pages）。
- 第 4 轮：排行榜按来源筛选、数据仓 `intake-from-server` 传递来源字段。
