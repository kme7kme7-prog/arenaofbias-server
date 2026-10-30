# 2026-10-30 · 题面参考图 COS 双写与删除清理 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok Bot

## 本轮目标

按 kme7 选定的方案 A：公开题（approved / legacy）的参考图双写到 COS，草稿、pending、rejected 不进桶；下架、换图、删除时按键删除并逐条刷新 CDN；给运维写 api 主机 `/media/references/`、`/media/pack-references/` 取消 301 的 nginx 指南。

## 改动

- `server/cos-dual-write.mjs`：新增参考图键白名单（`media/references/r-<32hex>.(png|jpg|webp)`、`media/pack-references/<task>/<name>`，拒绝 `.`、`..`、点开头和控制字符），`mirrorReferenceMedia`、`purgeReferenceMedia`、`purgePackReferenceMedia`。PR#27 的按作品前缀 purge 泛化为前缀任务，新增按键删除任务（不 List）。Put 仍受 `COS_MEDIA_ACCESS_CONTROLLED=1` 门控；删除仍受 `COS_DELETE_ON_REMOVE`，CDN 只用 `PurgeUrlsCache`。
- `server/references.mjs`：`syncMedia(before, after)` 按公开前后的参考图差集 put / purge。
- `server/questions.mjs`：`edit`、`review` 事务提交后、`remove` 清盘后调用 `syncReferenceMedia`；数据包题在转为公开时从当前快照 put，撤回公开或删除时清前缀。失败只记 `COS reference sync skipped:`。
- `deploy/nginx/reference-media.conf`：两个 `^~` 反代例外。`docs/deploy.md` 新增「题面参考图双写与 api `/media/` 例外」小节（位置、优先级、备份、`nginx -t`、reload、回滚、防覆盖、冒烟）；`docs/api-contract.md` 补一段。
- 无迁移，无新 env，无 npm 依赖。

## 验证

- 新增 `test/cos-references.test.mjs` 7 项：键白名单；门控开/关；按键删除且无 List，只发一次逐 URL 刷新；包前缀只列 `media/pack-references/<task>/`，CDN 失败只记日志，关删除时零请求；真实 questions/references 生命周期（草稿与 pending 不写、通过后写、换图 put 新 purge 旧、同值编辑不重写、拒绝清除、拒绝态编辑不写、重新通过再写、删除清除）；pending 题作者删除不发请求；数据包题拒绝/重新通过/删除。
- 去掉 review 钩子后有 2 项失败（变异检查）。
- `npm run check` 0 错误；`npm test` 596/596（Node 22.14）。
- 未连接真实 COS/CDN，未部署。

## 明确没做

- 不改线上、不 SSH、不改 nginx、不联系运维、不合并。
- 不改 Gallery（它仍把全部参考图拼到 CDN，作者看自己待审题图仍 404）。
- 新数据包里新增的公开包题不自动补传；存量不重做（10-28 运维已补 37 张）。

## 遗留物

无本地临时文件进仓。方案稿在仓外 `/workspace/rd/cos-references-dualwrite-20261028/PLAN.md`。

## 下一步建议

1. 先合并并发布代码，确认 `bootstrap.serverVersion` 带本 PR 标记，再请运维按 deploy.md 加 nginx 例外，然后冒烟。
2. 运维同步 `/root/aob-performance-20261026/` 的 payload 与护栏，确认宝塔是否保留手写 include。
3. 视需要另开 Gallery PR：非公开题参考图不走 CDN。
