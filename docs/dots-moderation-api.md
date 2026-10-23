# dots 内容审核 API

给 dots 用的接口。每个令牌单独配置权限（scope），只能用下面列出的接口；令牌访问其他任何 `/api/` 接口一律 403。

| scope | 能做什么 | 接口 |
|---|---|---|
| `moderation` | 列待审队列、看作品内容和截图、通过、打回（必须写理由） | `/api/dots/moderation/*` |
| `capture:read` | 只读列出截图失败（`capture_incomplete` 或没有桌面首屏截图）的作品 | `GET /api/dots/captures/failed` |
| `cover:write` | 给作品上传或替换封面（作品页封面图，不是截图） | `PUT /api/dots/works/:task/:id/cover` |
| `works:read` | 按 task/id 读一件作品的安全声明（队列外也可以），并下载已有截图和上传包内文件 | `GET /api/dots/works/:task/:id`、`…/images/:name`、`…/file?path=` |
| `meta:write` | 改作品声明。不能改归属题目、门面或核验 | `PATCH /api/dots/works/:task/:id/meta` |
| `preview:write` | 给作品上传或替换列表卡片的 3D 小模型预览（`.sbox`） | `PUT /api/dots/works/:task/:id/preview` |
| `captures:write` | 替换桌面或手机首屏截图（`first` / `mobile`，仅 JPEG） | `PUT /api/dots/works/:task/:id/captures/:slot` |

缺某项权限时返回 `403 {"code":"scope_required"}`。权限由运维逐项开关，去掉某项或整个令牌作废都在下一个请求生效。

完善作品信息时，一次授予：`moderation,capture:read,cover:write,works:read,meta:write,preview:write,captures:write`。封面和截图是两项权限，不要把截图并进 `cover:write`。新建令牌不写权限时仍然只有 `moderation`。`works:read` 含队列外截图和上传包文件的只读流；已经有这项权限的令牌不用再授新权限。数据包作品本批不提供包内文件。

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

### 7. 截图失败列表 `GET /api/dots/captures/failed?limit=50&manualCover=all&category=建模&cursor=...`（`capture:read`）

```bash
curl -sS "https://<API 域名>/api/dots/captures/failed?limit=50" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "items": [
    {
      "task": "one", "id": "up-abc123", "title": "作品标题", "status": "review",
      "reasons": ["capture_incomplete", "no_first_capture"],
      "screenshots": { "first": false, "mobile": true },
      "hasCover": true, "hasManualCover": true,
      "submittedAt": "2026-10-20T10:00:00.000Z"
    }
  ],
  "nextCursor": "dXAtYWJjMTIz"
}
```

- 范围：上传作品中，内容审核记为 `capture_incomplete`（截图不完整），**或**已发布截图里没有桌面首屏（`captures.first`）的。`reasons` 分别是 `capture_incomplete`、`no_first_capture`，可同时出现。
- 作者自己传没传封面（`hasCover`）不是筛选条件：封面是投稿时可选的，大多数作品本来就没有。
- 已经人工（dots 或管理员）换过封面的作品照样列出，`hasManualCover: true`，因为封面不能代替截图，截图仍然缺。只想看还没处理过封面的，用 `manualCover=exclude`；只看已换过的，用 `manualCover=only`；默认 `all`。其他值返回 `400 invalid_filter`。
- 按作品 id 排序（不是投稿时间），翻页期间新出现的作品可能落在已翻过的位置，下次从头拉即可。
- `limit` 1–100，默认 50。`nextCursor` 不为 null 时把它原样作为下一页的 `cursor`；为 null 表示到底了。cursor 无效返回 `400 invalid_cursor`。
- 只返回上面这些字段：没有作者、备注、邮箱、文件或 IP。`screenshots` 表示已发布截图里有没有桌面首屏 / 手机首屏。`status` 是内容审核状态（pending / review / approved / rejected / legacy）。

#### 只看「三维建模」：`category`

```bash
curl -sS "https://<API 域名>/api/dots/captures/failed?limit=50&category=3d" -H "Authorization: Bearer $TOKEN"
```

