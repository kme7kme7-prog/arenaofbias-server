# 2026-10-20 · dots 3D 预览上传接口 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok Bot
- 本文写于提交前。用户授权开 PR 并自测，不合并、不部署；不属于 09:30 发布（014e076）。

## 本轮目标

只给 dots 开接口，封面和 3D 小模型由 dots 自己做：新权限 `preview:write`、截图失败列表按「三维建模」筛选并标出 WebGPU、上传 ≤2 MB 的小模型接入现有预览机制、只换预览不动作品、可回滚、审计。

## 改动

- 新模块 `server/preview-uploads.mjs`：`.sbox` 校验与重建、WebGPU 静态特征扫描、预览版本存储（历史、回滚）。
- `server/dots-moderation.mjs`：`TOKEN_SCOPES` 加 `preview:write`；`captures/failed` 加 `category`；新路由 `PUT /api/dots/works/:task/:id/preview`。
- `server/work-previews.mjs`：`source: "dots"` 的清单允许版本化模型名 `preview-<stamp>.sbox` 和 `cover-*` 海报，sha 校验不变。
- `server/work-covers.mjs`：封面历史只看 `cover-*` 动作（与预览共用 `cover_history`）。
- `server/app.mjs`：接线、`/media/` 接受 `preview-<stamp>.sbox`、管理员 `preview-history` / `preview/rollback`。
- `scripts/moderation-token.mjs`：`preview-history`、`preview-rollback`；`grant` / `withdraw` 本来就按 `TOKEN_SCOPES` 通用。
- 无迁移（仍是 49），无新环境变量，无 npm 依赖。

## 关键判断

- 分类在题目上（`category`：文学 / 推理 / 静态网页 / 建模），「三维建模」= `建模`。筛选用题目 id 集合 `json_each(?)` 加主键 keyset。
- 只收 `.sbox`：Gallery 的 `readModel` 只读它，站点 three 没有 GLTFLoader；`.sbox` 能在服务器上不依赖 three 按白名单逐字段重建。glb 需要 chunk、扩展、外部 URI、动画等一整套清洗，前端还要加加载器，收益不抵风险。
- 存的是重建后的文件：头部只保留白名单字段，数据区只复制被引用的字节段，重新 gzip。
- 海报 = 当前人工封面（#20 `cover:write` 已校验）。没有人工封面时 409 `poster_required`。清单里记 `posterSha`，以后换封面不会让旧清单指向错误内容（`readWorkPreview` 按 sha 校验）。
- 不覆盖人工/烘焙预览：只要 `preview.json` 不是 `source: "dots"` 就 409 `preview_exists`，回滚同样拒绝。
- 缓存：写入后对作品行做一次 `updated_at = updated_at` 空更新，触发目录修订号，作品行内容不变。
- WebGPU 判断是静态扫描（不运行作品），文档写明特征和局限。

## 验证

- `npm run check` 通过。
- `test/dots-moderation.test.mjs` 新增 4 条：上传/清洗/版本/回滚/烘焙预览不覆盖/脚本；`preview:write` 单独授权、撤权、`DOTS_DISABLED_SCOPES`；`category` 筛选和 WebGPU 标记；数据区重建。
- 全量 `npm test`。

## 明确没做

- 未合并、未部署，未生成令牌。
- Gallery 未改：`site/result-previews.js` 已经先显示海报（`result-model-poster`），`IntersectionObserver`（rootMargin 180px）进入附近才 `readModel`，满足“先海报、滚到才加载模型”。
- 旧预览版本不自动清理。

## 遗留物

- 无。前一个 three.js 封面试做任务已作废：本地分支删除，未推送、未开 PR。

## 下一步建议

- 合并发布后给 dots 令牌单独 `grant <id> preview:write`，先在少量建模作品上试。
