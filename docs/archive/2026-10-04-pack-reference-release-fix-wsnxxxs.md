# 2026-10-04 · 包参考图联调与 Linux 脚本修正 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6.1 Sol / Codex desktop

## 本轮目标

修复联调发现的包参考图管理页面缺失，同时解决 Linux 发布门禁发现的部署脚本 CRLF。用户通过父代理授权本轮必要修正、提交与推送，生产切换仍由父代理统一执行。

## 改动

- 旧契约明确返回空包参考图，前台题目页有包回退，但管理与审核直接读取 API，不能显示参考图。本轮更新契约：catalog 保留已验证包的图片元数据和署名，题目 DTO 返回只读包引用。
- 新 `media/pack-references/<task>/<name>` 路由只提供当前包该题声明的图片，按题目可读权限取当前包原始字节，支持 GET / HEAD、可信来源 CORS / 预检和 no-cache。未声明文件 404；撤回公开后的图仅工作人员可读。不复制包图片、不写 reference_uploads，不改变上传图权限。
- 包题目元数据允许有序 name / caption 和来源同值重发，实际更改仍返回 400 并提示在数据仓维护；客户端 id / src 不用于绑定。普通标题 / 简述编辑仍不冻结包题面。
- Linux staged 测试失败定位到 datapack-sync.sh 的 CRLF。三个 shell Git blob 原为 LF，但 Windows 的默认换行转换把旧 git archive 中脚本变成 CRLF；补 `.gitattributes` 的 `*.sh text eol=lf`，固定现有三个部署 shell 脚本的检出与归档换行，不改变脚本逻辑或数据 pin。

## 验证

- 现有包题目和真实 HTTP 测试扩展，定向 13 / 13；完整 npm run check 95 / 0、npm test 283 / 283（10.8 秒），无失败 / 取消 / 跳过。覆盖 DTO、同值保存、包切换、GET / HEAD / CORS / OPTIONS、未声明 404、撤回权限及上传表 / 文件集合不变。
- 正式包与独立合成库 HTTP 实跑：腾势 Z 五图和署名同时进入 bootstrap / admin/questions / review；五张图片 GET / HEAD 200、image/jpeg、可信来源 CORS、字节 SHA-256 均与官方包一致。公开且有真实包作品时同值保存 200，reference_uploads 仍为 0。
- 三个 Bash 脚本语法与 git diff --check 通过；提交与源码归档逐脚本核对 LF，由父代理换新固定源码后重跑 Linux 门禁。

## 明确没做

未更改数据包或 pin、生产库、生产服务、其他仓库、上传图权限或数据库版本。未宣称 Linux 重跑或所有浏览器交互通过；本仓无 build / check:intake。

## 遗留物

证据、独立合成库及 HTTP 核对脚本在忽略目录 `output/coordinated-release-20261004/pack-reference-smoke/`，完整测试日志为 `package-reference-tests.log`；没有生产身份或业务内容加入源码。

## 下一步建议

父代理必须用本轮新 SHA 和源码包替换原 dcfcd95 staged 代码，重跑 Linux 门禁和 Gallery 管理参考图联调；API vhost 保持新媒体路径代理 Node，不能静态 alias 或额外缓存其权限响应。