```json
{ "items": [ { "task": "q-model", "id": "up-abc123", "...": "同上",
  "category": "建模", "webgpu": true, "webgpuSignals": ["navigator.gpu", "WebGPURenderer"] } ], "nextCursor": null }
```

- 分类字段在**题目**上，不在作品上：作品属于哪道题（`task`），题目的 `category` 是 `文学` / `推理` / `静态网页` / `建模` 之一。「三维建模」就是 `建模`（公开站的“三维建模”精选区也是这些题）。
- `category=建模`，或别名 `3d`、`modeling`、`三维建模`，只列这些题下的作品；其他分类名照原样匹配（如 `category=静态网页`），不认识的分类返回空列表。不带 `category` 时返回体和以前完全一样（没有下面三个字段）。
- 带了 `category` 时每项多三个字段：`category`（题目分类）、`webgpu`（布尔）、`webgpuSignals`（命中的特征）。
- **WebGPU 怎么判断**：服务器静态扫描作品自己的文件（入口页优先，再按名字排序的 `.html/.htm/.js/.mjs`，最多 400 个文件、合计 8 MB、单文件前 2 MB），不运行作品。命中下面任一特征即 `webgpu: true`：`navigator.gpu`、`WebGPURenderer`、`three/webgpu` 或 `three.webgpu(.nodes)(.min).js`、`getContext('webgpu')`、`.requestAdapter(`。这是启发式：用 CDN 动态拼接地址、或只在被扫描范围之外引用 WebGPU 的作品可能漏判；只有“能力检测后回退到 WebGL”的作品也会被标为 `true`，dots 可以按 `webgpuSignals` 自己再判断。截图服务的无头浏览器没有 WebGPU，这类作品通常截不出图。

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

### 9. 上传或替换 3D 预览 `PUT /api/dots/works/:task/:id/preview`（`preview:write`）

公开列表卡片先显示海报图，卡片滚到视口附近才加载小模型并在原地转动（Gallery 现有机制，`IntersectionObserver` 提前 180px）。这个接口让 dots 为作品提供这份小模型；海报图就是作品当前的人工封面。

请求体就是 `.sbox` 文件本身：

```bash
# 先传海报（第 8 节，cover:write），再传模型
curl -sS -X PUT https://<API 域名>/api/dots/works/q-model/up-abc123/cover \
  -H "Authorization: Bearer $TOKEN" --data-binary @poster.webp
curl -sS -X PUT https://<API 域名>/api/dots/works/q-model/up-abc123/preview \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @preview.sbox
```

```json
{ "task": "q-model", "id": "up-abc123", "historyId": 31,
  "previewModel": "media/up-abc123/preview-mgz3k1a2b3c4d5e6.sbox",
  "previewPoster": "media/up-abc123/cover-mgz3k0f9e8d7c6b5.webp", "previous": null,
  "stats": { "geometries": 3, "meshes": 5, "materials": 2, "textures": 0, "images": 0,
             "inflated": 183224, "droppedBytes": 0, "dropped": ["extras"] } }
```

**只接受 `.sbox`，不接受 glb。** 理由：公开站的预览加载器（Gallery `site/preview-model.js` 的 `readModel`）只读 `.sbox`，站点自带的 three 也没有 GLTFLoader；`.sbox` 的每个字段服务器都能不依赖 three 按白名单逐项重建，而 glb 要处理 JSON/BIN chunk、几十种扩展、外部 URI、内嵌图片和动画，攻击面大得多，前端还要另加一个加载器。dots 生成模型时直接导出 `.sbox` 即可（three 场景 → 下面的格式）。

**格式**：gzip 压缩的 `[u32 小端 头部长度][UTF-8 JSON 头部][补零到 8 字节对齐][数据区]`，`version: 2`（也接受旧版 1：数据区紧跟头部、不对齐）。头部：

