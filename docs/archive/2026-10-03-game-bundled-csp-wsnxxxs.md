# 2026-10-03 · 游戏内置作品同源嵌入 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6.1 Sol / high / Codex

## 本轮目标

修复公网联调实际发现的游戏题库封面及历史内置作品 iframe 被 CSP 拦截。

## 改动

- 现有 $aob_frontend_csp host / $uri map 对 game.arenaofbias.icu/art/pelican-cover.html 精确路径及 game /works/ 目录追加 frame-ancestors 'self'；$uri 不含 query，版本参数仍命中封面例外。
- 保留 Gallery 路径例外、game 顶层 frame-ancestors 'none'、API 与上传作品域原策略、前端 sandbox；不泛化其他 art 路径。
- docs/deploy.md 同步例外及发布验收要求。

## 验证

- npm run check：86 文件 / 0 错。
- 完整 npm test：259 / 259，0 失败 / 取消 / 跳过。
- git diff --check 通过；无 JS 变更，不新增实现镜像测试。
- Nginx 实配语法与响应头、实际 iframe 由父代理现场验证，当前未宣称该配置已部署。

## 明确没做

未更改前端、业务代码、数据库、数据包、作品文件、iframe sandbox 或其他 host CSP；未执行现场 reload。

## 遗留物

本轮前的脏 HANDOFF、integration / coordinated / pool 归档、本地 datapack.json 和未跟踪归档保留，未入提交。测试输出保存在忽略目录 output/server-integration-20261003/test-game-csp.log。

## 下一步建议

父代理部署固定 main 配置后 Nginx -t / reload，核对游戏顶层 none、封面及 /works/ self，目视题库及历史预览渲染；通过后在本归档补记结果。
