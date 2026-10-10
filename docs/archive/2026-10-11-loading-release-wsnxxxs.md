# 2026-10-11 · Gallery独立加载发布 · wsnxxxs

- 负责人：wsnxxxs；执行：Codex。用户明确授权提交、推送、部署并要求联调，凭据仅用于交互连接。

## 目标、改动与决策

发布已完成的3629a9e加载功能，只替换app/library/read-guard及新增catalog-response四运行文件；保留其他生产模块、数据源和媒体，继续兼容bootstrap。当前运行版本3629a9ed0c214e94587c99fb476fa4ea484215f5。Gallery完整2353文件仅七个改变，资产253d5e198065a92544e315c2。

公网发现继承的Nginx proxy_cache清除条件请求头，实际相同ETag反复200；新增deploy/nginx/api-proxy.conf，API根proxy包含后关闭代理缓存并采用gzip6，媒体location保持。应用公开缓存仍重验证，不扩展可见性或私有缓存。

各仓一个英文合并提交，正常push main。推送前另有远端260ae05的playground接入，保留其源码及历史并重新检查；本轮现场未部署该提交的content/show1compat及三个新文件，合并HEAD不能作为生产全量源码标记。

## 验证

- 原候选Windows/Linux check117/0、test337/337；合并最新上游Windows119/0、337/337。前端69/0、39/39、构建176/70、严格intake0错/8既有提示。
- 实际生产数据库在线一致副本及独立1.3GB文件副本联调65题/1259件：匿名与管理员目录字节一致、私有权限与统计no-store、旧聚合口径、撤下及ETag即时失效，写入仅限隔离副本。冷目录3635.62ms、热14.22ms/服务端0.20ms、304为4.45ms、匿名会话4.05ms/管理员6.97ms。
- 消费包integration smoke、发布候选真实跨域浏览/刷新通过。公网部署检查完整65题/45社区题/1259件、数据兼容、CORS、session与304；预检204。Chromium网络确认200→304，桌面1440/手机390题库与榜单目视、无横溢/控制台错误警告/bootstrap/业务POST。
- gzip传输236702→208325B；最后真实HTTPS200/304采样3366/337ms，304零正文/服务端0.21ms。最终手机完整目录首读7533ms、刷新3985ms，不能将目录重验证时间称为完整首屏时间或固定公网速度。
- 最终成功切换不可用1.727秒，总安装7.104秒；306用户/1381作品/60数据库题/9681原始票前后保持，schema41/integrity ok/外键0，active/running/NRestarts0。完整Gallery SHA门禁通过。

## 校验回滚与明确没做

旧Python解包filter不兼容在停服前发现并纠正。票表校验误写ballots，后又从session读取仅catalog提供的serverVersion，两次都触发自动回滚并恢复原服务；前者未替换应用，后者恢复旧代码。已将表/schema预检移到停服前，健康检查按实际端点契约执行。两次另有短暂重启、合计未记录，1.727秒仅最终成功切换。未恢复/覆盖生产DB，没有持久迁移。

未修改另一前端或私有数据源码，未生产登录/投稿/审核/投票，未逐件检验全部原作或真机FPS。未安装上游playground运行功能。

## 遗留物与下一步

回滚备份 `/root/aob-loading-release-20261011/backup` 保留原DB/运行文件/Gallery变化文件/版本/API配置；本轮隔离1.3GB数据副本已定点移除，旧轮备份保留。证据在服务器发布目录及Gallery/output/loading-release-20261011、output/playwright/loading-release-20261011，生成物、私有配置与凭据不提交。

后续playground增量发布须保留本轮四个模块及API include；真正组合上线并核对全量SHA后再改变组合版本标记。Gallery同轮归档记录完整流程与验收范围。
