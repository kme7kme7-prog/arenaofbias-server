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


## 2026-10-03 · 最终生产与公网验收完成

- 父代理提供的实际发布证据：9bf06d0abd8c5213bebb66eceab032edbf5b6c54 于 2026-10-03T11:21:38Z 上线，Nginx -t / reload 成功。game 封面精确路径和 /works/ 返回 frame-ancestors 'self'，顶层保留 'none'。
- 390px 手机及 1440px 桌面浏览器实际渲染鹈鹕示例，iframe 拒绝文案消失，无捕获 console error；此结果覆盖实际观察页面，未宣称全部作品交互验收。
- 最终部署文件集合和逐文件哈希均通过：203 tracked 源码（生产 datapack 配置单独核对）、69 runtime、包 2283 / Gallery 2337 / game 941 文件；保留的 121 个旧 game 文件不变，事件恢复后的旧包完整文件哈希继续保持。
- 24 项公网 HTTP 检查通过。API v2，后端 9bf06d0、Gallery 0a6、game b549 消费同一官方目录 digest；CORS、匿名权限、旧 game API 526 件作品 / 25 题、4 legacy 入口、fold 和内容 origin 均通过。
- systemd 服务 active / running，ExecMainStatus=0、NRestarts=0。主机 journal 不可读取，不据此宣称日志没有错误。未测试生产账号登录或提交投票，未逐件覆盖全部作品交互。
- 本补记替代上述待部署状态；只更新本轮最新 HANDOFF 节与本归档追加结果，不 commit / push，保留部署 SHA 与他人未提交材料。
