# 2026-10-01 · 社区题目审核与静态 ZIP 修复 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex desktop
- 范围：共享后端题目审核、示例结果投稿、后台审核和契约，以及联调发现的静态 ZIP 格式判定。本记录为提交与部署前状态。

## 本轮目标

发起社区题目时同时提交一份模型结果；题目一律人工审核，作品照常走内容审核与核验。完成与 Gallery 的真实联调，修复静态 ZIP 建题误拒，并准备两仓统一发布。

## 改动

- 未提交：v22 在迁移末尾追加 questions.moderation、deleted_at，旧题 legacy 保持公开，新题 pending；公开读取、作者/管理员私有读取与删除活动排除统一受题目状态约束。
- 未提交：支持 __new__ 草稿、示例结果格式推断与恢复；POST /api/questions 必须带 draftId、confirmed、work，同一事务建题、建 unverified 示例及审计，失败回滚。题目审核不替代作品内容审核与核验。
- 未提交：新增题目审核列表、人工通过/拒绝、按权限软删除接口及后台题目标签，bootstrap.review.questions、README 与 API 契约同步。与 Gallery 契约完全一致。
- 未提交：createDraft 把判定格式保存到 checks 中的 format.template，建题复用；旧草稿仅在 package.json 与 root 同时存在时判 vite。修复 dist/index.html 旁有 README 的 static ZIP 误判，保留显式 static，无新增迁移。
- 本轮仅整理 HANDOFF 与本归档。此前本地头像、题型榜单、投稿流程提交等待统一发布。

## 决策

- 用户已明确授权两仓 commit、push、deploy。提交使用 wsnxxxs 的 GitHub noreply 身份与英文简单句。
- 用户已授权部署后先备份、确认 4 道测试题各为零作品零票，再由管理员 API 逐条软删除：q-9becba326438d52c、q-9c39b8642a46c310、q-82a12216062f8541、q-fa132f1b3b3bfa93。
- 当前未提交、未推送、未部署，生产备份与清理未执行；部署与清理结果另有后续记录。无关 Show1 工作树改动和新的 121 件作品数据发布不纳入本轮。

## 验证

- npm run check：69 文件、0 错。最新全量 npm test：154/154，0 失败/取消/跳过；git diff --check 通过。
- 本次门禁前一轮全量为 153/154：既有 moderation mock 期望 rejected，实际 review。单独 moderation 6/6、再次全量 154/154 通过；如实保留间歇失败，原因未确认。
- 新增题目用例覆盖草稿、可见性、私有预览、两类审核独立、额度、删除约束和事务回滚；静态 ZIP 回归覆盖 dist/index.html + README 的显式 static / 自动推断及带 package.json 的显式 static。
- 本地隔离库后台浏览器验证题目详情、示例预览、拒绝理由、通过/拒绝状态与计数、删除确认取消、审计；console error 0。删除执行和日志由 API 测试覆盖。
- 与 Gallery 真实联调完成草稿、建题、作者视图、管理员预览与人工通过、作品内容审核后的公开展示。用户用同一 ZIP（dist 旁 README）实测建题成功、状态 pending；本地服务已停止。

## 明确没做

- 未部署、未备份或修改生产库、未清理上述 4 题。未运行真实 Luna 外部调用或真实截图服务；本地无密钥、capture 关闭，通过测试桩或转人工验证。未覆盖后台移动端或生产全部交互。
- 未改数据包、生成物、他人文件；未纳入无关 Show1 改动或新作品数据发布。文档整理不重复执行功能测试。

## 遗留物

- 本轮后端源码、后台、契约、测试和交接仍为待提交改动；test/questions.test.mjs 为本轮新文件。忽略目录的浏览器截图、隔离数据和本地配置保留，不提交。
- Gallery 旧 PR #1 属另一分支，是否关闭待用户确认，本轮不合并。

## 下一步建议

按用户授权完成提交、推送与统一部署，现场核对实际版本与迁移；备份后核对 4 题零作品零票，通过 API 清理并另记时间、结果和备份位置。
