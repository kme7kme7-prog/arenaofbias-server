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
