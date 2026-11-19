# 2026-11-19 · 批量投稿 plan 核对提示词版本 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok 4.7 / Cursor cloud agent

## 本轮目标

让普通管理员批量投稿的本地 `plan` 在有提示词版本的题目上拒绝缺失或无效的 `promptVariant`，并写明必须使用版本 id。只开 PR。不合并，不部署，不改生产、nginx、服务配置或 `BATCH_UPLOAD`。

## 改动

- `tools/batch-upload/variants.mjs` 从题库题目的 `promptVariants` 取出 id 和标签。`aob-batch.mjs` 的 `plan` 在读取作品文件之前做核对。`plan.mjs` 的摘要算法没有改，服务器行为没有改。
- 有非空 `promptVariants` 的题目：缺字段、空字符串、不是 id 的值（含中文标签）都失败，错误里列出 `id（标签）`。没有版本的题目，以及题库里没有的题目，仍可不写该字段。
- 题库来自固定地址的 `GET https://api.arenaofbias.icu/api/catalog`。没有 `--token`、`--endpoint`、`--insecure`。连不上、非 200、不是带 `questions` 的 JSON，或所有题目都没有 `promptVariants` 字段时，`plan` 失败且不写 `plan.json`。`auth` 和 `upload` 重算摘要时再核对一次。
- `AOB_BATCH_CATALOG_FILE` 只给测试替换本地题库快照，避免测试访问生产。文件无效就失败，不会改连别的主机。说明写在 `docs/batch-upload.md`。
- 文档中的示例使用 `voxel-mountain-city` 和 `promptVariant: "long"`，并写明不要填 `长提示词`。举例的三道题是 2026-11-19 线上题库里的现况，不是写死的名单。第三题标题是「忒修斯之船 · 3D」。

## 验证

- 调查时只读请求了一次 `https://api.arenaofbias.icu/api/catalog`（200，201 题）。有非空 `promptVariants` 的是 `supernovai`、`voxel-mountain-city`、`q-346be7b35d9f3e6a`，id 为 `long` / `short`，标签为 `长提示词` / `短提示词`。其余 198 题是空数组。线上 `serverVersion` 含 `pr31.3a7eaf2`。
- 对照 `submitMemberPipeline`：它调用 `promptVariantFrom(..., required=true)`。有版本的题目缺 id 会 400「请选择生成时使用的提示词版本」，id 对不上会 400「提示词版本无效」。批量上传总是带上 `promptVariant` 键，所以缺省会变成空字符串并被拒绝。
- `npm run check`：195 个文件，0 错误。
- `npm test`（`node --test test/*.test.mjs`）：624 通过，0 失败，0 取消，0 跳过。
- 新增测试覆盖：缺版本、错误 id、中文标签、合法 id（含首尾空格）、无版本题目、题库中不存在的题目、题库读失败、CLI 进程拒绝「短提示词」且不写出 `plan.json`、错误信息不含提示词原文。原有符号链接、硬链接、FIFO、作品键和限额测试仍通过。
- 测试没有访问生产 API，没有运行 `auth` 或 `upload`。

## 明确没做

- 不合并，不部署，不重启服务，不制造生产令牌，不修改 `BATCH_UPLOAD`、nginx 或生产配置。
- 不改 `questions.dto`。本仓库的公开题库 DTO 目前不输出 `promptVariants`，线上目录有该字段。这次只让 CLI 读取线上目录。
- 不改摘要算法，因此已有的无版本题目计划摘要不变。

## 遗留物

- 若以后部署的公开题库不再带 `promptVariants` 字段，`plan` 会因「没有提示词版本字段」而全部停住，直到目录重新带上该字段。空数组仍然表示该题不需要填。
- 题目不在题库中时，`plan` 不要求 `promptVariant`。上传时服务器仍会拒绝不存在的题目。
- `AOB_BATCH_CATALOG_FILE` 可以让本地 `plan` 不读官方题库。服务器上传时仍按数据包核对版本 id。

## 下一步建议

kme7 自测后再决定是否合并。合并、部署和打开 `BATCH_UPLOAD` 必须另一次明确授权。若要把本仓库的公开题库 DTO 补上 `promptVariants`，使以后部署仍能被 `plan` 核对，应单独开一轮。
