# 2026-10-05 · 被拒题目修改后重新提交 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Code

## 本轮目标与决策

用户要求被退回题目的提交人能看到原因、修改后重新上传，先出交互设计，确认后前后端实现。用户确认的规则：只有从未公开的被拒题目可重提，公开后撤下的不能改；重提不再检查发起资格，但重新计入待审数量；示例结果默认保留、可移除，不能在重提时换新；不限重提次数，只拦截内容未改的重复提交。

## 改动

- server/questions.mjs：新增 resubmit，按 audit 中 question-review approved 记录判断是否公开过；事务内可软删本人示例、复用 meta 校验、比对字段、写 pending 与 round/previous、写 question-resubmit 审计。作者 moderation 视图加 round、previous.reason/at；review 保留 round；byOwner 对 rejected 题目给 resubmittable。
- server/app.mjs：`POST /api/questions/:id/resubmit`，邮箱绑定与 write 限流。docs/api-contract.md 同步。
- test/questions.test.mjs：新增单元回归，覆盖未拒绝 409、他人 404、无改动/非法字段/非法 removeSamples 400、重提后 round 与 previous、示例软删与审计、再次拒绝保留 round、待审限额 429、公开后撤下不可重提。

## 验证

- npm run check：95 文件、0 错；npm test：299/299。
- Gallery 本地预览以本工作区后端 createPlatform + 临时库 + 合成题目联调：作者列表三种状态与 resubmittable、无改动被拒、改提示词并移除示例后成功（第 2 次）、管理员看到上次意见与改动对比。
- 未跑：跨仓 integration smoke（本轮未改其路径）；本仓无 build/intake 脚本。

## 明确没做与遗留物

未推送、部署或生产写入；未做 HTTP 层专门回归（路由为薄封装，浏览器联调覆盖）。主工作区有他人未提交改动，本轮在独立工作树 question-resubmit 分支完成并按用户授权本地提交一条，未合入 main。无待拍板事项。
