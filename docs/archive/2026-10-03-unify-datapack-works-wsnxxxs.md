# 2026-10-03 · 数据包作品当投稿处理 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Claude Opus 5.5

## 本轮目标

用户反馈 `#/campfire-campsite` 盲评只有一对。查明后用户定规则：不再区分馆藏和投稿；Gallery 投稿核验通过即公开，同时进 Gallery 正式盲评与 arena 娱乐盲评；arena 来源默认不进 Gallery 盲评（来源字段以后再做）；避免同一作品出现两次。

## 改动

均在分支 `unify-pool-defaults` 的本轮提交中。

- server/library.mjs：`flagsOf` 中数据包作品没有 override 行时三面默认开启；`legacyRounds`（旧 Show1 快照已有作品的轮次）里的娱乐面默认关闭。`adminWork` 给数据包作品也输出 `arena`，`toPublic` 输出 `addedAt`。预览键按 task/id 复用，修复同名作品打开别题页面。删除 `markCurated`。
- server/app.mjs：快照先读入，把轮次传给 library；删除收录提名、撤回、导出接口和 export 限流桶。
- server/show1compat.mjs：game 名单遍历数据包、按娱乐开关取作品；数据包作品 game id 为 `dp-<轮次>-<作品 id>`，旧票按 `up-` / `legacy:` 前缀换算编号。
- server/catalog.mjs：数据包作品带 `addedAt`，不再读 `sourceUpload` / `sourceDigest`。
- server/read-guard.mjs、admin/admin.js、server/config.mjs：删除导出豁免、提名按钮和收录注释。
- 删除 server/curate.mjs、server/arena-backfill.mjs、scripts/arena-backfill.mjs 及其测试和 npm 脚本。
- docs/api-contract.md、docs/deploy.md：两类来源同一规则，删除收录与回填章节；nginx 导出豁免暂留的说明。
- 测试：按新默认改写断言，删去多余的逐件审批，game 名单测试改为默认在名单中、关闭后移出。

## 决策

- 作品文件仍分数据包与数据库两处，只去掉规则差别：数据包出版本需要发版，投稿要即时公开。
- 旧快照轮次 001–008 的数据包作品娱乐面默认关闭：用内容哈希核对，中式建筑有 7 件与快照里的旧投稿是同一份。
- `curated_as` 列与过滤保留，历史收录件不会重复出现。
- nginx `read-zones.conf` 的导出豁免映射本轮不改，避免多一次 Nginx 部署；后端对该路径返回 404 并计入读取桶。
- 待定：arena 来源字段（用户说以后再做），之后旧站轮次的作品再按「默认不进 Gallery 盲评」处理。

## 验证

- `npm run check`：82 个文件 0 错；`npm test`：240/240（一次因测试内网络请求偶发失败，重跑通过）。
- 用去掉 5 件重复作品的真实数据包和临时库调接口：篝火营地池 8 件 8 配置，12 组未抽到重复件；game 名单 394 件、id 唯一，数据包作品 132 件且不含 004/005/007；13 道题的同名 Opus 各自打开本题页面；审核接口 177 件数据包作品均带盲评状态；关闭一件后池子 8→7；旧收录接口 404。
- 与 Gallery 同名分支同源联调见 Gallery 归档。
- 未验证：生产数据库与部署。

## 明确没做

- 未推送、未部署、未改生产数据，未改 nginx。

## 遗留物

- 本地 main 工作区另有未提交的「自定义厂商」改动，迁移号 v33 已被远端占用，合并时需改为 v35。

## 下一步建议

- 数据仓 `remove-duplicate-works` 出包后，后端与 Gallery 同时换 pin，先部署后端再部署 Gallery。
