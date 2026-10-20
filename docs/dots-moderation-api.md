# dots 内容审核 API

给 dots 用的接口。每个令牌单独配置权限（scope），只能用下面列出的接口；令牌访问其他任何 `/api/` 接口一律 403。

| scope | 能做什么 | 接口 |
|---|---|---|
| `moderation` | 列待审队列、看作品内容和截图、通过、打回（必须写理由） | `/api/dots/moderation/*` |
| `capture:read` | 只读列出截图失败或没有封面的作品 | `GET /api/dots/captures/failed` |
| `cover:write` | 给作品上传或替换封面 | `PUT /api/dots/works/:task/:id/cover` |

缺某项权限时返回 `403 {"code":"scope_required"}`。权限由运维逐项开关，去掉某项或整个令牌作废都在下一个请求生效。

站点：`https://<API 域名>`（与管理端同一 API 域名）。下文 `$TOKEN` 是运维发给你的令牌，形如 `aobd_<12 位 id>_<43 位随机串>`；文中的示例全是假的。

## 鉴权

每个请求带：

```
Authorization: Bearer $TOKEN
```

- 不需要 Cookie，也不需要 `Origin`。Cookie 不能打开 dots 接口；令牌也不能打开别的接口。
- 服务器只存令牌的 SHA-256，比较用常量时间；令牌不会写进日志或审计。丢了只能吊销后重发。
- 缺令牌、令牌错误或已吊销：`401`，带 `WWW-Authenticate: Bearer`。吊销立即生效。
- 用这个令牌访问 `/api/dots/` 以外的接口：`403 {"code":"token_forbidden"}`。
- 运维紧急开关：整个 dots 接口关闭时返回 `503 {"code":"dots_disabled"}`；某项能力关闭时返回 `503 {"code":"scope_disabled"}`。

## 队列里有什么

| 阶段 `stage` | 何时出现 | 何时消失 |
|---|---|---|
| `dots` | 模式为 `dots` 时的新投稿，待审（`pending`） | 有人做出决定；或超过截止时间（默认入队后 30 分钟），转回机器审核 |
| `review-only` | 模式为 `dots-review-only` 时，机器审核判为“需人工”的新投稿 | 有人做出决定；或超过截止时间，留在普通人工队列 |

模式切换前已经在队列里的作品不会出现在这里，照旧走原来的流程。

## 接口

### 1. 列队列 `GET /api/dots/moderation/queue`

```bash
curl -sS https://<API 域名>/api/dots/moderation/queue -H "Authorization: Bearer $TOKEN"
```

```json
{
  "mode": "dots",
  "timeoutMs": 1800000,
  "items": [
    {
      "task": "one", "id": "up-abc123", "stage": "dots",
      "title": "作品标题", "summary": "简介", "note": "作者说明",
      "model": "模型名", "vendor": "厂商", "effort": "Default", "tool": "工具",
      "generationMode": "single-turn", "humanIntervention": "none", "author": "作者名",
      "submittedAt": "2026-10-21T03:00:00.000Z", "queuedAt": "2026-10-21T03:00:00.000Z",
      "deadline": "2026-10-21T03:30:00.000Z",
      "machine": null,
      "entry": "index.html",
      "version": "r-xxxx.1792551600000",
      "url": "/api/dots/moderation/works/one/up-abc123"
    }
  ]
}
```

按 `queuedAt` 从早到晚排。`review-only` 条目的 `machine` 是机器的意见：`{"reason": "...", "categories": [], "error": null, "signals": []}`。`deadline` 之后条目不再出现，也不能再决定。

### 2. 看作品 `GET /api/dots/moderation/works/:task/:id`

```bash
curl -sS https://<API 域名>/api/dots/moderation/works/one/up-abc123 -H "Authorization: Bearer $TOKEN"
```

```json
{
  "work": {
    "task": "one", "id": "up-abc123", "stage": "dots", "...": "同队列条目",
    "files": [{ "path": "index.html", "bytes": 1234 }, { "path": "assets/app.js", "bytes": 5678 }],
    "images": [
      { "name": "first.jpg", "url": "/api/dots/moderation/works/one/up-abc123/images/first.jpg" },
      { "name": "mobile.jpg", "url": "/api/dots/moderation/works/one/up-abc123/images/mobile.jpg" }
    ]
  }
}
```