```json
{
  "version": 2, "normalized": false, "clip": false,
  "bounds": { "min": [x, y, z], "max": [x, y, z] },
  "geometries": [ { "attributes": { "position": { "type": "Float32Array", "offset": 0, "length": 300, "itemSize": 3 },
                                     "normal":   { "type": "Int8Array", "offset": 1200, "length": 300, "itemSize": 3, "normalized": true } },
                    "index": { "type": "Uint16Array", "offset": 1504, "length": 600, "itemSize": 1 },
                    "groups": [ { "start": 0, "count": 600, "materialIndex": 0 } ] } ],
  "materials": [ { "type": "MeshStandardMaterial", "color": 16746496, "roughness": 0.6, "metalness": 0.1 } ],
  "meshes": [ { "geometry": 0, "material": 0, "matrix": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] },
              { "geometry": 0, "material": 0, "matrix": [...16 个数...], "count": 50,
                "instances": { "type": "Float32Array", "offset": 2704, "length": 800 },
                "colors": { "type": "Float32Array", "offset": 5904, "length": 150 } } ],
  "images": [ { "uuid": "img-1", "url": "data:image/webp;base64,..." } ],
  "textures": [ { "uuid": "tex-1", "image": "img-1", "flipY": false, "colorSpace": "srgb" } ]
}
```

`offset` 是相对数据区开头的字节数，`length` 是元素个数（不是字节数）。

**校验规则**（任何一条不过就整包拒绝，不做“尽量修复”）：

- 大小：上传的 gzip 不超过 2 MB（`413 too_large`）；解压上限 24 MB，超过即停止解压（`413`，防压缩炸弹）；JSON 头部不超过 1 MB。
- 类型按内容判断：前 3 字节必须是 gzip 魔数 `1f 8b 08`，解压后头部长度、JSON、`version` 都要对上；glb（`glTF`）、zip、纯文本等返回 `415 unsupported_type`，结构不对返回 `422 invalid_model`。
- 数组：`type` 只能是 `Float32Array` `Float64Array` `Uint8Array` `Uint8ClampedArray` `Uint16Array` `Uint32Array` `Int8Array` `Int16Array` `Int32Array`；`offset + length × 元素字节数` 不能超出数据区。属性名只能是字母数字下划线（每个几何体最多 16 个），`itemSize` 1–16。实例矩阵和实例颜色必须是 `Float32Array`，长度分别等于 `count × 16`、`count × 3`。
- 网格的 `geometry` / `material` 下标必须存在；`matrix` 是 16 个有限数字；至少一个网格；必须有 `bounds` 且 min ≤ max。
- 材质类型白名单：`MeshStandardMaterial` `MeshPhysicalMaterial` `MeshBasicMaterial` `MeshLambertMaterial` `MeshPhongMaterial` `MeshToonMaterial` `MeshMatcapMaterial` `MeshNormalMaterial`。`ShaderMaterial`、`RawShaderMaterial` 等一律拒绝。材质里只保留白名单里的数值、布尔、颜色（0–0xFFFFFF 整数）和贴图引用；`userData`、`defines`、`uniforms`、`onBeforeCompile`、着色器源码等其他字段全部丢掉。
- 图片只能内嵌：`url` 必须是 `data:image/png|jpeg|webp;base64,...`，服务器按 magic bytes 核对内容与声明类型一致，单张解码后不超过 1 MB、宽高不超过 4096，最多 32 张。外部 URL、`blob:`、SVG、像素数组一律拒绝。贴图必须引用存在的图片，只保留白名单字段。
- 数量上限：几何体 4096、网格 8192、材质 1024、贴图 64、单网格实例 100 万。
- 清洗：服务器用通过校验的字段**重新生成**头部（顶层只剩 `version normalized clip bounds geometries materials meshes images textures`），数据区也只复制被引用的字节段并重新排布，再重新 gzip。顶层 `extras`、`userData`、未知键和数据区里没被引用的字节都会被去掉，丢掉的顶层键名和字节数在 `stats.dropped` / `stats.droppedBytes` 里返回。存下来的永远是重建后的文件，不是你上传的原件。

