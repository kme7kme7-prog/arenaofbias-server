# 2026-10-20 · WebGL 截图与截图服务断线 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok Bot
- 本文写于提交前。用户授权开 PR，未授权合并或部署。

## 本轮目标

10-20 18:00 那批重审里，WebGL / Three.js 作品大量在 goto 45 秒、screenshot 60 秒、鼠标操作 10 秒处超时，记 `capture_incomplete`。截图机没有 GPU，WebGL 走 SwiftShader 软件渲染，重启 capture 后 GPU 进程很快又回到满负荷，所以不是浏览器跑久了的问题，而是 WebGL 渲染本身慢。另外，`arenaofbias-capture` 重启时平台写五分钟冷却，排队作品立即全部转人工（17:15 一次 174 件）；超过 5MB 的入口页截完图才在送审时被拒。

## 改动

- `server/capture.mjs`
  - 新的 `frameGuard(fps)` 和伪装脚本合成一个 init script。页面调用 `getContext('webgl' | 'webgl2' | 'experimental-webgl')`（含 OffscreenCanvas）后，`requestAnimationFrame` 回调每秒最多跑 `fps` 次；提供暂停和恢复。没有 WebGL 的页面 rAF 原样透传。
  - 每个视口加载后探测各 frame 是否用了 WebGL；5 秒内不响应探测的 frame 也按 WebGL 处理。是 WebGL 时：单件总时长扩到 `webglTask`，单张截图上限用 `webglScreenshot`，截图和鼠标操作期间暂停动画帧，鼠标操作上限 ×3。
  - 导航改为 `domcontentloaded`，然后最多等 goto 上限的 `load`；Playwright 自己的 load 超时只记日志并按当前画面继续。
  - 远程端点读不到或连接失败抛 `CaptureUnavailable`，不写 `failedAt`。截图中途断线后重连失败也一样。队列保留这一件，按 `retryBase` 起翻倍、`retryMax` 封顶等待后从头重做；整次中断超过 `unavailable` 后，该件及后续作品返回 `{ unavailable: true }`，每件仍先试连一次，连上后恢复。中断开始和恢复各记一条日志。
  - `enqueue` 先看入口 HTML 大小，超过 `maxPageBytes` 不入队。导出 `entryBytes(work)`。
- `server/moderation.mjs`：截图前检查入口文件。超过上限记 `page_too_large`，文件不存在记 `page_missing`，截图服务长时间不可用记 `capture_unavailable`，都转人工。`inputFor` 原来的 5MB 判断改用同一个上限。
- `server/config.mjs`：`captureTimeoutConfig` 增加 WebGL 与重试的五个上限，新增 `captureOptionsConfig`（`CAPTURE_WEBGL_FPS`、`CAPTURE_MAX_PAGE_BYTES`）。规则同前：`0`、空值、非数字退回默认值。
- 文档：README 变量表，`docs/deploy.md` 第 6 节。
- 无数据库迁移，无 npm 依赖。`scripts/capture-browser.mjs` 和 systemd unit 没改，capture 服务不用重新部署。

| 变量 | 默认 |
| --- | --- |
| `CAPTURE_WEBGL_TASK_TIMEOUT_MS` | 300000 |
| `CAPTURE_WEBGL_SCREENSHOT_TIMEOUT_MS` | 120000 |
| `CAPTURE_WEBGL_FPS` | 8 |
| `CAPTURE_RETRY_BASE_MS` | 5000 |
| `CAPTURE_RETRY_MAX_MS` | 60000 |
| `CAPTURE_UNAVAILABLE_MAX_MS` | 1800000 |
| `CAPTURE_MAX_PAGE_BYTES` | 5242880 |

## 验证

- `npm run check`：144 个文件，0 错误。
- `node --test --test-concurrency=1 test/*.test.mjs`：408/408（这次 blind-pool 那条也过了）。
- `test/capture.test.mjs` 新增：远程端点缺失和连接失败时等待重试、不冷却、日志不含端点 token；长时间中断后返回 unavailable，恢复后继续；中途断线后等端点重新出现并重做；WebGL 页面截图上限放宽，每次截图和鼠标操作前后暂停/恢复；WebGL 扩展总时长让第二个视口能跑完；load 不触发时照常截图；frameGuard 限帧、暂停、取消；超大入口页不进队列、审核记 `page_too_large` / `page_missing` 且不调用截图；审核把 unavailable 记成 `capture_unavailable`。
- `a hung goto/screenshot fails inside the task budget` 两条单独反复跑偶尔失败（`launches.length >= 2`），未改动的 main 上同样会，是旧测试的时序问题。
- 本机真实 Chrome 155 + Playwright 1.63，`taskset -c 0` 限一个 CPU，渲染器确认是 SwiftShader，全屏重着色器约 0.5 fps：
  - 直接截图 35.0 秒；加 frameGuard 并暂停后 0.1 秒。
  - 完整 `createCapturer` 流程：改前（只限帧不暂停鼠标）两档延迟截图都在鼠标操作处超时，和线上 `截图步骤超时（input）` 一样；最终版本两件都拿到 4 张图，每件 67–78 秒。
- 未连接线上 `arenaofbias-capture`，未部署。

## 明确没做

- 不做每 N 件重建浏览器：重启后 GPU 很快又满，问题不在累积。
- 不改孤儿清理：那 5 件是人工移走的。
- 不改 capture 服务的 Chrome 启动参数，不换硬件 GPU，下面只写建议。
- 不合并，不部署。

## 遗留物

无。实验脚本在仓库外。

## 下一步建议

- 截图机加 GPU 或换带 GPU 的机器是根本解法，Chrome 用 `--use-angle=vulkan` / `--use-gl=egl` 走硬件。
- 不换硬件时可试：capture unit 的 `CPUQuota=100%` 只给 SwiftShader 一个核，放宽到 200% 效果最直接；桌面视口截图用 `deviceScaleFactor: 1` 已是最低，可再把 WebGL 页面的视口缩到 1280×800 左右；`--disable-gpu-vsync`、`--enable-unsafe-swiftshader` 的影响需实测；不建议 `--disable-webgl`，作品会白屏。
- 上线后看日志里 WebGL 作品的单件耗时，接近 300 秒再调 `CAPTURE_WEBGL_TASK_TIMEOUT_MS`。
