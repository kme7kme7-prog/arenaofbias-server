# 2026-10-02 · 通过即公开规则 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5

## 本轮目标

用户拍板：核验通过即公开，合格自动进盲评，管理员只处理例外；后端与 Gallery 审核界面统一。

## 改动

- server/library.mjs：review 在作品首次转为 verified 且请求未给开关、也未给 audience 时两面开启并记录本面决定；重复核验保持原开关。新增 arenaState，toPublic 对作者与管理员、adminWork 对投稿输出 arena { state, reason? }。
- server/app.mjs、server/inbox.mjs：管理员代传与收件箱发布不再显式传竞技场关闭，走同一缺省。
- admin/admin.js：已验证提示同步。
- docs/api-contract.md：字段表、review 缺省、代传 / 收件箱缺省与 batch-review 的 show_arena。
- test/admin.test.mjs、test/platform.test.mjs：三条旧分面审批断言按新规则改写，新增重复核验保持关闭、not_qualified 原因、in_pool 断言。

## 决策

- 馆藏 override 默认不变，仍在后台作品页开启。
- 不迁移存量数据，由管理员在 Gallery「不进盲评」批量开启。
- show_arena 不影响 Show1 站点作品列表（其使用 show_entertainment）。

## 验证

- `npm run check`：87 个文件 0 错；`npm test`：244/244。
- 与 Gallery 配合的隔离合成数据 Browser 验证见 Gallery 归档。
- 未验证：生产部署与生产数据。

## 明确没做

- 未推送、未部署、未改生产数据。

## 遗留物

- 工作区未跟踪 scripts/fountain-preview/serve.mjs 非本轮产生，未改动，请负责人确认归属。

## 下一步建议

- 与 Gallery 同版本发布。
