# 2026-10-03 · 四仓联调后端合并 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6.1 Sol / high / Codex

## 本轮目标

按用户四仓联调及发布授权，汇合后端已完成主线功能，交付父代理固定可发布后端提交。

## 改动

- 将本地 API v2 / 三角色 / 作品题目覆盖层与 origin/main 的长期 c 地址、娱乐池十件门槛合并；三项功能均有独立完成提交和既有回归，旧候选想法没有实现。
- 保留发布过的 v1–v37 迁移，角色统一改为追加 v38。新迁移不改历史票 / 审计 / curated_as / nominated_at；角色重建仍关闭事务外外键并重新开启。
- c 地址按当前覆盖层核对核验状态和软删除，后台撤下作品后旧地址 410；修订原测试以持久覆盖行验证真实撤下与恢复。
- API 契约迁移章节同步 v38；Show1 DTO 保持兼容，后端须先于配套游戏发布，Gallery 同步 API v2。

## 验证

- npm run check：86 文件，0 错。
- 最终 npm test：258 / 258，通过，0 失败 / 取消 / 跳过。
- v36 和 v37 各自升级到 v38、外键、依赖账号、票和审计原文、创建角色不随后来升降权变化均通过；v37 的持久 c 内容键保留。
- v1–v37 迁移逐项与 origin/main 比对相同，换行规范后内容一致。
- 内容真实 HTTP 回归确认撤下 / questioned / 软删除返回 410，不再进公开清单；恢复保持长期键。娱乐 9/10 阈值及 formal 豁免通过。
- git diff --check / staged diff --check 通过。

- 生产只读预部署副本（由父代理提供）复制后试迁移 v37 -> v38 通过；原副本未写入。19 张既有表按原列核对 SHA256 均保持，仅 users 的 member 按授权迁移为 user；votes=444、users=31，外键与完整性检查通过。回填 questions admin=7/user=7，works admin=16/user=344。父代理逐文件核对线上 68 个 runtime 文件等于 bdb55e9，旧 marker 5527c5e 失准；发布真实代码基线采用 bdb55e9，保留已上线内容键与门槛。

## 明确没做

未改数据包源码、生成物或当前消费 pin，未写生产库、部署、逐件作品交互或移动端验收；父代理执行固定包联调、统一 pin、推送后的发布与线上核对。

## 遗留物

保留开始时 HANDOFF 未提交内容、两条旧归档的修改和两条未跟踪归档。忽略目录 output/server-integration-20261003 保存原 HANDOFF、tracked patch、状态及测试证据，无凭据。

## 下一步建议

父代理从已进入上游 main 的最终 SHA 部署至 /www/wwwroot/arenaofbias-server，备份生产 SQLite / 包指针 / 旧代码后迁移到 v38，再发布游戏与 API v2 Gallery；核对公共 bootstrap、c 地址、游戏阈值、数据库行内容及服务状态。


## 差异包根链接复制修复（2026-10-03，发布前必要修复）

- 父代理在实际差异包部署中确认 cpSync(oldRoot) 会保留 .datapack/current 根符号链接，后续删除和更新写穿旧版本。仅修改 scripts/datapack-delta.mjs 与既有 delta 测试：先 realpathSync 解析旧根，基线核验和复制均使用实体目录，资源内部链接继续由 inventory 拒绝。
- 新 root-link 回归使用 Windows junction / Linux directory symlink，确认旧版本树 SHA256 不变、current 保持链接、目标是实体目录并通过目标校验。修复前 Windows cp 报 EPERM，修复后 2 / 2 专项通过；npm run check 86 / 0、完整 npm test 259 / 259、diff --check 通过。
- 本轮不操作生产，不重跑数据库迁移；线上受影响文件恢复与旧版本完整校验由父代理负责。保留父代理已更新但未提交的 datapack.json 与原脏文档。本补充与脚本 / 测试作为必要修复独立提交，父代理重新固定后端来源后发布。


## 2026-10-03 · 发布完成与差异包事件补记

- 父代理完成生产发布，固定后端 a7179f28c3c6c2de46f4da4b2b5e1ca4aa6fa6a1，API v2 / schema v38；Linux 干净固定源码 check 86 / 0、npm test 259 / 259 通过。验证后的统一数据包已安装，公网核对尚在进行；此补记不宣称全部交互或移动端验收通过。
- 事件发生于旧 delta 工具的暂存阶段：cpSync 保留 current 根链接，后续文件操作穿透链接，旧包 5 文件更新、8 文件删除。父代理短暂停服，使用事先保存的完整旧包缓存恢复全部 13 文件；确认旧包完整文件集合和每项 SHA256 精确复原后，才用实体路径重新暂存。旧版本保留，新工具 realpathSync 根解析回归及 Linux 全量 259 项测试通过。
- 上述资源恢复先完成，正式数据库迁移另行执行。停服迁移前 users=31 / votes=444 / works=360 / questions=14 / matches=445 / reactions=2；19 张既有表的原列内容哈希保留，users 只执行授权 member -> user。恢复服务前 foreign_key_check 和 integrity_check 均通过。
- 服务器受限备份目录 /root/aob-integrated-release-20261003/backup 保留 code.tar.gz 和停服一致数据库 platform-stopped.db。回退代码时不得覆盖迁移后产生的新业务写入。
- 本次只改本轮 HANDOFF 最新节与本归档追加部分，不 commit / push；线上固定 SHA 保持。他人脏文档和本地消费配置保留。