**海报图**：不在这个接口里传。海报就是作品当前的**人工封面**（第 8 节 `cover:write` 上传的 `cover-*` 文件，已经过那里的 PNG/JPEG/WebP、大小、尺寸校验）。作品还没有人工封面时返回 `409 poster_required`，先传封面再传模型。之后换封面不会自动改预览的海报；想让海报跟着换，换完封面后再传一次模型。

**只换预览，不动作品**：

- 只写 `media/<作品>/` 下的预览文件。作品文件、模型标签、封面、截图、审核状态和作品记录都不变。公开页和目录缓存立即更新。
- 每次上传换一个新文件名（`preview-<stamp>.sbox` 加同名清单 `preview-<stamp>.json`），旧版本全部保留，管理员可以回滚。
- 作品已经有运维流程烘焙的预览（不是 dots 传的）时返回 `409 preview_exists`，不会覆盖；dots 自己传的预览可以反复替换。
- 并发上传同一作品时后到的可能返回 `409 conflict`，重新上传即可。
- 回滚由管理员（后台 `POST /api/works/:task/:id/preview/rollback`）或运维脚本（`preview-rollback`）完成，dots 没有回滚权限；传错了就再传一个正确的。回滚到第一次上传之前会把预览整个撤掉，卡片回到只显示封面。

### 10. 读取作品 `GET /api/dots/works/:task/:id`（`works:read`）

不要求作品在审核队列里。上传作品和数据包作品都能读。

```bash
curl -sS "https://<API 域名>/api/dots/works/one/up-abc123?files=1" -H "Authorization: Bearer $TOKEN"
```

```json
{ "work": { "task": "one", "id": "up-abc123", "title": "作品标题", "summary": "", "note": "",
  "modelId": "m", "modelName": "模型", "vendor": "测试", "effort": "Default",
  "harnessId": null, "harnessOther": "测试工具", "providerId": "official",
  "generationMode": "single-turn", "humanIntervention": "none", "promptVariant": "",
  "status": "unverified", "moderationStatus": "approved", "moderationError": null,
  "cover": "media/up-abc123/cover.png", "hasManualCover": false,
  "captures": { "first": "media/up-abc123/first.jpg", "mobile": "media/up-abc123/mobile.jpg" },
  "preview": null, "author": "作者名", "submittedAt": "2026-10-22T00:00:00.000Z",
  "updatedAt": 1761000000000, "curated": false,
  "entry": "index.html",
  "images": [
    { "name": "first.jpg", "url": "/api/dots/works/one/up-abc123/images/first.jpg" },
    { "name": "mobile.jpg", "url": "/api/dots/works/one/up-abc123/images/mobile.jpg" }
  ],
  "fileCount": 1, "bytes": 1200,
  "files": [{ "path": "index.html", "bytes": 1200 }] } }
```

- 不返回邮箱、IP、内容密钥、scene URL、摘要哈希或令牌。这条 JSON 也不带作品包字节。`author` 只是显示名。
- `entry` 是上传包入口的相对路径（通常 `index.html`）。数据包作品为 `null`。
- `images` 列出 `media/<作品>/` 下符合图片白名单的文件（JPEG、PNG、WebP，含 `first.jpg`、`mobile.jpg`、`*-late.jpg`、封面和 `first-<stamp>.jpg`）。`url` 指向第 10.1 节。`captures.first` / `captures.mobile` 仍是存储指针字符串，下载以 `images[].url` 为准。没有这类文件时 `images` 为 `[]`。
- `files` 默认不出现。只有 `?files=1` 才列上传包里的相对路径和字节数（最多 2000 个）。数据包作品没有这项，本批也不提供包内文件下载。
- `moderationStatus` 是内容审核状态，不是“已公开”。内容通过之后作品仍要等人审才会公开。
- `updatedAt` 给第 11 节做并发校验。作品不存在返回 `404 not_found`。

已有 `works:read` 的令牌可以直接用下面两个接口，不必新授权。它们计入每令牌每分钟 120 次，不占写入额度。

### 10.1 已有截图 `GET /api/dots/works/:task/:id/images/:name`（`works:read`）

