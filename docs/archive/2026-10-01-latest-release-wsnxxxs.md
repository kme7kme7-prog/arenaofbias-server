# 2026-10-01 · 四仓整理与最新部署 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex；三个 GPT-6.1 Sol medium 子代理分别负责主站、Gallery、数据仓。

## 本轮目标

按用户授权盘点四仓、保留有效远端与现场修改、合并应合并分支、关闭过期工作、更新文档并部署。用户另行确认 Gallery 的 11 个既有未提交文件一并提交部署。本轮部署授权覆盖之前轮次的“不部署、不切换 pin”。

## 改动

- 主站从 `f304d26` 快进至 `72c7f103b0eba237a572c75ed7dd95e5d8681e06`，保留 Atmeplz 的原作者提交：17 个命题封面、纸面默认主题和旧 beta 提示移除。上游 / fork 的 main 同步；已合入的远端 `codex/paper-ink-theme` 分支删除。主站收尾提交仅为文档后继。
- Gallery 用户确认的上传 / 审核流程及 Harness 版本移除提交 `e23d9a5e1ba9e6e7c10ac6194089302ba43cf07c`，推送 main。既有 PR #1 已关闭，四仓本轮均无开放 PR。旧本地 worktree 保留历史输出和依赖链接，不再次删除。
- 数据内容源码 `997676d3162a780120f52220232c8d13d5473b81` 的 CI 36846799760 成功，固定不可变产物 `ba442b61d39e7b2892143ac8a27dcf9aa2607de6`。数据仓文档提交 `c14bb30136535589fd694789c614c99021af704c` / CI 36848638371 成功，但消费者不追随其文档发布的新包。后端与 Gallery pin 固定同一内容包。
- 部署前，现场后端 `.server-version=2448803` 的全部 155 个 tracked 文件，经 CRLF / LF 归一化比对与已合入提交相同，无未知修改。现场 Gallery 的 `portal-preview-20261001T073255Z` 已调查：入口补丁 `2e178cda` 和媒体版本缓存补丁 `af1f63b` 已进入 main；最终 app / ui 保留它们，移除这些已知差异后与原基线一致，没有其它现场改动遗漏。未强推或改写原作者提交。
- 2026-10-01T10:37:25Z 部署后端功能基线 `23574fbf02bd56f2e0318e827ae8a05c11b36812`；2026-10-01T11:26:56.467257Z（Brisbane 21:26:56）切换 Gallery、Show1 与新数据包。三个大场景响应在 VPS 下载时反复截断 / SHA 不匹配，改为 60 个 1MiB 内容哈希块经 8 条独立 SFTP 连接传输；逐块与拼接全文件 SHA256 通过后才安装。失败下载从未进入正式发布目录。
- 规范字节使用 `core.autocrlf=false` 的干净 Git export，避免 Windows CRLF 转换破坏原作指纹。所有 2366 个数据文件与 Git blob 字节完全一致。Gallery 2417 文件与 Show1 820 文件精确集合 / SHA256 通过；总入口产物与现网 1 文件相同，未重复切换。切换时再次确认 live 与部署前盘点一致。
- 新数据 schema 1、sourceDirty false、20 题 / 182 件；39 个展示模型、205 个注册模型、14 个 Harness；providers 官方 77 / 非官方 1 / 未填 104，Harness 版本字段为 0。Gallery 与 API catalogDigest 同为 `ee927cc83ceb774170a86e33bfa6b66453a8c50957329eb4f01a0584b2311ae3`。后端 catalog 观察 current 的 realpath 和不可变来源标记，切包后自动刷新，无需为数据另重启。
- 本仓收尾提交仅包含 datapack pin 和文档，将正式源码同步该 main 后继；运行完整 SHA 由 `.server-version` / bootstrap 与远端证据 `final-server-version` 确认。静态源 SHA 保持上述功能提交，文档后继不需重建。

## 验证

- 后端 Windows Node 24.16.0：check 74 文件 / 0 错，test 184/184；正式 VPS Node 22.23.2 对同一干净 LF 源码 check / test 184/184 通过。功能提交 CI 36846794933 成功；收尾文档 / pin 提交的 CI 状态以 Actions 为准。
- Gallery check 43/0、test 14/14、干净 build 182 件 / 57 个 site 文件、严格 intake 0 错 / 9 条既有提示、独立库真实跨仓 integration smoke 通过；CI 36849396485 成功。
- 数据 check 30/0、test 16/16、build:data 20 题 / 182 件、严格 intake 0 错 / 9 条既有提示。主站 typecheck、lint、check:game、check:theme、build、build:portal 及对应 Gallery 源码的 check-portal-entry 均通过。
- 停服务后 VACUUM INTO 一致性 v24 SQLite 备份，integrity_check ok；后端启动迁移至 v25，立即切换前后各表记录数全部相同。最终只读复核 v25 / integrity ok，users 27、works 268、votes 0、questions 5、comments 16、reactions 56、matches 3；正常浏览产生的访问记录不作为“始终不变”承诺。
- 服务 `arenaofbias-server` 与 `arenaofbias-moderation-tunnel` active；公开 bootstrap 的 capture / contentModeration / autoModeration 均 true，providers 为 official / unofficial。未改 systemd 环境或 Nginx；`nginx -t` 通过。
- 三个公网 HTTPS 首页 200；Gallery 显示 182 份解答，纸面玩法首页、登录注册入口、25 题提示词库及 SVG 封面正常，总入口到两个站点链接正确。Browser 控制台 error 0；Gallery/API 的 `.datapack-source.json`、`build-info.json`、`posters.json` 均 404。实际窗口 609px，无横向溢出；viewport override 未生效，不宣称精确窄屏验收。

## 明确没做

未创建生产测试账号、投稿、投票、清理业务记录或触发真实 Luna 付费审核；没有逐件浏览全部 182 件作品，没有精确移动设备 / 真机验收。不恢复旧公开 Pages，不改变服务器凭据、环境或 Nginx。不改已发布数据库迁移，不改生成物内容或原作指纹，不清理他人未提交文件。

## 遗留物

- 远端 `/root/aob-final-release-20261001/backup/`：一致性 v24 `platform.db`、旧 `code.tar.gz`、原 server-version / datapack-current / database-before.json。父目录保存 database-after-server.json、database-final.json、bootstrap、三个目标 manifest、release-verification.json、static-switched-at 与最终版本证据。
- `/www/wwwroot/gallery.prev`、`show1-dist.prev` 保存本轮之前的现场完整目录，包括旧 Gallery 的 app/ui 备份；既有 `.prev` 改名为 `.prev.bak-<UTC>` 后保留。旧数据 `39a2fa43b25488b09069644fdcd6df50adc06dc0` 保留，未 prune；历史有效 matches 可继续引用旧版本。
- 本地各仓忽略的 output 保存规范导出、构建、哈希和浏览器证据；部署工具仅使用本地忽略目录的 Python/Paramiko，不引入服务器 npm 依赖，也不保存密码或 GitHub token。

## 下一步建议

后续发布继续现场审计、main 祖先检查、完整 manifest 校验并固定不可变内容包。回退先保留当前数据库与新写入，恢复匹配的前端 / pin / 后端代码；v25 库不能直接让仅支持 v24 的旧代码读取。若必须完整降级数据库，先停止写入并单独确认数据恢复范围，不自动覆盖现库。当前没有必要再合并开放 PR 或删除含历史证据的 worktree。
