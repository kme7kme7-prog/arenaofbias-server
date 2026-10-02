# 2026-10-02 · 固定数据包与发布联调 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex desktop

## 本轮目标

用户已授权四仓整理、提交、推送、部署，并要求联调。本阶段固定 CI 发布的数据包，完成生产切换前的验证。

## 改动

datapack.json 从旧产物固定到不可变产物 9356c7057c9898ace07cc86d6d8a852d5f7eeb75，来源 623bfebc33e51aca36f8c4d3a83a3bcf0a616da3。Gallery 的忽略配置同步；两端不自动追随后续文档提交产生的包。本阶段没有业务代码修改。

## 验证

- 数据仓 CI 36988885817 成功。数据 check 34/0、test 16/16、intake 182 件 / 0 错误 / 10 警告。
- 后端 e70ba13 的干净 LF 源码：Windows check 87/0、test 244/244；服务器 Node 22.23.2 check 87/0、test 244/244。
- Gallery 固定源码 3e441a3、Show1 固定源码 22bb6b3 均生产构建成功；Gallery intake 182 件 / 0 错误 / 10 警告。真实后端 integration-smoke 通过，含注册、投稿、审核、内容资源、盲评投票与版本不一致处理。
- Edge 隔离联调 8 项通过：game UI 登录；已打开 Gallery 的账号控件更新；Secure / HttpOnly / Lax 会话 Cookie 只在 api 主机；带凭据的跨主机评论和有效盲评票；同账号 focus / visible / persisted pageshow 不额外拉 bootstrap；Gallery 登出后 game 焦点刷新；Gallery 登录后 game 焦点刷新；管理端登录。使用临时 SQLite、临时账号及本机一次性 Turnstile 校验桩，没有生产写入。页面异常 0。
- 初次混用 Windows 工作树与 LF 导出时，共享脚本字节断言因 CRLF 失败；统一隔离 LF 导出后通过。Gallery 数据目录 junction 被 cpSync 当作链接复制导致 EEXIST；改为隔离目录的实际副本后构建通过。浏览器夹具的 Cookie 容器、响应后控件等待、窄屏导航及管理端 /admin/ 路径已纠正；投票夹具按现行规则启用临时盲评开关并绑定测试邮箱，最终完整通过。没有据此修改业务代码或既有测试。
- 按现场五个配置的原始哈希生成 Nginx 候选，在服务器隔离配置通过 nginx -t；正式配置尚未切换。只读版本门禁仍为本人记录的 83e43fe；后续正式结果另记发布归档。

## 明确没做

本阶段没有部署、迁移业务库、真实密码登录、SMTP / 自动审核或生产投票评论。game /api 反代和 game 的 CORS 来源保留。截图服务的独立降权基础设施不自动启用。没有修改 Cookie 属性、安装 npm 依赖或改生产账号角色。

## 遗留物

忽略的 output/four-repo-release-20261002 保存干净源码、候选配置、完整 manifest 与联调证据；服务器 /root/aob-shared-session-release-20261002 是本轮受限暂存目录。没有保存登录密码或 GitHub token。大数据包仍在传输，线上服务运行。

## 下一步建议

完整文件集合和 SHA-256 通过后，备份源码、数据指针、SQLite 与 Nginx，再进行协调切换及生产验收。真实生产登录 / Turnstile 验收需要用户浏览器配合，已询问；不会把隔离桩验证写成生产登录已通过。