不要求作品在审核队列里。队内的 `…/moderation/works/…/images/:name` 只对队列中的作品有效；队列外用这一条。

```bash
curl -sS "https://<API 域名>/api/dots/works/one/up-abc123/images/first.jpg" -H "Authorization: Bearer $TOKEN" -o first.jpg
```

文件名须匹配图片白名单（JPEG、PNG、WebP），并且必须出现在 `media/<作品>/` 的目录列表里。返回图片字节，`Cache-Control: no-store`，`Content-Security-Policy: sandbox; default-src 'none'`。作品不存在，或文件名不在目录里（含 `..` 一类越界），返回 `404 not_found`。

### 10.2 上传包文件 `GET /api/dots/works/:task/:id/file?path=<相对路径>`（`works:read`）

只提供上传作品。数据包作品返回 `404 not_found`，即使包里有这个文件。

```bash
curl -sS "https://<API 域名>/api/dots/works/one/up-abc123/file?path=index.html" -H "Authorization: Bearer $TOKEN" -o index.html
```

入口页的 `path` 用第 10 节的 `entry`。其余资源用 `?files=1` 列出的相对路径，逐个拉取。不做整包 zip。

路径经 realpath 限制在作品目录内。缺 `path` 返回 `400 invalid_path`；含 `..`、越界或不是普通文件返回 `404 not_found`。响应固定 `Content-Type: application/octet-stream`、`Content-Disposition: attachment`、`Cache-Control: no-store`、`Content-Security-Policy: sandbox; default-src 'none'`，不在 API 域名上渲染。

### 11. 修改作品信息 `PATCH /api/dots/works/:task/:id/meta`（`meta:write`）

部分更新。可改：`title` `summary` `note` `modelId` `modelName` `vendor` `effort` `promptVariant` `harnessId` `harnessOther` `providerId` `generationMode` `humanIntervention`。

不能改：`task`（归属题目，`400 task_forbidden`）、门面、核验、封面、预览、截图、文件包、`owner`。其他未知字段 `400 invalid_field`。

```bash
curl -sS -X PATCH https://<API 域名>/api/dots/works/one/up-abc123/meta \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"新标题","updatedAt":1761000000000}'
```

```json
{ "work": { "title": "新标题", "updatedAt": 1761000001000, "...": "同第 10 节" }, "resubmitted": false }
```

- 语义与管理员改信息相同：**默认不重新送审**。`resubmitted` 为 false，内容审核状态不变，作品也不会因此公开。
- 需要重新送审时加 `"resubmitModeration": true`。只有送审文本变了（标题、简介、模型、档位、说明、Harness/服务商补充，以及生成方式、人工介入），并且内容审核开着，才会回到 pending，此时 `resubmitted` 为 true。没变的字段不会重送。数据包作品不能重送（`409 not_resubmittable`）。
- 带上一次读到的 `updatedAt`。中间被人改过则 `409 conflict`，不会覆盖。不带也可以，但并发写入仍可能 409。
- 数据包作品写入展示覆盖，不改数据包文件。

### 12. 替换截图 `PUT /api/dots/works/:task/:id/captures/:slot`（`captures:write`）

`slot` 只能是 `first`（桌面首屏）或 `mobile`（手机首屏）。请求体是 JPEG 本身。这不是封面：封面仍走第 8 节的 `cover:write`。

```bash
curl -sS -X PUT https://<API 域名>/api/dots/works/one/up-abc123/captures/first \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @first.jpg
```

```json
{ "task": "one", "id": "up-abc123", "slot": "first",
  "file": "media/up-abc123/first-mgz3k1a2b3c4d5e6.jpg",
  "previous": "media/up-abc123/first.jpg",
  "type": "image/jpeg", "width": 1440, "height": 900 }
```

