# 2026-09-30 · Luna Flex content moderation · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex desktop GPT-6
- 范围：共享后端、管理端和配套画廊；独立 worktree，从 server 115ac342 / gallery 85942dd6 开始。原目录他人未提交文件不改动。沿用用户完成修改后英文简单句 commit 的明确授权，身份通过 gh api user 核实；每仓一条，不推送。

## 本轮目标

确认画廊上传经共享 server API，加入文字和图片自动内容审查，疑似交人工。用户选择 GPT-6 Luna Flex，并询问便宜的接口；核对官方价格与 OpenRouter 购买积分费用后，以官方直连为默认，可配置 Responses API 根地址。

## 改动

- v19 只追加幂等 moderation JSON 列，旧作品 legacy 保持原状态。内容与来源核验分开，pending/review/rejected 不公开；人工通过不会自动核验来源。
- 内置 fetch 串行异步队列，启动恢复 pending；截图 Promise 返回两档图片/文字，采用私密预览源。送审使用严格 JSON schema、store:false、service_tier:flex；失败和不确定结果转人工，标准档无自动回退。
- 公开列表、Show1 动态池、盲评/互动、原作品内容源、封面/截图和收录导出加内容门槛。作者/管理员通过 DTO 获一小时随机 bearer 预览源；持有 URL 即可预览，不宣称预览源另有账户鉴权。
- 人工通过/拒绝及自动重试端点，后台按钮和审计；声明编辑重审，与更新/audit 同事务。以存储的审查 JSON 比较更新，避免较早响应覆盖人工决定或新版声明。
- README、接口契约与部署文档同步，源码无 npm 新依赖。送审仅声明、入口静态文字、两档实际文字、封面和两张首屏，没有完整遍历资源包或交互画面。

## 验证

- npm run check：59 文件 0 错。npm test：128/128，包括 6 项新增 HTTP 场景及既有升级回归。临时库验证 v19 重跑、旧默认状态与 quick_check；v16/v17 升级测试保持历史作品、投票、对局和审计。
- 本地假 Responses API 校验模型 ID、Flex 档、严格 schema、三张送审图和实际/静态文字，覆盖 review/rejected、429、非 Flex、incomplete、refusal、空输出。上传不等 API；匿名/其他作者不能取待审页面/媒体，作者能预览，内容通过后才公开，核验独立；管理员直传/收件箱发布不能绕过。
- 覆盖管理员权限、必填理由、人工拒绝/通过/重试，旧自动结果与编辑的竞争，以及新 worker 恢复数据库 pending 行。缺 key/截图无付费请求。
- 预配置既有 Playwright 1.63.0 + Chrome，实际生成 1440×900 和 390×844 JPEG，送到本地模拟接口，429 后 review。浏览器完成后台人工通过、前端人工拒绝和重试、手机 HTML 上传/试加载/正式提交，公开 bootstrap 随人工决定放行/撤回。前端/后台内容按钮和个人中心状态已目检，390px 无横向溢出。
- 联调初次未将管理端 origin 加入测试 SITE_ORIGINS，iframe 被 frame-ancestors 拒绝；补齐隔离配置后验证通过，没有改动生产配置或为此调整服务逻辑。前端试加载只有既有 allow/allowfullscreen 优先级警告，最终页面无新增 JS 错误。

## 决策

默认官方 Responses API 的 gpt-6-luna Flex；密钥只在服务器环境，前端不持有。不批量重审历史作品，默认开关关闭；已有待审/拒绝在关闭开关后仍受限。缺截图不会按仅文字的结果自动放行。不改变来源核验、评分和原作。

## 明确没做

真实付费 API 未测试（没有正式密钥），生产 Playwright/Chrome/域名配置未验；未连接线上、未迁移现有业务库、未更新 pin/数据仓、未 push/部署。不会把模拟审核结论描述为模型真实审查能力。

## 遗留物

output/playwright/luna-smoke-state 保存独立临时库、测试作品和请求摘要；画廊 output/playwright 保存截图，全部忽略。server worktree node_modules 测试 junction 指向既有前端依赖，不入库。原目录的他人修改保留。配套画廊归档记录构建与页面结果。

## 下一步建议

采用配套提交后在服务器受限环境配置 CONTENT_MODERATION=1、MODERATION_API_KEY、CAPTURE=1；按部署文档备份和版本门禁先后端再前端。真实 API 检查响应 Flex 与结果，再用样本校准审查规则；旧代码不理解 v19 状态，不能直接只回滚旧代码。
