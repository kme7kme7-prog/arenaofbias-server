# 2026-10-03 · 统一发布者角色与 API v2 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex 父代理与三名 GPT-6.1 Sol / high 子代理

## 本轮目标

完成用户粘贴的后端任务：保留数据包与 SQLite 物理存储，对外统一题目、作品、操作与发布者角色，支持高级管理员 / 普通管理员 / 普通用户；同步 /admin/ 和 API 契约。仅在 arenaofbias-server 工作。

## 改动

- 数据库追加幂等 v37、三级账号角色、创建时 author_role 与题目 / 作品覆盖层。历史票 JSON、审计和退役来源列保留；旧 admin 账号保持高级。
- 工作人员发布作品跳过自动审查、human / approved、unverified，仍等核验；题目均 pending。moderator 的本人审核 / 核验 / 门面 / 校准 / 收件箱归属决定返回 403，meta 可编辑；题目管理和其余高级入口维持 admin。
- bootstrap v2 统一公开列表、author/mine、acceptsUploads/cover；去除来源身份和 arena uploads。公开署名隐藏工作人员姓名头像，管理接口提供追溯昵称；数据包资源字段由前端包提供。新投票快照省略 curated，旧 JSON 兼容读取且原样保留。
- 题目与作品包覆盖支持统一编辑、审核、撤下恢复、无票软删除；已有作品的公开提示词 / 提交格式限制沿用。评论访问跟随题目与作品可见性。数据包内容审核默认 approved，重复内容审核 / 自动重试为 409；核验使用统一 review 接口。
- 删除作品 display 路由；保留 admin/questions 创建别名并改 pending。后台发布者筛选与列、题目编辑审核、三级角色与权限同步；减少覆盖与资格读取的重复调用，修复首次空路由作品加载。docs/api-contract.md 同步。

## 验证

- npm run check：85 文件，0 错误。最终 npm test：255 tests / 255 pass / 0 fail，9 suites；日志 npm-test-complete.log。定向测试分别覆盖题目 / 迁移、作品 / 核验、路由 / 后台 API，最终全量包含全部定向用例。
- v36 隔离迁移两表各 author_role admin=2 / moderator=0 / user=1；另补 moderator 缺省回填后各 2 / 1 / 1。foreign_key_check 空、foreign_keys 恢复 ON，session 等依赖保留，votes / audit 原始行一致，curated_as / nominated_at 原值保留；再运行迁移不随作者角色变化。
- 本地只读包 20 题 / 182 作品 + 临时库公开题 1 / 核验作品 3，bootstrap 21 / 185、v2；覆盖 title / acceptsUploads / cover 和作品 title 生效，公开工作人员 name 暴露数 0。新建临时 works 三角色各 1；questions admin=1、moderator=1、user=0，moderator 题为 pending。这个数量使用同一包的旧 Gallery 合并口径，不代表生产当前包数量。
- Browser 隔离账号验收：高级管理端全部题目 22（含 pending），题目覆盖表单保存并被 bootstrap 读取，角色选项三值；普通管理员隐藏题目 / 用户 / 流量等入口，自己的作品可编辑、无审核 / 取景 / 删除入口，门面复选框 disabled；空 hash 的 /admin/ 正常加载 185 / 30。捕获 console error / warn=0；截图 admin-question-editor.png、admin-roles.png、moderator-works.png、moderator-own-editor.png 在本轮 output。
- 有过两次 listen(0) 随机使用 fetch 禁用端口的 bad port 失败，其中既有 shutdown 测试等待未到达的请求而停滞；停止该次子进程、HTTP 定向与完整套件复跑均通过。没有为偶发环境问题扩大实现或测试范围。
- protected-before.json 中排名文件与四份他轮归档 SHA256 全部一致；Show1 兼容层和回放脚本无本轮差异。HANDOFF 旧段落原样保留，仅本节加入提交。

## 明确没做

不访问生产、不部署、不 push；不修改 Gallery、另一前端、作品资源、数据仓库或消费 pin。生产 author_role 回填数量尚未获取；未做实际发布、双前端整站、SMTP、CAPTCHA、真实外部审查、所有作品交互、移动端 / 多浏览器验收。server 不提供 build / check:intake；这些消费端检查属于 Gallery 同步任务。

## 遗留物

- 用户本轮开头明确要求完成功能后英文简单句 commit：本轮仅一个本地功能提交，身份 wsnxxxs / GitHub noreply；他轮未提交与未跟踪归档不纳入。提交结果由父代理最终回复给出。
- output/unify-authorship-20261003-parent 为忽略的本地验证脚本、日志、截图与原工作区基线。隔离浏览器服务已停止，最后的工作区 fixture 已由服务正常清除。
- 较早的外部临时测试目录 C:/Users/Ryan/AppData/Local/Temp/authorship-v2-review-2Fv1oa 留存：对应 local-review 进程已停止。对这一个已验证自建目录的递归清理被自动审批以 blocked by policy 拒绝，未扩大清理或删除他人数据；不影响提交及测试。
- 接手时的 HANDOFF 未提交历史段落、两份已修改归档与两份未跟踪归档原样留在工作区；排名、回放和层级排名测试不纳入。

## 下一步建议

Gallery 按 HANDOFF 顶部 DTO / 路由清单联调，并与后端一同发布 apiVersion 2；发布轮另行获得授权、备份生产库、完成 v37 后记录真实两表 author_role 数量。本轮不执行发布。
