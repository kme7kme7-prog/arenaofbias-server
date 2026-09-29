# 2026-09-30 · 作品来源维度第 2 轮 · wsnxxxs

- 负责人：GitHub 提交身份待用户决定 ｜ 执行 AI：Codex

## 本轮目标

在共享后端保存、校验并输出 Harness 与服务商来源；维持旧客户端、旧数据包和旧后端对 v16 数据库的兼容。只修改 server 仓库。

## 改动

- 基线 `origin/main@2ae065df3fc78f08022c4a04209b5f6a608d9bb3`，工作分支 `provenance-round2`。数据仓第 1 轮已合并并发布，`datapack.json` pin 更新为产物 `e5ef61c882e11319ebe1f06ca5534cb1b4723adb`；`npm run fetch:datapack` 成功。数据包含 11 条 Harness、10 条服务商、83 件馆藏。线上仍 pin `574b17e`，等本轮部署才切换。
- `server/db.mjs` 追加幂等 v16：`harness_id`、`harness_other`、`harness_version`、`provider_id`、`provider_other`；ID 和长度列级 CHECK，两个非空且未删除作品的部分索引。不回填、不改变已有行。v8 旁注记录 legacy 票的身份列是裸模型 ID。
- `server/catalog.mjs` 读取完整来源注册表，旧包缺字段时用空数组；馆藏结果读取三个新字段，`tool` 继续取 `sourceLabel`。`server/library.mjs` 为投稿、审核、元数据编辑及公开视图接入来源字段；ID 与「其他」互斥，版本依附 Harness，注册表 ID 允许 `listed: false`。旧客户端只传 `tool` 仍能投稿；空 `tool` 由 Harness 名称或「其他」原文生成。
- `server/inbox.mjs`、`server/app.mjs` 透传后台录入来源字段，移除写死的「管理员代传」工具名；`server/curate.mjs` 的收录导出包含五个字段。
- `server/arena.mjs` 身份快照增加 `harnessId`、`harnessVersion`、`providerId`，单票更正支持两个注册表 ID。`configKey`、`digest`、计分和排行榜筛选不变。Show1 旧兼容端点不变；Q13 的 model 查询范围及只改 modelName 的顺带修复未做。后台界面留到第 3 轮。
- 更新 `README.md` 与 `docs/api-contract.md`。新增 `test/provenance.test.mjs`；仅调整管理员录入工具默认值断言，以及用户许可的两处旧迁移测试索引，未改 Show1 golden 或其断言语义。

## 验证

- `npm run check`：54 文件，0 错。`npm test`：116/116 通过、0 失败，Show1 golden 通过。
- 指定新数据包、临时空库：`PRAGMA user_version=16`、`PRAGMA quick_check=ok`、`GET /api/bootstrap=200`。注册表 ID 和「其他」各投稿一次，经审核后在公开接口可见；提名和导出成功，导出含来源字段。
- `origin/main@2ae065d` 的旧代码直接打开 v16 库，旧列列表 INSERT、SELECT 均成功。在同一 v16 库写入 3 张 arena 票，将身份 JSON 中三个新键删除形成旧格式快照；新旧代码对 `by=config` 与 `by=model` 的结果去掉 `updatedAt` 后逐字节相同。旧代码测试进程关闭时有异步收录回调报 `database is not open`，发生在榜单对比完成后；运行中的服务未关闭数据库，不影响这两项比对结果。
- 临时演练材料位于 `output/provenance-round2/`（被 gitignore，含旧代码导出及测试库）；未写其他仓库。未提交、推送、开 PR、合并、部署或发布数据包。

## 只读的部署后核对命令（准备好，未执行）

在部署前保存各表行数基线并暂停会产生写入的流量；迁移后用下面命令核对。连接按 `output/schema-study/profile-prod.mjs` 使用 `readOnly: true` 和 `PRAGMA query_only=ON`。`nondefault_existing` 应为 0；若部署后已有新投稿，需以部署前作品 ID 集合为范围单独核查。

```bash
live=/www/wwwroot/arenaofbias-server
node --input-type=module - "$live/.data/platform.db" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
db.exec('PRAGMA query_only = ON');
console.log('user_version', db.prepare('PRAGMA user_version').get().user_version);
console.log('quick_check', db.prepare('PRAGMA quick_check').get().quick_check);
const columns = db.prepare('PRAGMA table_info(works)').all().map((row) => row.name);
console.log('provenance_columns', ['harness_id', 'harness_other', 'harness_version', 'provider_id', 'provider_other'].every((name) => columns.includes(name)));
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
  console.log('rows', name, db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n);
}
console.log('nondefault_existing', db.prepare(`SELECT COUNT(*) AS n FROM works WHERE harness_id IS NOT NULL OR harness_other <> '' OR harness_version <> '' OR provider_id IS NOT NULL OR provider_other <> ''`).get().n);
db.close();
NODE
```

核对 `user_version=16`、`quick_check=ok`、五列齐全，各表行数与部署前记录一致，且所有部署前作品的五列保持 `NULL,'' ,'',NULL,''`。该命令未连接或修改线上数据库。

## 线上库副本的部署前榜单对比步骤（未执行）

1. 按 `docs/deploy.md` 先备份，并在只读连接上对线上库执行 `VACUUM INTO`，输出到受限临时目录，勿直接让试验代码打开生产库。线上 arena 票目前为 0；此步骤仍可防止池和输出结构回归。
2. 从同一副本复制两份 `platform.db` 到独立的临时 `DATA_DIR`；旧代码检出部署前 SHA，新代码检出本轮待审 SHA。两个进程使用同一已校验的数据包目录。新代码会将自己的副本升到 v16，旧代码保持原版本。
3. 分别从各自代码目录导入 `createPlatform` 与 `limits`，令 `config.dist` 指向同一数据包、`config.dataDir` 指向各自副本；`capture=false`。对全站和每个题目调用 `arena.leaderboard({ task, by })`，`by` 分别为 `config`、`model`，去掉响应的 `updatedAt`，按相同次序 `JSON.stringify` 后比较。全部一致才继续部署。
4. 若需生成副本，可按现有 `docs/deploy.md` 的 `VACUUM INTO` 命令执行；它只读源库并写新的临时副本。比较过程只接触副本。生产流量若在复制期间继续写入，以单次 `VACUUM INTO` 的快照为两侧共同基线。

## 明确没做

未回填历史来源、未增加排行榜来源筛选、未修改 Show1 旧兼容响应或后台界面、未处理 Q13、未改其他仓库。部署顺序是已发布的第 1 轮数据包 → 本轮后端 → 第 3 轮前端。只回滚后端代码即可继续打开 v16 库；旧代码 INSERT/SELECT 已在本地证实。

## 遗留物

- `C:\Users\Ryan\Desktop\arenaofbias-server\output\provenance-round2\` 是可清理的本地临时目录。用户此前提到的 `C:\Users\Ryan\AppData\Local\Temp\dp-check` 浅克隆仍存在，可由用户删除；本轮没有操作它。
- 本轮尚未提交。需用户决定是否提交及使用哪个 GitHub 身份。

## 下一步建议

先审阅本分支与接口文档；用户确认提交身份后再提交。部署前执行线上库副本榜单对比，部署后执行只读核对并记录实际表行数，再安排第 3 轮前端更新。