只有当前在队列里的作品能看，其他返回 404。`files` 最多列 2000 个。截图在投稿后由截图服务生成，刚进队列时可能还没有，稍后再取。

### 3. 截图 `GET /api/dots/moderation/works/:task/:id/images/:name`

返回图片本身（`first.jpg` 桌面首屏、`mobile.jpg` 手机首屏、`*-late.jpg` 延迟截图、封面）。

### 4. 原始文件 `GET /api/dots/moderation/works/:task/:id/file?path=<相对路径>`

返回上传包里的某个文件，固定 `application/octet-stream`、`attachment`，不在 API 域名上渲染。路径限制在作品目录内，越界返回 404。

### 5. 通过 `POST /api/dots/moderation/works/:task/:id/approve`

```bash
curl -sS -X POST https://<API 域名>/api/dots/moderation/works/one/up-abc123/approve \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"内容正常"}'
```

`reason` 可选，默认“dots 审核通过”，最长 500 字。建议同时带上查看时拿到的 `version`：`{"reason":"内容正常","version":"r-xxxx.1792551600000"}`。作者在你查看之后改过作品时返回 `409 {"code":"stale"}`，不会把没看过的新版本放出去。

### 6. 打回 `POST /api/dots/moderation/works/:task/:id/reject`

```bash
curl -sS -X POST https://<API 域名>/api/dots/moderation/works/one/up-abc123/reject \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"页面含有不当内容"}'
```

`reason` 必填，空或只有空白返回 `400 {"code":"reason_required"}`，最长 500 字。`version` 同上，可选但建议带。打回理由作者能看到，请写清楚。

dots 的“通过”和机器自动通过一样：作品对作者和管理员可见，公开展示仍要管理员的来源核验或人工通过，不会因为 dots 通过直接公开。

通过和打回的成功返回：

```json
{ "applied": true, "status": "approved", "task": "one", "id": "up-abc123" }
```

同一个决定重复提交返回 `{"applied": false, ...}`，不会重复生效。

### 7. 截图失败 / 无封面列表 `GET /api/dots/captures/failed?limit=50&cursor=...`（`capture:read`）

```bash
curl -sS "https://<API 域名>/api/dots/captures/failed?limit=50" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "items": [
    {
      "task": "one", "id": "up-abc123", "title": "作品标题", "status": "review",
      "reasons": ["capture_incomplete", "no_cover"], "hasCover": false,
      "screenshots": { "first": false, "mobile": true },
      "submittedAt": "2026-10-20T10:00:00.000Z"
    }
  ],
  "nextCursor": "MTc5MjU1MTYwMDAwMDp1cC1hYmMxMjM"
}
```

- 范围：内容审核记为 `capture_incomplete`（截图不完整），或没有封面的上传作品。按投稿时间从早到晚。
- `limit` 1–100，默认 50。`nextCursor` 不为 null 时把它原样作为下一页的 `cursor`；为 null 表示到底了。cursor 无效返回 `400 invalid_cursor`。
- 只返回上面这些字段：没有作者、备注、邮箱、文件或 IP。`status` 是内容审核状态（pending / review / approved / rejected / legacy）。

### 8. 上传或替换封面 `PUT /api/dots/works/:task/:id/cover`（`cover:write`）

请求体就是图片本身：

```bash
curl -sS -X PUT https://<API 域名>/api/dots/works/one/up-abc123/cover \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @cover.webp
```

```json
{ "task": "one", "id": "up-abc123", "historyId": 12,
  "cover": "media/up-abc123/cover-mgz3k1a2b3c4d5e6.webp", "previous": "media/up-abc123/cover.png",
  "type": "image/webp", "width": 1200, "height": 630 }
```