- 类型按文件内容判断，只收 JPEG。PNG、WebP、GIF 返回 `415 unsupported_type`。大小不超过 3 MB，宽高 64–4096 且不超过 1677 万像素。
- 只改 `works.captures` 里这一个键，并写成新文件名。另一个槽、`*-late.jpg`、封面、作品文件、审核状态都不变。
- **不会**把 `capture_incomplete` 清掉，也不会把作品标成已通过或已取景。缺首屏的作品换上 `first` 之后不再因为“没有 first”出现在截图失败列表里；若审核错误仍是 `capture_incomplete`，它还在列表里。
- 截图服务以后重跑会再写 `first.jpg` / `mobile.jpg` 并盖掉这个键。人工封面不会被这里或重跑截图改掉。
- 没有回滚接口。传错了再传一张。并发时后到的可能 `409 conflict`。
- 其它 slot（包括 `first-late`）返回 `400 invalid_slot`。

## 状态码

| 状态码 | `code` | 含义 |
|---|---|---|
| 200 | — | 成功 |
| 400 | `reason_required` / `invalid_path` / `invalid_filter` / `invalid_cursor` / `invalid_field` / `task_forbidden` / `invalid_slot` / — | 打回缺理由、缺 path、请求体不是 JSON 对象、meta 字段不允许、试图改题、截图槽不是 first/mobile |
| 401 | `unauthorized` | 缺令牌、令牌错或已吊销 |
| 403 | `token_forbidden` | 用令牌访问了 dots 以外的接口 |
| 403 | `scope_required` | 令牌没有这项权限 |
| 422 | `bad_dimensions` | 封面或截图尺寸不在允许范围 |
| 503 | `dots_disabled` / `scope_disabled` | 运维临时关闭了整个 dots 接口或这项能力 |
| 404 | `not_found` | 接口不存在，作品不存在，作品不在 dots 队列里（队列接口），截图或包内文件不存在，或数据包作品请求了包内文件 |
| 405 | `method_not_allowed` | 方法不对 |
| 409 | `not_in_queue` | 作品已经被别人（机器、管理员）决定，或已超时转走；返回体 `current.status` 是当前状态 |
| 409 | `stale` | 带的 `version` 不是当前版本：作者改过作品，重新查看 |
| 409 | `conflict` | 决定、封面、预览、信息或截图刚好被修改，重新获取后再写 |
| 409 | `not_resubmittable` | 数据包作品不能重新送审 |
| 409 | `poster_required` | 传预览前作品还没有人工封面 |
| 409 | `preview_exists` | 作品已有不是 dots 上传的预览，不覆盖 |
| 413 / 415 | — / `too_large` / `unsupported_type` | 请求体太大（审核与 meta 8 KiB，封面和截图 3 MB，预览 2 MB / 解压 24 MB）/ 审核或 meta 请求不是 `application/json`，封面不是 PNG/JPEG/WebP，截图不是 JPEG，或预览不是 gzip 的 `.sbox` |
| 422 | `invalid_model` | 预览包结构或内容不符合上面的白名单 |
| 429 | `rate_limited` | 限流，看 `Retry-After` 头或 `retryAfter` 字段（秒） |

错误返回体：`{"error": "中文说明", "code": "..."}`。

## 限流

- 每个令牌每分钟 120 次（运维可用 `DOTS_REQUESTS_PER_MIN` 调整）。队列外截图和上传包文件计入这 120 次，不另开更严的读桶。
- 写操作（封面、预览、信息、截图）另计每分钟 30 次（`DOTS_WRITES_PER_MIN`）。读队列、读作品、下截图和包内文件不占这个额度。
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
- 改信息和换截图同样是条件更新：用读到的 `updatedAt` 或当时的截图记录做比较，先写入的生效，后到的 `409 conflict`。

## 审计

每个通过鉴权的请求都会记录：令牌 id 和标签、动作（list / view / view-image / view-file / approve / reject / list-capture-gaps / cover-replace / preview-replace / work-get / work-image / work-file / meta / capture-replace）、作品、理由、时间、IP、结果。不记录令牌明文。作品的审核记录里决定人显示为 `dots:<令牌标签>`。meta 的理由是改了哪些字段名；截图写入的理由是 `first` 或 `mobile`。`work-image` 和 `work-file` 是队列外的只读拉取，与队内的 `view-image`、`view-file` 分开计。
