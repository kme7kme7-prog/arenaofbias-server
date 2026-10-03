# 2026-10-03 · MiniMax 787 盲评加载与错误重试修复 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex 主代理；未使用子代理。

## 本轮目标与改动

用户要求修复已排查的 MiniMax M3.1 Max 787 盲评加载失败。原作默认选择 npmmirror，但独立作品域的 CSP 未放行；原作错误层的换源按钮又被控件折叠隐藏。

默认 CDN 加入 registry.npmmirror.com，限制为已核对过的 Three.js 0.170.0 `/three/0.170.0/files/`。server/config.mjs 维护固定路径，content.mjs、capture.mjs、inspect.mjs 分别按同一路径控制 CSP、截图请求与上传提示。其他包和版本仍拦截，显式环境名单仍覆盖默认值。server/fold.js 保留 #err、#error、role=alert|alertdialog 内的按钮。

在既有测试中核对真实内容 HTTP 响应的路径 CSP、截图请求的允许/拒绝、上传提示；新增一个真实错误层结构的折叠回归。README 与 API 契约同步。以上本轮文件与本归档随单条英文提交保存，根 HANDOFF 的既有混合记录留在本地。

## 验证

- 后端 `npm run check`：86 文件 / 0 错；`npm test`：261 / 261，通过且无失败、取消或跳过；`git diff --check`：通过。
- Gallery `npm run check`：52 文件 / 0 错；`npm test`：19 / 19；`npm run build`：176 作品 / 62 site 文件；`CI=1 npm run check:intake`：0 错 / 8 既有提示。Gallery 无功能源码改动，构建仅更新本地生成物。
- Browser：本地调用现有 createContentHandler，读取未修改的缓存原作并使用合成盲评 m key，不连接业务数据库。默认桌面下，默认 npmmirror 映射保留，canvas1280×720、FPS 更新、错误层与加载层隐藏、普通面板仍折叠，截图目视飞机正常。移除该源模拟失败，三个换源按钮均可见，点击 unpkg 后正常渲染。
- 实际390×844宽度下，错误按钮可见、无横向溢出，点击 unpkg 恢复；新 origin 的默认 npmmirror 也正常渲染。首次等待加载层隐藏曾超时，后续 DOM 确认 canvas390×844 / FPS135、错误层隐藏、加载层 display:none，截图确认。手机普通面板由已有覆盖面积保护保留，本轮没有调整该行为或原作取景。
- 未执行真机、Safari/Firefox、全部作品交互、生产对局、真实账号/投稿/投票或自动截图浏览器；截图网络规则由现有路由守卫测试验证。

## 决策、明确没做与遗留物

只放行固定版本路径，保留作品 origin 隔离和现有其他策略。未修改作品原始源码、数据包、pin、数据库、Gallery 或另一前端功能，未 push/部署。原作的失败文案仍保留，成功默认加载已消除本次误报触发条件。

开工前 HANDOFF、datapack.json、他轮归档的修改和未跟踪文档原样保留，不纳入功能提交。临时验证服务和页面已关闭，浏览器尺寸已恢复。生成截图在 Gallery 忽略目录 `output/boeing-cdn-repair-20261003/`。

## 下一步建议

发布本轮独立后端修复并重启服务。若生产显式设置 CONTENT_CDN_ALLOWLIST，同步加入 registry.npmmirror.com；保持其他配置和数据库不变。上线后以新的盲评对局核对默认加载及失败重试。
