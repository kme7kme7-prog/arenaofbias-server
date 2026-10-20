# 2026-10-20 · 截图与审核队列超时 · kme7kme7-prog

- 负责人：kme7kme7-prog ｜ 执行 AI：Grok 4.7
- 本文写于提交前。用户授权开分支和 PR，未授权合并或部署。

## 本轮目标

截图队列和自动内容审核队列从 2026-10-20 01:11（UTC+8）起约 16 小时没有完成一件。运维判断是调用独立 capture 服务时 `browser.newContext` 没有超时，一件卡住后串行队列不再前进，审核也停。本轮给会挂住的浏览器调用和单件总时长加上限，超时后按现有失败语义结束该件并继续下一件；连接卡死或断开时重建连接。

## 改动

- `server/capture.mjs`：`createCapturer` 的 `launch`、`capture`、`close`。`newContext`、`newPage`、`goto`、`screenshot`、关闭 page/context/浏览器，以及连接或本地启动，都有上限。单件任务另有总时长。超时后视口仍按原逻辑重试一次；整件到点就停止，已拍到的公开图仍写回，缺的材料走原来的不完整失败。关闭调用本身也有上限，关不掉就丢掉该连接。`newContext` 若在超时之后才返回，返回时补关。
- 看门狗与重连：单件计时器到点会丢弃当前浏览器连接并让正在等待的那一步失败。分步超时同样丢弃连接，下一次 `initialize` 重新连接；配置了 `CAPTURE_ENDPOINT_FILE` 时重新读端点。浏览器发出 `disconnected` 时，正在进行的那一步立即失败并在重试时重连。这种丢弃不写入五分钟冷却。浏览器启动失败或独立服务连不上，仍用原来的五分钟冷却。
- `server/config.mjs`：`captureTimeoutConfig` 从环境变量读取上限。`0`、空值和非数字退回默认值。
- 审核队列没有单独再套一层时限。它原来就堵在 `capturer.enqueue`；该调用现在一定会结束，材料不齐时仍是 `capture_incomplete`，然后处理下一件。Flex 请求原有的 15 分钟中止没有改。
- 文档：README 环境变量表，`docs/deploy.md` 第 6 节。内部还有路由 15 秒、鼠标 10 秒、页面文字 45 秒，不是环境变量，受单件总时长约束。
- 无数据库迁移，无 npm 依赖。

超时参数：

| 变量 | 默认 |
| --- | --- |
| `CAPTURE_TASK_TIMEOUT_MS` | 180000 |
| `CAPTURE_NEW_CONTEXT_TIMEOUT_MS` | 45000 |
| `CAPTURE_NEW_PAGE_TIMEOUT_MS` | 30000 |
| `CAPTURE_GOTO_TIMEOUT_MS` | 45000 |
| `CAPTURE_SCREENSHOT_TIMEOUT_MS` | 60000 |
| `CAPTURE_CLOSE_TIMEOUT_MS` | 15000 |
| `CAPTURE_CONNECT_TIMEOUT_MS` | 30000 |

## 验证

- `npm run check`：142 个文件，0 错误。
- `node --test test/capture.test.mjs`：19/19。覆盖配置回退、goto/screenshot 超时传入、`newContext` 挂起后重读端点并继续下一件、迟到的 context 被关闭、导航中断开后重连、goto/screenshot 挂起时在单件总时长内失败且下一件仍运行、close 挂起后放弃并重连、审核队列把两件挂起都记为 `capture_incomplete` 后结束。
- `npm test`：398/399。失败的 1 条是 `test/blind-pool.test.mjs`「same package content follows registration and provenance changes while other works stay put」，期望厂商名 `Renamed vendor`，实际仍是 `Current vendor`。同一断言在未包含本轮改动的 main 上是 390/391；该文件单独运行 21/21。不是本轮引入的。
- 未启动真实 Chrome，未连接线上 `arenaofbias-capture`，未做浏览器验收，未部署。

## 明确没做

- 不合并，不部署，不重启线上服务，不修改生产数据库。
- 不重启 systemd 里的 capture 进程。平台只能丢掉自己的连接并重连；Chrome 进程本身卡死时，每件会在总时长内失败并转人工，但进程仍要靠服务重启恢复。
- 不缩短审核模型 15 分钟的 Flex 时限。
- 不修改已有的 3.5 秒 / 8.5 秒固定等待。
- 未处理与本轮无关的 blind-pool 全量失败。

## 遗留物

无新增生成物。超时只在假浏览器对象上验证。

## 下一步建议

合并前在隔离环境用真实 capture 服务确认一张正常截图仍能在总时长内完成，并人为挂起 `newContext` 后看下一件是否继续。若线上四张图经常接近 3 分钟，再调高 `CAPTURE_TASK_TIMEOUT_MS`。Chrome 进程卡死时仍应重启 `arenaofbias-capture`。
