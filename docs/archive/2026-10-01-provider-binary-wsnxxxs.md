# 2026-10-01 · 服务商仅官方 / 非官方 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex desktop；后端、后台、数据仓子代理为 GPT-6.1 Sol（medium）

## 本轮目标

对齐 Gallery 本轮契约：服务商只为 official / unofficial，未填为 null，Harness 不变；同步私有数据仓。用户授权完成功能后使用英文简单句提交，当前任务仅本地修改、验证与提交。

## 改动

- 后端基线 main@2448803。catalog 固定官方 / 非官方两项 listed:true，不依赖旧数据包的 providers 登记表；bootstrap 新增 providers。读取旧包中的其他 ID 或 providerName 时归为非官方。
- 上传、作者 PATCH 与管理员审核只接受两项 providerId 或 null/空串。上传/审核沿用未知字段忽略策略，不存 providerOther/providerName；PATCH 与管理员 meta 按既有未知字段规则 400。管理员上传与收件箱登记去掉 providerOther 参数透传。
- 公开、我的作品、审核列表去 providerName；内部 providerOther 及收录导出的兼容字段保持空串。后台服务商下拉和筛选只剩未注明/官方/非官方，手填和相似名称逻辑只对 Harness 保留。
- db.mjs 仅在 MIGRATIONS 末尾追加 v25：official 优先保留，其他非空 provider_id 或 provider_other 转 unofficial，未填保持 null，统一清空 provider_other。迁移可重复执行，保留其他元数据和时间戳。
- 排行榜读取旧票快照及更正时归并旧服务商 ID，原始持久快照不重写；两侧都符合筛选才计入，filters 回显、unset 与计分维度保持。
- provenance 测试覆盖两个合法值、空值、非法 ID/类型、未知字段策略、v24→v25 及重复执行、旧包、bootstrap/我的作品/审核输出、非官方与 unset 计票。邮箱幂等测试固定调用 v24，避免追加迁移后检查了错误迁移。README、API 契约和 HANDOFF 同步。
- 数据仓提交 0f68eca（Normalize provider sources.）：登记表保留停用历史 ID，但公开构建仅两项；唯一 third-party 源码引用改 unofficial，构建/收录工具归并旧名称。实际 182 件为 77 官方、1 非官方、104 未填；Harness 与原作保持。

## 验证

- Windows Node 24.16.0，npm run check：73 文件 / 0 错误。
- npm test：175/175，0 失败/取消/跳过。预期邮件、数据库故障注入日志由断言验证，不是测试失败。
- 来源定向测试：7/7；补充实际 GET /api/me 输出断言后再次通过。
- 首轮定向测试 5/7：新 v24 夹具引用已删除的 model_name，且原审计断言因新增作者 PATCH 读取到更早 meta 行；修正夹具与审计断言后全过。
- 后台 node --check、内存表单函数检查通过：旧值归类、三项下拉、providerId 请求与清空、Harness 名称匹配。git diff --check 通过。
- 数据仓 check 30/0、test 16/16、check:intake 182 件/0 错/9 既有提示、完整 build:data 182 件/20 题通过。后端直接读取该开发包，核对两项 provider 及 77/1/104 作品分类通过；开发包 sourceDirty:true。

## 明确没做

未 push、部署、生产写库、发布不可变包、切换后端本地数据包或更新消费者 pin；未修改 Gallery/Show1 源码、生成物或新增依赖。未运行生产 Node 22、真实 Gallery 浏览器联调、后台视觉、真实内容审核或截图服务；本轮来源元数据和表单以 API/函数验证为主。

## 遗留物

接手时后端及数据仓工作区干净；没有改删他人文件。本轮数据仓既有 build 脚本更新忽略的 dist，未手改或提交。原后端 .data、dist、.datapack 和输出目录保留。

## 下一步建议

发布时先部署后端并完成 v25 迁移，再启用 Gallery 当前二值写入与榜单筛选。更新数据包时按不可变产物流程更新 pin；catalog 自动观察目录 realpath 与版本，代码发布仍需重启服务。不要直接覆盖现有生成物或把本地开发包当正式发布包。
