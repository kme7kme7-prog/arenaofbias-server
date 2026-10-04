# 2026-10-04 · Gallery 版本标记部署配套 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex；GPT-6.1 Sol / high 子代理

## 本轮目标

配合 Gallery 已完成的跨发布旧标签页恢复，只维护 server 仓库的部署文档。用户明确禁止 commit / push / 部署 / 生产登录，并要求 GPT-6.1 Sol / high 分工；两个子代理分别核对 Nginx 与修改部署文档，父代理集成、验证与交接。

## 改动

- `docs/deploy.md` 的 Gallery 差异发布完整 manifest 保留 `version.json`，构建示例检查 assets 与 index.html 全部 ?v= 一致；差异资产 tar 排除标记，先上传资产和入口的差异包，再单独上传标记，即使标记哈希未变也上传。
- 远端示例在 .next 核验完整树后，暂留旧标记，切换全部资产和 index.html，再在同一文件系统原子发布新标记；提前发布标记会让旧标签页刷新到半套新版。Gallery 回退先复制 gallery.prev 到独立暂存，最后恢复旧标记，保留原 .prev。旧版没有标记时示例在切换前停止，并说明整目录回退的边界。
- 明确 /version.json 的 no-cache / no-store、禁止长缓存 / immutable 与 CDN / 反代缓存。现有 JSON 规则已满足，不新增 location；将来若为此路径新增 location，必须 include security-headers.conf。
- 本地核对 static-private-paths.conf、read-zones.conf 与 ArenaGalleri 的 gallery-private-files.conf 均不阻止此路径，使用普通资源 20r/s、burst 200 及共享 64 并发，不加入 catalog 限流。三个配置与 Gallery 均未修改。
- 发布验收新增 HEAD 200 / no-cache（或 no-store）及 GET assets 与 index.html app.js?v= / 全部资产版本一致；旧标签页恢复交互另行验收。根 HANDOFF 仅新增本轮节，原有内容保留。

## 验证

- npm run check：91 文件 / 0 错。完整 npm test：278 / 278，0 失败 / 取消 / 跳过。测试包含工作区原有未提交功能，不能归因于本轮文档修改；没有新增仓库测试。
- 六个相关 Bash 示例块的 bash -n 通过；使用本地合成目录和离线 scp 替身演练 Gallery 新旧标记、首次引入标记、标记哈希不变以及 Show1 发布。完整 manifest / 精确集合核验、标记单独最后传输、资产先切换、标记最后生效、回退保持 .prev、缺少旧标记时切换前停止均通过。
- 演练在 Windows Git Bash 中执行；早期两次因 Git Bash SHA 输出的二进制分隔符与 Python 写入 CRLF 不符合示例的 Linux manifest 格式而停止。最终只规范化合成 manifest 的分隔符及 LF 后通过，未改文档绕过核验；这不是生产 Linux 演练。
- git diff --check 与本轮文档相对链接检查通过；原有脏文件内容哈希保持，HANDOFF 原有内容逐字节保留。
- 缓存规则证据是现有 docs/deploy.md 与本地历史 vhost output/four-repo-release-20261002/nginx/gallery.conf / gallery.conf.candidate 的 JSON no-cache 规则，不代表当前生产响应。

## 明确没做

未 commit、push、连接或登录生产、部署、重载 Nginx、请求公网 version.json 或验收生产缓存头 / CDN / 旧标签页恢复；未改业务源码、数据库、数据包、生成物或 Gallery 前端。未执行 Nginx -t（本轮无配置改动，且本机无 Nginx），未执行 build / check:intake（server 无这些脚本，Gallery 未改）。

## 遗留物

- 本轮前已修改的 HANDOFF、datapack.json、API 契约、业务源码与测试、既有归档，以及未跟踪的参考图实现 / 测试 / 他轮归档全部保留。
- 最终离线证据位于忽略目录 `output/gallery-version-deploy-20261004-gz9e7zfx/summary.txt` 与 `smoke.log`；早期演练目录同样保留，不做无差别清理。

## 下一步建议

用户另行授权发布后，按 [部署文档](../deploy.md#静态站差异部署show1--gallery) 执行完整发布与验收，核实现场 vhost / CDN 规则及旧标签页恢复交互；不要把本轮本地文档完成当作上线。

## 追记（2026-10-04）

用户随后授权提交本轮文档，以一条本地提交入库；仍未推送、未部署。