- 类型按文件内容（magic bytes）判断，`Content-Type` 随便填都不影响。只接受 PNG、JPEG、WebP；SVG、GIF 等返回 `415 unsupported_type`。
- 大小不超过 3 MB（`413`），宽高都在 64–4096 像素之间且不超过 1677 万像素（`422 bad_dimensions`），空请求体 `400 invalid_image`。
- 只改封面。作品文件、模型和其他标签都不会被改，这个接口也不接受这些字段。
- 每次上传换一个新文件名，旧封面文件保留，当前截图另存一份；公开页和目录缓存立即更新。
- 不影响审核状态：换封面不会通过或打回作品，未公开的作品换了封面也仍未公开。
- 截图服务以后重新截图只会更新截图，不会覆盖这里上传的封面（封面优先级：人工/dots 上传 > 自动流程，自动流程从不写封面）。
- 并发上传同一作品时后到的可能返回 `409 conflict`，重新上传即可；成功的每一次都按顺序记录。
- 回滚由管理员在后台或运维脚本完成，dots 没有回滚权限；要撤销自己传错的封面，直接再传一张正确的，或请管理员回滚。

## 状态码

| 状态码 | `code` | 含义 |
|---|---|---|
| 200 | — | 成功 |
| 400 | `reason_required` / `invalid_path` / — | 打回缺理由、缺 path、请求体不是 JSON 对象 |
| 401 | `unauthorized` | 缺令牌、令牌错或已吊销 |
| 403 | `token_forbidden` | 用令牌访问了 dots 以外的接口 |
| 403 | `scope_required` | 令牌没有这项权限 |
| 422 | `bad_dimensions` | 封面尺寸不在允许范围 |
| 503 | `dots_disabled` / `scope_disabled` | 运维临时关闭了整个 dots 接口或这项能力 |
| 404 | `not_found` | 接口不存在，或作品不在 dots 队列里 |
| 405 | `method_not_allowed` | 方法不对 |
| 409 | `not_in_queue` | 作品已经被别人（机器、管理员）决定，或已超时转走；返回体 `current.status` 是当前状态 |
| 409 | `stale` | 带的 `version` 不是当前版本：作者改过作品，重新查看 |
| 409 | `conflict` | 决定时作品刚好被修改，重新取队列再试 |
| 413 / 415 | — / `too_large` / `unsupported_type` | 请求体太大（审核 8 KiB，封面 3 MB）/ 审核请求不是 `application/json`，或封面不是 PNG/JPEG/WebP |
| 429 | `rate_limited` | 限流，看 `Retry-After` 头或 `retryAfter` 字段（秒） |

错误返回体：`{"error": "中文说明", "code": "..."}`。

## 限流

- 每个令牌每分钟 120 次（运维可用 `DOTS_REQUESTS_PER_MIN` 调整）。
- 同一 IP 鉴权失败每分钟 20 次。

建议每 30–60 秒拉一次队列，不要更频繁。

## 超时转交

- 截止时间从入队时间（存在数据库里）算，默认 30 分钟（`DOTS_REVIEW_TIMEOUT_MS`）。服务重启不重新计时。
- `dots` 模式：超时后作品交给机器审核（结果里记 `fallback: "dots-timeout"`）。机器开始审之后、写结果之前，dots 仍可决定，谁先写入算谁的。
- `dots-review-only` 模式：作品在 dots 队列期间一直也在管理员的人工队列里，管理员可以随时处理。超时后只是从 dots 队列消失，留给人工，不会再交给机器（机器已经审过一次，结论就是“需要人看”）。

## 幂等与并发

- 写入是条件更新：只有作品仍处于你看到的待审状态时才会生效。dots、机器、管理员同时决定时，第一个写入的生效，后面的返回 409 `not_in_queue`，不会覆盖。
- 同一个决定重复提交返回 200 `applied: false`。网络超时后可以放心重试同一请求。
- 作者在审核期间改了送审信息时，作品会以新版本重新排队（`version` 改变）。带了旧 `version` 的决定返回 409 `stale`，请重新查看。

## 审计

每个通过鉴权的请求都会记录：令牌 id 和标签、动作（list / view / view-image / view-file / approve / reject / list-capture-gaps / cover-replace）、作品、理由、时间、IP、结果。作品的审核记录里决定人显示为 `dots:<令牌标签>`。
