# 2026-10-02 · Gallery 审核接入盲评开关 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5

## 本轮目标

承接小红帽盲评池为零的调查：Gallery 审核只开展览馆、不发 show_arena，用户要求前后端审核逻辑统一。

## 改动

- server/app.mjs：batch-review 接受可选布尔 show_arena，仅 verified 时随 show_gallery 一并生效，非布尔返回 400。
- admin/admin.js：已验证提示改为「已核验并优先展示；是否进入盲评以盲评开关为准」。
- test/admin.test.mjs：批量核验开启盲评、非法 show_arena 两条断言。

## 决策

- 维持分面审批；Gallery 审核显式发送两个开关，批量接口补 show_arena 以对齐单件 review。

## 验证

- `npm run check`：87 个文件 0 错；`npm test`：244/244。
- 与 Gallery 配合的隔离合成数据 Browser 验证：单件与批量开启盲评均落库，池统计随之变化。
- 未验证：生产部署与生产数据。

## 明确没做

- 未改生产数据、未推送、未部署。

## 遗留物

- 工作区未跟踪 scripts/fountain-preview/ 非本轮产生，未改动，请负责人确认归属。

## 下一步建议

- 与 Gallery 同版本发布。
