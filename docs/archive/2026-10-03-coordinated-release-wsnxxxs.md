# 2026-10-03 · 四仓协调发布 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop

## 本轮目标

按用户要求联调部署四仓现有改动，适配上游与本地冲突。

## 改动

合入 origin/main 的收件箱、共用编辑、双面核验章、后台审核跳转与 Gallery CSP 修复，保留贴纸、模型厂商与注入审核功能。保持已上线迁移 v1–v34，贴纸清空顺延 v35，model_vendor 为 v36；固定 v34 / v32 的测试索引。

新增 scripts/reconcile-catalog.mjs：默认只读 dry-run；停服后按新包登记名/别名唯一匹配自定义投稿，清空 model_other/model_vendor；仅给旧空档位馆藏票写入补齐更正，并处理未结束对局。原始投票身份保持，变更进入 audit；退休馆藏仍有业务引用时拒绝，只有 work_overrides 开关的历史记录保留为休眠行。

数据包固定 389199bd8f555b1115b1f0009532974a23eb2227，来源 d82a8719c13668f983f0efb66279cd7503286645，CI 37048464853 成功；Gallery 同包。

## 验证

源码 check 88/0、test 251/251。现场后端 2915a49 的 server/admin 全部规范化 LF 哈希与已合并提交一致；已上线 CSP hash cdadd621 保持。生产 v34 备份副本迁移至 v36：users 31、works 353、votes 364、comments 16、questions 14 保留，原始票面与用户/评论/题目逐行哈希一致；仅按此前已确认贴纸迁移将 62 条旧 reactions 清零。16 件模型注册映射、251 个投票侧更正、0 个未结束对局侧；连续执行第二次为零变更，audit 与数据库内容不变，integrity ok。

Linux 完整检查、固定源码真实联调、生产部署及验收尚待执行，完成后追加实际结果。

## 明确没做

不修改既有原始票面，不回填旧 note 中厂商，不修改 CAPTCHA/SMTP/角色或 game /api 反代，不部署截图降权基础设施，不执行真实外部审核测试调用。

## 遗留物

合并前工作树 stash 保留；output 与服务器 /root/aob-coordinated-release-20261003 保存证据和备份，生成物不提交；其他工作树未改。

## 下一步建议

完成固定源码与数据包联调，备份并停服，协调切换、核对业务保留和公网页面。

## 完成追加（2026-10-03）

a280874f3f063f3fbacfba386460e53e81709893 已推送 origin/main；2026-10-02T19:00:25Z（Brisbane 10-03 05:00:25）协调上线。Gallery e0e980b、竞技场 48b0871、新包 389199bd8f555b1115b1f0009532974a23eb2227，数据源码 d82a871 / CI 37048464853；catalogDigest 31bed22d1a8987cb6c23d04ec27e9641dc335004ee7e01cbc9b7b26acb3a1bd5。发布来源均在 origin/main。

首次 Windows git archive 使用默认 core.autocrlf，Linux shell 测试因 pipefail 后的 CR 失败（250/251）；改用 git -c core.autocrlf=false archive 导出三个固定源码，不改源文件，重建前端并完整复验 Linux check 88/0、test 251/251。固定 LF 真实 integration-smoke 与双站 Edge 隔离会话 8 项通过；生产不执行真实账号 / 评论 / 盲投测试写入。

停服后备份，安装源码与包，再迁移 v34→v36 和身份更正；切换前完整静态清单 / 哈希核对，普通目录复制未用硬链接。生产 users 31、works 353、votes 364、matches 366、comments 16、questions 14 保留；用户 / 原始票面 / 评论 / 题目逐行哈希一致，无已投票或未过期对局丢失，配置比较仍 364。仅已确认贴纸迁移清空 62 条 reactions。16 件模型映射、251 个投票侧 correction、0 个未结束对局侧，第二次 dry-run 零变更，integrity ok。退休馆藏仅有的 work_overrides 历史行保留。

Nginx -t 前后通过，CSP 文件哈希 cdadd621 保持；后端与 arenaofbias-moderation-tunnel active。服务启动首个健康请求短暂拒绝连接，下一次成功，后续公网检查通过。公网版本 / 目录 / 模型数 / 贴纸、双前端 CORS 与预检、三个作品路径 framing、安全头、私有路径 404、旧 game API 代理、桌面 / 手机页面和 Claude 黑洞 canvas 通过。没有修改 DNS、角色、凭据、SMTP、CAPTCHA 或截图服务基础设施；真实外部审核调用未验收。

备份 /root/aob-coordinated-release-20261003/backup 包含切换前 / 后库、源码、版本 / 包指针、Nginx 与原旧目录；上一版本前端在 show1-dist.prev / gallery.prev。证据 output/coordinated-release-20261003，含 reconciliation-production.json、db-preservation.json、evidence/production-readonly.json 与截图。回退不得以旧库覆盖上线后新写入；旧数据注册表与更正需协调处理。stash、其他工作树及生成物保留；完成结果本地追加，不改写已推送历史或另建第二条提交。
