# 2026-10-05 · Correct uploaded model attribution in rankings · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6.1 Sol / medium，Codex desktop

## 本轮目标

修复投稿错误模型名更正后旧名仍在排名的问题；保留正式原票、原始快照及待决对局，不隐藏榜行或清空票。

## 改动

- 根因：POST /api/admin/works/:task/:id/meta 与 review 已刷新arena缓存，但排行读取votes原始a/b_identity或显式correction；作品当前声明更正没有写历史correction，所以旧计分key继续得分。
- library.setMeta/review在既有事务内，对管理员修改数据库投稿模型/厂商/档位、同一作品且digest一致的arena历史票写correction并逐側审计；仅替换modelId/modelName/vendor/effort及派生key，来源与其他快照字段保留。普通作者编辑、标题/摘要改动、包display overlay、legacy/Show1票保持既有规则。
- 既有未决定match不失效；vote保存原始match快照后，若同内容投稿当前模型/档位已改，单侧写correction与审计，按当前归属计票并揭晓。不存在整批清理，无数据库迁移。
- 新增离线correct-upload-attribution脚本，默认只读dry-run；显式task/work/旧名/新注册model/digest/expected/actor边界。当前verified未删作品、原始id/task/modelId null/旧名/digest/effort均须匹配；apply需新backup并VACUUM INTO后事务更新correction及逐项审计，外键检查失败回滚。不实例化平台、HTTP或后台业务。

## 验证

- Node24.16.0，npm run check108文件/0错；npm test317/317，0失败/取消/跳过；git diff --check通过。
- 新真实HTTP/SQLite回归覆盖历史票转移且原identity/choice/source不变、旧榜行消失、待决对局继续计票且不再产生旧名、标题编辑不触发、review档位同步更正。
- 父代理只读生产证据：tengwang-pavilion/up-3mm5847a原提交GPT6.1·Max，管理员meta后当前gpt-6.1-sol/Max；6条arena票仍旧身份无correction。六侧digest与当前上传完全一致；harness codex/provider official/单轮/无人改保持。对应meta audit1246，原submit1172、verified1197。生产备份及离线实证由父代理持有，不提交业务记录。

## 明确没做

本代理没有生产写库、SSH、部署、历史清票、包来源ID更改；离线6票dry-run/副本apply/真实备份核对及发布由父代理执行。不能把源码测试称为生产修复已完成。

## 遗留物

输出日志忽略目录output/upload-attribution-20261005-test.log；本仓原先工作区干净，其他worktree遗留不改。

## 下一步建议

以最终SHA部署，数据库仍v40。生产停服一致备份后，按明确作品与digest先dry-run断言6侧、在副本apply核对原票/旧列/原snapshot完全保持，再由父代理执行正式定点更正并重启刷新缓存；上线后验证GPT6.1旧行消失且gpt-6.1-sol获得对应6票。
